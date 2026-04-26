// Options page entry. Persists per-ruleset enable/disable state and the
// auto-refresh preference to `chrome.storage.sync`; the SW watches for
// storage changes and reconciles DNR + alarm state accordingly.
//
// We don't call `chrome.declarativeNetRequest.updateEnabledRulesets` from
// here directly because the SW already owns that reconciliation logic —
// having two writers would race when the user rapid-clicks checkboxes.
// Same principle for the alarm: the SW recreates / clears the alarm in
// response to the storage change.

import {
  AUTO_REFRESH_DEFAULT,
  AUTO_REFRESH_KEY,
  COSMETIC_LAST_REFRESHED_KEY,
  SOURCE_IDS,
} from '../shared/messages.js';

async function loadFilterListToggles(): Promise<void> {
  // Spread the readonly tuple because `chrome.storage.sync.get` wants
  // `string[]`. See sw/index.ts for the same pattern.
  //
  // Checkboxes are keyed by *source* id (`easylist`, `easyprivacy`), not
  // by the underlying chunk ids the manifest declares. The SW expands
  // source prefs into chunks when it reconciles with Chrome's DNR set.
  const stored = await chrome.storage.sync.get([...SOURCE_IDS]);
  for (const id of SOURCE_IDS) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) continue;
    // Default the checkbox to its HTML `checked` attribute when we have no
    // stored value — that way first-install users see both enabled (the
    // manifest default) without a flicker.
    if (typeof stored[id] === 'boolean') el.checked = stored[id] as boolean;
    el.addEventListener('change', () => {
      void chrome.storage.sync.set({ [id]: el.checked });
    });
  }
}

async function loadAutoRefreshToggle(): Promise<void> {
  const el = document.getElementById(
    AUTO_REFRESH_KEY,
  ) as HTMLInputElement | null;
  if (!el) return;
  const stored = await chrome.storage.sync.get([AUTO_REFRESH_KEY]);
  el.checked =
    typeof stored[AUTO_REFRESH_KEY] === 'boolean'
      ? (stored[AUTO_REFRESH_KEY] as boolean)
      : AUTO_REFRESH_DEFAULT;
  el.addEventListener('change', () => {
    void chrome.storage.sync.set({ [AUTO_REFRESH_KEY]: el.checked });
  });
}

/**
 * Render the most-recent successful refresh timestamp from storage. Hides
 * the line entirely on never-refreshed installs (no point reading
 * "Last refreshed: never" — the bundled lists ARE recent at install time).
 */
async function renderLastRefreshed(): Promise<void> {
  const el = document.getElementById('lastRefreshed') as HTMLElement | null;
  if (!el) return;
  const stored = await chrome.storage.local.get([COSMETIC_LAST_REFRESHED_KEY]);
  const iso = stored[COSMETIC_LAST_REFRESHED_KEY];
  if (typeof iso !== 'string') {
    el.textContent = '';
    return;
  }
  // Locale-aware rendering. The stored ISO is UTC; the user sees their
  // own zone — that's the format they expect from "last refreshed at" UI.
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) {
    // Storage somehow holds a non-ISO string. Don't crash; just hide.
    el.textContent = '';
    return;
  }
  el.textContent = `Last refreshed: ${ts.toLocaleString()}`;
}

void Promise.all([
  loadFilterListToggles(),
  loadAutoRefreshToggle(),
  renderLastRefreshed(),
]);

export {};
