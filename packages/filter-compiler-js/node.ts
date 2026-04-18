// Build-time entry (Node). Used by the extension build pipeline to compile
// filter lists (ABP syntax) into MV3 declarativeNetRequest rulesets + a
// cosmetic-rule bundle consumed by content scripts at runtime.
//
// This file is a thin facade. All heavy lifting lives in the Rust crate
// `filter-compiler-rs`, built with `wasm-pack --target nodejs`. The Wasm
// package is copied into ./pkg-node/ during the workspace build.
//
// Phase 0: the Wasm binding is not wired yet. We export the intended surface
// so consumers can start depending on stable types.

export interface CompileInput {
  /** Raw filter list contents, keyed by source name (e.g. "easylist"). */
  lists: Record<string, string>;
  /** Optional target Chrome version; compiler may emit newer rule shapes. */
  chromeMinVersion?: number;
}

export interface CompiledRuleset {
  /** DNR rules ready to serialize to rulesets/*.json. */
  dnrRules: unknown[];
  /** Compact cosmetic rules (shipped to the content script at runtime). */
  cosmetic: {
    /** Serialized selector trie or byte-array; exact shape TBD. */
    bundle: Uint8Array;
    /** Entry count for diagnostics. */
    count: number;
  };
  /** Per-list compile diagnostics — parse errors, dropped rules, etc. */
  diagnostics: Array<{ list: string; severity: 'info' | 'warn' | 'error'; message: string }>;
}

/**
 * Compile one or more filter lists. Phase 0 stub: throws until the Wasm
 * binding is wired in Phase 1.
 */
export async function compile(_input: CompileInput): Promise<CompiledRuleset> {
  throw new Error('filter-compiler-js/node: Wasm binding not wired yet (Phase 0 stub)');
}
