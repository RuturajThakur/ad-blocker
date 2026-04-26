// Cosmetic-bundle merge helpers.
//
// Two callers share this code:
//   - The build script, when emitting per-source cosmetic-{source}.json
//     files (it doesn't merge across sources anymore — kept here for
//     symmetry / future reuse and so the content-side has a tested helper).
//   - The content script, which fetches each enabled source's bundle at
//     document_start and merges them in-memory before running the matcher.
//
// Why duplicate-aware merge: real filter lists share many selectors —
// `##.ad-banner` shows up in EasyList, EasyPrivacy, and EasyList Cookie all
// at once. Without dedup, a user with all four lists enabled would see the
// same selector four times in the injected <style> block. Browser CSS
// matchers handle that fine but the bytes are wasted, and DevTools-side
// debugging gets cluttered.

import type { CosmeticBundle } from '@ad-blocker/filter-compiler-js/web';

/**
 * Empty bundle. Useful as the seed when reducing over a (possibly empty)
 * array of source bundles.
 */
export const EMPTY_BUNDLE: CosmeticBundle = Object.freeze({
  generic_hide: [],
  domain_hide: {},
  domain_exceptions: {},
}) as CosmeticBundle;

/**
 * Merge two cosmetic bundles into a new one. Pure — does not mutate inputs.
 *
 * Merge policy:
 *   - `generic_hide`: concat, dedup, preserve first-occurrence order.
 *   - `domain_hide`, `domain_exceptions`: union the maps; for each shared
 *     hostname key, concat selector arrays and dedup.
 *
 * Sort order on the domain-keyed maps is stable (sorted alphabetically) so
 * that two callers merging the same inputs in any order produce
 * byte-identical bundles. Cheap form of build determinism.
 */
export function mergeBundles(
  a: CosmeticBundle,
  b: CosmeticBundle,
): CosmeticBundle {
  const mergeList = (xs: string[], ys: string[]): string[] => {
    const out = new Set<string>();
    for (const x of xs) out.add(x);
    for (const y of ys) out.add(y);
    return [...out];
  };

  const mergeMap = (
    ma: Record<string, string[]>,
    mb: Record<string, string[]>,
  ): Record<string, string[]> => {
    const keys = new Set<string>([...Object.keys(ma), ...Object.keys(mb)]);
    const out: Record<string, string[]> = {};
    for (const k of [...keys].sort()) {
      out[k] = mergeList(ma[k] ?? [], mb[k] ?? []);
    }
    return out;
  };

  return {
    generic_hide: mergeList(a.generic_hide, b.generic_hide),
    domain_hide: mergeMap(a.domain_hide, b.domain_hide),
    domain_exceptions: mergeMap(a.domain_exceptions, b.domain_exceptions),
  };
}

/**
 * Merge an arbitrary list of bundles into one. Returns an empty bundle if
 * the input list is empty — equivalent to "no enabled sources".
 */
export function mergeAllBundles(bundles: CosmeticBundle[]): CosmeticBundle {
  return bundles.reduce(mergeBundles, structuredClone(EMPTY_BUNDLE));
}
