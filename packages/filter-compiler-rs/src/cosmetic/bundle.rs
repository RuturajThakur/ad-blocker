//! Cosmetic bundle — the JSON artefact the content script loads at page start.
//!
//! # Wire shape
//! ```text
//! {
//!   "generic_hide":       [".ad-banner", "div[id^=\"adslot-\"]"],
//!   "domain_hide":        { "example.com": [".sponsor"], ... },
//!   "domain_exceptions":  { "example.com": [".sponsor"], ... }
//! }
//! ```
//!
//! Apply order the content script is expected to follow:
//!   1. Hide everything in `generic_hide` (all documents).
//!   2. Hide everything in `domain_hide[current_domain]`.
//!   3. Un-hide (remove matching selectors) everything in
//!      `domain_exceptions[current_domain]`.
//!
//! That order is why `domain_exceptions` buckets per-domain rather than
//! per-selector: exceptions are intrinsically scoped to a site, and the
//! overwhelming majority of ABP exception rules in EasyList have a non-empty
//! domain list.
//!
//! # Determinism
//! `BTreeMap` is chosen over `HashMap` so serialized JSON is byte-identical
//! for byte-identical inputs. Integration tests and diff-based review both
//! rely on that. The cost is O(log n) insert vs. amortized O(1) — negligible
//! at the scale of one filter list (low millions of rules at the extreme).

use std::collections::BTreeMap;

use serde::Serialize;

use crate::errors::ConversionError;
use crate::token::{CosmeticRule, CosmeticVariant};

/// Accumulated cosmetic output for an entire filter list.
///
/// Mutated in place as the compile loop iterates tokens. Empty buckets are
/// still serialized as `[]` / `{}` — callers can rely on the three keys
/// always being present.
#[derive(Debug, Default, Clone, Serialize)]
pub struct CosmeticBundle {
    /// Selectors to hide on every page, regardless of host.
    pub generic_hide: Vec<String>,
    /// Per-domain selectors to hide. Key is the domain as it appeared in the
    /// source (lowercased by the list author; we don't normalize).
    pub domain_hide: BTreeMap<String, Vec<String>>,
    /// Per-domain selectors to *un*-hide, removing any match from the
    /// `generic_hide` + `domain_hide` union for that domain.
    pub domain_exceptions: BTreeMap<String, Vec<String>>,
}

/// Per-rule emit result, parallel to `network::emit::EmitOutcome`.
///
/// `applied` is true iff the rule successfully contributed a selector to the
/// bundle. When `applied` is false *and* `diagnostics` is empty, the rule was
/// silently accepted as a no-op — that shouldn't happen in v1 but the shape
/// is left open for defensive use.
#[derive(Debug, Default)]
pub struct CosmeticOutcome {
    pub applied: bool,
    pub diagnostics: Vec<Diagnostic>,
}

/// Line-tagged conversion error for the cosmetic pipeline. Mirrors
/// `network::emit::Diagnostic` intentionally — `lib.rs` has one `From` impl
/// per source to flatten into the public `DiagnosticJson`.
#[derive(Debug, Clone)]
pub struct Diagnostic {
    pub line_no: u32,
    pub error: ConversionError,
}

impl CosmeticBundle {
    /// True iff all three buckets are empty. Used by tests and as a hint for
    /// the service worker (skip content-script injection if no cosmetics).
    pub fn is_empty(&self) -> bool {
        self.generic_hide.is_empty()
            && self.domain_hide.is_empty()
            && self.domain_exceptions.is_empty()
    }
}

/// Consume one cosmetic token and merge its contribution into `bundle`.
///
/// Contract:
///   - A successful ElementHide with no domains appends to `generic_hide`.
///   - A successful ElementHide with positive domains appends to each of
///     those domains' `domain_hide` entry. `~`-negated domains in the list
///     are ignored for v1 (with no diagnostic — ABP lists commonly mix
///     positive + negative domains and we're representing only the positives).
///   - A successful ElementHide with *only* negated domains drops the rule
///     with an `UnsupportedCosmetic("negated-domain-only")` diagnostic —
///     the "generic-except" semantics need a fourth bucket.
///   - A successful cosmetic exception (`#@#`) with positive domains
///     appends to each domain's `domain_exceptions`. Same negated-only
///     caveat applies.
///   - A generic cosmetic exception (`#@#.foo` with no domain) drops with
///     an `UnsupportedCosmetic("generic-exception")` diagnostic.
///   - Any non-ElementHide variant drops with a matching
///     `UnsupportedCosmetic(variant-slug)` diagnostic.
///
/// The selector body is stored verbatim — no CSS validation in v1. Malformed
/// selectors will be silently dropped by the browser's CSSOM at injection
/// time, which is loud enough for now. Real CSS parsing is a v2 concern.
pub fn emit_cosmetic(
    rule: &CosmeticRule<'_>,
    is_exception: bool,
    line_no: u32,
    bundle: &mut CosmeticBundle,
) -> CosmeticOutcome {
    let mut out = CosmeticOutcome::default();

    // Route unsupported variants first. They short-circuit before we touch
    // the domain list, so we never half-record a rule that also has a
    // variant problem.
    let variant_slug = match rule.variant {
        CosmeticVariant::ElementHide => None,
        CosmeticVariant::ExtendedHide => Some("extended-hide"),
        CosmeticVariant::CssInject => Some("css-inject"),
        CosmeticVariant::ScriptInject => Some("script-inject"),
        CosmeticVariant::HtmlFilter => Some("html-filter"),
    };
    if let Some(slug) = variant_slug {
        out.diagnostics.push(Diagnostic {
            line_no,
            error: ConversionError::UnsupportedCosmetic(slug.to_string()),
        });
        return out;
    }

    // Empty body is malformed — `##` with nothing after it. Chrome would
    // reject the eventual CSS rule; we reject now for a cleaner diagnostic.
    let body = rule.body.trim();
    if body.is_empty() {
        out.diagnostics.push(Diagnostic {
            line_no,
            error: ConversionError::UnsupportedCosmetic("empty-selector".to_string()),
        });
        return out;
    }

    let (includes, excludes) = split_domains(rule.domains);

    // Generic cosmetic exception (`#@#foo` with no domains) — can't express
    // in v1's bucket shape. See module docs.
    if is_exception && includes.is_empty() && excludes.is_empty() {
        out.diagnostics.push(Diagnostic {
            line_no,
            error: ConversionError::UnsupportedCosmetic("generic-exception".to_string()),
        });
        return out;
    }

    // Negated-only domain list (`~foo.com##.ad`) — would need a
    // "generic-except" bucket. Deferred.
    if includes.is_empty() && !excludes.is_empty() {
        out.diagnostics.push(Diagnostic {
            line_no,
            error: ConversionError::UnsupportedCosmetic("negated-domain-only".to_string()),
        });
        return out;
    }

    // Route into the right bucket. Note: excluded domains in a
    // positive-domain list are *silently dropped* in v1 — `example.com,~sub.example.com##.ad`
    // becomes "hide on example.com" with no sub.example.com exclusion. This
    // loses precision but keeps the bundle shape simple. Filter-list authors
    // who need that granularity can write an explicit `#@#` rule.
    if includes.is_empty() {
        // Universal.
        if is_exception {
            // Shouldn't reach: the generic-exception path short-circuits above.
            unreachable!("generic exception handled earlier");
        }
        bundle.generic_hide.push(body.to_string());
    } else {
        let target = if is_exception {
            &mut bundle.domain_exceptions
        } else {
            &mut bundle.domain_hide
        };
        for dom in includes {
            target
                .entry(dom.to_string())
                .or_default()
                .push(body.to_string());
        }
    }

    out.applied = true;
    out
}

/// Split a comma-separated cosmetic-domain list into `(includes, excludes)`.
///
/// ABP cosmetic domains use `,` (not `|` like network `$domain=`). A leading
/// `~` on a segment flips it to exclude. Empty segments (from `,,` or a
/// leading/trailing comma) are dropped silently — EasyList has drive-by
/// malformed lines and we shouldn't abort over them.
fn split_domains(list: &str) -> (Vec<&str>, Vec<&str>) {
    let mut inc = Vec::new();
    let mut exc = Vec::new();
    for seg in list.split(',') {
        let seg = seg.trim();
        if seg.is_empty() {
            continue;
        }
        if let Some(rest) = seg.strip_prefix('~') {
            let rest = rest.trim();
            if !rest.is_empty() {
                exc.push(rest);
            }
        } else {
            inc.push(seg);
        }
    }
    (inc, exc)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule<'a>(domains: &'a str, variant: CosmeticVariant, body: &'a str) -> CosmeticRule<'a> {
        CosmeticRule {
            domains,
            variant,
            body,
        }
    }

    #[test]
    fn universal_element_hide_lands_in_generic_bucket() {
        let mut b = CosmeticBundle::default();
        let r = rule("", CosmeticVariant::ElementHide, ".ad-banner");
        let out = emit_cosmetic(&r, false, 1, &mut b);
        assert!(out.applied);
        assert!(out.diagnostics.is_empty());
        assert_eq!(b.generic_hide, vec![".ad-banner".to_string()]);
        assert!(b.domain_hide.is_empty());
        assert!(b.domain_exceptions.is_empty());
    }

    #[test]
    fn scoped_element_hide_lands_in_domain_bucket() {
        let mut b = CosmeticBundle::default();
        let r = rule("example.com", CosmeticVariant::ElementHide, ".sponsor");
        let out = emit_cosmetic(&r, false, 1, &mut b);
        assert!(out.applied);
        assert_eq!(
            b.domain_hide.get("example.com"),
            Some(&vec![".sponsor".to_string()])
        );
    }

    #[test]
    fn comma_separated_domains_fan_out() {
        // example.com,sub.example.com##.x should add the selector under BOTH
        // domain keys. This is how EasyList expresses "same rule, multiple
        // sites" — and it's why we chose the fan-out representation instead
        // of a single list entry with a domain set.
        let mut b = CosmeticBundle::default();
        let r = rule(
            "example.com,sub.example.com",
            CosmeticVariant::ElementHide,
            ".x",
        );
        emit_cosmetic(&r, false, 1, &mut b);
        assert_eq!(b.domain_hide.len(), 2);
        assert!(b.domain_hide.contains_key("example.com"));
        assert!(b.domain_hide.contains_key("sub.example.com"));
    }

    #[test]
    fn cosmetic_exception_lands_in_exceptions_bucket() {
        let mut b = CosmeticBundle::default();
        let r = rule("example.com", CosmeticVariant::ElementHide, ".ok");
        let out = emit_cosmetic(&r, true, 1, &mut b);
        assert!(out.applied);
        assert_eq!(
            b.domain_exceptions.get("example.com"),
            Some(&vec![".ok".to_string()])
        );
        // And, crucially, the exception did *not* also land in domain_hide.
        assert!(b.domain_hide.is_empty());
    }

    #[test]
    fn extended_hide_is_dropped_with_diagnostic() {
        let mut b = CosmeticBundle::default();
        let r = rule("example.com", CosmeticVariant::ExtendedHide, ".x:has(.ad)");
        let out = emit_cosmetic(&r, false, 42, &mut b);
        assert!(!out.applied);
        assert_eq!(out.diagnostics.len(), 1);
        assert_eq!(out.diagnostics[0].line_no, 42);
        assert!(matches!(
            &out.diagnostics[0].error,
            ConversionError::UnsupportedCosmetic(s) if s == "extended-hide"
        ));
        assert!(b.is_empty());
    }

    #[test]
    fn css_inject_script_inject_html_filter_all_dropped() {
        // Not three separate tests because the assertion shape is identical —
        // we're really just pinning the variant → slug table.
        let cases = &[
            (CosmeticVariant::CssInject, "css-inject"),
            (CosmeticVariant::ScriptInject, "script-inject"),
            (CosmeticVariant::HtmlFilter, "html-filter"),
        ];
        for (v, want_slug) in cases {
            let mut b = CosmeticBundle::default();
            let r = rule("example.com", *v, "body");
            let out = emit_cosmetic(&r, false, 1, &mut b);
            assert!(!out.applied, "variant {v:?} should drop");
            assert_eq!(out.diagnostics.len(), 1);
            match &out.diagnostics[0].error {
                ConversionError::UnsupportedCosmetic(s) => assert_eq!(s, want_slug),
                other => panic!("expected UnsupportedCosmetic, got {other:?}"),
            }
        }
    }

    #[test]
    fn generic_cosmetic_exception_is_dropped() {
        let mut b = CosmeticBundle::default();
        let r = rule("", CosmeticVariant::ElementHide, ".ad");
        let out = emit_cosmetic(&r, true, 1, &mut b);
        assert!(!out.applied);
        assert!(matches!(
            &out.diagnostics[0].error,
            ConversionError::UnsupportedCosmetic(s) if s == "generic-exception"
        ));
    }

    #[test]
    fn negated_domain_only_is_dropped() {
        let mut b = CosmeticBundle::default();
        let r = rule("~example.com", CosmeticVariant::ElementHide, ".ad");
        let out = emit_cosmetic(&r, false, 1, &mut b);
        assert!(!out.applied);
        assert!(matches!(
            &out.diagnostics[0].error,
            ConversionError::UnsupportedCosmetic(s) if s == "negated-domain-only"
        ));
    }

    #[test]
    fn mixed_positive_and_negated_keeps_positives_only() {
        // `example.com,~sub.example.com##.ad` — v1 stores the rule under
        // example.com and silently ignores the sub.example.com exclusion.
        // This test exists to *pin* that behavior so a future change that
        // flips to "drop with diagnostic" doesn't do it silently.
        let mut b = CosmeticBundle::default();
        let r = rule(
            "example.com,~sub.example.com",
            CosmeticVariant::ElementHide,
            ".ad",
        );
        let out = emit_cosmetic(&r, false, 1, &mut b);
        assert!(out.applied);
        assert!(out.diagnostics.is_empty());
        assert_eq!(b.domain_hide.len(), 1);
        assert!(b.domain_hide.contains_key("example.com"));
    }

    #[test]
    fn empty_selector_is_dropped() {
        let mut b = CosmeticBundle::default();
        let r = rule("example.com", CosmeticVariant::ElementHide, "   ");
        let out = emit_cosmetic(&r, false, 1, &mut b);
        assert!(!out.applied);
        assert!(matches!(
            &out.diagnostics[0].error,
            ConversionError::UnsupportedCosmetic(s) if s == "empty-selector"
        ));
    }

    #[test]
    fn multiple_rules_accumulate_in_source_order() {
        // Source order is part of the bundle contract — not alphabetic, not
        // deduplicated. A filter-list author inserting a rule at line N
        // relies on it landing after the rule at line N-1.
        let mut b = CosmeticBundle::default();
        emit_cosmetic(
            &rule("", CosmeticVariant::ElementHide, ".first"),
            false,
            1,
            &mut b,
        );
        emit_cosmetic(
            &rule("", CosmeticVariant::ElementHide, ".second"),
            false,
            2,
            &mut b,
        );
        assert_eq!(b.generic_hide, vec![".first", ".second"]);
    }

    #[test]
    fn bundle_serializes_to_snake_case_with_empty_collections() {
        // Pin the wire shape. Even an empty bundle must serialize to an
        // object with all three keys present — content script expects them.
        let b = CosmeticBundle::default();
        let v = serde_json::to_value(&b).unwrap();
        assert!(v["generic_hide"].is_array());
        assert!(v["domain_hide"].is_object());
        assert!(v["domain_exceptions"].is_object());
        assert_eq!(v["generic_hide"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn is_empty_reflects_all_three_buckets() {
        let mut b = CosmeticBundle::default();
        assert!(b.is_empty());
        b.generic_hide.push(".x".to_string());
        assert!(!b.is_empty());
    }

    #[test]
    fn split_domains_handles_negations_and_empties() {
        let (inc, exc) = split_domains("example.com, ~foo.com,,bar.com, ~ , baz.com");
        assert_eq!(inc, vec!["example.com", "bar.com", "baz.com"]);
        assert_eq!(exc, vec!["foo.com"]);
    }
}
