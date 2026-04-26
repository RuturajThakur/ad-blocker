// Tests for the Node facade (`node.ts`). Runs the Wasm compiler end-to-end
// over the same `tiny.txt` fixture the Rust integration tests use, then
// asserts the JSON shape the TS types promise.
//
// Why re-test from the JS side when the Rust crate already has a pinned
// shape? Two reasons:
//   1. The facade is where we unify init + call + type narrowing. A silent
//      regression on any of those (e.g. wasm-pack target change, init-path
//      refactor) won't show up in the Rust tests but will break every JS
//      consumer.
//   2. `CompileReport` is the wire contract between Rust and TS. Locking it
//      in a vitest snapshot-style assertion means a field rename on the
//      Rust side can't silently land — one side or the other will fail.
//
// The fixture path is the Rust crate's own, intentionally. Copying the
// file into this package would mean two sources of truth.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { compile, type CompileReport } from './node.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TINY_PATH = resolve(HERE, '../filter-compiler-rs/tests/fixtures/tiny.txt');
const TINY = readFileSync(TINY_PATH, 'utf8');

describe('node facade / compile()', () => {
  let report: CompileReport;

  // Compile once for the whole suite. `compile` is pure, and the Wasm init
  // is memoized internally — separating the init from the per-test work
  // would just make failures harder to read.
  beforeAll(async () => {
    report = await compile(TINY);
  });

  it('returns a version string from the Rust crate', () => {
    // We don't pin a specific version (bumping Cargo.toml shouldn't churn
    // JS tests), just that the field exists and is non-empty.
    expect(typeof report.version).toBe('string');
    expect(report.version.length).toBeGreaterThan(0);
  });

  it('tallies token kinds the way the lexer does', () => {
    // These counts pin the fixture, not the lexer: 5 network, 2 network
    // exceptions, 8 cosmetic (4 supported + 4 unsupported dialects), 1
    // cosmetic exception, plus blanks/comments/headers. If tiny.txt is
    // edited, update these to match.
    expect(report.counts.network).toBe(5);
    expect(report.counts.network_exception).toBe(2);
    expect(report.counts.cosmetic).toBe(8);
    expect(report.counts.cosmetic_exception).toBe(1);
  });

  it('emits 7 DNR rules with monotonic IDs starting at 1', () => {
    // Same invariant dnr_integration.rs pins on the Rust side — we re-check
    // it here because the Wasm → JsValue round-trip has historically been
    // where off-by-one IDs creep in.
    expect(report.dnr_rules).toHaveLength(7);
    report.dnr_rules.forEach((rule, i) => {
      expect(rule.id).toBe(i + 1);
    });
  });

  it('populates the cosmetic bundle with the expected shape', () => {
    const b = report.cosmetic_bundle;
    expect(b.generic_hide).toEqual(['.ad-banner', 'div[id^="adslot-"]']);
    // Fan-out: example.com,sub.example.com##.sponsor-box writes under both.
    expect(b.domain_hide['example.com']).toEqual(['.sponsor-box']);
    expect(b.domain_hide['sub.example.com']).toEqual(['.sponsor-box']);
    expect(b.domain_hide['news.site']).toEqual(['aside.promo']);
    expect(b.domain_exceptions['example.com']).toEqual(['.sponsor-box']);
  });

  it('records exactly the 4 unsupported_cosmetic diagnostics', () => {
    // If this drifts, either the fixture changed or the emitter started
    // accepting a dialect it shouldn't. Either way: investigate.
    const cosmetic = report.diagnostics.filter(
      (d) => d.kind === 'unsupported_cosmetic',
    );
    expect(cosmetic).toHaveLength(4);
    const byLine = new Map(cosmetic.map((d) => [d.line, d.message] as const));
    expect(byLine.get(26)).toMatch(/extended-hide/);
    expect(byLine.get(29)).toMatch(/css-inject/);
    expect(byLine.get(30)).toMatch(/script-inject/);
    expect(byLine.get(31)).toMatch(/html-filter/);
  });

  it('returns a plain JSON object (no class instances across the boundary)', () => {
    // Build scripts will `JSON.stringify(report)` to disk. If the Wasm
    // binding ever swapped to returning a class with methods, this round
    // trip would drop data silently.
    const roundtripped = JSON.parse(JSON.stringify(report)) as CompileReport;
    expect(roundtripped.dnr_rules).toHaveLength(report.dnr_rules.length);
    expect(roundtripped.cosmetic_bundle.generic_hide).toEqual(
      report.cosmetic_bundle.generic_hide,
    );
  });

  it('is safe to call concurrently (init is memoized)', async () => {
    // Build scripts compile many lists in parallel. Kicking off N compiles
    // at once must not race the init or return corrupt reports.
    const reports = await Promise.all([
      compile(TINY),
      compile(TINY),
      compile(TINY),
    ]);
    for (const r of reports) {
      expect(r.dnr_rules).toHaveLength(7);
      expect(r.cosmetic_bundle.generic_hide).toHaveLength(2);
    }
  });

  it('handles an empty input without throwing', () => {
    // Edge case worth pinning: an empty filter list (user disabled all
    // lists in the popup) should produce an empty-but-shaped report.
    return compile('').then((r) => {
      expect(r.dnr_rules).toEqual([]);
      expect(r.diagnostics).toEqual([]);
      expect(r.cosmetic_bundle.generic_hide).toEqual([]);
      expect(r.cosmetic_bundle.domain_hide).toEqual({});
      expect(r.cosmetic_bundle.domain_exceptions).toEqual({});
    });
  });
});
