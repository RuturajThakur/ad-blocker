//! Filter compiler — Rust/Wasm.
//!
//! This crate parses Adblock Plus-style filter lists and emits two artefacts:
//!   1. `declarativeNetRequest` rule JSON for Chrome MV3.
//!   2. A cosmetic-selector bundle consumed by the content script (Phase 3).
//!
//! Two Wasm build targets are produced from this one source:
//!   - `wasm-pack build --target nodejs` — consumed by the CI build pipeline.
//!   - `wasm-pack build --target web`    — consumed by the extension service worker.
//!
//! Boundary discipline: callers pass whole filter lists across the FFI and
//! receive whole compiled artefacts back. There is no line-by-line streaming
//! across Wasm↔JS.
//!
//! ### Public surface
//! - [`greet`] — toolchain smoke test.
//! - [`count_tokens`] / [`TokenCounts`] — lightweight lex-only analytics.
//! - [`compile`] — full pipeline: lex → parse options → emit DNR rules. Returns
//!   a [`CompileReport`] serialized into a JS object.
//! - [`compile_to_report`] — pure-Rust entry point used by integration tests
//!   and benches (avoids the wasm_bindgen round-trip).

pub mod cosmetic;
pub mod errors;
pub mod lexer;
pub mod network;
pub mod token;

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::cosmetic::CosmeticBundle;
use crate::errors::ConversionError;
use crate::network::dnr::DnrRule;
use crate::network::emit;
use crate::token::TokenKind;

/// Toolchain smoke-test. Kept beyond Phase 1 because it's a cheap end-to-end
/// signal that the wasm binding is wired; callers outside the extension
/// (e.g. CI) use it as a "is the compiler loadable at all" probe.
#[wasm_bindgen]
pub fn greet(name: &str) -> String {
    format!(
        "filter-compiler-rs v{} — hello, {}!",
        env!("CARGO_PKG_VERSION"),
        name
    )
}

/// Counts for each token kind. Kept as a standalone type even though
/// [`CompileReport`] embeds a `counts` field, because [`count_tokens`] is a
/// stable wasm surface — removing it would break existing consumers.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct TokenCounts {
    pub blank: u32,
    pub comment: u32,
    pub header: u32,
    pub network: u32,
    pub network_exception: u32,
    pub cosmetic: u32,
    pub cosmetic_exception: u32,
}

impl TokenCounts {
    /// Walk the lexer once and tally every token kind. Cheap — the lexer
    /// is zero-alloc and the match arm is a handful of increments.
    pub fn tally(src: &str) -> Self {
        let mut c = Self::default();
        for tok in lexer::tokenize(src) {
            match tok.kind {
                TokenKind::Blank => c.blank += 1,
                TokenKind::Comment => c.comment += 1,
                TokenKind::Header => c.header += 1,
                TokenKind::Network(_) => c.network += 1,
                TokenKind::NetworkException(_) => c.network_exception += 1,
                TokenKind::Cosmetic(_) => c.cosmetic += 1,
                TokenKind::CosmeticException(_) => c.cosmetic_exception += 1,
            }
        }
        c
    }
}

/// JS-facing wrapper around `TokenCounts::tally`. Returns the counts as a
/// plain object. Kept separate from [`compile`] because calling it is ~50x
/// faster — it skips option parsing and DNR emission entirely.
#[wasm_bindgen]
pub fn count_tokens(input: &str) -> Result<JsValue, JsValue> {
    let counts = TokenCounts::tally(input);
    serde_wasm_bindgen::to_value(&counts).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Compile options — stable shape for callers. Grows over phases; each new
/// field must default to the previous behavior so old callers continue to
/// work without code changes.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CompileOptions {
    /// Merge overlapping rules. Default true for release; tests flip false
    /// to get deterministic golden-file output. Not yet plumbed through —
    /// the emitter in Phase 2 emits every rule independently.
    pub compact: bool,
}

/// JSON-friendly diagnostic. This is the *stable* shape the JS side sees —
/// `ConversionError` is an internal enum whose variants may come and go,
/// but `{ line, kind, message }` is the contract.
///
/// `kind` is a short snake_case discriminator suitable for switching on in JS
/// without parsing `message`. Message is the `Display` form for humans.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticJson {
    /// 1-indexed source line, passed through from the lexer token.
    pub line: u32,
    /// Stable discriminator: `unknown_option` | `unsupported_option` |
    /// `malformed_option` | `empty_option`. New kinds may be added over time;
    /// JS consumers should treat unknown kinds as warnings by default.
    pub kind: String,
    /// Human-readable message. For display, not for parsing.
    pub message: String,
}

/// Map an internal `ConversionError` to the stable JS-facing kind string.
///
/// Single source of truth for the `kind` field. Exhaustive match so adding a
/// new `ConversionError` variant is a compile-time prompt to pick its wire
/// name — important because JS consumers will grow code that switches on it.
fn error_kind(err: &ConversionError) -> &'static str {
    match err {
        ConversionError::UnknownOption(_) => "unknown_option",
        ConversionError::UnsupportedOption(_) => "unsupported_option",
        ConversionError::MalformedOption { .. } => "malformed_option",
        ConversionError::EmptyOption => "empty_option",
        ConversionError::UnsupportedCosmetic(_) => "unsupported_cosmetic",
    }
}

impl From<emit::Diagnostic> for DiagnosticJson {
    fn from(d: emit::Diagnostic) -> Self {
        Self {
            line: d.line_no,
            kind: error_kind(&d.error).to_string(),
            message: d.error.to_string(),
        }
    }
}

impl From<cosmetic::bundle::Diagnostic> for DiagnosticJson {
    fn from(d: cosmetic::bundle::Diagnostic) -> Self {
        Self {
            line: d.line_no,
            kind: error_kind(&d.error).to_string(),
            message: d.error.to_string(),
        }
    }
}

/// Top-level compile result. Serialized to a plain JS object when returned
/// through the wasm `compile` entry point.
#[derive(Debug, Clone, Serialize)]
pub struct CompileReport {
    /// Crate version, for log-and-report traceability ("which compiler
    /// produced this ruleset?").
    pub version: String,
    /// Raw token-kind tallies, same shape as [`TokenCounts`].
    pub counts: TokenCounts,
    /// DNR rules, ordered by source appearance. IDs are monotonic u32
    /// starting at 1 with no gaps for dropped rules.
    pub dnr_rules: Vec<DnrRule>,
    /// Every issue encountered during conversion. Presence of a
    /// `unsupported_option` or `malformed_option` kind means the matching
    /// source line did not produce a rule; `unknown_option` / `empty_option`
    /// are advisory only.
    pub diagnostics: Vec<DiagnosticJson>,
    /// Element-hide / cosmetic-exception bundle. Always present in the wire
    /// shape — an input with no cosmetic rules produces an empty bundle with
    /// all three sub-fields as empty collections, not `null`. The content
    /// script can check `is_empty` (or the JS equivalent) to short-circuit.
    pub cosmetic_bundle: CosmeticBundle,
}

/// Pure-Rust compile entry point.
///
/// Returns a [`CompileReport`] with every network rule converted, every
/// diagnostic attached to its source line, and every cosmetic rule counted
/// (bundle emission is Phase 3 and currently always `None`).
///
/// Invariants:
///   - `report.dnr_rules[i].id` is monotonic: `rule[i].id < rule[i+1].id`.
///   - IDs start at 1, never reused across the same report.
///   - Dropped rules do *not* skip an ID — the next successful rule reuses
///     the ID that would have gone to the dropped one.
///   - `report.counts` reflects source lines (not emitted rules), so a
///     dropped rule still increments `counts.network`.
pub fn compile_to_report(input: &str) -> CompileReport {
    let mut report = CompileReport {
        version: env!("CARGO_PKG_VERSION").to_string(),
        counts: TokenCounts::default(),
        dnr_rules: Vec::new(),
        diagnostics: Vec::new(),
        cosmetic_bundle: CosmeticBundle::default(),
    };
    let mut next_id: u32 = 1;

    for tok in lexer::tokenize(input) {
        match tok.kind {
            TokenKind::Blank => report.counts.blank += 1,
            TokenKind::Comment => report.counts.comment += 1,
            TokenKind::Header => report.counts.header += 1,
            TokenKind::Network(ref r) => {
                report.counts.network += 1;
                let out = emit::emit_network(r, false, tok.line_no, next_id);
                apply_outcome(out, &mut report, &mut next_id);
            }
            TokenKind::NetworkException(ref r) => {
                report.counts.network_exception += 1;
                let out = emit::emit_network(r, true, tok.line_no, next_id);
                apply_outcome(out, &mut report, &mut next_id);
            }
            TokenKind::Cosmetic(ref r) => {
                report.counts.cosmetic += 1;
                let out =
                    cosmetic::emit_cosmetic(r, false, tok.line_no, &mut report.cosmetic_bundle);
                for d in out.diagnostics {
                    report.diagnostics.push(DiagnosticJson::from(d));
                }
            }
            TokenKind::CosmeticException(ref r) => {
                report.counts.cosmetic_exception += 1;
                let out =
                    cosmetic::emit_cosmetic(r, true, tok.line_no, &mut report.cosmetic_bundle);
                for d in out.diagnostics {
                    report.diagnostics.push(DiagnosticJson::from(d));
                }
            }
        }
    }

    report
}

/// Fold one emitter outcome into the running report: append rule if present,
/// bump the ID counter iff we appended, flatten diagnostics into the report's
/// flat list. Pulled out so the two caller arms (Network / NetworkException)
/// don't duplicate the bookkeeping.
fn apply_outcome(out: emit::EmitOutcome, report: &mut CompileReport, next_id: &mut u32) {
    if let Some(rule) = out.rule {
        report.dnr_rules.push(rule);
        // saturating_add so a pathological 4B-rule input can't panic in
        // release builds; Chrome rejects >300k rules per ruleset anyway,
        // but defensive is cheap.
        *next_id = next_id.saturating_add(1);
    }
    for d in out.diagnostics {
        report.diagnostics.push(DiagnosticJson::from(d));
    }
}

/// Wasm-facing compile. Serializes a full [`CompileReport`] to a plain JS
/// object. Use [`compile_to_report`] from Rust code instead of going through
/// this — it skips the JsValue round-trip.
#[wasm_bindgen]
pub fn compile(input: &str, options: JsValue) -> Result<JsValue, JsValue> {
    // `options` currently only carries `compact`, which isn't plumbed yet.
    // Decoding it anyway so the ABI stays honest — the JS side has been
    // passing `{ compact: false }` since Phase 0 and we don't want to
    // surprise it with a "no, we don't accept options anymore" error.
    let _opts: CompileOptions = serde_wasm_bindgen::from_value(options).unwrap_or_default();
    let report = compile_to_report(input);
    // `serialize_maps_as_objects(true)` is essential here. The default
    // serde_wasm_bindgen behavior serializes Rust `BTreeMap`/`HashMap` as
    // JS `Map` instances, but the CompileReport wire contract is plain
    // JS objects — build scripts `JSON.stringify` the report to disk, and
    // `JSON.stringify` on a Map silently produces `{}`. That would drop
    // the cosmetic bundle's `domain_hide` and `domain_exceptions` fields
    // without any error. Opting into object-shaped maps here keeps the
    // JSON round-trip honest.
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    report
        .serialize(&serializer)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::dnr::DnrAction;

    #[test]
    fn greet_contains_name() {
        assert!(greet("world").contains("world"));
    }

    #[test]
    fn tally_mixed_list() {
        let src = "\
! header comment
[Adblock Plus 2.0]

||ads.com^
@@||good.com^
##.u
example.com##.d
example.com#@#.a
";
        let c = TokenCounts::tally(src);
        assert_eq!(c.comment, 1);
        assert_eq!(c.header, 1);
        assert_eq!(c.blank, 1);
        assert_eq!(c.network, 1);
        assert_eq!(c.network_exception, 1);
        assert_eq!(c.cosmetic, 2);
        assert_eq!(c.cosmetic_exception, 1);
    }

    #[test]
    fn compile_emits_block_and_allow_rules() {
        let src = "||ads.example.com^\n@@||good.example.com^\n";
        let r = compile_to_report(src);
        assert_eq!(r.dnr_rules.len(), 2);
        assert_eq!(r.dnr_rules[0].id, 1);
        assert_eq!(r.dnr_rules[0].priority, 1);
        assert_eq!(r.dnr_rules[0].action, DnrAction::Block);
        assert_eq!(r.dnr_rules[1].id, 2);
        assert_eq!(r.dnr_rules[1].priority, 2);
        assert_eq!(r.dnr_rules[1].action, DnrAction::Allow);
        assert!(r.diagnostics.is_empty());
    }

    #[test]
    fn compile_assigns_monotonic_ids() {
        let src = "||a.com^\n||b.com^\n||c.com^\n||d.com^\n";
        let r = compile_to_report(src);
        let ids: Vec<u32> = r.dnr_rules.iter().map(|r| r.id).collect();
        assert_eq!(ids, vec![1, 2, 3, 4]);
    }

    #[test]
    fn compile_drops_unsupported_and_records_diagnostic_with_line() {
        // Line 2 has an unsupported option; lines 1 and 3 are normal.
        // The bad line must be dropped, the good lines must still produce
        // rules, IDs must stay monotonic (no gap at the dropped line).
        let src = "||good1.com^\n||bad.com^$csp=default-src\n||good2.com^\n";
        let r = compile_to_report(src);
        assert_eq!(r.dnr_rules.len(), 2, "middle rule should have been dropped");
        assert_eq!(r.dnr_rules[0].id, 1);
        assert_eq!(
            r.dnr_rules[1].id, 2,
            "ID must not skip a slot for the dropped rule"
        );
        assert_eq!(r.diagnostics.len(), 1);
        assert_eq!(r.diagnostics[0].line, 2);
        assert_eq!(r.diagnostics[0].kind, "unsupported_option");
        assert!(r.diagnostics[0].message.contains("csp"));
    }

    #[test]
    fn compile_keeps_rule_on_unknown_option_but_records_warning() {
        // Unknown (typo-ish) options are advisory: the rule still emits, a
        // diagnostic goes into the report. JS can surface it as a lint.
        let src = "||ads.com^$thirdparty,script\n"; // missing hyphen
        let r = compile_to_report(src);
        assert_eq!(r.dnr_rules.len(), 1);
        assert_eq!(r.diagnostics.len(), 1);
        assert_eq!(r.diagnostics[0].kind, "unknown_option");
    }

    #[test]
    fn compile_counts_reflect_source_lines_not_emitted_rules() {
        // Counts track what the lexer saw; the emitter's dropping decisions
        // are orthogonal. A dropped `$csp=` rule still bumps network count.
        let src = "||ok.com^\n||bad.com^$csp=x\n";
        let r = compile_to_report(src);
        assert_eq!(r.counts.network, 2, "both lines lexed as network");
        assert_eq!(r.dnr_rules.len(), 1, "one was dropped in emit");
    }

    #[test]
    fn compile_report_serializes_to_expected_top_level_shape() {
        // Pin the wire shape of the CompileReport. If a field is added or
        // renamed, this test catches it — downstream JS consumers rely on
        // `dnr_rules`, `diagnostics`, `counts`, and the three cosmetic
        // sub-fields being exactly these keys.
        let src = "||ads.com^\n";
        let r = compile_to_report(src);
        let v = serde_json::to_value(&r).unwrap();
        assert!(v["version"].is_string());
        assert!(v["counts"].is_object());
        assert!(v["dnr_rules"].is_array());
        assert!(v["diagnostics"].is_array());
        // Cosmetic bundle is now always an object, even for network-only
        // inputs — the content script gets a predictable shape to read.
        assert!(v["cosmetic_bundle"].is_object());
        assert!(v["cosmetic_bundle"]["generic_hide"].is_array());
        assert!(v["cosmetic_bundle"]["domain_hide"].is_object());
        assert!(v["cosmetic_bundle"]["domain_exceptions"].is_object());
        assert_eq!(v["dnr_rules"][0]["action"]["type"], "block");
        assert_eq!(v["dnr_rules"][0]["condition"]["urlFilter"], "||ads.com^");
    }

    #[test]
    fn compile_routes_cosmetics_to_bundle_not_dnr() {
        // Comments/headers/blanks produce no rules of any kind. Cosmetic
        // tokens produce no DNR rules but DO populate the cosmetic bundle.
        // This separation is the whole point of Phase 3 — DNR can't hide
        // elements, the content script does that at page load.
        let src = "\
! Title: test
[Adblock Plus 2.0]

##.universal-ad
example.com##.scoped-ad
example.com#@#.allowed
";
        let r = compile_to_report(src);
        assert_eq!(r.dnr_rules.len(), 0, "cosmetic rules don't produce DNR");
        assert!(
            r.diagnostics.is_empty(),
            "all 3 cosmetic rules are supported"
        );
        assert_eq!(r.counts.cosmetic, 2);
        assert_eq!(r.counts.cosmetic_exception, 1);
        // Bundle sanity: one generic, one scoped, one exception.
        assert_eq!(r.cosmetic_bundle.generic_hide, vec![".universal-ad"]);
        assert_eq!(
            r.cosmetic_bundle.domain_hide.get("example.com"),
            Some(&vec![".scoped-ad".to_string()])
        );
        assert_eq!(
            r.cosmetic_bundle.domain_exceptions.get("example.com"),
            Some(&vec![".allowed".to_string()])
        );
    }

    #[test]
    fn compile_drops_unsupported_cosmetic_variant_with_diagnostic() {
        // Parallel to the network-side `compile_drops_unsupported_...` test:
        // line 2 has an unsupported variant, lines 1 and 3 don't. The bad
        // line contributes nothing to the bundle but produces a diagnostic
        // pinned to the right line number and kind.
        let src = "\
##.ok-generic
example.com#?#.has-ad:has(.x)
##.ok-another
";
        let r = compile_to_report(src);
        assert_eq!(r.cosmetic_bundle.generic_hide.len(), 2);
        assert_eq!(r.diagnostics.len(), 1);
        assert_eq!(r.diagnostics[0].line, 2);
        assert_eq!(r.diagnostics[0].kind, "unsupported_cosmetic");
        assert!(r.diagnostics[0].message.contains("extended-hide"));
    }

    #[test]
    fn diagnostic_from_conversion_error_sets_kind_correctly() {
        // The From impl is the bridge between internal errors and the wire.
        // If a new ConversionError variant is added without updating this
        // impl, the compiler forces the match to be exhaustive — this test
        // just pins the *string* values so JS consumers can switch on them.
        let cases: &[(ConversionError, &str)] = &[
            (ConversionError::UnknownOption("x".into()), "unknown_option"),
            (
                ConversionError::UnsupportedOption("csp".into()),
                "unsupported_option",
            ),
            (
                ConversionError::MalformedOption {
                    name: "domain".into(),
                    reason: "r".into(),
                },
                "malformed_option",
            ),
            (ConversionError::EmptyOption, "empty_option"),
            (
                ConversionError::UnsupportedCosmetic("extended-hide".into()),
                "unsupported_cosmetic",
            ),
        ];
        for (err, want_kind) in cases {
            // Exercise both From paths — the shared helper means both sides
            // produce the same kind for the same error, but we can't statically
            // enforce that without a macro, so the test double-checks.
            let via_network = emit::Diagnostic {
                line_no: 1,
                error: err.clone(),
            };
            let via_cosmetic = cosmetic::bundle::Diagnostic {
                line_no: 1,
                error: err.clone(),
            };
            let j1: DiagnosticJson = via_network.into();
            let j2: DiagnosticJson = via_cosmetic.into();
            assert_eq!(j1.kind, *want_kind, "network path, error = {err:?}");
            assert_eq!(j2.kind, *want_kind, "cosmetic path, error = {err:?}");
            assert_eq!(j1.kind, j2.kind);
        }
    }
}
