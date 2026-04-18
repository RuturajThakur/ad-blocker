// Content script entry — injected at document_start into every frame.
// Goals at this stage:
//   1. Run as early as possible so cosmetic filtering can hide elements
//      before they paint.
//   2. Keep this file tiny; lazy-load the selector engine and Wasm runtime
//      only when the SW hands us a ruleset.
//   3. Never block the page. All work is async and best-effort.

(() => {
  // Stub: ask the SW for this tab's cosmetic rules.
  // Real implementation will:
  //   - resolve hostname + ancestor frames
  //   - receive compact selector trie
  //   - apply via a single <style> tag + MutationObserver
  chrome.runtime.sendMessage({ type: 'cs:request-cosmetics' }, (resp) => {
    if (chrome.runtime.lastError) {
      // SW not ready yet — retry on idle.
      return;
    }
    console.debug('[cs] cosmetics stub response', resp);
  });
})();

export {};
