/// <reference path="./asset-imports.d.ts" />
// ^^^ The triple-slash reference is load-bearing across consumers: when
// `apps/extension`'s tsc transitively typechecks this file (because the SW
// imports `compile`), it doesn't see asset-imports.d.ts via its own include
// glob — only the filter-compiler-js workspace lists that file. The
// reference forces TS to follow the link and pick up the `*?url` declaration
// for any consumer of this module.

// Wasm-backed compile entry point for browser / service-worker contexts.
//
// The `?url` import below uses Vite's asset-suffix syntax. Its type
// declaration lives in `asset-imports.d.ts` alongside this file — that
// indirection is intentional: a `declare module '*?url'` form inside a
// `.ts` file with imports is treated by TS as a module *augmentation*,
// which cannot use wildcard names. Putting it in a sibling `.d.ts` puts
// it in ambient context, where the wildcard works.
//
// Mirrors `node.ts` (the build-time entry) but loads the .wasm bytes via
// fetch instead of `fs.readFileSync`. The two facades intentionally do not
// share an init helper — each one's bytes-loading strategy is the only
// thing that differs between contexts, and it's the part you'd swap if
// you ever needed a third target. Sharing helpers across them would mean
// the helper has to know about all targets, which is the worse trade.
//
// Why this lives in a separate file from `web.ts`:
//   - `web.ts` is the runtime *matcher* and is intentionally pure-JS so
//     the content script's bundle stays small (~no wasm in content).
//   - This file IS the wasm consumer. Anything importing from here pulls
//     in the wasm-pack JS wrapper plus the .wasm asset.
//   - Service workers want this; content scripts don't. Splitting the
//     file lets each consumer take only what it needs.
//
// Vite/crxjs glue: the `?url` suffix on the wasm import asks Vite to emit
// the .wasm into the build's `assets/` directory and hand us back a URL
// pointing at it. wasm-pack's `init({ module_or_path: url })` then does the
// fetch-and-instantiate dance internally. In the extension build this URL
// resolves to a `chrome-extension://...` origin, which the SW can fetch
// without web_accessible_resources gymnastics (SW context is privileged).

import init, { compile as wasmCompile } from 'filter-compiler-rs';
// `?url` is a Vite asset import. Returns a URL string that resolves to the
// .wasm file as it lands in the bundle output. Without `?url`, Vite would
// try to import the wasm as a module — which works for some toolchains but
// not consistently for service workers in MV3.
import wasmUrl from 'filter-compiler-rs/filter_compiler_rs_bg.wasm?url';

import type {
  CompileDiagnostic,
  CompileOptions,
  CompileReport,
  CosmeticBundle,
  DiagnosticKind,
  DnrRule,
  TokenCounts,
} from './node.js';

// Re-export the wire types so callers don't have to reach across to /node
// to type their consuming code. The types are owned by node.ts because that
// was the first facade — they're contractually the same in either context.
export type {
  CompileDiagnostic,
  CompileOptions,
  CompileReport,
  CosmeticBundle,
  DiagnosticKind,
  DnrRule,
  TokenCounts,
};

// ---------------------------------------------------------------------------
// Wasm init — one-shot, memoized.
//
// In the SW's auto-refresh path we compile each enabled source in series; a
// single init covers all of them. The cost is small (~3 ms on a desktop
// CPU) but doing it N times for N lists is pure waste.
// ---------------------------------------------------------------------------

let initPromise: Promise<void> | null = null;

function ensureInitialized(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // `module_or_path` accepts a URL string (this path), a Response, raw
    // bytes, or a WebAssembly.Module. The URL form is the cheapest in a
    // browser context — it lets the engine do streaming instantiation
    // straight off the network response.
    await init({ module_or_path: wasmUrl });
  })();
  return initPromise;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Compile a single ABP filter list into DNR rules + a cosmetic bundle.
 *
 * Concurrency note: it's safe to await `compile()` from multiple call sites
 * concurrently — the memoized `initPromise` means only one wasm init runs,
 * and the wasm `compile` fn itself is called serially in practice (each
 * call returns a fresh report, no shared mutable state on the Rust side).
 *
 * @param source  Raw contents of a filter list (UTF-8 text).
 * @param options Compile options; see {@link CompileOptions}.
 * @returns The full compile report. JSON-plain — safe to write straight
 *          into chrome.storage.local without serialization gymnastics.
 */
export async function compile(
  source: string,
  options: CompileOptions = {},
): Promise<CompileReport> {
  await ensureInitialized();
  return wasmCompile(source, options) as CompileReport;
}

/**
 * Test-only hook: reset the memoized init promise so a suite can exercise
 * the cold-init path. Not part of the public API — prefixed with `__` so
 * it's obvious at call sites.
 */
export function __resetForTests(): void {
  initPromise = null;
}
