//! Integration test — runs `compile_to_report` over the shared `tiny.txt`
//! fixture and asserts properties of the resulting cosmetic bundle.
//!
//! Complements `dnr_integration.rs` (network-rule side) and
//! `lexer_integration.rs` (lex-level counts). This test pins what the
//! Phase 3 cosmetic emitter produces end-to-end.
//!
//! Fixture cosmetic summary (see tests/fixtures/tiny.txt for the source):
//!   Supported (land in the bundle):
//!     - line 17: `##.ad-banner`                  → generic_hide
//!     - line 18: `##div[id^="adslot-"]`          → generic_hide
//!     - line 19: `example.com,sub.example.com##.sponsor-box`
//!                                                → domain_hide × 2
//!     - line 20: `news.site##aside.promo`        → domain_hide
//!     - line 23: `example.com#@#.sponsor-box`    → domain_exceptions
//!   Unsupported (drop with UnsupportedCosmetic diagnostic):
//!     - line 26: `example.com#?#...`             → extended-hide
//!     - line 29: `example.com#$#...`             → css-inject
//!     - line 30: `example.com#%#...`             → script-inject
//!     - line 31: `example.com##^...`             → html-filter
//!
//! So we expect: generic_hide.len()=2, domain_hide has 3 keys, exceptions
//! has 1 key, 4 `unsupported_cosmetic` diagnostics on lines 26/29/30/31.

use filter_compiler_rs::compile_to_report;

const TINY: &str = include_str!("fixtures/tiny.txt");

#[test]
fn generic_hide_contains_both_universal_selectors_in_source_order() {
    // Lines 17 and 18 are both universal element-hide. Order matters — a
    // content script applying rules in stored order gives filter-list
    // authors predictable behavior.
    let r = compile_to_report(TINY);
    assert_eq!(
        r.cosmetic_bundle.generic_hide,
        vec![".ad-banner", "div[id^=\"adslot-\"]"]
    );
}

#[test]
fn domain_hide_fans_out_across_comma_separated_domains() {
    // Line 19: `example.com,sub.example.com##.sponsor-box` should appear
    // under BOTH domain keys. Line 20 contributes `news.site`.
    let r = compile_to_report(TINY);
    assert_eq!(
        r.cosmetic_bundle.domain_hide.len(),
        3,
        "3 unique domains: example.com, sub.example.com, news.site"
    );
    assert_eq!(
        r.cosmetic_bundle.domain_hide.get("example.com"),
        Some(&vec![".sponsor-box".to_string()])
    );
    assert_eq!(
        r.cosmetic_bundle.domain_hide.get("sub.example.com"),
        Some(&vec![".sponsor-box".to_string()])
    );
    assert_eq!(
        r.cosmetic_bundle.domain_hide.get("news.site"),
        Some(&vec!["aside.promo".to_string()])
    );
}

#[test]
fn domain_exceptions_captures_scoped_unhide() {
    // Line 23: `example.com#@#.sponsor-box` — note this un-hides the SAME
    // selector line 19 hides on the same domain. That's not a contradiction:
    // the source list is telling the content script "hide .sponsor-box on
    // example.com, actually scratch that, don't". The emitter faithfully
    // records both — runtime reconciliation is the content script's job.
    let r = compile_to_report(TINY);
    assert_eq!(r.cosmetic_bundle.domain_exceptions.len(), 1);
    assert_eq!(
        r.cosmetic_bundle.domain_exceptions.get("example.com"),
        Some(&vec![".sponsor-box".to_string()])
    );
}

#[test]
fn four_unsupported_cosmetic_variants_produce_diagnostics() {
    // Lines 26, 29, 30, 31 — one of each unsupported dialect.
    // Asserting kind + line lets this test catch either a line-number
    // off-by-one in the emitter or a slug rename (which would be a wire
    // break for JS consumers that switch on the slug).
    let r = compile_to_report(TINY);

    let cosmetic_diags: Vec<_> = r
        .diagnostics
        .iter()
        .filter(|d| d.kind == "unsupported_cosmetic")
        .collect();
    assert_eq!(cosmetic_diags.len(), 4, "4 unsupported cosmetic variants");

    let mut by_line: std::collections::BTreeMap<u32, &str> = std::collections::BTreeMap::new();
    for d in &cosmetic_diags {
        by_line.insert(d.line, d.message.as_str());
    }
    // Spot-check each expected line carries the expected slug in its message.
    assert!(by_line[&26].contains("extended-hide"), "{:?}", by_line[&26]);
    assert!(by_line[&29].contains("css-inject"), "{:?}", by_line[&29]);
    assert!(by_line[&30].contains("script-inject"), "{:?}", by_line[&30]);
    assert!(by_line[&31].contains("html-filter"), "{:?}", by_line[&31]);
}

#[test]
fn total_diagnostics_are_exactly_the_four_cosmetic_drops() {
    // The network side of tiny.txt is clean (dnr_integration.rs asserts
    // `diagnostics.is_empty()`). So the full report's diagnostic count
    // should exactly equal the cosmetic-drop count — if it doesn't, a
    // network-side regression is leaking in from elsewhere.
    let r = compile_to_report(TINY);
    assert_eq!(
        r.diagnostics.len(),
        4,
        "only the 4 unsupported cosmetics should diagnose"
    );
}

#[test]
fn bundle_serializes_with_expected_keys_and_shape() {
    // End-to-end JSON shape: the content-script side will JSON.parse this
    // and expect the three keys. A field rename on the Rust side would
    // silently break the extension without this test.
    let r = compile_to_report(TINY);
    let v = serde_json::to_value(&r).expect("report must serialize");
    let bundle = &v["cosmetic_bundle"];
    assert!(bundle.is_object(), "cosmetic_bundle must be an object");

    let generic = bundle["generic_hide"].as_array().unwrap();
    assert_eq!(generic.len(), 2);
    assert_eq!(generic[0].as_str(), Some(".ad-banner"));

    let domain_hide = bundle["domain_hide"].as_object().unwrap();
    assert_eq!(domain_hide.len(), 3);
    // BTreeMap → JSON preserves key-sorted order. Spot-check one entry.
    assert_eq!(domain_hide["example.com"][0].as_str(), Some(".sponsor-box"));

    let exceptions = bundle["domain_exceptions"].as_object().unwrap();
    assert_eq!(exceptions.len(), 1);
    assert!(exceptions.contains_key("example.com"));
}

#[test]
fn dnr_pipeline_unaffected_by_cosmetic_routing() {
    // Regression guard: when cosmetic routing was added, nothing about the
    // DNR pipeline's output should have changed. Re-run the key DNR
    // assertions from dnr_integration.rs to catch cross-pipeline leakage.
    let r = compile_to_report(TINY);
    assert_eq!(r.dnr_rules.len(), 7, "DNR rule count must still be 5+2");
    for (i, rule) in r.dnr_rules.iter().enumerate() {
        assert_eq!(rule.id, (i as u32) + 1, "DNR IDs still monotonic from 1");
    }
}
