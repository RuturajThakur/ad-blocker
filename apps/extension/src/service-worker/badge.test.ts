// Unit coverage for the badge formatter. The chrome.* surface is mocked
// out at the integration level (manual smoke test); here we just pin the
// pure formatting contract so a future refactor (different cap, different
// "n+" suffix) has to satisfy the same shape.

import { describe, expect, it } from 'vitest';

import { formatBadgeCount } from './badge.js';

describe('formatBadgeCount()', () => {
  it('renders empty string for zero or negative counts', () => {
    // Empty rather than "0" because the badge is an activity signal —
    // showing "0" on a quiet site is just visual noise.
    expect(formatBadgeCount(0)).toBe('');
    expect(formatBadgeCount(-1)).toBe('');
    expect(formatBadgeCount(-9999)).toBe('');
  });

  it('renders the raw count for 1..99', () => {
    expect(formatBadgeCount(1)).toBe('1');
    expect(formatBadgeCount(9)).toBe('9');
    expect(formatBadgeCount(42)).toBe('42');
    expect(formatBadgeCount(99)).toBe('99');
  });

  it('caps at "99+" for any count above 99', () => {
    // The badge has limited horizontal real estate; the popup carries the
    // full number for users who want it. Cap chosen at 3 chars so a small
    // toolbar icon stays legible.
    expect(formatBadgeCount(100)).toBe('99+');
    expect(formatBadgeCount(500)).toBe('99+');
    expect(formatBadgeCount(99_999)).toBe('99+');
  });

  it('handles non-finite inputs defensively', () => {
    // The chrome API never returns these, but the formatter is a pure
    // helper that should not panic on garbage — guarding NaN / Infinity
    // here means callers don't have to.
    expect(formatBadgeCount(Number.NaN)).toBe('');
    expect(formatBadgeCount(Number.POSITIVE_INFINITY)).toBe('');
    expect(formatBadgeCount(Number.NEGATIVE_INFINITY)).toBe('');
  });
});
