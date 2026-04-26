// External companion to qa-test.html. Kept as a separate file because the
// extension's CSP forbids inline <script> execution. Lives under public/ so
// Vite copies it verbatim into dist/ on every build — emptyOutDir wipes
// dist/ first, then publicDir gets mirrored in.

document.getElementById('host').textContent = location.hostname || '(file://)';

// Defer one tick so the content script has a chance to inject its <style>.
setTimeout(() => {
  const style = document.querySelector('style[data-ad-blocker="cosmetic"]');
  const el = document.getElementById('style-count');
  if (!el) return;
  el.textContent = style
    ? `found — ${style.textContent.length} chars`
    : 'NOT FOUND (content script did not run or bundle fetch failed)';
}, 50);
