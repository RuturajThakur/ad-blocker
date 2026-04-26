//! Integration test — runs `compile_to_report` over the shared `tiny.txt`
//! fixture and asserts properties of the resulting DNR ruleset.
//!
//! Complements `lexer_integration.rs`: that one checks the lexer produces
//! the right token counts; this one checks the full pipeline (lex → parse
//! options → emit DNR rules) produces Chrome-shaped output.
//!
//! Design: prefer property-style assertions (rule count, monotonic IDs,
//! every rule has these fields) plus *spot checks* of specific rules
//! looked up by URL filter. A full golden-JSON comparison was considered
//! and rejected for v1 — it couples too tightly to the fixture, so a
//! one-line fixture change would require regenerating the golden. Spot
//! checks stay readable even as the fixture grows.
//!
//! Fixture summary (see tests/fixtures/tiny.txt for the source):
//!   - 5 network block rules on lines 6–10
//!   - 2 network exceptions on lines 13–14
//!   - 8 cosmetics + 1 cosmetic exception (Phase 3, ignored by this test)
//!   - No unsupported options → no expected diagnostics

use filter_compiler_rs::{
    compile_to_report,
    network::dnr::{DnrAction, DnrRule, DomainType, ResourceTypeWire},
};

const TINY: &str = include_str!("fixtures/tiny.txt");

/// Convenience: look up a rule by its urlFilter pattern. Every fixture rule
/// has a distinct pattern so this is unambiguous.
fn find_by_pattern<'a>(rules: &'a [DnrRule], pat: &str) -> &'a DnrRule {
    rules
        .iter()
        .find(|r| r.condition.url_filter.as_deref() == Some(pat))
        .unwrap_or_else(|| panic!("no rule with urlFilter == {pat:?}"))
}

#[test]
fn compile_emits_seven_rules_and_no_network_diagnostics() {
    // 5 block + 2 allow = 7.
    //
    // Cosmetic-side diagnostics (4 unsupported variants in the fixture —
    // see cosmetic_integration.rs) are expected and ignored here. This
    // test only guards the *network* pipeline: filter for the kinds that
    // network emission can emit and assert the filtered list is empty.
    let r = compile_to_report(TINY);
    assert_eq!(
        r.dnr_rules.len(),
        7,
        "expected 7 DNR rules (5 block + 2 allow)"
    );
    let network_diags: Vec<_> = r
        .diagnostics
        .iter()
        .filter(|d| {
            matches!(
                d.kind.as_str(),
                "unknown_option" | "unsupported_option" | "malformed_option" | "empty_option"
            )
        })
        .collect();
    assert!(
        network_diags.is_empty(),
        "network side of fixture shouldn't produce diagnostics; got {network_diags:?}"
    );
}

#[test]
fn counts_reflect_full_fixture_shape() {
    // A sanity check that the top-level pipeline still tallies the lex-level
    // counts the same way `lexer_integration.rs` does. If these diverge, the
    // counts are being mutated somewhere they shouldn't be.
    let r = compile_to_report(TINY);
    assert_eq!(r.counts.network, 5);
    assert_eq!(r.counts.network_exception, 2);
    assert_eq!(r.counts.cosmetic, 8);
    assert_eq!(r.counts.cosmetic_exception, 1);
    assert_eq!(r.counts.header, 1);
}

#[test]
fn ids_are_monotonic_starting_at_one() {
    // Chrome rejects duplicate IDs at load time. The `id == index+1`
    // assertion is stronger than "monotonic": it proves no gaps, which is
    // the contract `compile_to_report` documents.
    let r = compile_to_report(TINY);
    for (i, rule) in r.dnr_rules.iter().enumerate() {
        assert_eq!(
            rule.id,
            (i as u32) + 1,
            "rule at index {i} should have id {}, got {}",
            i + 1,
            rule.id
        );
    }
}

#[test]
fn first_five_rules_are_blocks_last_two_are_allows() {
    // Source order matters: the lexer walks lines top-to-bottom, and the
    // fixture puts blocks before exceptions. Anything reordering would be
    // a bug (makes diffs unreadable; also changes emitted IDs).
    let r = compile_to_report(TINY);
    for (i, rule) in r.dnr_rules[..5].iter().enumerate() {
        assert_eq!(rule.action, DnrAction::Block, "rule {i} should be Block");
        assert_eq!(rule.priority, 1, "rule {i} should have priority 1");
    }
    for (i, rule) in r.dnr_rules[5..].iter().enumerate() {
        assert_eq!(
            rule.action,
            DnrAction::Allow,
            "rule at allow-index {i} should be Allow"
        );
        assert_eq!(
            rule.priority, 2,
            "rule at allow-index {i} should have priority 2"
        );
    }
}

#[test]
fn third_party_modifier_becomes_domain_type_third_party() {
    // Fixture line 7: `||doubleclick.net^$third-party`
    // ABP's `$third-party` → DNR's `domainType: "thirdParty"`. No resource
    // types, no initiator domains.
    let r = compile_to_report(TINY);
    let rule = find_by_pattern(&r.dnr_rules, "||doubleclick.net^");
    assert_eq!(rule.condition.domain_type, Some(DomainType::ThirdParty));
    assert!(rule.condition.resource_types.is_empty());
    assert!(rule.condition.initiator_domains.is_empty());
}

#[test]
fn script_and_domain_include_flow_through_to_condition() {
    // Fixture line 8: `||googlesyndication.com/pagead/$script,domain=example.com|foo.com`
    // Exercises: (a) ABP `script` → DNR `"script"` wire name, (b) pipe-separated
    // domain list order preservation, (c) no excluded initiators.
    let r = compile_to_report(TINY);
    let rule = find_by_pattern(&r.dnr_rules, "||googlesyndication.com/pagead/");
    assert_eq!(
        rule.condition.resource_types,
        vec![ResourceTypeWire::Script]
    );
    assert_eq!(
        rule.condition.initiator_domains,
        vec!["example.com".to_string(), "foo.com".to_string()]
    );
    assert!(rule.condition.excluded_initiator_domains.is_empty());
}

#[test]
fn negated_third_party_becomes_first_party_and_negated_domain_is_excluded() {
    // Fixture line 10: `||tracker.net^$~third-party,domain=~allowed.com`
    // - `~third-party` → `domainType: "firstParty"`
    // - `domain=~allowed.com` → the one domain is prefixed with `~`, so it
    //   goes to `excludedInitiatorDomains`, and the include list is empty.
    // This is the only fixture rule that exercises both negations at once.
    let r = compile_to_report(TINY);
    let rule = find_by_pattern(&r.dnr_rules, "||tracker.net^");
    assert_eq!(rule.condition.domain_type, Some(DomainType::FirstParty));
    assert!(
        rule.condition.initiator_domains.is_empty(),
        "no positive domains expected"
    );
    assert_eq!(
        rule.condition.excluded_initiator_domains,
        vec!["allowed.com".to_string()]
    );
}

#[test]
fn allow_rule_with_image_and_domain_includes_all_three_fields() {
    // Fixture line 14: `@@||partner.com^$image,domain=example.com`
    // The most information-dense exception in the fixture — checks that
    // exception routing (priority 2, Allow action) and condition building
    // both work when options are present.
    let r = compile_to_report(TINY);
    let rule = find_by_pattern(&r.dnr_rules, "||partner.com^");
    assert_eq!(rule.action, DnrAction::Allow);
    assert_eq!(rule.priority, 2);
    assert_eq!(rule.condition.resource_types, vec![ResourceTypeWire::Image]);
    assert_eq!(
        rule.condition.initiator_domains,
        vec!["example.com".to_string()]
    );
}

#[test]
fn every_rule_serializes_to_chrome_required_fields() {
    // End-to-end: compile → JSON → walk each rule and verify every field
    // Chrome requires is present with the correct type. If a serde attribute
    // regresses (wrong casing, missing field), this catches it before it
    // reaches a browser.
    let r = compile_to_report(TINY);
    let json = serde_json::to_string(&r).expect("CompileReport must serialize");
    let v: serde_json::Value = serde_json::from_str(&json).expect("output must be valid JSON");

    let rules = v["dnr_rules"]
        .as_array()
        .expect("dnr_rules must be an array");
    assert_eq!(rules.len(), 7);

    for (i, rule) in rules.iter().enumerate() {
        let ctx = format!("rule[{i}]");
        assert!(rule["id"].is_u64(), "{ctx}.id must be a number");
        assert!(rule["priority"].is_u64(), "{ctx}.priority must be a number");
        assert!(
            rule["action"]["type"].is_string(),
            "{ctx}.action.type must be a string"
        );
        let action_type = rule["action"]["type"].as_str().unwrap();
        assert!(
            action_type == "block" || action_type == "allow",
            "{ctx}.action.type should be block|allow, got {action_type}"
        );
        assert!(
            rule["condition"]["urlFilter"].is_string(),
            "{ctx}.condition.urlFilter must be a string (note camelCase)"
        );
    }
}
