// bench-phase-4b.ts — Phase 4b baseline measurement.
//
// Goal: run the existing compiler over real EasyList + EasyPrivacy and
// record the damage, so we have a concrete before-picture to compare
// against as we add $domain= support (4b.3), split rulesets under the DNR
// cap (4b.4), etc. Written as a standalone script — no test framework —
// because the output is a markdown report, not a pass/fail gate.
//
// Prereq: run `pnpm -F @ad-blocker/extension lists:fetch` first. If the
// vendored lists are missing we bail with a clear error instead of
// silently measuring nothing.
//
// The report captures exactly the four numbers we care about at this
// stage:
//   1. Compile wall-clock per list (millis).
//   2. DNR rule count vs Chrome's 30,000-per-ruleset cap.
//   3. Diagnostic count broken down by `kind` (the interesting signal —
//      tells us which compiler features to add next).
//   4. Cosmetic bundle size after JSON.stringify.
//
// We also compute rough "coverage" — what fraction of source lines the
// compiler accepted without complaint. Low coverage on EasyList tells us
// where the feature gaps are hurting worst.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  compile,
  type CompileReport,
  type DiagnosticKind,
} from '@ad-blocker/filter-compiler-js/node';

// ---------------------------------------------------------------------------
// Paths + config.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, '..');
const VENDOR_DIR = join(EXT_ROOT, 'vendor');
const BENCH_DIR = join(EXT_ROOT, 'bench');
const REPORT_PATH = join(BENCH_DIR, 'phase-4b-baseline.md');

/** Chrome's hard per-ruleset cap on enabled static rules. See:
 *  https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#property-MAX_NUMBER_OF_STATIC_RULES_PER_RULESET
 */
const DNR_RULE_CAP_PER_RULESET = 30_000;

interface BenchTarget {
  id: string;
  path: string;
}

const TARGETS: readonly BenchTarget[] = [
  { id: 'easylist', path: join(VENDOR_DIR, 'easylist.txt') },
  { id: 'easyprivacy', path: join(VENDOR_DIR, 'easyprivacy.txt') },
] as const;

// ---------------------------------------------------------------------------
// Measurement.
// ---------------------------------------------------------------------------

interface Measurement {
  id: string;
  path: string;
  sourceBytes: number;
  sourceLines: number;
  compileMs: number;
  dnrRuleCount: number;
  diagnosticCount: number;
  diagnosticsByKind: Record<string, number>;
  cosmeticBundleBytes: number;
  cosmeticGenericCount: number;
  cosmeticDomainKeyCount: number;
  cosmeticExceptionKeyCount: number;
  /** Compiler version that produced this report — recorded so future
   *  diffs against this baseline are anchored to a specific compiler. */
  compilerVersion: string;
}

async function measure(target: BenchTarget): Promise<Measurement> {
  if (!existsSync(target.path)) {
    throw new Error(
      `${target.id}: source file missing at ${target.path}. ` +
        `Run \`pnpm -F @ad-blocker/extension lists:fetch\` first.`,
    );
  }

  const source = readFileSync(target.path, 'utf8');
  const sourceLines = countLines(source);

  // Warm one dry run off the clock so Wasm init cost doesn't get billed to
  // the first target. The second target already amortizes init, so only
  // the first measurement is affected — this evens that out.
  if (target.id === TARGETS[0]?.id) {
    await compile('! warm-up comment\n');
  }

  const t0 = performance.now();
  const report = await compile(source);
  const compileMs = performance.now() - t0;

  return {
    id: target.id,
    path: target.path,
    sourceBytes: Buffer.byteLength(source, 'utf8'),
    sourceLines,
    compileMs,
    dnrRuleCount: report.dnr_rules.length,
    diagnosticCount: report.diagnostics.length,
    diagnosticsByKind: groupDiagnosticsByKind(report),
    cosmeticBundleBytes: Buffer.byteLength(
      JSON.stringify(report.cosmetic_bundle),
      'utf8',
    ),
    cosmeticGenericCount: report.cosmetic_bundle.generic_hide.length,
    cosmeticDomainKeyCount: Object.keys(report.cosmetic_bundle.domain_hide)
      .length,
    cosmeticExceptionKeyCount: Object.keys(
      report.cosmetic_bundle.domain_exceptions,
    ).length,
    compilerVersion: report.version,
  };
}

/**
 * Count source lines the compiler sees. We match the Rust lexer's
 * line-splitting convention — `\n`-delimited, with a trailing newline
 * counting as a separator, not an extra line.
 */
function countLines(source: string): number {
  if (source.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 0x0a /* \n */) n++;
  }
  // If the file doesn't end in a newline, the last chunk is still a line.
  if (source.charCodeAt(source.length - 1) !== 0x0a) n++;
  return n;
}

function groupDiagnosticsByKind(
  report: CompileReport,
): Record<DiagnosticKind | string, number> {
  const out: Record<string, number> = {};
  for (const d of report.diagnostics) {
    out[d.kind] = (out[d.kind] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report rendering.
// ---------------------------------------------------------------------------

const nf = new Intl.NumberFormat('en-US');

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(1)} ms`;
}

/**
 * Render the measurement set as a markdown report. The report is laid out
 * so the top section answers "what's the damage?" at a glance, with the
 * detail tables below.
 */
function renderReport(measurements: Measurement[]): string {
  const lines: string[] = [];

  lines.push('# Phase 4b — Baseline measurement');
  lines.push('');
  lines.push(
    'Snapshot of what the current compiler produces when pointed at real ' +
      'upstream EasyList + EasyPrivacy. This is the before-picture for ' +
      'Phase 4b work — every subsequent change in 4b.3 (domain=), 4b.4 ' +
      '(ruleset splitting), etc. should reference this baseline.',
  );
  lines.push('');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(
    `- Compiler version: ${measurements[0]?.compilerVersion ?? 'unknown'}`,
  );
  lines.push(
    `- DNR rule cap per ruleset: ${nf.format(DNR_RULE_CAP_PER_RULESET)} (Chrome limit)`,
  );
  lines.push('');

  // --- Executive summary table ---------------------------------------------
  lines.push('## At a glance');
  lines.push('');
  lines.push(
    '| List | Lines | Compile | DNR rules | Over cap? | Diagnostics | Cosmetic bundle |',
  );
  lines.push(
    '|------|------:|--------:|----------:|:---------:|------------:|----------------:|',
  );
  for (const m of measurements) {
    const overCap =
      m.dnrRuleCount > DNR_RULE_CAP_PER_RULESET
        ? `**YES (+${nf.format(m.dnrRuleCount - DNR_RULE_CAP_PER_RULESET)})**`
        : 'no';
    lines.push(
      `| \`${m.id}\` | ${nf.format(m.sourceLines)} | ${fmtMs(m.compileMs)} | ` +
        `${nf.format(m.dnrRuleCount)} | ${overCap} | ${nf.format(m.diagnosticCount)} | ` +
        `${fmtBytes(m.cosmeticBundleBytes)} |`,
    );
  }
  lines.push('');

  // --- Coverage ------------------------------------------------------------
  lines.push('## Coverage');
  lines.push('');
  lines.push(
    'Rough view of what fraction of source lines the compiler either ' +
      'translated cleanly or rejected with a diagnostic. Blank and ' +
      'comment lines are part of the denominator — real coverage against ' +
      '*rule-bearing* lines is higher than these numbers suggest.',
  );
  lines.push('');
  lines.push('| List | Source lines | Diagnostic lines | Diagnostic rate |');
  lines.push('|------|-------------:|-----------------:|----------------:|');
  for (const m of measurements) {
    const rate =
      m.sourceLines === 0
        ? '—'
        : ((m.diagnosticCount / m.sourceLines) * 100).toFixed(2) + '%';
    lines.push(
      `| \`${m.id}\` | ${nf.format(m.sourceLines)} | ${nf.format(m.diagnosticCount)} | ${rate} |`,
    );
  }
  lines.push('');

  // --- Diagnostics by kind -------------------------------------------------
  lines.push('## Diagnostics by kind');
  lines.push('');
  lines.push(
    'The interesting column. Each `kind` here maps to a specific missing ' +
      'compiler feature; the largest buckets are what 4b.3+ should ' +
      'prioritize.',
  );
  lines.push('');
  // Union of all kinds seen across lists, sorted desc by total count — the
  // ordering makes it obvious which missing features are most impactful.
  const totals: Record<string, number> = {};
  for (const m of measurements) {
    for (const [k, c] of Object.entries(m.diagnosticsByKind)) {
      totals[k] = (totals[k] ?? 0) + c;
    }
  }
  const kindsOrdered = Object.keys(totals).sort(
    (a, b) => totals[b]! - totals[a]!,
  );

  if (kindsOrdered.length === 0) {
    lines.push('_No diagnostics produced. Either the compiler is perfect ' +
      'or the lists are too small — check `At a glance` for context._');
  } else {
    const header = ['Kind', 'Total', ...measurements.map((m) => `\`${m.id}\``)];
    lines.push('| ' + header.join(' | ') + ' |');
    lines.push(
      '|' +
        [
          '------',
          '------:',
          ...measurements.map(() => '------:'),
        ].join('|') +
        '|',
    );
    for (const k of kindsOrdered) {
      const row = [
        `\`${k}\``,
        nf.format(totals[k] ?? 0),
        ...measurements.map((m) => nf.format(m.diagnosticsByKind[k] ?? 0)),
      ];
      lines.push('| ' + row.join(' | ') + ' |');
    }
  }
  lines.push('');

  // --- Cosmetic bundle detail ---------------------------------------------
  lines.push('## Cosmetic bundle shape');
  lines.push('');
  lines.push('| List | Generic selectors | Domain-scoped keys | Exception keys | Bundle size |');
  lines.push('|------|-------------------:|-------------------:|---------------:|------------:|');
  for (const m of measurements) {
    lines.push(
      `| \`${m.id}\` | ${nf.format(m.cosmeticGenericCount)} | ` +
        `${nf.format(m.cosmeticDomainKeyCount)} | ` +
        `${nf.format(m.cosmeticExceptionKeyCount)} | ` +
        `${fmtBytes(m.cosmeticBundleBytes)} |`,
    );
  }
  lines.push('');

  // --- Notes placeholder ---------------------------------------------------
  lines.push('## Notes');
  lines.push('');
  lines.push(
    '<!-- Add interpretation here as Phase 4b progresses. Post-4b.5 we ' +
      'append a "post-integration" section comparing against these numbers. -->',
  );
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const measurements: Measurement[] = [];
  for (const target of TARGETS) {
    process.stderr.write(`measuring ${target.id}...\n`);
    const m = await measure(target);
    process.stderr.write(
      `  compile=${fmtMs(m.compileMs)} rules=${nf.format(m.dnrRuleCount)} ` +
        `diag=${nf.format(m.diagnosticCount)} cosmetic=${fmtBytes(m.cosmeticBundleBytes)}\n`,
    );
    measurements.push(m);
  }

  const markdown = renderReport(measurements);
  mkdirSync(BENCH_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, markdown, 'utf8');
  process.stderr.write(`\nreport written: ${REPORT_PATH}\n`);
}

main().catch((err) => {
  process.stderr.write(`bench-phase-4b failed: ${String(err)}\n`);
  process.exit(1);
});
