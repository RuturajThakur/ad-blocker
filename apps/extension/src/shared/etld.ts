// eTLD+1 (registrable-domain) extraction.
//
// Used by the per-site pause toggle (slice 5.0). The pause feature stores
// hosts as eTLD+1 — `theguardian.com` rather than `www.theguardian.com` —
// so a single pause covers every subdomain a site hands out (`m.`, `news.`,
// `cdn.`, etc.). Anything narrower would force users to pause each
// subdomain separately, which is bad UX; anything broader (e.g. naive
// "last two segments") would mistakenly pause whole TLDs like `.co.uk`.
//
// We rely on `tldts` because correctness here requires the Public Suffix
// List, which has hundreds of multi-segment entries (`.co.uk`,
// `.com.au`, `.appspot.com`, ...) and ships a new release roughly monthly.
// Hand-rolling a partial table would be a correctness footgun. The full
// PSL adds ~30KB gzipped to the extension bundle — acceptable for getting
// the pause boundary right.
//
// Caller surface is intentionally tiny: one function. If callers ever
// need raw subdomain or TLD breakdown, add it here rather than scattering
// `tldts` imports across the codebase.

import { getDomain } from 'tldts';

/**
 * Return the registrable domain ("eTLD+1") for a hostname or URL string.
 *
 * Returns `null` for inputs that don't have one — including IP addresses
 * (`192.168.1.1`), `localhost`, and entries that aren't valid hosts at
 * all. Callers should handle `null` by falling back to a sensible default
 * (typically: don't pause, since we have no stable identity to key on).
 *
 * Examples:
 *   etldPlusOne('https://www.theguardian.com/article/123') → 'theguardian.com'
 *   etldPlusOne('news.guardian.co.uk') → 'guardian.co.uk'
 *   etldPlusOne('localhost') → null
 *   etldPlusOne('chrome://extensions') → null
 *   etldPlusOne('') → null
 */
export function etldPlusOne(hostOrUrl: string): string | null {
  if (!hostOrUrl) return null;
  // tldts accepts both bare hostnames and full URLs; we pass through and
  // let it normalize. `validHosts: ['http', 'https']` would be too strict
  // — file:// and chrome-extension:// are realistic inputs the caller may
  // hand us, and `getDomain` returns null for those naturally.
  return getDomain(hostOrUrl);
}
