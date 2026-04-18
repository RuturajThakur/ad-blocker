//! Filter compiler — Rust/Wasm.
//!
//! This crate parses Adblock Plus-style filter lists and emits two artefacts:
//!   1. `declarativeNetRequest` rule JSON for Chrome MV3.
//!   2. A cosmetic-selector bundle consumed by the content script.
//!
//! Two Wasm build targets are produced from this one source:
//!   - `wasm-pack build --target nodejs` — consumed by the CI build pipeline.
//!   - `wasm-pack build --target web`    — consumed by the extension service worker.
//!
//! Boundary discipline: callers pass whole filter lists across the FFI and receive
//! whole compiled artefacts back. There is no line-by-line streaming across Wasm↔JS.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

// Phase 0 hello-world entry point. Exists to prove the toolchain works end-to-end.
// Delete or replace in Phase 1 once the real compile() entry point lands.
#[wasm_bindgen]
pub fn greet(name: &str) -> String {
    format!("filter-compiler-rs v{} — hello, {}!", env!("CARGO_PKG_VERSION"), name)
}

/// Phase 0 smoke-test entry point. Counts lines in the input — the minimum viable
/// signal that we can pass a large string across the Wasm boundary and return a number.
#[wasm_bindgen]
pub fn count_lines(input: &str) -> u32 {
    input.lines().count() as u32
}

/// Compile options — will grow in Phase 1. Kept as a struct so JS callers can pass
/// a single object and we can evolve the shape without breaking the ABI.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CompileOptions {
    /// If true, include the compactor pass that merges overlapping rules.
    /// Default: true for release, false for deterministic golden-file tests.
    pub compact: bool,
}

/// Placeholder for the real `compile()` entry point. Phase 1 replaces the body.
#[wasm_bindgen]
pub fn compile(input: &str, options: JsValue) -> Result<JsValue, JsValue> {
    let _opts: CompileOptions =
        serde_wasm_bindgen::from_value(options).unwrap_or_default();

    // TODO(phase-1): run lexer → classifier → emitters → compactor.
    let stub = serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "lines_seen": input.lines().count(),
        "dnr_rules": [],
        "cosmetic_bundle": null,
        "status": "phase-0-stub"
    });

    serde_wasm_bindgen::to_value(&stub).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greet_contains_name() {
        assert!(greet("world").contains("world"));
    }

    #[test]
    fn count_lines_counts_lines() {
        assert_eq!(count_lines(""), 0);
        assert_eq!(count_lines("a"), 1);
        assert_eq!(count_lines("a\nb\nc"), 3);
    }
}
