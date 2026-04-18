// Popup entry — tiny UI, reads state from SW via chrome.runtime.sendMessage.

import type { Response } from '../shared/messages.ts';

const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');

chrome.runtime.sendMessage({ type: 'popup:get-state' }, (raw: unknown) => {
  if (chrome.runtime.lastError || !raw) {
    if (statusEl) statusEl.textContent = 'unavailable';
    return;
  }
  const resp = raw as Response;
  if (!resp.ok) {
    if (statusEl) statusEl.textContent = 'error';
    return;
  }
  if (statusEl) statusEl.textContent = resp.enabled ? 'enabled' : 'paused';
  if (countEl) countEl.textContent = String(resp.blockedCount ?? 0);
});

export {};
