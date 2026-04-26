// Tests for the web facade (`web.ts`). Exercises the pure-JS cosmetic
// matcher directly over a hand-built bundle. We don't route these through
// the Wasm compiler because the matcher's contract is with the bundle
// shape, not with what any particular filter list happens to produce —
// mixing in compilation would make failures ambiguous ("did the matcher
// break, or did the bundle change?").

import { describe, it, expect } from 'vitest';

import { createCosmeticMatcher, type CosmeticBundle } from './web.js';

/**
 * Helper to build bundles for individual test cases. Full literals inline
 * would bury the assertion under boilerplate; this keeps each test's
 * intent visible at a glance.
 */
function bundle(
  parts: Partial<CosmeticBundle>,
): CosmeticBundle {
  return {
    generic_hide: parts.generic_hide ?? [],
    domain_hide: parts.domain_hide ?? {},
    domain_exceptions: parts.domain_exceptions ?? {},
  };
}

describe('web facade / createCosmeticMatcher()', () => {
  it('returns only generic_hide when no domain rules match', async () => {
    const m = await createCosmeticMatcher({
      bundle: bundle({ generic_hide: ['.ad', '.banner'] }),
    });
    expect(m.match('unrelated.test').hide).toEqual(['.ad', '.banner']);
  });

  it('adds domain_hide entries for an exact hostname match', async () => {
    const m = await createCosmeticMatcher({
      bundle: bundle({
        generic_hide: ['.ad'],
        domain_hide: { 'example.com': ['.sponsor'] },
      }),
    });
    const hide = m.match('example.com').hide;
    expect(hide).toContain('.ad');
    expect(hide).toContain('.sponsor');
  });

  it('matches a parent hostname for subdomains (suffix walk)', async () => {
    // `.sponsor` is scoped to example.com — it should apply on
    // `foo.bar.example.com` too, which is the whole point of the walk.
    const m = await createCosmeticMatcher({
      bundle: bundle({ domain_hide: { 'example.com': ['.sponsor'] } }),
    });
    expect(m.match('foo.bar.example.com').hide).toEqual(['.sponsor']);
  });

  it('does not match a cousin domain by prefix', async () => {
    // `example.com.attacker.com` must NOT match a rule keyed to
    // `example.com`. The walk is suffix-only; we rely on `.` boundaries
    // because we slice at dot positions rather than doing substring
    // checks.
    const m = await createCosmeticMatcher({
      bundle: bundle({ domain_hide: { 'example.com': ['.sponsor'] } }),
    });
    expect(m.match('example.com.attacker.com').hide).toEqual([]);
  });

  it('removes selectors present in domain_exceptions for the same host', async () => {
    // Classic EasyList shape — hide a class globally, then un-hide it on
    // one site that legitimately uses the class for non-ads.
    const m = await createCosmeticMatcher({
      bundle: bundle({
        generic_hide: ['.promo'],
        domain_exceptions: { 'example.com': ['.promo'] },
      }),
    });
    expect(m.match('example.com').hide).toEqual([]);
    // But still hides on other hosts.
    expect(m.match('elsewhere.test').hide).toEqual(['.promo']);
  });

  it('domain_exceptions walks suffixes just like domain_hide', async () => {
    const m = await createCosmeticMatcher({
      bundle: bundle({
        generic_hide: ['.promo'],
        domain_exceptions: { 'example.com': ['.promo'] },
      }),
    });
    expect(m.match('news.example.com').hide).toEqual([]);
  });

  it('deduplicates selectors across generic + domain additions', async () => {
    // A selector can appear in both generic_hide and a domain_hide entry
    // (e.g. `##.ad` followed by `example.com##.ad`). The matcher uses a
    // Set, so the output must not repeat it.
    const m = await createCosmeticMatcher({
      bundle: bundle({
        generic_hide: ['.ad'],
        domain_hide: { 'example.com': ['.ad', '.other'] },
      }),
    });
    const hide = m.match('example.com').hide;
    expect(hide).toEqual(['.ad', '.other']);
  });

  it('lowercases the input hostname', async () => {
    // Bundle keys are lowercase (the Rust emitter normalizes). Chrome
    // gives us lowercase hostnames in practice, but handling mixed case
    // defensively costs nothing and avoids a class of silent misses.
    const m = await createCosmeticMatcher({
      bundle: bundle({ domain_hide: { 'example.com': ['.x'] } }),
    });
    expect(m.match('EXAMPLE.com').hide).toEqual(['.x']);
  });

  it('returns an empty array for an empty hostname', async () => {
    // Chrome passes an empty hostname for `about:blank` and similar.
    // We should match nothing — not even generic rules — because there's
    // no real document to style, and most callers skip rendering anyway.
    // Actually — callers DO want generic rules on any real page, so the
    // behavior we pin is: return generic rules only. Empty `hostname`
    // just means "no domain-scoped additions".
    const m = await createCosmeticMatcher({
      bundle: bundle({
        generic_hide: ['.ad'],
        domain_hide: { 'example.com': ['.x'] },
      }),
    });
    expect(m.match('').hide).toEqual(['.ad']);
  });

  it('is safe to call many times (no per-call state)', async () => {
    const m = await createCosmeticMatcher({
      bundle: bundle({ generic_hide: ['.ad'] }),
    });
    for (let i = 0; i < 100; i++) {
      expect(m.match('example.com').hide).toEqual(['.ad']);
    }
  });

  it('does not leak through bundle mutation after construction', async () => {
    // A caller holding the bundle shouldn't be able to retroactively add
    // rules by pushing to the array. Defensive copy of generic_hide is
    // the relevant guard.
    const b = bundle({ generic_hide: ['.ad'] });
    const m = await createCosmeticMatcher({ bundle: b });
    b.generic_hide.push('.injected');
    expect(m.match('example.com').hide).toEqual(['.ad']);
  });
});
