// Unit tests for the cosmetic-bundle merge helpers.
//
// This module is the runtime bridge between "per-source bundles on disk"
// (slice 5.2) and "one matcher in the content script". The build script
// emits one cosmetic JSON per source; the content script fetches the
// bundles for currently-enabled sources and merges them in-memory before
// running the matcher. So if these helpers are wrong, every page load
// for users with multiple lists enabled is wrong.
//
// We pin the three things that would silently break in a refactor:
//   1. Dedup behavior (no double selectors when two lists share rules).
//   2. Sort-stable output for byte-determinism.
//   3. EMPTY_BUNDLE is a safe seed value (immutable, no shared state).

import { describe, expect, it } from 'vitest';

import { EMPTY_BUNDLE, mergeAllBundles, mergeBundles } from './cosmetic-merge.js';

import type { CosmeticBundle } from '@ad-blocker/filter-compiler-js/web';

/** Shorthand bundle constructor — fills in any unsupplied fields. */
function bundle(parts: Partial<CosmeticBundle>): CosmeticBundle {
  return {
    generic_hide: parts.generic_hide ?? [],
    domain_hide: parts.domain_hide ?? {},
    domain_exceptions: parts.domain_exceptions ?? {},
  };
}

describe('mergeBundles()', () => {
  it('dedupes generic_hide selectors while preserving first-occurrence order', () => {
    const a = bundle({ generic_hide: ['.ad', '.banner', '.sponsor'] });
    const b = bundle({ generic_hide: ['.banner', '.popup'] });
    expect(mergeBundles(a, b).generic_hide).toEqual([
      '.ad',
      '.banner',
      '.sponsor',
      '.popup',
    ]);
  });

  it('unions domain_hide maps and dedupes selectors per host', () => {
    const a = bundle({
      domain_hide: { 'example.com': ['.x', '.y'], 'foo.com': ['.f'] },
    });
    const b = bundle({
      domain_hide: { 'example.com': ['.y', '.z'], 'bar.com': ['.b'] },
    });
    const merged = mergeBundles(a, b);
    expect(merged.domain_hide['example.com']).toEqual(['.x', '.y', '.z']);
    expect(merged.domain_hide['foo.com']).toEqual(['.f']);
    expect(merged.domain_hide['bar.com']).toEqual(['.b']);
  });

  it('unions domain_exceptions the same way as domain_hide', () => {
    const a = bundle({ domain_exceptions: { 'site.com': ['.allow'] } });
    const b = bundle({ domain_exceptions: { 'site.com': ['.allow', '.also'] } });
    expect(mergeBundles(a, b).domain_exceptions['site.com']).toEqual([
      '.allow',
      '.also',
    ]);
  });

  it('emits domain-keyed maps in sorted key order (byte-determinism)', () => {
    // Insertion order would otherwise leak into the JSON output, making
    // builds non-reproducible across runs / merge orderings.
    const a = bundle({ domain_hide: { 'zeta.com': ['.z'], 'alpha.com': ['.a'] } });
    const b = bundle({ domain_hide: { 'mike.com': ['.m'] } });
    const merged = mergeBundles(a, b);
    expect(Object.keys(merged.domain_hide)).toEqual([
      'alpha.com',
      'mike.com',
      'zeta.com',
    ]);
  });

  it('does not mutate either input', () => {
    const a = bundle({ generic_hide: ['.a'], domain_hide: { 's.com': ['.x'] } });
    const b = bundle({ generic_hide: ['.b'], domain_hide: { 's.com': ['.y'] } });
    const aBefore = JSON.parse(JSON.stringify(a));
    const bBefore = JSON.parse(JSON.stringify(b));
    mergeBundles(a, b);
    expect(a).toEqual(aBefore);
    expect(b).toEqual(bBefore);
  });
});

describe('mergeAllBundles()', () => {
  it('returns an empty bundle when given no inputs (the "all sources off" case)', () => {
    const out = mergeAllBundles([]);
    expect(out.generic_hide).toEqual([]);
    expect(out.domain_hide).toEqual({});
    expect(out.domain_exceptions).toEqual({});
  });

  it('returns content equivalent to the single input when given just one bundle', () => {
    const only = bundle({
      generic_hide: ['.a', '.b'],
      domain_hide: { 'x.com': ['.x'] },
    });
    const out = mergeAllBundles([only]);
    expect(out.generic_hide).toEqual(['.a', '.b']);
    expect(out.domain_hide).toEqual({ 'x.com': ['.x'] });
  });

  it('reduces N bundles in declaration order, deduping cumulatively', () => {
    // EasyList + EasyPrivacy + EasyList-Cookie all carry `.ad-banner`
    // (in real life). With three sources enabled we still want one copy.
    const easylist = bundle({ generic_hide: ['.ad-banner', '.ad-slot'] });
    const easyprivacy = bundle({ generic_hide: ['.ad-banner', '.tracker'] });
    const cookie = bundle({ generic_hide: ['.ad-banner', '.cookie-wall'] });
    expect(mergeAllBundles([easylist, easyprivacy, cookie]).generic_hide).toEqual(
      ['.ad-banner', '.ad-slot', '.tracker', '.cookie-wall'],
    );
  });

  it('does not share state across calls (defensive against a frozen-seed regression)', () => {
    // If the implementation ever started mutating EMPTY_BUNDLE as the
    // accumulator (instead of cloning), the second call would see leftovers
    // from the first. Guard against that.
    const first = mergeAllBundles([bundle({ generic_hide: ['.first'] })]);
    const second = mergeAllBundles([bundle({ generic_hide: ['.second'] })]);
    expect(first.generic_hide).toEqual(['.first']);
    expect(second.generic_hide).toEqual(['.second']);
  });
});

describe('EMPTY_BUNDLE', () => {
  it('is frozen so an accidental mutation throws under strict mode', () => {
    expect(Object.isFrozen(EMPTY_BUNDLE)).toBe(true);
  });

  it('has the correct empty shape', () => {
    expect(EMPTY_BUNDLE.generic_hide).toEqual([]);
    expect(EMPTY_BUNDLE.domain_hide).toEqual({});
    expect(EMPTY_BUNDLE.domain_exceptions).toEqual({});
  });
});
