// Runtime entry (browser / service worker). Loaded by the extension at
// runtime to:
//   - decode the compact cosmetic bundle produced at build time, and
//   - evaluate cosmetic-rule matching against page hostname + ancestors.
//
// Backed by the same Rust crate, built with `wasm-pack --target web`. The
// Wasm artifact is copied into ./pkg-web/ during the workspace build and
// bundled into the extension via a dynamic import.
//
// Phase 0: stub surface so the SW/content script can be scaffolded without
// waiting for the Wasm binding.

export interface CosmeticMatcherInit {
  /** Serialized bundle produced by the build-time compiler. */
  bundle: Uint8Array;
}

export interface CosmeticMatch {
  /** CSS selectors to hide. */
  hide: string[];
  /** CSS injection blocks (for :style() rules). */
  styles: string[];
}

export interface CosmeticMatcher {
  match(hostname: string): CosmeticMatch;
  dispose(): void;
}

/**
 * Initialize the Wasm runtime and return a matcher bound to the given bundle.
 * Phase 0 stub: throws until the Wasm binding is wired.
 */
export async function createCosmeticMatcher(_init: CosmeticMatcherInit): Promise<CosmeticMatcher> {
  throw new Error('filter-compiler-js/web: Wasm binding not wired yet (Phase 0 stub)');
}
