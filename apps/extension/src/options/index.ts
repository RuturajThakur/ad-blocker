// Options page entry. Persists per-ruleset enable/disable state to
// chrome.storage.sync; the SW watches for storage changes and reconciles
// DNR's enabled set accordingly.
//
// We don't call `chrome.declarativeNetRequest.updateEnabledRulesets` from
// here directly because the SW already owns that reconciliation logic —
// having two writers would race when the user rapid-clicks checkboxes.

import { SOURCE_IDS } from '../shared/messages.js';

async function load() {
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

void load();

export {};
