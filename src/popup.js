import { DEFAULT_SETTINGS, DEFAULT_STATE, TWEET_LIMIT, tweetLength, uid } from './shared.js';

const $ = (id) => document.getElementById(id);

const SETTING_FIELDS = [
  ['intervalMinutes', 'number'],
  ['jitterPercent', 'number'],
  ['dailyCap', 'number'],
  ['quietStart', 'number'],
  ['quietEnd', 'number'],
  ['quietHoursEnabled', 'checkbox'],
  ['humanCursor', 'checkbox'],
  ['openTabIfMissing', 'checkbox'],
  ['typingSpeed', 'select'],
];

let cache = { settings: DEFAULT_SETTINGS, state: DEFAULT_STATE, queue: [], history: [] };

async function load() {
  const raw = await chrome.storage.local.get(['settings', 'state', 'queue', 'history']);
  cache = {
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    state: { ...DEFAULT_STATE, ...(raw.state || {}) },
    queue: raw.queue || [],
    history: raw.history || [],
  };
  render();
}

const saveQueue = (queue) => chrome.storage.local.set({ queue });
const saveSettings = (settings) => chrome.storage.local.set({ settings });

// ------------------------------------------------------------------ rendering

function relative(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function statusLine() {
  const { settings, state, queue } = cache;
  const dot = $('statusDot');
  dot.className = 'dot';

  if (state.consecutiveFailures >= 3) {
    dot.classList.add('warn');
    return 'Paused after 3 failures in a row. Check the History tab, then flip the switch back on.';
  }
  if (!settings.enabled) return 'Paused. Turn the switch on to start posting.';
  if (!queue.length) return 'Nothing queued — add a post and it will go out on schedule.';
  if (state.activeJob) return 'Posting right now…';
  if (settings.dailyCap > 0 && state.postedToday >= settings.dailyCap) {
    return `Daily cap reached (${state.postedToday}/${settings.dailyCap}). Resumes tomorrow.`;
  }

  dot.classList.add('on');
  if (!state.nextRunAt) return 'Scheduling the next post…';
  const delta = state.nextRunAt - Date.now();
  const capNote =
    settings.dailyCap > 0 ? ` · ${state.postedToday}/${settings.dailyCap} today` : '';
  return delta <= 0
    ? `Next post is due now${capNote}`
    : `Next post in about ${relative(delta)}${capNote}`;
}

function renderQueue() {
  const list = $('queue');
  const { queue } = cache;
  list.replaceChildren();
  $('queueCount').textContent = String(queue.length);
  $('queueEmpty').style.display = queue.length ? 'none' : 'block';
  $('postNow').disabled = !queue.length;

  queue.forEach((item, i) => {
    const li = document.createElement('li');

    const body = document.createElement('div');
    body.className = 'text';
    body.textContent = item.text;
    li.appendChild(body);

    if (item.lastError) {
      const meta = document.createElement('div');
      meta.className = 'meta err';
      meta.textContent = `Retrying — ${item.lastError}`;
      body.appendChild(meta);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      iconButton('↑', 'Move up', i === 0, () => move(i, -1)),
      iconButton('↓', 'Move down', i === queue.length - 1, () => move(i, 1)),
      iconButton('✕', 'Remove', false, () => remove(i), 'del')
    );
    li.appendChild(actions);
    list.appendChild(li);
  });
}

function iconButton(label, title, disabled, onClick, extra) {
  const b = document.createElement('button');
  b.className = extra ? `icon ${extra}` : 'icon';
  b.textContent = label;
  b.title = title;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function renderHistory() {
  const list = $('history');
  const { history } = cache;
  list.replaceChildren();
  $('historyEmpty').style.display = history.length ? 'none' : 'block';

  for (const h of history) {
    const li = document.createElement('li');
    const body = document.createElement('div');
    body.className = 'text';
    body.textContent = h.text;
    li.appendChild(body);

    const meta = document.createElement('div');
    const when = new Date(h.at).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    if (h.status === 'posted') {
      meta.className = 'meta ok';
      meta.textContent = `Posted · ${when}`;
    } else if (h.status === 'retrying') {
      meta.className = 'meta';
      meta.textContent = `Attempt ${h.attempt} failed · ${when} · ${h.error || ''}`;
    } else {
      meta.className = 'meta err';
      meta.textContent = `Failed · ${when} · ${h.error || ''}`;
    }
    li.appendChild(meta);
    list.appendChild(li);
  }
}

function renderSettings() {
  for (const [id, kind] of SETTING_FIELDS) {
    const el = $(id);
    if (kind === 'checkbox') el.checked = !!cache.settings[id];
    else el.value = cache.settings[id];
  }
  $('enabled').checked = !!cache.settings.enabled;
}

function render() {
  $('status').textContent = statusLine();
  renderQueue();
  renderHistory();
  renderSettings();
}

// -------------------------------------------------------------------- actions

async function move(i, dir) {
  const queue = cache.queue.slice();
  const j = i + dir;
  if (j < 0 || j >= queue.length) return;
  [queue[i], queue[j]] = [queue[j], queue[i]];
  cache.queue = queue;
  await saveQueue(queue);
  renderQueue();
}

async function remove(i) {
  const queue = cache.queue.slice();
  queue.splice(i, 1);
  cache.queue = queue;
  await saveQueue(queue);
  renderQueue();
}

function updateCount() {
  const text = $('draft').value;
  const left = TWEET_LIMIT - tweetLength(text);
  const el = $('count');
  el.textContent = String(left);
  el.classList.toggle('over', left < 0);
  $('add').disabled = !text.trim() || left < 0;
}

$('draft').addEventListener('input', updateCount);

$('add').addEventListener('click', async () => {
  const text = $('draft').value.trim();
  if (!text || tweetLength(text) > TWEET_LIMIT) return;
  cache.queue = [...cache.queue, { id: uid(), text, addedAt: Date.now() }];
  await saveQueue(cache.queue);
  $('draft').value = '';
  updateCount();
  render();
});

// Cmd/Ctrl+Enter to queue, same as X's own composer shortcut.
$('draft').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    $('add').click();
  }
});

$('postNow').addEventListener('click', async () => {
  $('postNow').disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'POST_NOW' });
  $('status').textContent = res?.ok
    ? 'Posting right now…'
    : res?.error || 'Could not start that post.';
});

$('enabled').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  cache.settings = { ...cache.settings, enabled };
  // Turning it back on clears the failure streak that paused it.
  cache.state = { ...cache.state, consecutiveFailures: enabled ? 0 : cache.state.consecutiveFailures };
  await chrome.storage.local.set({ settings: cache.settings, state: cache.state });
  if (enabled) await chrome.runtime.sendMessage({ type: 'RESCHEDULE' });
  render();
});

for (const [id, kind] of SETTING_FIELDS) {
  $(id).addEventListener('change', async (e) => {
    const value =
      kind === 'checkbox'
        ? e.target.checked
        : kind === 'number'
          ? Number(e.target.value)
          : e.target.value;
    cache.settings = { ...cache.settings, [id]: value };
    await saveSettings(cache.settings);
    if (id === 'intervalMinutes' || id === 'jitterPercent') {
      await chrome.runtime.sendMessage({ type: 'RESCHEDULE' });
    }
    render();
  });
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document
      .querySelectorAll('.panel')
      .forEach((p) => p.classList.toggle('active', p.id === `panel-${tab.dataset.tab}`));
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') load();
});

setInterval(() => {
  $('status').textContent = statusLine();
}, 1000);

updateCount();
load();
