// Ruleset build script. Run before `vite build`, or standalone via
// `pnpm -F @ad-blocker/extension build:rulesets`.
//
// Responsibilities:
//   1. For each configured filter list source, compile it into DNR rules,
//      split the resulting rule array across N fixed-size *chunks*, and
//      write one ruleset JSON per chunk to rulesets/<source>-<n>.json.
//      Chrome caps static rulesets at 30,000 rules each (the
//      `MAX_NUMBER_OF_STATIC_RULES_PER_RULESET` limit), and a real
//      EasyList has ~60k rules, so chunking is load-bearing — without it
//      the manifest fails to install.
//   2. Write *one cosmetic bundle per source* to assets/cosmetic-<source>.json.
//      The content script fetches only the bundles for currently-enabled
//      sources and merges them in-memory — that way disabling a source via
//      the options page suppresses both its DNR and its cosmetic rules in
//      one go. (Earlier builds emitted a single merged bundle, which left a
//      correctness gap: disabling EasyList-Annoyances stopped its network
//      rules but its CSS selectors kept hiding elements.)
//   3. Write a build-summary.json with per-source + per-chunk counts, for CI.
//   4. Log a human-readable summary to stderr.
//
// The chunk count (CHUNKS_PER_SOURCE) is declared in *both* this file and
// manifest.json. If a source ever exceeds `CHUNK_SIZE × CHUNKS_PER_SOURCE`
// rules, we fail the build with a message telling the maintainer to bump
// both. Silent overflow would either drop rules or violate the manifest
// schema — neither is acceptable.
//
// Why Node + TypeScript, not a cargo binary? The compiler itself is Rust,
// but the *build orchestration* — which lists to include, where outputs
// go, how to chunk — lives with the extension and is easier to iterate on
// in the same language the rest of the app is written in.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compile,
  type CompileReport,
  type CosmeticBundle,
  type DnrRule,
} from '@ad-blocker/filter-compiler-js/node';

import {
  CHUNKS_PER_SOURCE,
  chunkId,
  type SourceId,
} from '../src/shared/messages.js';

// ---------------------------------------------------------------------------
// Configuration.
// ---------------------------------------------------------------------------

/** One filter list source — maps 1:N to DNR rulesets via chunking. */
interface SourceEntry {
  /** User-facing id, also the storage-key / checkbox id in the options
   *  page. Must be a value in SOURCE_IDS to stay in sync with the SW. */
  id: SourceId;
  /** Path to the raw filter list, resolved relative to apps/extension/.
   *  Typically a `vendor/*.txt` fetched by scripts/fetch-lists.ts. */
  source: string;
}

/**
 * Default source config: real upstream lists. Requires
 * `pnpm -F @ad-blocker/extension lists:fetch` to have populated vendor/.
 * Tests pass a different config (see build-rulesets.test.ts) so they can
 * run against the tiny in-tree fixture without a network round-trip.
 */
const SOURCES: SourceEntry[] = [
  { id: 'easylist', source: 'vendor/easylist.txt' },
  { id: 'easyprivacy', source: 'vendor/easyprivacy.txt' },
  { id: 'easylist-cookie', source: 'vendor/easylist-cookie.txt' },
  { id: 'easylist-annoyances', source: 'vendor/easylist-annoyances.txt' },
];

/** Per-chunk DNR rule cap. Chrome enforces 30,000 as MAX_NUMBER_OF_STATIC
 *  _RULES_PER_RULESET; we mirror that number here so a chunk that hits the
 *  limit locally corresponds to a chunk that would just barely load at
 *  runtime. */
const CHUNK_SIZE = 30_000;

// ---------------------------------------------------------------------------
// Path layout.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, '..');
const RULESETS_DIR = join(EXT_ROOT, 'rulesets');
const ASSETS_DIR = join(EXT_ROOT, 'assets');
const SUMMARY_PATH = join(EXT_ROOT, 'build-summary.json');

// ---------------------------------------------------------------------------
// Compile step.
// ---------------------------------------------------------------------------

interface CompiledSource {
  id: SourceId;
  source: string;
  report: CompileReport;
}

async function compileSource(entry: SourceEntry): Promise<CompiledSource> {
  const sourcePath = resolve(EXT_ROOT, entry.source);
  if (!existsSync(sourcePath)) {
    // Error text is the developer's next action. Don't paraphrase the
    // command — the pnpm script name must match exactly.
    throw new Error(
      `${entry.id}: source file not found at ${entry.source}.\n` +
        `If this is a vendor/ path, run:\n` +
        `  pnpm -F @ad-blocker/extension lists:fetch`,
    );
  }
  const text = readFileSync(sourcePath, 'utf8');
  const report = await compile(text);
  return { id: entry.id, source: entry.source, report };
}

// ---------------------------------------------------------------------------
// Chunk step.
// ---------------------------------------------------------------------------

/** One DNR ruleset chunk about to be written to disk. */
export interface ChunkOutput {
  /** Stable chunk id, e.g. `easylist-1`. Matches a `rule_resources[].id`
   *  in manifest.json. */
  id: string;
  /** Source this chunk came from. */
  sourceId: SourceId;
  /** 0-based index within the source's chunk slot. */
  chunkIndex: number;
  /** The actual DNR rules. May be empty — trailing chunks under the
   *  headroom fill are written as `[]`. Chrome accepts empty rulesets. */
  rules: DnrRule[];
}

/**
 * Split a source's DNR rules into fixed-size chunks. Preserves rule order
 * and original rule ids (rule ids only have to be unique *within* a
 * ruleset, so restarting from 1 in each chunk would also be valid — we
 * keep the original numbering for easier traceability back to the
 * compiler's rule table).
 *
 * Fails loudly if the rule count exceeds `chunkSize × maxChunks` rather
 * than silently dropping rules.
 */
export function chunkRules(
  sourceId: SourceId,
  rules: DnrRule[],
  chunkSize: number,
  maxChunks: number,
): ChunkOutput[] {
  const capacity = chunkSize * maxChunks;
  if (rules.length > capacity) {
    // Compose the message so the maintainer knows exactly what to edit.
    const nf = new Intl.NumberFormat('en-US');
    throw new Error(
      `${sourceId}: ${nf.format(rules.length)} DNR rules exceeds the ` +
        `${nf.format(maxChunks)}-chunk × ${nf.format(chunkSize)}-rule ` +
        `budget (${nf.format(capacity)}). Bump CHUNKS_PER_SOURCE in ` +
        `src/shared/messages.ts AND add matching entries to ` +
        `manifest.json's declarative_net_request.rule_resources[].`,
    );
  }
  const chunks: ChunkOutput[] = [];
  for (let i = 0; i < maxChunks; i++) {
    const start = i * chunkSize;
    const end = start + chunkSize;
    chunks.push({
      id: chunkId(sourceId, i + 1),
      sourceId,
      chunkIndex: i,
      // slice() tolerates out-of-bounds gracefully — when rules.length
      // doesn't fill every chunk, trailing slices are empty arrays.
      rules: rules.slice(start, end),
    });
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Output writers.
// ---------------------------------------------------------------------------

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------

export interface BuildSummary {
  version: string;
  builtAt: string;
  chunkSize: number;
  chunksPerSource: number;
  sources: Array<{
    id: SourceId;
    source: string;
    ruleCount: number;
    diagnosticCount: number;
    /** Count of diagnostics grouped by `kind`. Quick shape for a CI lint. */
    diagnosticsByKind: Record<string, number>;
    chunks: Array<{
      id: string;
      ruleCount: number;
      /** ruleCount / chunkSize as an integer percent. Lets CI warn
       *  when a chunk is filling up (e.g. >90%). */
      fillPercent: number;
    }>;
    /** Cosmetic-bundle counts for *this source only*. The content script
     *  fetches each enabled source's bundle separately and merges in
     *  memory, so the global "totals" are user-config-dependent and
     *  intentionally not summarized here. */
    cosmetic: {
      genericHideCount: number;
      domainHideKeyCount: number;
      domainExceptionKeyCount: number;
    };
  }>;
}

export function summarize(
  compiled: CompiledSource[],
  chunksBySource: Map<SourceId, ChunkOutput[]>,
  chunkSize: number,
): BuildSummary {
  return {
    version: compiled[0]?.report.version ?? 'unknown',
    builtAt: new Date().toISOString(),
    chunkSize,
    chunksPerSource: CHUNKS_PER_SOURCE,
    sources: compiled.map((c) => {
      const byKind: Record<string, number> = {};
      for (const d of c.report.diagnostics) {
        byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
      }
      const chunks = chunksBySource.get(c.id) ?? [];
      const bundle = c.report.cosmetic_bundle;
      return {
        id: c.id,
        source: c.source,
        ruleCount: c.report.dnr_rules.length,
        diagnosticCount: c.report.diagnostics.length,
        diagnosticsByKind: byKind,
        chunks: chunks.map((ch) => ({
          id: ch.id,
          ruleCount: ch.rules.length,
          fillPercent: Math.round((ch.rules.length / chunkSize) * 100),
        })),
        cosmetic: {
          genericHideCount: bundle.generic_hide.length,
          domainHideKeyCount: Object.keys(bundle.domain_hide).length,
          domainExceptionKeyCount: Object.keys(bundle.domain_exceptions).length,
        },
      };
    }),
  };
}

function formatSummary(summary: BuildSummary): string {
  const nf = new Intl.NumberFormat('en-US');
  const lines: string[] = [];
  lines.push(
    `ad-blocker rulesets built (compiler v${summary.version}, ` +
      `${summary.chunksPerSource} chunks × ${nf.format(summary.chunkSize)} rules/chunk)`,
  );
  for (const s of summary.sources) {
    const diags =
      s.diagnosticCount === 0
        ? ''
        : ` (${nf.format(s.diagnosticCount)} diagnostic${s.diagnosticCount === 1 ? '' : 's'})`;
    lines.push(`  - ${s.id}: ${nf.format(s.ruleCount)} rules${diags}  [${s.source}]`);
    for (const ch of s.chunks) {
      const fill =
        ch.fillPercent >= 90
          ? `  ** ${ch.fillPercent}% full **`
          : `  ${ch.fillPercent}%`;
      lines.push(`      ${ch.id}: ${nf.format(ch.ruleCount)} rules${fill}`);
    }
    lines.push(
      `      cosmetic: ${nf.format(s.cosmetic.genericHideCount)} generic, ` +
        `${nf.format(s.cosmetic.domainHideKeyCount)} domain-scoped, ` +
        `${nf.format(s.cosmetic.domainExceptionKeyCount)} exception domains`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public build entry point — exported for tests.
// ---------------------------------------------------------------------------

export interface BuildResult {
  /** Per-source compile output (pre-chunking). */
  compiled: CompiledSource[];
  /** Flat list of every chunk written, in manifest order. */
  chunks: ChunkOutput[];
  /** Per-source cosmetic bundles, keyed by source id. Each was written to
   *  `assets/cosmetic-<source>.json`. The content script fetches the
   *  bundles for currently-enabled sources only and merges them at runtime. */
  cosmeticBySource: Map<SourceId, CosmeticBundle>;
  /** Summary JSON that was written to build-summary.json. */
  summary: BuildSummary;
}

/**
 * Run the full ruleset build. Writes all output files to disk, returns the
 * compiled state so tests can assert on it without re-reading the files.
 */
export async function buildRulesets(
  sources: SourceEntry[] = SOURCES,
  chunkSize: number = CHUNK_SIZE,
  chunksPerSource: number = CHUNKS_PER_SOURCE,
): Promise<BuildResult> {
  // Compile in parallel — Wasm init is memoized inside the facade so
  // concurrent calls share the first init.
  const compiled = await Promise.all(sources.map(compileSource));

  // Chunk per source. A Map keeps the chunk groups indexable by source
  // id, which the summary builder needs.
  const chunksBySource = new Map<SourceId, ChunkOutput[]>();
  const flatChunks: ChunkOutput[] = [];
  for (const c of compiled) {
    const chunks = chunkRules(c.id, c.report.dnr_rules, chunkSize, chunksPerSource);
    chunksBySource.set(c.id, chunks);
    flatChunks.push(...chunks);
  }

  // Write every chunk — including empty trailing ones. Chrome expects the
  // file paths declared in the manifest to exist, even if the ruleset is
  // empty.
  for (const ch of flatChunks) {
    writeJson(join(RULESETS_DIR, `${ch.id}.json`), ch.rules);
  }

  // One cosmetic bundle per source. The content script fetches each
  // enabled source's bundle separately so disabling a source via the
  // options page suppresses both DNR and cosmetic rules.
  const cosmeticBySource = new Map<SourceId, CosmeticBundle>();
  for (const c of compiled) {
    cosmeticBySource.set(c.id, c.report.cosmetic_bundle);
    writeJson(
      join(ASSETS_DIR, `cosmetic-${c.id}.json`),
      c.report.cosmetic_bundle,
    );
  }

  const summary = summarize(compiled, chunksBySource, chunkSize);
  writeJson(SUMMARY_PATH, summary);

  return { compiled, chunks: flatChunks, cosmeticBySource, summary };
}

// ---------------------------------------------------------------------------
// CLI entry.
// ---------------------------------------------------------------------------

const isMain = (() => {
  if (!process.argv[1]) return false;
  const invoked = resolve(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  return resolve(self) === invoked;
})();

if (isMain) {
  buildRulesets()
    .then((r) => {
      process.stderr.write(formatSummary(r.summary) + '\n');
    })
    .catch((err) => {
      // Preserve the message body — it's tuned for developer action.
      process.stderr.write(`build-rulesets failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
