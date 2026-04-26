// Content script — injected at document_start into every frame.
//
// Goal: apply cosmetic (element-hide) rules before the page paints. We do
// this by fetching the per-source cosmetic bundles (web-accessible JSONs
// produced at build time by scripts/build-rulesets.ts), merging the
// bundles for sources the user has enabled, resolving the selectors for
// this frame's hostname, and injecting a single <style> tag that hides
// them.
//
// Why per-source bundles (slice 5.2)? Each source (EasyList, EasyPrivacy,
// EasyList-Cookie, EasyList-Annoyances) is independently toggleable in
// the options page. With one merged build-time bundle we'd hide selectors
// from a list the user disabled — DNR would stop blocking the network
// requests but the CSS would keep hiding elements. Splitting the bundles
// closes that gap: enabled-sources determine both DNR and cosmetic shape.
//
// Why no SW round-trip? Each bundle is reachable as a static asset via
// `chrome.runtime.getURL`. Going through the SW would be one more wake-up
// per page load for zero added value — the bundles are already fetchable
// by any content script, and the matching logic is pure JS.
//
// Why no MutationObserver? Content scripts are single-page instances;
// navigation creates a new instance with the new hostname. Dynamic changes
// to hostname within one page (history.pushState etc.) don't affect what
// cosmetic rules apply — the eTLD+1 policy was set by the top-frame load.
// A polling observer would add cost without adding blocking power.
//
// Pause-on-host (slice 5.0): we read `pausedHosts` directly from
// `chrome.storage.local`. Going through the SW would force a wake-up on
// every navigation, defeating the no-round-trip design. The check is
// async, so there's a brief window between document_start and the
// storage callback during which a paused page is still "blocking" — but
// since the cosmetic injection is also gated on that same callback, no
// styles are inserted in the meantime. The DNR side is paused via a
// session rule unconditionally, so network requests are already flowing.

import { mergeAllBundles } from '../shared/cosmetic-merge.js';
import { etldPlusOne } from '../shared/etld.js';
import {
  PAUSED_HOSTS_KEY,
  SOURCE_DEFAULTS,
  SOURCE_IDS,
  type SourceId,
} from '../shared/messages.js';
import {
  createCosmeticMatcher,
  type CosmeticBundle,
} from '@ad-blocker/filter-compiler-js/web';

/** Build the URL for a single source's bundle. The build script writes
 *  one of these per source under `assets/cosmetic-{id}.json`. */
function bundleUrl(sourceId: SourceId): string {
  return chrome.runtime.getURL(`assets/cosmetic-${sourceId}.json`);
}

/**
 * Check whether this frame's eTLD+1 is in the user's paused list. Returns
 * `false` defensively on any storage error — the DNR layer is the
 * authoritative pause signal; a missing cosmetic suppression is a soft
 * failure, not a privacy/correctness one.
 */
async function isHostPaused(): Promise<boolean> {
  const host = etldPlusOne(location.hostname);
  if (!host) return false;
  try {
    const stored = await chrome.storage.local.get([PAUSED_HOSTS_KEY]);
    const list = stored[PAUSED_HOSTS_KEY];
    if (!Array.isArray(list)) return false;
    return list.includes(host);
  } catch (err) {
    console.debug('[cs] pause check failed', err);
    return false;
  }
}

/**
 * Read which sources the user has enabled from chrome.storage.sync,
 * falling back to `SOURCE_DEFAULTS` for keys without a stored value. The
 * SW uses the exact same fallback policy in its `readSourcePrefs` —
 * keeping both readers consulting one source-of-truth map (`SOURCE_DEFAULTS`)
 * is what guarantees the CS and DNR sides agree on which lists are "on".
 */
async function readEnabledSources(): Promise<SourceId[]> {
  try {
    const stored = await chrome.storage.sync.get([...SOURCE_IDS]);
    return SOURCE_IDS.filter((id) =>
      typeof stored[id] === 'boolean'
        ? (stored[id] as boolean)
        : SOURCE_DEFAULTS[id],
    );
  } catch (err) {
    console.debug('[cs] enabled-sources read failed; falling back to defaults', err);
    return SOURCE_IDS.filter((id) => SOURCE_DEFAULTS[id]);
  }
}

/**
 * Fetch one source's cosmetic bundle. Returns `null` if the asset is
 * missing or malformed — caller filters out nulls before merging. We log
 * at warn-level on failure because a missing per-source asset is a
 * build-time problem (the build script must have failed for that source),
 * not a runtime one — the network-side DNR rules for that source are
 * independent and remain active.
 */
async function fetchBundle(sourceId: SourceId): Promise<CosmeticBundle | null> {
  try {
    const res = await fetch(bundleUrl(sourceId));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as CosmeticBundle;
  } catch (err) {
    console.warn(`[cs] cosmetic bundle unavailable for ${sourceId}`, err);
    return null;
  }
}

/**
 * Resolve selectors for this frame's hostname and inject them as a CSS
 * `display: none !important` block. Wrapped in an async IIFE so we can
 * await without relying on top-level await (which content scripts still
 * don't universally support, depending on the crxjs wrapping mode).
 */
(async () => {
  // Pause check first — if the user has paused this site, we want to
  // skip the bundle fetches entirely. Saves N round-trips and keeps
  // paused sites visually pristine.
  if (await isHostPaused()) {
    console.debug('[cs] cosmetic injection skipped (host paused)');
    return;
  }

  const enabled = await readEnabledSources();
  if (enabled.length === 0) {
    // Every source disabled. No cosmetic work to do. The DNR side is
    // similarly empty in this case (SW reconciles to zero enabled
    // chunks), so the page sees the extension as "off" overall.
    return;
  }

  // Fetch enabled-source bundles in parallel — we want the page to start
  // painting as quickly as possible, and serial fetches would compound
  // each list's network round-trip into the critical path.
  const fetched = await Promise.all(enabled.map(fetchBundle));
  const bundles = fetched.filter((b): b is CosmeticBundle => b !== null);
  if (bundles.length === 0) {
    // All bundle fetches failed — extremely unlikely in practice
    // (chrome-extension:// is local) but bail rather than crash.
    return;
  }

  const merged = mergeAllBundles(bundles);
  const matcher = await createCosmeticMatcher({ bundle: merged });
  const { hide } = matcher.match(location.hostname);
  if (hide.length === 0) return;

  injectHideStyle(hide);
})();

/**
 * Build and inject a single <style> tag that hides all matched selectors.
 *
 * The selector list is joined into one CSS rule rather than one-per-rule
 * because the browser's selector matcher is very efficient at a single
 * multi-comma rule, and it halves the DOM nodes we insert.
 *
 * We use `display: none !important` rather than `visibility: hidden`
 * because hidden elements can still occupy layout space, and any
 * author-level CSS that also sets `display` would win without the
 * `!important` qualifier. `!important` is justified here: the whole point
 * of a filter-list rule is to override whatever the page would normally do.
 */
function injectHideStyle(selectors: string[]): void {
  // document_start means <head> may not exist yet. Fall back to
  // documentElement — both <html> and <head> accept <style> children.
  const host = document.head ?? document.documentElement;
  if (!host) {
    // Document isn't even partially constructed yet. This is rare at
    // document_start but possible in the moment before <html> is created.
    // Retry once the DOM is ready enough to host our node.
    document.addEventListener(
      'readystatechange',
      () => injectHideStyle(selectors),
      { once: true },
    );
    return;
  }
  const style = document.createElement('style');
  // `data-*` attribute for traceability — useful when debugging a page
  // where a user reports "my content disappeared". Grep-able in devtools.
  style.setAttribute('data-ad-blocker', 'cosmetic');
  style.textContent = `${selectors.join(',\n')} { display: none !important; }`;
  host.appendChild(style);
}

export {};
