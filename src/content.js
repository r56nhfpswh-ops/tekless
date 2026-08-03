/* Tekless Queue — runs inside x.com and drives the real composer.
 *
 * Everything here works against the UI you'd click yourself, in the session
 * you're already signed into. No tokens, no credentials, no background HTTP.
 */
(() => {
  if (window.__teklessQueueLoaded) return;
  window.__teklessQueueLoaded = true;

  const SEL = {
    editor: '[data-testid="tweetTextarea_0"]',
    postInline: '[data-testid="tweetButtonInline"]',
    postModal: '[data-testid="tweetButton"]',
    sideNavCompose: '[data-testid="SideNav_NewTweet_Button"]',
    toast: '[data-testid="toast"]',
    accountSwitcher: '[data-testid="SideNav_AccountSwitcher_Button"]',
    loginButton: '[data-testid="loginButton"]',
  };

  const TYPING = {
    fast: [4, 14],
    natural: [22, 68],
    slow: [55, 130],
  };

  let running = false;
  let currentJobId = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const visible = (el) => !!el && el.getClientRects().length > 0;

  function $(sel) {
    const el = document.querySelector(sel);
    return visible(el) ? el : null;
  }

  async function waitFor(fn, { timeout = 10000, interval = 120 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > deadline) return null;
      await sleep(interval);
    }
  }

  // ------------------------------------------------------------ fake cursor

  let cursorEl = null;
  let cursorPos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  function cursor() {
    if (cursorEl && cursorEl.isConnected) return cursorEl;
    cursorEl = document.createElement('div');
    cursorEl.setAttribute('aria-hidden', 'true');
    Object.assign(cursorEl.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '18px',
      height: '18px',
      marginLeft: '-2px',
      marginTop: '-2px',
      pointerEvents: 'none',
      zIndex: '2147483647',
      transition: 'opacity .2s',
      background:
        "no-repeat center/contain url(\"data:image/svg+xml;utf8," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
            '<path d="M5 2l14 8.5-6.2 1.2 3.4 6.6-2.6 1.4-3.4-6.6L5 18z" ' +
            'fill="#1d9bf0" stroke="white" stroke-width="1.4" stroke-linejoin="round"/></svg>'
        ) +
        '")',
    });
    document.documentElement.appendChild(cursorEl);
    return cursorEl;
  }

  function place(x, y) {
    cursorPos = { x, y };
    const el = cursor();
    el.style.transform = `translate(${x}px, ${y}px)`;
  }

  function hideCursor() {
    if (cursorEl) cursorEl.style.opacity = '0';
  }

  // A slight arc plus an ease curve — a straight linear slide reads as
  // obviously mechanical when you're watching it happen.
  async function glideTo(x, y, enabled) {
    if (!enabled) {
      cursorPos = { x, y };
      return;
    }
    const from = { ...cursorPos };
    const dist = Math.hypot(x - from.x, y - from.y);
    const steps = Math.max(8, Math.min(38, Math.round(dist / 22)));
    const bowAmount = Math.min(60, dist * 0.18) * (Math.random() < 0.5 ? -1 : 1);
    const nx = dist === 0 ? 0 : -(y - from.y) / dist;
    const ny = dist === 0 ? 0 : (x - from.x) / dist;

    cursor().style.opacity = '1';
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const bow = Math.sin(Math.PI * t) * bowAmount;
      const px = from.x + (x - from.x) * ease + nx * bow;
      const py = from.y + (y - from.y) * ease + ny * bow;
      place(px, py);
      const target = document.elementFromPoint(px, py);
      if (target) {
        target.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            clientX: px,
            clientY: py,
            view: window,
          })
        );
      }
      await sleep(rand(6, 16));
    }
    place(x, y);
  }

  function fire(el, type, x, y) {
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      view: window,
    };
    if (Ctor === PointerEvent) Object.assign(init, { pointerId: 1, pointerType: 'mouse', isPrimary: true });
    el.dispatchEvent(new Ctor(type, init));
  }

  async function click(el, useCursor) {
    el.scrollIntoView({ block: 'center', behavior: useCursor ? 'smooth' : 'auto' });
    await sleep(useCursor ? rand(180, 380) : 30);
    const r = el.getBoundingClientRect();
    const x = r.left + r.width * (0.35 + Math.random() * 0.3);
    const y = r.top + r.height * (0.35 + Math.random() * 0.3);

    await glideTo(x, y, useCursor);
    for (const t of ['pointerover', 'mouseover', 'pointermove', 'mousemove']) fire(el, t, x, y);
    await sleep(rand(30, 90));
    for (const t of ['pointerdown', 'mousedown']) fire(el, t, x, y);
    await sleep(rand(40, 110));
    for (const t of ['pointerup', 'mouseup']) fire(el, t, x, y);
    el.click();
    await sleep(rand(120, 260));
  }

  // -------------------------------------------------------------- typing

  function caretToEnd(el) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // The composer is a rich-text editor, not a textarea — assigning .value or
  // .textContent does nothing. execCommand is deprecated but is still the one
  // path that both the editor and the React state layer agree on.
  function insert(text) {
    if (document.execCommand('insertText', false, text)) return true;
    document.activeElement?.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
    );
    return true;
  }

  function lineBreak() {
    if (!document.execCommand('insertLineBreak')) insert('\n');
  }

  async function typeInto(el, text, speed, useCursor) {
    await click(el, useCursor);
    caretToEnd(el);
    const [lo, hi] = TYPING[speed] || TYPING.natural;

    const lines = text.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const words = lines[li].split(' ');
      for (let wi = 0; wi < words.length; wi++) {
        insert(wi === words.length - 1 ? words[wi] : words[wi] + ' ');
        await sleep(rand(lo, hi));
      }
      if (li < lines.length - 1) {
        lineBreak();
        await sleep(rand(lo, hi));
      }
    }
    await sleep(rand(250, 500));
  }

  function editorText(el) {
    return (el?.innerText || '').replace(/\u200b/g, '').trim();
  }

  // -------------------------------------------------------------- the flow

  function signedOut() {
    return !!$(SEL.loginButton) && !$(SEL.accountSwitcher);
  }

  async function openComposer(useCursor) {
    let editor = $(SEL.editor);
    if (editor) return editor;

    const navBtn = $(SEL.sideNavCompose);
    if (navBtn) {
      await click(navBtn, useCursor);
      editor = await waitFor(() => $(SEL.editor), { timeout: 8000 });
      if (editor) return editor;
    }

    // No composer and no way to open one in place — send the tab to the compose
    // route. This reloads us; the job gets reclaimed from storage on boot.
    const guard = `tekless-nav-${currentJobId}`;
    if (!sessionStorage.getItem(guard)) {
      sessionStorage.setItem(guard, '1');
      location.assign('https://x.com/compose/post');
      return 'navigating';
    }
    return null;
  }

  function postButton() {
    const modal = $(SEL.postModal);
    if (modal) return modal;
    return $(SEL.postInline);
  }

  const SUCCESS_TOAST = /\b(sent|posted)\b/i;

  async function confirmPosted(editor, before) {
    // Toasts clear themselves after a few seconds, so an error has to be caught
    // while it's on screen — checking once the poll has expired finds nothing.
    const outcome = await waitFor(
      () => {
        const toast = $(SEL.toast);
        const msg = toast ? (toast.innerText || '').trim() : '';
        if (msg) {
          return SUCCESS_TOAST.test(msg) ? { ok: true } : { ok: false, error: `X said: ${msg}` };
        }
        if (!editor.isConnected) return { ok: true };
        if (editorText(editor) !== before) return { ok: true };
        return null;
      },
      { timeout: 20000, interval: 100 }
    );

    return (
      outcome || {
        ok: false,
        error: 'Clicked Post but the composer never cleared — the post may not have gone out.',
      }
    );
  }

  async function runJob(job) {
    if (running) return;
    running = true;
    currentJobId = job.jobId;
    const useCursor = job.humanCursor !== false;

    try {
      if (signedOut()) {
        return report(job, false, 'Not signed in to X in this browser profile.');
      }

      const editor = await openComposer(useCursor);
      if (editor === 'navigating') return; // resumes after the page loads
      if (!editor) {
        return report(job, false, 'Could not find or open the composer on this page.');
      }

      await typeInto(editor, job.text, job.typingSpeed, useCursor);

      const typed = editorText(editor);
      if (!typed) {
        return report(job, false, 'Text did not land in the composer.');
      }

      const btn = await waitFor(
        () => {
          const b = postButton();
          return b && b.getAttribute('aria-disabled') !== 'true' ? b : null;
        },
        { timeout: 8000 }
      );
      if (!btn) {
        return report(job, false, 'The Post button stayed disabled — check the post length.');
      }

      await click(btn, useCursor);
      const result = await confirmPosted(editor, typed);
      sessionStorage.removeItem(`tekless-nav-${job.jobId}`);
      return report(job, result.ok, result.error);
    } catch (err) {
      return report(job, false, String(err && err.message ? err.message : err));
    } finally {
      hideCursor();
      running = false;
    }
  }

  function report(job, ok, error) {
    chrome.runtime.sendMessage({ type: 'JOB_RESULT', jobId: job.jobId, ok, error });
  }

  // ------------------------------------------------------------- plumbing

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'RUN_JOB') {
      sendResponse({ ok: true });
      runJob(msg.job);
      return false;
    }
    return false;
  });

  // Claim a job left mid-flight by a navigation or a reload.
  (async () => {
    await sleep(1200);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'CLAIM_JOB' });
      if (res?.job && !running) runJob(res.job);
    } catch {
      /* service worker asleep; the next tick will re-dispatch */
    }
  })();
})();
