// Build-time entry (Node). Called by the extension's ruleset build script to
// compile an ABP filter list into:
//   - a declarativeNetRequest JSON array (written to rulesets/*.json), and
//   - a cosmetic bundle (written to cosmetic-bundle.json and shipped as a
//     static asset the content script fetches at runtime).
//
// This file is a thin facade over `filter-compiler-rs` (the Rust/Wasm crate,
// built with `wasm-pack --target web`). Going through a facade — rather than
// having the build script import the Wasm pkg directly — keeps one place to
// (a) initialize the Wasm module, (b) type-stamp the JSON contract the Rust
// side produces, and (c) swap in a different compiler later (e.g. a pure-JS
// fallback) without touching callers.
//
// Why target=web + manual init in Node? `wasm-pack --target web` emits a
// single .js + .wasm pair that works in browsers, service workers, and
// Node ≥ 16 once we hand it the .wasm bytes. We picked that target because
// the runtime side (web.ts) needs the web target anyway, and shipping two
// different wasm-pack builds of the same crate just to support Node is
// needless complexity for a build-time-only code path.
//
// The .wasm bytes are read via `createRequire(import.meta.url).resolve(...)`
// rather than `new URL(..., import.meta.url)` because the latter points at
// the facade's own directory, not the resolved `filter-compiler-rs` package.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// `filter-compiler-rs` is a `file:`-linked package written out by wasm-pack
// into ../filter-compiler-rs/pkg/. Its default export is the async init
// function; named exports are the wasm-bound functions.
import init, { compile as wasmCompile } from 'filter-compiler-rs';

// ---------------------------------------------------------------------------
// Wire types — mirror the Rust side's `CompileReport` exactly. These are the
// stable contract between the Rust compiler and every JS consumer. If you
// change a field name here you must also update `src/lib.rs` (and vice
// versa); the Rust integration tests pin the JSON shape but won't catch a
// rename on the TS side.
// ---------------------------------------------------------------------------

/** Stable snake_case kind discriminators emitted by the Rust compiler. */
export type DiagnosticKind =
  | 'unknown_option'
  | 'unsupported_option'
  | 'malformed_option'
  | 'empty_option'
  | 'unsupported_cosmetic';

/** One issue attached to one source line. `message` is for humans only —
 *  switch on `kind` for programmatic handling. */
export interface CompileDiagnostic {
  line: number;
  kind: DiagnosticKind | string;
  message: string;
}

/** Counts of each lexer token kind over the input. Separate from emitted
 *  rule counts: a dropped rule still increments its source-side counter. */
export interface TokenCounts {
  blank: number;
  comment: number;
  header: number;
  network: number;
  network_exception: number;
  cosmetic: number;
  cosmetic_exception: number;
}

/** A Chrome declarativeNetRequest rule. We keep this as `unknown`-ish here
 *  on purpose: the authoritative shape lives in Chrome's docs and the Rust
 *  side tests against it; re-typing it in TS would duplicate the spec. */
export interface DnrRule {
  id: number;
  priority: number;
  action: Record<string, unknown>;
  condition: Record<string, unknown>;
}

/** Cosmetic rules bundled for the content script. `generic_hide` is the hot
 *  path (applied on every page); the two domain maps key by hostname. */
export interface CosmeticBundle {
  generic_hide: string[];
  domain_hide: Record<string, string[]>;
  domain_exceptions: Record<string, string[]>;
}

/** Top-level compile result — everything the Rust side produces. */
export interface CompileReport {
  /** Crate version of the compiler that produced this report. */
  version: string;
  counts: TokenCounts;
  dnr_rules: DnrRule[];
  diagnostics: CompileDiagnostic[];
  cosmetic_bundle: CosmeticBundle;
}

/** Compile options passed through to the Rust side. Fields default to the
 *  previous behavior; new fields can be added without breaking callers. */
export interface CompileOptions {
  /** Merge overlapping rules (not yet plumbed on the Rust side). */
  compact?: boolean;
}

// ---------------------------------------------------------------------------
// Wasm init — one-shot, memoized. Build scripts call `compile()` many times
// across a batch of lists; paying the ~3ms init cost per call would add up.
// ---------------------------------------------------------------------------

let initPromise: Promise<void> | null = null;

/**
 * Initialize the Wasm module once per process. Safe to await concurrently —
 * later callers share the first caller's promise.
 */
function ensureInitialized(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Resolve the .wasm path relative to the installed `filter-compiler-rs`
    // package, not this facade's own directory. `createRequire` is the
    // documented way to get a Node-style `require.resolve` from an ESM
    // module; using `import.meta.resolve` would work on Node 20+ but we
    // keep Node ≥ 16 for pnpm-monorepo compatibility.
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('filter-compiler-rs/filter_compiler_rs_bg.wasm');
    const bytes = readFileSync(wasmPath);
    // `wasm-pack --target web` exposes init as the default export. It
    // accepts raw bytes, a WebAssembly.Module, a URL, or a Response. Raw
    // bytes is the simplest path on Node.
    await init({ module_or_path: bytes });
  })();
  return initPromise;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Compile a single ABP filter list into DNR rules + a cosmetic bundle.
 *
 * Multi-list merging (ID renumbering across lists, dedup) is the caller's
 * concern — see `apps/extension/scripts/build-rulesets.ts`. Keeping the
 * facade single-list matches the Rust compiler's own surface and avoids
 * baking a merge policy into a module that doesn't own the policy.
 *
 * @param source  Raw contents of a filter list (UTF-8 text).
 * @param options Compile options; see {@link CompileOptions}.
 * @returns The full compile report, already JSON-plain (no class instances).
 */
export async function compile(
  source: string,
  options: CompileOptions = {},
): Promise<CompileReport> {
  await ensureInitialized();
  // The Rust side expects a plain object; we pass it straight through.
  // `wasmCompile` returns `any` per the .d.ts — we narrow via the typed
  // interface and trust the Rust tests to keep the shape honest.
  const result = wasmCompile(source, options) as CompileReport;
  return result;
}

/**
 * Test-only hook: reset the memoized init promise so a suite can exercise
 * the cold-init path. Not part of the public API — prefixed with `__` so
 * it's obvious at call sites.
 */
export function __resetForTests(): void {
  initPromise = null;
}
