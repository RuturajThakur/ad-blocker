// Coverage for the eTLD+1 wrapper. The wrapper itself is one line; the
// value of these tests is pinning the *behavior* of the boundary so a
// future swap (different tldts version, replacement library, hand-roll
// fallback) has to satisfy the same contract.

import { describe, expect, it } from 'vitest';

import { etldPlusOne } from './etld.js';

describe('etldPlusOne()', () => {
  it('strips www. and returns the apex domain', () => {
    expect(etldPlusOne('www.theguardian.com')).toBe('theguardian.com');
    expect(etldPlusOne('theguardian.com')).toBe('theguardian.com');
  });

  it('handles multi-segment public suffixes correctly', () => {
    // The whole reason we ship the full PSL — naive "last two segments"
    // would yield `.co.uk` for the next case, which would be catastrophic.
    // All examples below live in the ICANN section of the PSL so they
    // match under tldts's default mode (no allowPrivateDomains). Private-
    // section suffixes like `appspot.com` would need that flag — and we
    // deliberately don't pass it: a user pausing `foo.appspot.com` is
    // (correctly) pausing the whole appspot.com platform from their
    // perspective. The PSL's PRIVATE section is informational, not a
    // policy boundary we want to honor for ad-blocking pause scope.
    expect(etldPlusOne('news.guardian.co.uk')).toBe('guardian.co.uk');
    expect(etldPlusOne('shop.example.com.au')).toBe('example.com.au');
    expect(etldPlusOne('subsite.example.co.jp')).toBe('example.co.jp');
  });

  it('accepts full URLs, not just hostnames', () => {
    expect(etldPlusOne('https://www.theguardian.com/article/123')).toBe(
      'theguardian.com',
    );
    expect(etldPlusOne('http://news.guardian.co.uk/?q=1')).toBe('guardian.co.uk');
  });

  it('returns null for hostless or non-DNS inputs', () => {
    // Each of these would be a footgun if it returned anything truthy —
    // we'd persist a bogus key into pausedHosts and confuse the SW.
    expect(etldPlusOne('')).toBeNull();
    expect(etldPlusOne('localhost')).toBeNull();
    expect(etldPlusOne('192.168.1.1')).toBeNull();
    expect(etldPlusOne('::1')).toBeNull();
    expect(etldPlusOne('chrome://extensions')).toBeNull();
    expect(etldPlusOne('chrome-extension://abc/popup.html')).toBeNull();
    expect(etldPlusOne('about:blank')).toBeNull();
  });

  it('normalizes case', () => {
    // Hostnames are case-insensitive in DNS; storage keys derived from
    // them must be too, otherwise the user pausing `Example.com` from
    // one tab and visiting `example.com` from another sees the rule miss.
    expect(etldPlusOne('WWW.EXAMPLE.COM')).toBe('example.com');
  });
});
