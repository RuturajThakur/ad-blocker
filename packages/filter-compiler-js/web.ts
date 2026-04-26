// Runtime entry (content script / service worker). Loaded in the extension
// to resolve cosmetic selectors for a given page hostname, using the bundle
// produced at build time by `node.ts` → `compile()`.
//
// Deliberately does NOT call into Wasm. The cosmetic matching we do in v1
// is naive hostname-suffix lookup over two small maps, and running that in
// plain JS is faster than paying the Wasm boundary cost (~0.1ms per call
// for this workload — most pages hit the generic-hide path only). If the
// matching logic grows into real-trie territory we'll move it back into the
// Rust crate and re-export it here.
//
// Why a facade at all if it's all JS? Two reasons:
//   1. The `CosmeticBundle` wire type is owned by `filter-compiler-js` — both
//      facades should import it from the same place. Keeping the bundle type
//      here means node.ts and web.ts agree by construction.
//   2. If we later swap this for a Wasm-backed matcher, nothing above us
//      changes. The content script already talks to a matcher interface.

import type { CosmeticBundle } from './node.js';

// Re-export the type so consumers that only depend on the /web entry can
// stay in-package instead of reaching across to /node. Cross-package
// imports would work but make the dependency graph noisier than necessary.
export type { CosmeticBundle };

// ---------------------------------------------------------------------------
// Public interface.
// ---------------------------------------------------------------------------

export interface CosmeticMatch {
  /** CSS selectors to hide on this page. Deduped, order-stable. */
  hide: string[];
}

export interface CosmeticMatcher {
  /**
   * Resolve the selectors to hide on `hostname`. The caller is expected to
   * pass the page's top-frame hostname; the matcher walks all suffixes
   * internally so `foo.bar.example.com` will match rules scoped to
   * `example.com`, `bar.example.com`, or `foo.bar.example.com`.
   */
  match(hostname: string): CosmeticMatch;
}

export interface CosmeticMatcherInit {
  bundle: CosmeticBundle;
}

// ---------------------------------------------------------------------------
// Hostname suffix walk — no PSL.
// ---------------------------------------------------------------------------

/**
 * Generate the hostname suffixes the matcher should look up, longest first.
 *
 * Example: `a.b.example.com` → [`a.b.example.com`, `b.example.com`,
 * `example.com`, `com`].
 *
 * We intentionally do NOT stop at the eTLD (e.g. `co.uk`) here — the filter
 * list author's rules are keyed against hostnames they wrote, and those
 * never target a bare TLD. Walking all the way down is cheap (handful of
 * map lookups) and keeps us from depending on a PSL table at runtime.
 *
 * Hostnames are lowercased on the caller's side (in `match`), so we don't
 * re-lowercase here.
 */
function hostnameSuffixes(hostname: string): string[] {
  if (!hostname) return [];
  const out: string[] = [hostname];
  let i = hostname.indexOf('.');
  while (i !== -1 && i < hostname.length - 1) {
    out.push(hostname.slice(i + 1));
    i = hostname.indexOf('.', i + 1);
  }
  return out;
}

/**
 * Collect selectors from a domain-keyed map for every suffix of `hostname`.
 * Returns a `Set` so callers can compose with set algebra (see `match`).
 */
function collectForHostname(
  map: Record<string, string[]>,
  hostname: string,
): Set<string> {
  const out = new Set<string>();
  for (const suffix of hostnameSuffixes(hostname)) {
    const selectors = map[suffix];
    if (!selectors) continue;
    for (const sel of selectors) out.add(sel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matcher factory.
// ---------------------------------------------------------------------------

/**
 * Create a cosmetic matcher bound to a compiled bundle.
 *
 * The matcher is intentionally stateless past construction — each `match`
 * call re-walks the suffixes. That keeps it safe to share across tabs and
 * avoids any per-hostname cache-invalidation concerns. With the bundles we
 * ship (tiny.txt today, EasyList later) the hot path is dominated by the
 * generic-hide concat, which is independent of hostname and dedup'd at
 * build time — so the per-call cost is essentially the domain-map lookup.
 *
 * Async for forward-compatibility: when a future version of this matcher
 * backs onto Wasm, init will be async; keeping the signature async now
 * means we won't need to break callers later.
 */
export async function createCosmeticMatcher(
  init: CosmeticMatcherInit,
): Promise<CosmeticMatcher> {
  const { bundle } = init;
  // Snapshot generic_hide once — it's the same for every page. Copying it
  // also defends against a caller mutating the bundle after construction.
  const genericHide = [...bundle.generic_hide];
  const domainHide = bundle.domain_hide;
  const domainExceptions = bundle.domain_exceptions;

  return {
    match(hostname: string): CosmeticMatch {
      // Normalize once. Chrome gives us lowercase hostnames in practice,
      // but being defensive here costs nothing and the lower-case form is
      // what the build-time emitter stores keys as.
      const host = hostname.toLowerCase();

      // Start with everything the generic rules want to hide, plus anything
      // the per-domain hide map adds for this hostname (or any parent).
      const hide = new Set<string>(genericHide);
      for (const sel of collectForHostname(domainHide, host)) hide.add(sel);

      // `domain_exceptions` un-hides selectors the same hostname walk
      // would otherwise hide. EasyList uses this to exempt one site from
      // an otherwise-broad hide; the contract is "remove these selectors
      // from the hide set for this page". We don't distinguish exceptions
      // against generic vs. domain rules — the content script only cares
      // about the final hide set.
      for (const sel of collectForHostname(domainExceptions, host)) {
        hide.delete(sel);
      }

      // Order-stable output: preserve the bundle's build-time ordering
      // (generic_hide first, then domain_hide insertions in walk order).
      // The Set above is insertion-ordered in all engines we target.
      return { hide: [...hide] };
    },
  };
}
