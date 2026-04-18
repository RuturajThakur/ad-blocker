// Options page entry. Persists to chrome.storage.sync (small prefs) and
// chrome.storage.local (larger per-profile state).

const ids = ['easylist', 'easyprivacy'] as const;

async function load() {
  const stored = await chrome.storage.sync.get(ids as unknown as string[]);
  for (const id of ids) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) continue;
    if (typeof stored[id] === 'boolean') el.checked = stored[id];
    el.addEventListener('change', () => {
      void chrome.storage.sync.set({ [id]: el.checked });
    });
  }
}

void load();

export {};
