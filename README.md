# Tekless Queue

A browser extension that posts your queued drafts to X on a schedule. It works
by driving the composer in the tab you're already signed into — clicking, typing,
and pressing Post the way you would — so there are no API keys, no passwords, and
nothing stored anywhere but your own browser.

## Install

It's an unpacked extension; there's no build step.

**Chrome, Edge, Brave, Arc**

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this folder
4. Pin the icon to your toolbar

**Firefox**

1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on** and pick `manifest.json`

Firefox drops temporary add-ons when you restart, so Chrome is the better home
for something meant to run all day.

## Using it

Open the popup and you get three tabs.

**Queue** — write a post, hit *Add to queue* (or `Cmd`/`Ctrl+Enter`). Items go out
oldest first. Reorder with the arrows, drop one with `✕`, or push the top item out
immediately with *Post next now*. The counter bills links at X's flat 23-character
rate, same as the real composer.

**Schedule** — how often to post, and the guardrails:

| Setting | What it does |
| --- | --- |
| Post every | Minutes between posts |
| Vary the gap | Spreads each gap ± this much so posts don't land on an exact clock cadence; the average stays put |
| Max per day | Stops after N posts, resets at local midnight (0 = no cap) |
| Quiet hours | A window where nothing goes out; handles overnight ranges like 23→7 |
| Typing speed | How fast text is entered into the composer |
| Show the cursor moving | Draws a pointer that glides to each control before clicking |
| Open an X tab if none is open | Otherwise it waits until you have x.com open somewhere |

**History** — what went out and when, plus the reason for anything that didn't.

Flip the switch in the header to start. The status line tells you when the next
post is due.

## How it works

- `src/background.js` is the service worker. A one-minute alarm ticks, and when
  the next run is due it picks the head of the queue, finds or opens an x.com tab,
  and hands off a job.
- `src/content.js` runs in the page. It opens the composer (in place via the
  sidebar button, or by navigating to `/compose/post` if it has to), types the
  text, clicks Post, and waits for confirmation before reporting back.
- `src/shared.js` holds the scheduling math, which is unit-tested.

The job lives in `chrome.storage`, not in memory, so a navigation or a service
worker shutdown mid-post doesn't lose it — the content script reclaims the job
when the page loads again.

A few deliberate choices worth knowing about:

- **Typing goes through `execCommand('insertText')`.** X's composer is a rich text
  editor, not a `<textarea>`; setting `.value` or `.textContent` does nothing at all,
  because React never sees the change.
- **Posting is confirmed, not assumed.** After clicking Post it waits for the
  composer to clear or a toast to appear, up to 20 seconds. Anything else is
  recorded as a failure rather than silently dropped.
- **Failures retry twice, then stop.** Three failed posts in a row pauses the whole
  schedule and badges the icon, so a logged-out session or a markup change doesn't
  grind your entire queue into the failure log while you're away.
- **Timing is accurate to about a minute.** Extension alarms can't be scheduled
  more finely than that, which is invisible at any realistic posting interval.

## Tests

```
npm test
```

Covers link-weighted character counting, quiet-hour windows including ones that
cross midnight, and the jitter distribution — that it stays inside its band,
averages out to the interval you set, and never schedules something into a quiet
window.

## Regenerating the icons

```
npm run icons
```

`tools/make_icons.py` writes the PNGs directly with `zlib`, so there's no image
library to install.

## Worth knowing

- **X's rules.** Automation Rules allow you to automate your own account, but they
  prohibit spam, duplicate or near-duplicate content, and posting the same thing
  across multiple accounts. Scheduling your own writing is squarely fine; a firehose
  of near-identical posts is what gets accounts limited. The interval and daily cap
  exist to help you stay on the right side of that.
- **The tab needs to stay open.** This drives a real browser tab, so it only posts
  while your browser is running and you're signed in. It's a scheduler for a machine
  you're already using, not a server-side one.
- **Interface changes will break it.** It depends on X's `data-testid` attributes.
  If posting starts failing, that's the first thing to check — the selectors are all
  in the `SEL` object at the top of `src/content.js`.
- **Nothing leaves your browser.** The queue, settings, and history live in
  `chrome.storage.local`. There's no server, no analytics, and no network access
  beyond the x.com tab itself.
