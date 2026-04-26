// Popup entry — small UI surface, but does several things:
//   1. Reads state from the SW (enabled, count, host, paused-on-host).
//   2. Lets the user pause/unpause the current site with a single click.
//   3. Lets the user clear all paused sites in one go ("Resume everywhere").
//
// Everything that mutates state goes through the SW — the popup never
// touches DNR or storage directly. Centralizing writes there avoids the
// classic two-writer race when the user rapid-clicks the pause button.

import type { Message, Response } from '../shared/messages.js';

const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const hostEl = document.getElementById('host');
const pauseBtn = document.getElementById('pause') as HTMLButtonElement | null;
const resumeAllEl = document.getElementById('resume-all') as HTMLAnchorElement | null;
const pausedCountEl = document.getElementById('paused-count');

/**
 * Send a message to the SW and resolve with its response. We wrap
 * `chrome.runtime.sendMessage` because its callback-flavored signature
 * doesn't return a useful promise on Chrome < 99 and the polyfilled
 * promise variant swallows lastError. Doing the wrap by hand once means
 * every caller has the same error semantics.
 */
function send(msg: Message): Promise<Response> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (raw: unknown) => {
      if (chrome.runtime.lastError || !raw) {
        resolve({ ok: false, error: chrome.runtime.lastError?.message ?? 'no response' });
        return;
      }
      resolve(raw as Response);
    });
  });
}

/**
 * Render the popup state. Called once on load and again after every
 * mutation. Keeping the view-update in one place means a partial render
 * (e.g. someone forgetting to update the host label after a toggle) is
 * impossible by construction.
 */
function render(resp: Response): void {
  if (!resp.ok) {
    if (statusEl) statusEl.textContent = 'unavailable';
    if (pauseBtn) pauseBtn.hidden = true;
    if (resumeAllEl) resumeAllEl.hidden = true;
    return;
  }

  // The "enabled" line reads "paused" if the user has *globally* turned
  // both lists off. Per-site pauses don't flip this — that's a different
  // semantic, surfaced in the pause button label.
  if (statusEl) statusEl.textContent = resp.enabled ? 'enabled' : 'paused';
  if (countEl) countEl.textContent = String(resp.blockedCount ?? 0);
  if (hostEl) hostEl.textContent = resp.currentHost ?? '—';

  if (pauseBtn) {
    if (!resp.currentHost) {
      // No usable host (chrome:// page, localhost, IP). Hide the button
      // — pausing a hostless URL has no meaningful semantic.
      pauseBtn.hidden = true;
    } else {
      pauseBtn.hidden = false;
      pauseBtn.textContent = resp.pausedOnCurrentHost
        ? `Resume on ${resp.currentHost}`
        : `Pause on ${resp.currentHost}`;
      pauseBtn.dataset.host = resp.currentHost;
    }
  }

  if (resumeAllEl && pausedCountEl) {
    const n = resp.pausedHosts.length;
    resumeAllEl.hidden = n === 0;
    pausedCountEl.textContent = String(n);
  }
}

pauseBtn?.addEventListener('click', async () => {
  const host = pauseBtn.dataset.host;
  if (!host) return;
  // Disable while in flight to prevent rapid double-clicks from racing
  // each other through the SW. The render() call after the response will
  // re-enable (button will redraw with new label and `hidden = false`).
  pauseBtn.disabled = true;
  const resp = await send({ type: 'popup:toggle-pause', host });
  pauseBtn.disabled = false;
  render(resp);
  // Auto-reload the active tab so the user immediately sees the new
  // state. Without this, the page they're looking at has already been
  // blocked/allowed under the old policy; only future navigations would
  // see the change. Mainstream ad blockers (AdGuard, AdBlock) follow this
  // pattern; uBO does not but uses a "needs reload" badge instead — for
  // a v0 with no badge yet, auto-reload is the clearer signal.
  await reloadActiveTab();
});

resumeAllEl?.addEventListener('click', async (e) => {
  e.preventDefault();
  const resp = await send({ type: 'popup:resume-all' });
  render(resp);
  await reloadActiveTab();
});

/**
 * Reload the currently-active tab. Failures are non-fatal — the popup
 * still updated, the user just won't see the effect until they reload
 * manually. Most common reason to fail: the active tab is a chrome://
 * URL we can't reload.
 */
async function reloadActiveTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.reload(tab.id);
  } catch (err) {
    console.debug('[popup] active tab reload failed', err);
  }
}

void send({ type: 'popup:get-state' }).then(render);

export {};
