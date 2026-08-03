// Shared constants and pure helpers. Loaded by the service worker via import,
// and duplicated logic is deliberately avoided elsewhere.

export const DEFAULT_SETTINGS = {
  enabled: false,
  intervalMinutes: 45,
  jitterPercent: 20,
  quietHoursEnabled: false,
  quietStart: 23,
  quietEnd: 7,
  dailyCap: 0,
  humanCursor: true,
  typingSpeed: 'natural',
  openTabIfMissing: true,
};

export const DEFAULT_STATE = {
  nextRunAt: null,
  lastRunAt: null,
  activeJob: null,
  consecutiveFailures: 0,
  postedToday: 0,
  todayKey: null,
};

export const MAX_ATTEMPTS = 3;

// Retrying these just burns attempts — the same text will fail the same way.
const PERMANENT_FAILURES = [
  /already said that/i,
  /duplicate/i,
  /not signed in/i,
  /is over the limit/i,
  /stayed disabled/i,
];

export function isPermanentFailure(error) {
  return !!error && PERMANENT_FAILURES.some((re) => re.test(error));
}
export const JOB_TIMEOUT_MS = 120000;
export const HISTORY_LIMIT = 200;
export const TWEET_LIMIT = 280;

export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// X substitutes every link with a fixed-length t.co URL, so a long link costs
// the same as a short one. Everything else is close enough to a code point count.
export function tweetLength(text) {
  const withoutUrls = text.replace(/https?:\/\/\S+/g, '');
  const urlCount = (text.match(/https?:\/\/\S+/g) || []).length;
  return Array.from(withoutUrls).length + urlCount * 23;
}

export function inQuietHours(date, s) {
  if (!s.quietHoursEnabled) return false;
  const h = date.getHours() + date.getMinutes() / 60;
  const { quietStart: a, quietEnd: b } = s;
  if (a === b) return false;
  return a < b ? h >= a && h < b : h >= a || h < b;
}

// First moment at or after `date` that falls outside the quiet window.
export function quietHoursEnd(date, s) {
  const out = new Date(date);
  out.setMinutes(0, 0, 0);
  const endHour = Math.floor(s.quietEnd);
  out.setHours(endHour);
  out.setMinutes(Math.round((s.quietEnd - endHour) * 60));
  if (out <= date) out.setDate(out.getDate() + 1);
  return out;
}

export function computeNextRun(settings, from = Date.now()) {
  const base = settings.intervalMinutes * 60000;
  const spread = base * (settings.jitterPercent / 100);
  // Spread the gap around the configured interval so posts don't land on an
  // exact clock cadence — an interval of 45m stays an average of 45m.
  const delta = base + (Math.random() * 2 - 1) * spread;
  let next = new Date(from + Math.max(60000, delta));
  if (inQuietHours(next, settings)) next = quietHoursEnd(next, settings);
  return next.getTime();
}

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
