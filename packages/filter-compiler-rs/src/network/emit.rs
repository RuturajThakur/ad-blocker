//! Network-rule emitter — the glue layer that takes a lexed `NetworkRule`
//! plus its parsed options and produces a Chrome DNR rule.
//!
//! Responsibilities (only these; everything else belongs upstream or down):
//!   1. Run the options parser on the raw `$...` string.
//!   2. Decide whether the options set is *rule-fatal* (e.g. contains an
//!      `UnsupportedOption` — dropping the rule is safer than emitting a
//!      wrong one).
//!   3. Build the `DnrCondition` from the pattern + typed options.
//!   4. Pick `action` + `priority` from the block/allow × regular/important
//!      matrix below.
//!   5. Bundle the rule and all collected diagnostics into an [`EmitOutcome`]
//!      so the caller has one place to look.
//!
//! The caller (Phase 2 slice 5, in `lib.rs`) owns ID generation so that IDs
//! stay monotonic across the whole ruleset. The emitter just receives the
//! next ID and stamps it onto the rule.
//!
//! ### Priority ladder
//! Chrome resolves rule conflicts by numeric priority: higher wins, ties
//! are broken by action precedence (`allow` > `block`). The ladder we use:
//!
//! | Source shape          | Action | Priority |
//! |-----------------------|--------|----------|
//! | `||ads.com^`          | block  | 1        |
//! | `@@||good.com^`       | allow  | 2        |
//! | `||ads.com^$important`| block  | 3        |
//! | `@@||good.com^$important` | allow | 4     |
//!
//! Why this ladder: ABP's original rules for `$important` say an important
//! block wins over a regular allow, and an important allow wins over an
//! important block. Mapping that directly to DNR priority numbers makes
//! the semantics fall out of Chrome's matcher for free, with no need for
//! separate `allowAllRequests` actions or per-rule flags.

use crate::errors::ConversionError;
use crate::network::dnr::{DnrAction, DnrCondition, DnrRule, DomainType};
use crate::network::options::{self, NetworkOptions};
use crate::token::NetworkRule;

/// A single emitter result: either a rule (possibly with advisory
/// diagnostics) or no rule (with the diagnostics explaining why).
#[derive(Debug, Clone, Default)]
pub struct EmitOutcome {
    /// `Some` if a DNR rule was produced. `None` if the rule had to be
    /// dropped — the reason is in `diagnostics`.
    pub rule: Option<DnrRule>,
    /// Everything that went sideways during conversion, with source line
    /// numbers attached. Includes both advisory warnings (rule still
    /// emitted) and fatal errors (rule dropped).
    pub diagnostics: Vec<Diagnostic>,
}

/// Line-attributed conversion problem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub line_no: u32,
    pub error: ConversionError,
}

/// Convert one lexed network rule into a DNR rule. See module docs for the
/// full contract; in short:
///   - `is_exception` is `true` iff the lexer classified this as
///     `TokenKind::NetworkException` (i.e., the source had an `@@` prefix).
///   - `line_no` is attached to every diagnostic; passed through verbatim.
///   - `id` stamps the resulting rule. Caller is responsible for uniqueness.
pub fn emit_network(
    rule: &NetworkRule<'_>,
    is_exception: bool,
    line_no: u32,
    id: u32,
) -> EmitOutcome {
    let parsed = options::parse_options(rule.options);
    let mut diagnostics: Vec<Diagnostic> = parsed
        .errors
        .into_iter()
        .map(|error| Diagnostic { line_no, error })
        .collect();

    // Rule-fatal check 1: UnsupportedOption changes semantics. Emitting a
    // plain block rule when the source said `$csp=...` or `$redirect=...`
    // would silently produce the wrong behavior. Drop instead.
    if diagnostics
        .iter()
        .any(|d| matches!(d.error, ConversionError::UnsupportedOption(_)))
    {
        return EmitOutcome {
            rule: None,
            diagnostics,
        };
    }

    // Rule-fatal check 2: empty or whitespace-only pattern. A rule with no
    // URL pattern can't safely match anything; Chrome would reject it at
    // load time. Catch it here with a clear error.
    if rule.pattern.trim().is_empty() {
        diagnostics.push(Diagnostic {
            line_no,
            error: ConversionError::MalformedOption {
                name: "pattern".into(),
                reason: "empty URL pattern".into(),
            },
        });
        return EmitOutcome {
            rule: None,
            diagnostics,
        };
    }

    let (action, priority) = action_and_priority(is_exception, parsed.opts.important);
    let condition = build_condition(rule.pattern, &parsed.opts);

    EmitOutcome {
        rule: Some(DnrRule {
            id,
            priority,
            action,
            condition,
        }),
        diagnostics,
    }
}

/// Priority ladder. See module docs' table.
fn action_and_priority(is_exception: bool, important: bool) -> (DnrAction, u32) {
    match (is_exception, important) {
        (false, false) => (DnrAction::Block, 1),
        (true, false) => (DnrAction::Allow, 2),
        (false, true) => (DnrAction::Block, 3),
        (true, true) => (DnrAction::Allow, 4),
    }
}

/// Translate the typed options bundle into a DNR condition. Pattern is
/// passed through verbatim — ABP's pattern grammar (`||`, `^`, `|`, `*`)
/// is a subset of what Chrome's `urlFilter` accepts.
fn build_condition(pattern: &str, opts: &NetworkOptions) -> DnrCondition {
    // `$popup` — DNR has no popup-specific context, so the pragmatic
    // mapping is `main_frame`. This is additive: if the rule already
    // specified resource types (rare in real lists — almost all `$popup`
    // rules stand alone), we *append* MainFrame so the popup block still
    // happens without clobbering the author's intent. Guard against
    // duplicates so `popup,document` doesn't produce `[MainFrame, MainFrame]`.
    let mut resource_types: Vec<_> = opts
        .resource_types
        .iter()
        .copied()
        .map(Into::into)
        .collect();
    if opts.popup {
        let main_frame = options::ResourceType::MainFrame.into();
        if !resource_types.contains(&main_frame) {
            resource_types.push(main_frame);
        }
    }

    DnrCondition {
        url_filter: Some(pattern.to_string()),
        resource_types,
        excluded_resource_types: opts
            .excluded_resource_types
            .iter()
            .copied()
            .map(Into::into)
            .collect(),
        initiator_domains: opts.domains_include.clone(),
        excluded_initiator_domains: opts.domains_exclude.clone(),
        domain_type: opts.third_party.map(|tp| {
            if tp {
                DomainType::ThirdParty
            } else {
                DomainType::FirstParty
            }
        }),
        is_url_filter_case_sensitive: opts.match_case,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::dnr::ResourceTypeWire;

    fn net<'a>(pattern: &'a str, opts: &'a str) -> NetworkRule<'a> {
        NetworkRule {
            pattern,
            options: opts,
        }
    }

    fn unwrap_rule(out: EmitOutcome) -> DnrRule {
        assert!(
            out.diagnostics.is_empty(),
            "expected no diagnostics, got {:?}",
            out.diagnostics
        );
        out.rule.expect("expected a rule, got dropped")
    }

    #[test]
    fn plain_block_rule_has_priority_one() {
        let out = emit_network(&net("||ads.example.com^", ""), false, 10, 1);
        let r = unwrap_rule(out);
        assert_eq!(r.id, 1);
        assert_eq!(r.priority, 1);
        assert_eq!(r.action, DnrAction::Block);
        assert_eq!(
            r.condition.url_filter.as_deref(),
            Some("||ads.example.com^")
        );
    }

    #[test]
    fn exception_rule_has_priority_two_and_allow_action() {
        let out = emit_network(&net("||good.example.com^", ""), true, 12, 5);
        let r = unwrap_rule(out);
        assert_eq!(r.priority, 2);
        assert_eq!(r.action, DnrAction::Allow);
    }

    #[test]
    fn important_block_has_priority_three() {
        let out = emit_network(&net("||ads.example.com^", "important"), false, 1, 1);
        let r = unwrap_rule(out);
        assert_eq!(r.priority, 3);
        assert_eq!(r.action, DnrAction::Block);
    }

    #[test]
    fn important_allow_has_priority_four() {
        let out = emit_network(&net("||good.example.com^", "important"), true, 1, 1);
        let r = unwrap_rule(out);
        assert_eq!(r.priority, 4);
        assert_eq!(r.action, DnrAction::Allow);
    }

    #[test]
    fn resource_types_are_translated_to_wire() {
        let out = emit_network(&net("||x.com^", "script,image,~font"), false, 1, 1);
        let r = unwrap_rule(out);
        assert_eq!(
            r.condition.resource_types,
            vec![ResourceTypeWire::Script, ResourceTypeWire::Image]
        );
        assert_eq!(
            r.condition.excluded_resource_types,
            vec![ResourceTypeWire::Font]
        );
    }

    #[test]
    fn subdocument_maps_to_sub_frame_wire() {
        // End-to-end vocabulary check: ABP `subdocument` should emerge as
        // DNR `sub_frame`. If the From impl regresses, this catches it at
        // the integration point where it matters.
        let out = emit_network(&net("||x.com^", "subdocument"), false, 1, 1);
        let r = unwrap_rule(out);
        assert_eq!(r.condition.resource_types, vec![ResourceTypeWire::SubFrame]);
    }

    #[test]
    fn domain_list_maps_to_initiator_domains() {
        let out = emit_network(
            &net("||x.com^", "domain=foo.com|~bar.com|baz.com"),
            false,
            1,
            1,
        );
        let r = unwrap_rule(out);
        assert_eq!(r.condition.initiator_domains, vec!["foo.com", "baz.com"]);
        assert_eq!(r.condition.excluded_initiator_domains, vec!["bar.com"]);
    }

    #[test]
    fn third_party_becomes_domain_type() {
        let out = emit_network(&net("||x.com^", "third-party"), false, 1, 1);
        let r = unwrap_rule(out);
        assert_eq!(r.condition.domain_type, Some(DomainType::ThirdParty));

        let out = emit_network(&net("||x.com^", "first-party"), false, 1, 1);
        let r = unwrap_rule(out);
        assert_eq!(r.condition.domain_type, Some(DomainType::FirstParty));
    }

    #[test]
    fn match_case_flips_the_case_sensitive_flag() {
        let out = emit_network(&net("/Tracking/*", "match-case"), false, 1, 1);
        let r = unwrap_rule(out);
        assert!(r.condition.is_url_filter_case_sensitive);
    }

    #[test]
    fn unsupported_option_drops_the_rule() {
        // `$csp=` semantically changes what the rule *does* — silently
        // converting it to a block rule would be a correctness bug.
        // Drop with a diagnostic instead.
        let out = emit_network(&net("||x.com^", "csp=default-src 'self'"), false, 42, 1);
        assert!(out.rule.is_none(), "expected rule to be dropped");
        assert_eq!(out.diagnostics.len(), 1);
        assert_eq!(out.diagnostics[0].line_no, 42);
        assert_eq!(
            out.diagnostics[0].error,
            ConversionError::UnsupportedOption("csp".into())
        );
    }

    #[test]
    fn empty_pattern_drops_the_rule() {
        let out = emit_network(&net("   ", ""), false, 7, 1);
        assert!(out.rule.is_none());
        assert_eq!(out.diagnostics.len(), 1);
        match &out.diagnostics[0].error {
            ConversionError::MalformedOption { name, .. } => assert_eq!(name, "pattern"),
            other => panic!("expected MalformedOption, got {other:?}"),
        }
    }

    #[test]
    fn unknown_option_is_advisory_rule_still_emitted() {
        // `$xyzzy` is a typo, not a real option. The emitter can't know
        // what the user meant, but the pattern + other options are still
        // valid — emit the rule with a warning rather than drop it.
        let out = emit_network(&net("||x.com^", "xyzzy,script"), false, 3, 1);
        let r = out.rule.as_ref().expect("expected rule to be emitted");
        assert_eq!(r.condition.resource_types, vec![ResourceTypeWire::Script]);
        assert_eq!(out.diagnostics.len(), 1);
        assert_eq!(
            out.diagnostics[0].error,
            ConversionError::UnknownOption("xyzzy".into())
        );
    }

    #[test]
    fn diagnostics_carry_line_numbers() {
        // Line numbers are the whole point of tracking conversion errors
        // per-rule — users need to know which line in their filter list
        // had the problem. Pin this so a future refactor can't quietly
        // lose the attribution.
        let out = emit_network(&net("||x.com^", "xyzzy,zzz"), false, 137, 1);
        assert_eq!(out.diagnostics.len(), 2);
        assert!(out.diagnostics.iter().all(|d| d.line_no == 137));
    }

    #[test]
    fn popup_alone_emits_main_frame_block_rule() {
        // Shape: `||badpop.example^$popup` — the dominant pattern in
        // EasyList. Expect a block rule scoped to main_frame, no other
        // resource types.
        let out = emit_network(&net("||badpop.example^", "popup"), false, 1, 42);
        let r = unwrap_rule(out);
        assert_eq!(r.action, DnrAction::Block);
        assert_eq!(r.priority, 1);
        assert_eq!(r.condition.resource_types, vec![ResourceTypeWire::MainFrame]);
    }

    #[test]
    fn popup_with_third_party_preserves_domain_type() {
        // The second-most common popup shape in EasyList combines
        // `$popup,third-party`. Both fields should land in the condition.
        let out = emit_network(
            &net("||tracker.example^", "popup,third-party"),
            false,
            1,
            1,
        );
        let r = unwrap_rule(out);
        assert_eq!(r.condition.resource_types, vec![ResourceTypeWire::MainFrame]);
        assert_eq!(r.condition.domain_type, Some(DomainType::ThirdParty));
    }

    #[test]
    fn popup_appends_rather_than_overrides_explicit_resource_types() {
        // Rare in real lists, but pin the semantics: if the author
        // specified other resource types, popup adds main_frame rather
        // than silently dropping their intent.
        let out = emit_network(&net("||x.com^", "popup,script"), false, 1, 1);
        let r = unwrap_rule(out);
        assert_eq!(
            r.condition.resource_types,
            vec![ResourceTypeWire::Script, ResourceTypeWire::MainFrame]
        );
    }

    #[test]
    fn popup_plus_document_does_not_double_add_main_frame() {
        // `$popup,document` — `document` already maps to main_frame.
        // The popup branch must not append a duplicate.
        let out = emit_network(&net("||x.com^", "popup,document"), false, 1, 1);
        let r = unwrap_rule(out);
        assert_eq!(r.condition.resource_types, vec![ResourceTypeWire::MainFrame]);
    }

    #[test]
    fn realistic_easylist_shape_produces_expected_rule() {
        // Full integration at the emitter level. The input mimics a common
        // EasyList line. The assertion uses a snapshot over the whole
        // condition so we catch any cross-field regression.
        let out = emit_network(
            &net(
                "||tracker.com^",
                "third-party,script,domain=example.com|~safe.example.com",
            ),
            false,
            1,
            7,
        );
        let r = unwrap_rule(out);
        assert_eq!(r.id, 7);
        assert_eq!(r.priority, 1);
        assert_eq!(r.action, DnrAction::Block);
        let c = &r.condition;
        assert_eq!(c.url_filter.as_deref(), Some("||tracker.com^"));
        assert_eq!(c.resource_types, vec![ResourceTypeWire::Script]);
        assert!(c.excluded_resource_types.is_empty());
        assert_eq!(c.initiator_domains, vec!["example.com"]);
        assert_eq!(c.excluded_initiator_domains, vec!["safe.example.com"]);
        assert_eq!(c.domain_type, Some(DomainType::ThirdParty));
        assert!(!c.is_url_filter_case_sensitive);
    }
}
