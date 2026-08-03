import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  computeNextRun,
  inQuietHours,
  quietHoursEnd,
  tweetLength,
  dayKey,
  isPermanentFailure,
} from '../src/shared.js';

const at = (h, m = 0) => new Date(2026, 0, 15, h, m, 0, 0);

test('tweetLength counts plain text by code point', () => {
  assert.equal(tweetLength('hello'), 5);
  assert.equal(tweetLength(''), 0);
  // Emoji outside the BMP count once, not twice.
  assert.equal(tweetLength('🚀'), 1);
});

test('tweetLength bills every link at the fixed t.co cost', () => {
  assert.equal(tweetLength('https://x.com'), 23);
  assert.equal(tweetLength('https://example.com/a/very/long/path?with=query&more=params'), 23);
  assert.equal(tweetLength('see https://x.com ok'), 4 + 23 + 3);
  assert.equal(tweetLength('https://a.com https://b.com'), 23 + 1 + 23);
});

test('quiet hours across midnight covers the night, not the day', () => {
  const s = { ...DEFAULT_SETTINGS, quietHoursEnabled: true, quietStart: 23, quietEnd: 7 };
  assert.equal(inQuietHours(at(23, 30), s), true);
  assert.equal(inQuietHours(at(2), s), true);
  assert.equal(inQuietHours(at(6, 59), s), true);
  assert.equal(inQuietHours(at(7), s), false);
  assert.equal(inQuietHours(at(12), s), false);
  assert.equal(inQuietHours(at(22, 59), s), false);
});

test('quiet hours within a single day stay within that day', () => {
  const s = { ...DEFAULT_SETTINGS, quietHoursEnabled: true, quietStart: 9, quietEnd: 17 };
  assert.equal(inQuietHours(at(8), s), false);
  assert.equal(inQuietHours(at(9), s), true);
  assert.equal(inQuietHours(at(16, 59), s), true);
  assert.equal(inQuietHours(at(17), s), false);
  assert.equal(inQuietHours(at(23), s), false);
});

test('quiet hours are inert when disabled', () => {
  const s = { ...DEFAULT_SETTINGS, quietHoursEnabled: false, quietStart: 0, quietEnd: 23 };
  assert.equal(inQuietHours(at(3), s), false);
});

test('quietHoursEnd lands on the next end boundary in the future', () => {
  const s = { ...DEFAULT_SETTINGS, quietHoursEnabled: true, quietStart: 23, quietEnd: 7 };
  assert.equal(quietHoursEnd(at(23, 30), s).getTime(), at(7).getTime() + 24 * 3600 * 1000);
  assert.equal(quietHoursEnd(at(2), s).getTime(), at(7).getTime());
});

test('computeNextRun stays inside the jitter band and never goes backwards', () => {
  const s = { ...DEFAULT_SETTINGS, intervalMinutes: 45, jitterPercent: 20 };
  const now = at(12).getTime();
  const base = 45 * 60000;
  for (let i = 0; i < 500; i++) {
    const next = computeNextRun(s, now);
    assert.ok(next > now, 'next run must be in the future');
    assert.ok(next - now >= base * 0.8 - 1, `gap ${next - now} below jitter floor`);
    assert.ok(next - now <= base * 1.2 + 1, `gap ${next - now} above jitter ceiling`);
  }
});

test('computeNextRun averages out to the configured interval', () => {
  const s = { ...DEFAULT_SETTINGS, intervalMinutes: 60, jitterPercent: 25 };
  const now = at(12).getTime();
  let total = 0;
  const runs = 4000;
  for (let i = 0; i < runs; i++) total += computeNextRun(s, now) - now;
  const meanMinutes = total / runs / 60000;
  assert.ok(Math.abs(meanMinutes - 60) < 1.5, `mean gap was ${meanMinutes.toFixed(2)} min`);
});

test('computeNextRun keeps a floor of one minute on tiny intervals', () => {
  const s = { ...DEFAULT_SETTINGS, intervalMinutes: 1, jitterPercent: 60 };
  const now = at(12).getTime();
  for (let i = 0; i < 200; i++) {
    assert.ok(computeNextRun(s, now) - now >= 60000);
  }
});

test('computeNextRun pushes past a quiet window instead of landing in it', () => {
  const s = {
    ...DEFAULT_SETTINGS,
    intervalMinutes: 60,
    jitterPercent: 0,
    quietHoursEnabled: true,
    quietStart: 23,
    quietEnd: 7,
  };
  // 23:30 + 60 min would land at 00:30, inside the window.
  const next = new Date(computeNextRun(s, at(23, 30).getTime()));
  assert.equal(inQuietHours(next, s), false);
  assert.equal(next.getHours(), 7);
});

test('dayKey rolls at local midnight', () => {
  assert.equal(dayKey(at(23, 59)), dayKey(at(0, 1)));
  assert.notEqual(dayKey(new Date(2026, 0, 15, 12)), dayKey(new Date(2026, 0, 16, 12)));
});

test('permanent failures are recognised so they are not retried', () => {
  assert.equal(isPermanentFailure('X said: Whoops! You already said that.'), true);
  assert.equal(isPermanentFailure('Not signed in to X in this browser profile.'), true);
  assert.equal(isPermanentFailure('The Post button stayed disabled — check the post length.'), true);
  assert.equal(isPermanentFailure('Timed out waiting for the page to confirm the post.'), false);
  assert.equal(isPermanentFailure('Could not find or open the composer on this page.'), false);
  assert.equal(isPermanentFailure(undefined), false);
});
