//! Cosmetic-rule pipeline.
//!
//! Handles ABP/uBO-style element-hide rules (`##selector` and `#@#selector`),
//! routing each rule into one of three buckets of the [`CosmeticBundle`]
//! consumed at runtime by the extension's content script.
//!
//! Scope — Phase 3 v1:
//!   - `##selector` (universal element-hide) → `generic_hide`
//!   - `domain[,domain]##selector` → `domain_hide`
//!   - `domain[,domain]#@#selector` → `domain_exceptions`
//!
//! Deliberately **not** supported in v1 (each drops the rule and records an
//! `UnsupportedCosmetic` diagnostic):
//!   - `#?#` extended/procedural selectors (:has-text, :matches-css, …)
//!   - `#$#` CSS/snippet inject
//!   - `#%#` script-snippet inject
//!   - `##^` HTML filter
//!   - generic cosmetic exceptions (`#@#.ad` with no domain)
//!   - negated-domain-only includes (`~example.com##.ad`)
//!
//! Those last two *could* be expressed in the current bundle shape with a
//! fourth bucket, but doing so changes the content-script's apply order from
//! "set difference" to "per-domain override" — a runtime-logic shift worth
//! its own design pass. Deferred to v1.1.

pub mod bundle;

pub use bundle::{emit_cosmetic, CosmeticBundle, CosmeticOutcome};
