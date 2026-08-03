import {
  DEFAULT_SETTINGS,
  DEFAULT_STATE,
  MAX_ATTEMPTS,
  JOB_TIMEOUT_MS,
  HISTORY_LIMIT,
  computeNextRun,
  isPermanentFailure,
  inQuietHours,
  quietHoursEnd,
  dayKey,
  uid,
} from './shared.js';

const TICK_ALARM = 'tekless-tick';
const X_URLS = ['https://x.com/*', 'https://twitter.com/*'];

async function read() {
  const raw = await chrome.storage.local.get(['settings', 'state', 'queue', 'history']);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    state: { ...DEFAULT_STATE, ...(raw.state || {}) },
    queue: raw.queue || [],
    history: raw.history || [],
  };
}

const write = (patch) => chrome.storage.local.set(patch);

async function patchState(fn) {
  const { state } = await read();
  const next = { ...state, ...(await fn(state)) };
  await write({ state: next });
  return next;
}

function ensureAlarm() {
  chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings, state, queue, history } = await read();
  await write({ settings, state, queue, history });
  ensureAlarm();
});

chrome.runtime.onStartup.addListener(ensureAlarm);

// ---------------------------------------------------------------- scheduling

async function rollDayCounter(state) {
  const today = dayKey();
  if (state.todayKey !== today) return { todayKey: today, postedToday: 0 };
  return {};
}

async function armNextRun(settings, from = Date.now()) {
  const nextRunAt = computeNextRun(settings, from);
  await patchState(() => ({ nextRunAt }));
  return nextRunAt;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== TICK_ALARM) return;
  await tick();
});

async function tick() {
  const { settings, state, queue } = await read();
  const rolled = await rollDayCounter(state);
  if (Object.keys(rolled).length) Object.assign(state, await patchState(() => rolled));

  // A job that never reported back — the tab was closed, X was slow, the page
  // navigated mid-flight. Reclaim it so the queue doesn't wedge.
  if (state.activeJob && Date.now() - state.activeJob.startedAt > JOB_TIMEOUT_MS) {
    await finishJob(state.activeJob, {
      ok: false,
      error: 'Timed out waiting for the page to confirm the post.',
    });
    return;
  }
  if (state.activeJob) return;
  if (!settings.enabled || queue.length === 0) return;

  if (settings.dailyCap > 0 && state.postedToday >= settings.dailyCap) return;

  const now = new Date();
  if (inQuietHours(now, settings)) {
    await patchState(() => ({ nextRunAt: quietHoursEnd(now, settings).getTime() }));
    return;
  }

  if (state.nextRunAt == null) {
    await armNextRun(settings);
    return;
  }
  if (Date.now() < state.nextRunAt) return;

  await startJob(queue[0]);
}

// -------------------------------------------------------------- job lifecycle

async function findOrOpenTab(settings) {
  const tabs = await chrome.tabs.query({ url: X_URLS });
  const usable = tabs.find((t) => t.status === 'complete') || tabs[0];
  if (usable) return usable;
  if (!settings.openTabIfMissing) return null;
  return chrome.tabs.create({ url: 'https://x.com/home', active: false });
}

// A freshly installed extension has no content script in tabs that were already
// open, so inject on demand rather than asking the user to reload every tab.
async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (pong?.ok) return true;
  } catch {
    /* not injected yet */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
    await new Promise((r) => setTimeout(r, 300));
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return !!pong?.ok;
  } catch {
    return false;
  }
}

async function startJob(item, { manual = false } = {}) {
  const { settings } = await read();
  const tab = await findOrOpenTab(settings);
  if (!tab) {
    await armNextRun(settings);
    return { ok: false, error: 'No x.com tab open, and opening one is turned off.' };
  }

  const job = {
    jobId: uid(),
    itemId: item.id,
    text: item.text,
    tabId: tab.id,
    startedAt: Date.now(),
    attempt: (item.attempts || 0) + 1,
    manual,
    humanCursor: settings.humanCursor,
    typingSpeed: settings.typingSpeed,
  };
  await patchState(() => ({ activeJob: job }));

  const ready = await ensureContentScript(tab.id);
  if (!ready) {
    // The tab is probably still loading. The content script claims the job from
    // storage on its own once it boots, so just let the timeout guard handle it.
    return { ok: true, pending: true };
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'RUN_JOB', job });
  } catch {
    /* content script will pick the job up from storage after load */
  }
  return { ok: true, pending: true };
}

async function finishJob(job, result) {
  const { settings, queue, history, state } = await read();
  const idx = queue.findIndex((q) => q.id === job.itemId);
  const item = idx >= 0 ? queue[idx] : { id: job.itemId, text: job.text };
  const nextQueue = queue.slice();
  let entry = null;
  let failures = state.consecutiveFailures;
  let postedToday = state.postedToday;

  if (result.ok) {
    if (idx >= 0) nextQueue.splice(idx, 1);
    entry = { id: item.id, text: job.text, at: Date.now(), status: 'posted' };
    failures = 0;
    postedToday += 1;
  } else if (job.attempt < MAX_ATTEMPTS && !isPermanentFailure(result.error)) {
    // Keep it at the head of the queue and try again shortly.
    if (idx >= 0) nextQueue[idx] = { ...item, attempts: job.attempt, lastError: result.error };
    entry = {
      id: item.id,
      text: job.text,
      at: Date.now(),
      status: 'retrying',
      error: result.error,
      attempt: job.attempt,
    };
  } else {
    if (idx >= 0) nextQueue.splice(idx, 1);
    entry = { id: item.id, text: job.text, at: Date.now(), status: 'failed', error: result.error };
    failures += 1;
  }

  const nextHistory = [entry, ...history].slice(0, HISTORY_LIMIT);
  const retrying = entry.status === 'retrying';
  const from = retrying ? Date.now() - settings.intervalMinutes * 60000 + 120000 : Date.now();

  // Three failed posts in a row means something structural is wrong — X changed
  // its markup, the session is logged out, the account is limited. Stop rather
  // than grinding the whole queue into the failure log.
  const shouldPause = failures >= 3;

  await write({
    queue: nextQueue,
    history: nextHistory,
    settings: shouldPause ? { ...settings, enabled: false } : settings,
    state: {
      ...state,
      activeJob: null,
      lastRunAt: Date.now(),
      consecutiveFailures: failures,
      postedToday,
      nextRunAt: computeNextRun(settings, from),
    },
  });

  if (shouldPause) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f4212e' });
  } else if (result.ok) {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ------------------------------------------------------------------ messaging

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'WHO_AM_I':
        sendResponse({ tabId: sender.tab?.id ?? null });
        return;

      case 'JOB_RESULT': {
        const { state } = await read();
        if (!state.activeJob || state.activeJob.jobId !== msg.jobId) {
          sendResponse({ ok: false, error: 'stale job' });
          return;
        }
        await finishJob(state.activeJob, { ok: msg.ok, error: msg.error });
        sendResponse({ ok: true });
        return;
      }

      case 'CLAIM_JOB': {
        // Content script booted and is asking whether it owns a pending job.
        const { state } = await read();
        const job = state.activeJob;
        sendResponse(job && job.tabId === sender.tab?.id ? { job } : { job: null });
        return;
      }

      case 'POST_NOW': {
        const { queue } = await read();
        if (!queue.length) {
          sendResponse({ ok: false, error: 'Queue is empty.' });
          return;
        }
        chrome.action.setBadgeText({ text: '' });
        sendResponse(await startJob(queue[0], { manual: true }));
        return;
      }

      case 'RESCHEDULE': {
        const { settings } = await read();
        ensureAlarm();
        await armNextRun(settings);
        chrome.action.setBadgeText({ text: '' });
        sendResponse({ ok: true });
        return;
      }

      case 'TICK_NOW':
        await tick();
        sendResponse({ ok: true });
        return;

      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();
  return true;
});

ensureAlarm();
