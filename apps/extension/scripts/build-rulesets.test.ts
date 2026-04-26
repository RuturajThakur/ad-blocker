// Tests for the ruleset build script.
//
// We test three layers:
//   1. The pure `chunkRules` helper, which is where the 4b.4 correctness
//      risk lives. Chunk boundaries, empty trailing chunks, and overflow
//      detection are all easier to reason about in isolation than through
//      the full compile pipeline.
//   2. The `summarize` helper, with hand-built reports. Pins the per-chunk
//      accounting shape (fillPercent, diagnosticsByKind, per-source
//      cosmetic counts) so a future refactor can't silently regress CI's
//      visibility.
//   3. An end-to-end run of `buildRulesets` against the in-tree tiny
//      fixture (NOT the vendored real lists — those require a separate
//      fetch step and would make the test suite network-dependent).
//      Confirms the chunk output layout, the trailing empty chunks, and
//      the per-source `cosmetic-<id>.json` emission introduced in 5.2.

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import {
  buildRulesets,
  chunkRules,
  summarize,
  type BuildSummary,
  type ChunkOutput,
} from './build-rulesets.js';
import type {
  CompileReport,
  CosmeticBundle,
  DnrRule,
} from '@ad-blocker/filter-compiler-js/node';
import { CHUNKS_PER_SOURCE, type SourceId } from '../src/shared/messages.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, '..');

/** Tiny helper — ergonomic CompileReport for merge/summarize tests. */
function report(
  id: SourceId,
  bundle: Partial<CosmeticBundle>,
): { id: SourceId; source: string; report: CompileReport } {
  return {
    id,
    source: `fixtures/${id}.txt`,
    report: {
      version: '0.0.0-test',
      counts: {
        blank: 0,
        comment: 0,
        header: 0,
        network: 0,
        network_exception: 0,
        cosmetic: 0,
        cosmetic_exception: 0,
      },
      dnr_rules: [],
      diagnostics: [],
      cosmetic_bundle: {
        generic_hide: bundle.generic_hide ?? [],
        domain_hide: bundle.domain_hide ?? {},
        domain_exceptions: bundle.domain_exceptions ?? {},
      },
    },
  };
}

/** Build N placeholder DNR rules for chunking tests. Shape-only — the
 *  chunker doesn't inspect the rule contents. */
function fakeRules(n: number): DnrRule[] {
  const out: DnrRule[] = [];
  for (let i = 1; i <= n; i++) {
    out.push({ id: i, priority: 1, action: {}, condition: {} });
  }
  return out;
}

// ---------------------------------------------------------------------------
// chunkRules()
// ---------------------------------------------------------------------------

describe('chunkRules()', () => {
  it('splits rules across chunks in declaration order, preserving rule ids', () => {
    const rules = fakeRules(7);
    const chunks = chunkRules('easylist', rules, 3, 3);
    expect(chunks.map((c) => c.id)).toEqual([
      'easylist-1',
      'easylist-2',
      'easylist-3',
    ]);
    // First two chunks filled to capacity; third picks up the remainder.
    expect(chunks[0]!.rules.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(chunks[1]!.rules.map((r) => r.id)).toEqual([4, 5, 6]);
    expect(chunks[2]!.rules.map((r) => r.id)).toEqual([7]);
  });

  it('pads trailing chunks with empty arrays when rule count < capacity', () => {
    const rules = fakeRules(2);
    const chunks = chunkRules('easylist', rules, 3, 3);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.rules).toHaveLength(2);
    expect(chunks[1]!.rules).toEqual([]);
    expect(chunks[2]!.rules).toEqual([]);
  });

  it('throws a precise error when rule count exceeds capacity', () => {
    const rules = fakeRules(10);
    expect(() => chunkRules('easylist', rules, 3, 3)).toThrowError(
      /10 DNR rules exceeds the 3-chunk × 3-rule budget \(9\)/,
    );
  });

  it('produces no chunks when maxChunks is zero (edge case)', () => {
    expect(chunkRules('easylist', [], 3, 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// summarize()
// ---------------------------------------------------------------------------

describe('summarize()', () => {
  it('captures per-source rule/diagnostic counts and per-chunk fill', () => {
    const compiled = [
      {
        ...report('easylist', {}),
        report: {
          ...report('easylist', {}).report,
          dnr_rules: fakeRules(4),
          diagnostics: [
            { line: 10, kind: 'unsupported_option', message: 'x' },
            { line: 20, kind: 'unknown_option', message: 'y' },
            { line: 30, kind: 'unsupported_option', message: 'z' },
          ],
        },
      },
    ];
    const chunks: ChunkOutput[] = [
      {
        id: 'easylist-1',
        sourceId: 'easylist',
        chunkIndex: 0,
        rules: fakeRules(3),
      },
      {
        id: 'easylist-2',
        sourceId: 'easylist',
        chunkIndex: 1,
        rules: fakeRules(1),
      },
      { id: 'easylist-3', sourceId: 'easylist', chunkIndex: 2, rules: [] },
    ];
    const chunksBySource = new Map<SourceId, ChunkOutput[]>();
    chunksBySource.set('easylist', chunks);

    const s = summarize(
      compiled,
      chunksBySource,
      10, // chunkSize used only for fillPercent
    );

    expect(s.sources).toHaveLength(1);
    expect(s.sources[0]!.ruleCount).toBe(4);
    expect(s.sources[0]!.diagnosticCount).toBe(3);
    expect(s.sources[0]!.diagnosticsByKind).toEqual({
      unsupported_option: 2,
      unknown_option: 1,
    });
    expect(s.sources[0]!.chunks).toEqual([
      { id: 'easylist-1', ruleCount: 3, fillPercent: 30 },
      { id: 'easylist-2', ruleCount: 1, fillPercent: 10 },
      { id: 'easylist-3', ruleCount: 0, fillPercent: 0 },
    ]);
  });

  it('captures per-source cosmetic-bundle sizes (no cross-source merge)', () => {
    // Each source carries its OWN bundle; the build no longer merges
    // across sources. We pin both sources independently to make sure a
    // future refactor doesn't accidentally start merging again.
    const compiled = [
      report('easylist', {
        generic_hide: ['.a', '.b', '.c'],
        domain_hide: { 'example.com': ['.x'], 'other.com': ['.y'] },
        domain_exceptions: { 'example.com': ['.z'] },
      }),
      report('easylist-cookie', {
        generic_hide: ['.cookie-banner'],
        domain_hide: {},
        domain_exceptions: {},
      }),
    ];
    const s = summarize(compiled, new Map(), 30_000);

    expect(s.sources).toHaveLength(2);
    expect(s.sources[0]!.id).toBe('easylist');
    expect(s.sources[0]!.cosmetic).toEqual({
      genericHideCount: 3,
      domainHideKeyCount: 2,
      domainExceptionKeyCount: 1,
    });
    expect(s.sources[1]!.id).toBe('easylist-cookie');
    expect(s.sources[1]!.cosmetic).toEqual({
      genericHideCount: 1,
      domainHideKeyCount: 0,
      domainExceptionKeyCount: 0,
    });
  });

  it('uses "unknown" for version when there are no entries', () => {
    const s = summarize([], new Map(), 30_000);
    expect(s.version).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// buildRulesets() end-to-end smoke (tiny fixture).
// ---------------------------------------------------------------------------

describe('buildRulesets() end-to-end', () => {
  // Use the small in-tree fixture — we don't want to make this suite
  // network-dependent by reaching into vendor/ (which may not even exist
  // on a fresh clone before `lists:fetch` has run). The fixture has very
  // few rules so every chunk except `-1` should come out empty.
  const TINY_SOURCES = [
    { id: 'easylist' as SourceId, source: 'fixtures/tiny.txt' },
    { id: 'easyprivacy' as SourceId, source: 'fixtures/tiny.txt' },
  ];

  const EASYLIST_1_PATH = join(EXT_ROOT, 'rulesets', 'easylist-1.json');
  const EASYLIST_2_PATH = join(EXT_ROOT, 'rulesets', 'easylist-2.json');
  const EASYLIST_3_PATH = join(EXT_ROOT, 'rulesets', 'easylist-3.json');
  const COSMETIC_EASYLIST_PATH = join(
    EXT_ROOT,
    'assets',
    'cosmetic-easylist.json',
  );
  const COSMETIC_EASYPRIVACY_PATH = join(
    EXT_ROOT,
    'assets',
    'cosmetic-easyprivacy.json',
  );
  const SUMMARY_PATH = join(EXT_ROOT, 'build-summary.json');

  it('writes one ruleset JSON per declared chunk, fills non-empty chunks first', async () => {
    const result = await buildRulesets(TINY_SOURCES);

    // One compile per source.
    expect(result.compiled).toHaveLength(2);
    expect(result.compiled.map((c) => c.id)).toEqual(['easylist', 'easyprivacy']);

    // CHUNKS_PER_SOURCE × 2 sources flat-written chunks.
    expect(result.chunks).toHaveLength(CHUNKS_PER_SOURCE * 2);
    expect(result.chunks.map((c) => c.id)).toEqual([
      'easylist-1',
      'easylist-2',
      'easylist-3',
      'easyprivacy-1',
      'easyprivacy-2',
      'easyprivacy-3',
    ]);

    // The tiny fixture produces only a handful of DNR rules, so they all
    // land in chunk 1 and the rest are empty arrays on disk.
    const chunk1 = JSON.parse(readFileSync(EASYLIST_1_PATH, 'utf8'));
    expect(Array.isArray(chunk1)).toBe(true);
    expect(chunk1.length).toBeGreaterThan(0);
    expect(chunk1[0]).toHaveProperty('id');
    expect(chunk1[0]).toHaveProperty('action');
    expect(chunk1[0]).toHaveProperty('condition');

    const chunk2 = JSON.parse(readFileSync(EASYLIST_2_PATH, 'utf8'));
    expect(chunk2).toEqual([]);
    const chunk3 = JSON.parse(readFileSync(EASYLIST_3_PATH, 'utf8'));
    expect(chunk3).toEqual([]);

    // Cosmetic bundles: one file per source. Both sources point at the
    // same fixture in this test, but each gets its OWN bundle file — the
    // build script no longer merges across sources (the content script
    // does that at runtime, gated on which sources the user has enabled).
    const easylistBundle = JSON.parse(
      readFileSync(COSMETIC_EASYLIST_PATH, 'utf8'),
    );
    expect(easylistBundle.generic_hide).toEqual([
      '.ad-banner',
      'div[id^="adslot-"]',
    ]);
    expect(easylistBundle.domain_hide['example.com']).toEqual(['.sponsor-box']);
    expect(easylistBundle.domain_exceptions['example.com']).toEqual([
      '.sponsor-box',
    ]);

    const easyprivacyBundle = JSON.parse(
      readFileSync(COSMETIC_EASYPRIVACY_PATH, 'utf8'),
    );
    // Both sources used the same fixture, so the easyprivacy bundle has
    // the same shape — but it's a separate file on disk, not a copy of
    // the easylist bundle reference.
    expect(easyprivacyBundle.generic_hide).toEqual([
      '.ad-banner',
      'div[id^="adslot-"]',
    ]);

    // The in-memory map mirrors what was written to disk.
    expect([...result.cosmeticBySource.keys()]).toEqual([
      'easylist',
      'easyprivacy',
    ]);
    expect(result.cosmeticBySource.get('easylist')!.generic_hide).toEqual(
      easylistBundle.generic_hide,
    );

    // Summary shape: per-source with chunk breakdown + per-source cosmetic.
    const summary = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8')) as BuildSummary;
    expect(summary.sources).toHaveLength(2);
    expect(summary.sources[0]!.chunks).toHaveLength(CHUNKS_PER_SOURCE);
    expect(summary.chunksPerSource).toBe(CHUNKS_PER_SOURCE);
    // First chunk should have rules, later chunks should be empty.
    expect(summary.sources[0]!.chunks[0]!.ruleCount).toBeGreaterThan(0);
    expect(summary.sources[0]!.chunks[1]!.ruleCount).toBe(0);
    expect(summary.sources[0]!.chunks[2]!.ruleCount).toBe(0);
    // Per-source cosmetic counts surface in the summary too.
    // The fixture has:
    //   - 2 generic hides (`.ad-banner`, `div[id^="adslot-"]`)
    //   - 3 domain-hide keys (example.com + sub.example.com + news.site)
    //   - 1 domain-exception key (example.com)
    expect(summary.sources[0]!.cosmetic.genericHideCount).toBe(2);
    expect(summary.sources[0]!.cosmetic.domainHideKeyCount).toBe(3);
    expect(summary.sources[0]!.cosmetic.domainExceptionKeyCount).toBe(1);
  });

  it('emits an independent bundle per source (no cross-source merge at build time)', async () => {
    // The build script intentionally does NOT dedupe across sources — that
    // happens at runtime in the content script, where it's user-config
    // dependent (only enabled sources are merged). This test pins that
    // contract so a future "optimization" doesn't quietly fold bundles
    // together at build time and break the per-source toggle behavior.
    const { cosmeticBySource } = await buildRulesets(TINY_SOURCES);
    expect(cosmeticBySource.size).toBe(2);
    const easylist = cosmeticBySource.get('easylist')!;
    const easyprivacy = cosmeticBySource.get('easyprivacy')!;
    // Same fixture → same content, but distinct objects (no shared ref).
    expect(easylist.generic_hide).toEqual(easyprivacy.generic_hide);
    expect(easylist).not.toBe(easyprivacy);
  });

  afterAll(() => {
    // Leave outputs in place — a later `pnpm build:rulesets` will refresh
    // them with the real vendor/ sources, and inspecting the generated
    // files is useful when debugging. Only clean up under CI.
    if (process.env.CI) {
      const paths = [
        EASYLIST_1_PATH,
        EASYLIST_2_PATH,
        EASYLIST_3_PATH,
        join(EXT_ROOT, 'rulesets', 'easyprivacy-1.json'),
        join(EXT_ROOT, 'rulesets', 'easyprivacy-2.json'),
        join(EXT_ROOT, 'rulesets', 'easyprivacy-3.json'),
        COSMETIC_EASYLIST_PATH,
        COSMETIC_EASYPRIVACY_PATH,
        SUMMARY_PATH,
      ];
      for (const p of paths) {
        if (existsSync(p)) rmSync(p, { force: true });
      }
    }
  });
});
