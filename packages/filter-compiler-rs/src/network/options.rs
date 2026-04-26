//! Parser for a network rule's `$...` options string.
//!
//! Input: the raw text *after* the `$` on a network filter line. The lexer
//! already sliced this for us; we never see the `$` itself. Example inputs:
//!
//! ```text
//! "third-party,domain=foo.com|~bar.com,script,image"
//! "~third-party,match-case"
//! ""   (no options)
//! ```
//!
//! Output: a [`ParsedOptions`] carrying a typed [`NetworkOptions`] plus a
//! list of [`ConversionError`]s collected from the segments that didn't
//! parse. We deliberately collect errors rather than bail on the first —
//! the emitter (Phase 2 slice 4) decides rule-fatality per error kind.
//!
//! Scope:
//! - Resource types (negatable, no value): script, image, stylesheet,
//!   xmlhttprequest, subdocument, document, object, ping, media, font,
//!   websocket, other. Plus `all` as a documented no-op.
//! - Party modifier: third-party / first-party (negatable).
//! - Boolean flags: match-case, important (non-negatable, no value).
//! - Domain list: domain=a.com|b.com|~c.com.
//! - `$popup`: best-effort mapping to DNR `main_frame`. ABP `$popup`
//!   targets URLs opened in a new window/tab; DNR has no popup-specific
//!   context, so we treat it as a top-frame block. Minor over-block risk
//!   when the URL is also navigated to directly — strictly better than
//!   dropping the rule, which would lose the popup block entirely.
//! - Known-but-unsupported options: csp, redirect, redirect-rule,
//!   removeparam, rewrite, webrtc, genericblock, generichide, elemhide,
//!   document-hide. These produce `UnsupportedOption` errors — the
//!   emitter treats them as rule-fatal because they change matching
//!   semantics.
//!
//! Everything else becomes `UnknownOption`, which is advisory — the emitter
//! can still produce a DNR rule for "||ads.com^$xyzzy,script" by ignoring
//! the unknown part, because the network pattern itself is still well-formed.

use crate::errors::ConversionError;

/// Chrome declarativeNetRequest resource-type categories, spelled in ABP
/// vocabulary. The DNR-wire-format strings live in `network::dnr`; keeping
/// the enum free of DNR specifics lets us target other engines later
/// (Safari content blockers use a different string set).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ResourceType {
    Script,
    Image,
    Stylesheet,
    /// DNR: `xmlhttprequest`.
    XmlHttpRequest,
    /// DNR: `sub_frame`. ABP calls this `subdocument`.
    SubFrame,
    /// DNR: `main_frame`. ABP calls this `document`.
    MainFrame,
    Object,
    Ping,
    Media,
    Font,
    WebSocket,
    Other,
}

impl ResourceType {
    /// Parse an ABP resource-type name (case-insensitive). Returns `None` if
    /// the name is not a resource type — caller falls through to other option
    /// categories (party, domain, etc.) before giving up.
    fn from_abp_name(name: &str) -> Option<Self> {
        // `to_ascii_lowercase` allocates; option names are short (<= 15 chars
        // for everything we recognise) so the cost is negligible vs the
        // readability win of one clean `match`.
        Some(match name.to_ascii_lowercase().as_str() {
            "script" => Self::Script,
            "image" => Self::Image,
            "stylesheet" => Self::Stylesheet,
            "xmlhttprequest" => Self::XmlHttpRequest,
            "subdocument" => Self::SubFrame,
            "document" => Self::MainFrame,
            "object" => Self::Object,
            "ping" => Self::Ping,
            "media" => Self::Media,
            "font" => Self::Font,
            "websocket" => Self::WebSocket,
            "other" => Self::Other,
            _ => return None,
        })
    }
}

/// Parsed, typed network-rule options. Empty collections + `None` mean "no
/// constraint" — matches DNR's "field absent = matches anything" convention.
#[derive(Debug, Default, Clone)]
pub struct NetworkOptions {
    /// Resource types this rule applies to. Empty = all types.
    pub resource_types: Vec<ResourceType>,
    /// Resource types this rule must *not* apply to (from `~script` etc.).
    /// DNR emits these into `excludedResourceTypes`.
    pub excluded_resource_types: Vec<ResourceType>,
    /// Initiator domains this rule applies to.
    pub domains_include: Vec<String>,
    /// Initiator domains explicitly excluded (the `~foo.com` entries in
    /// `domain=a.com|~b.com`).
    pub domains_exclude: Vec<String>,
    /// `Some(true)` = only third-party requests; `Some(false)` = only
    /// first-party; `None` = either. Matches DNR's `domainType` which has
    /// `thirdParty` / `firstParty` / absent.
    pub third_party: Option<bool>,
    /// Case-sensitive URL matching. DNR default is already case-insensitive,
    /// so we flip the field only when the user asked for it.
    pub match_case: bool,
    /// Bumps this rule's priority so it wins ties against ordinary rules.
    pub important: bool,
    /// `$popup` — target URLs opened as popups (new window/tab). DNR has
    /// no popup context, so the emitter maps this to `main_frame` (plus
    /// whatever other resource types the rule already declares). See the
    /// module docs for the over-block trade-off.
    pub popup: bool,
}

/// Parse result. We always return a best-effort `NetworkOptions` plus any
/// errors encountered; the emitter decides which errors are rule-fatal.
/// That split (parser returns everything, emitter makes policy) keeps this
/// module reusable if we later target an engine with different fatality
/// rules (e.g. Safari's content blocker, which has no CSP equivalent at all).
#[derive(Debug, Default, Clone)]
pub struct ParsedOptions {
    pub opts: NetworkOptions,
    pub errors: Vec<ConversionError>,
}

/// Parse the options string. Never panics, never returns Err — all problems
/// are collected into `errors`. An empty `src` returns a default `ParsedOptions`.
pub fn parse_options(src: &str) -> ParsedOptions {
    let mut out = ParsedOptions::default();
    if src.is_empty() {
        return out;
    }
    for segment in src.split(',') {
        parse_segment(segment, &mut out);
    }
    out
}

/// Options that ABP defines but we haven't implemented. Hitting one should
/// be loud, not silent — a user's CSP rule becoming a plain block rule would
/// be a correctness bug, not a missing feature.
const KNOWN_UNSUPPORTED: &[&str] = &[
    "csp",
    "redirect",
    "redirect-rule",
    "removeparam",
    "rewrite",
    "webrtc",
    "genericblock",
    "generichide",
    "elemhide",
    "document-hide",
];

fn parse_segment(raw: &str, out: &mut ParsedOptions) {
    let seg = raw.trim();
    if seg.is_empty() {
        out.errors.push(ConversionError::EmptyOption);
        return;
    }

    // Leading `~` is the ABP "negation" marker. For resource types it flips
    // positive/excluded. For party modifiers it flips third/first. For
    // anything else it's a malformed option.
    let (negated, rest) = match seg.strip_prefix('~') {
        Some(r) => (true, r),
        None => (false, seg),
    };

    // `name=value` split. Most options have no value; domain= is the main
    // one that does. `split_once` gives us None-or-(name, value).
    let (name, value) = match rest.split_once('=') {
        Some((n, v)) => (n, Some(v)),
        None => (rest, None),
    };

    // Resource-type fast path — checked first because it's the highest-volume
    // case in real filter lists.
    if let Some(kind) = ResourceType::from_abp_name(name) {
        if value.is_some() {
            out.errors.push(malformed(
                name,
                "resource-type option does not take a value",
            ));
            return;
        }
        if negated {
            out.opts.excluded_resource_types.push(kind);
        } else {
            out.opts.resource_types.push(kind);
        }
        return;
    }

    // Party modifier. `third-party` positive → third_party = Some(true);
    // `~third-party` → Some(false); `first-party` → Some(false); `~first-party` → Some(true).
    if name.eq_ignore_ascii_case("third-party") {
        if value.is_some() {
            out.errors.push(malformed(name, "does not take a value"));
            return;
        }
        out.opts.third_party = Some(!negated);
        return;
    }
    if name.eq_ignore_ascii_case("first-party") {
        if value.is_some() {
            out.errors.push(malformed(name, "does not take a value"));
            return;
        }
        out.opts.third_party = Some(negated);
        return;
    }

    // Non-negatable, no-value flags.
    if name.eq_ignore_ascii_case("match-case") {
        if negated || value.is_some() {
            out.errors
                .push(malformed(name, "not negatable and takes no value"));
            return;
        }
        out.opts.match_case = true;
        return;
    }
    if name.eq_ignore_ascii_case("important") {
        if negated || value.is_some() {
            out.errors
                .push(malformed(name, "not negatable and takes no value"));
            return;
        }
        out.opts.important = true;
        return;
    }

    // `$popup` — see module docs for the DNR mapping rationale. Non-negatable:
    // `~popup` is a real uBO syntax ("don't apply to popup context") that we
    // can't implement without popup-context detection, and it doesn't occur
    // in EasyList/EasyPrivacy anyway. Rejecting it keeps the flag boolean-
    // clean and surfaces any future list that adopts the syntax.
    if name.eq_ignore_ascii_case("popup") {
        if negated || value.is_some() {
            out.errors
                .push(malformed(name, "not negatable and takes no value"));
            return;
        }
        out.opts.popup = true;
        return;
    }

    // `$all` means "match all resource types". DNR treats an empty resource
    // type list the same way, so `$all` is a documented no-op for us — we
    // just accept it silently. If the user wrote `script,all` they get
    // script-only matching (the `all` adds nothing); that's the ABP semantic.
    if name.eq_ignore_ascii_case("all") {
        if negated || value.is_some() {
            out.errors
                .push(malformed(name, "not negatable and takes no value"));
        }
        return;
    }

    // Domain list.
    if name.eq_ignore_ascii_case("domain") {
        if negated {
            out.errors.push(malformed(
                name,
                "cannot be negated at the option level; prefix individual domains with `~`",
            ));
            return;
        }
        match value {
            None | Some("") => {
                out.errors
                    .push(malformed(name, "expected `=` followed by a domain list"));
            }
            Some(v) => {
                parse_domain_list(
                    v,
                    &mut out.opts.domains_include,
                    &mut out.opts.domains_exclude,
                );
            }
        }
        return;
    }

    // Known but not yet supported.
    if KNOWN_UNSUPPORTED
        .iter()
        .any(|u| name.eq_ignore_ascii_case(u))
    {
        out.errors
            .push(ConversionError::UnsupportedOption(name.to_string()));
        return;
    }

    // Fallthrough.
    out.errors
        .push(ConversionError::UnknownOption(name.to_string()));
}

/// Short helper so the call sites don't bury intent in boilerplate.
fn malformed(name: &str, reason: &str) -> ConversionError {
    ConversionError::MalformedOption {
        name: name.to_string(),
        reason: reason.to_string(),
    }
}

/// Split a `domain=` value into include / exclude vecs.
///
/// Rules:
///   - `|` separates entries.
///   - `~` prefix puts the entry in the exclude list (minus the prefix).
///   - Empty segments (leading `|`, doubled `||`, trailing `|`) are
///     silently dropped. EasyList has historical malformed entries that
///     shouldn't abort compilation.
fn parse_domain_list(raw: &str, include: &mut Vec<String>, exclude: &mut Vec<String>) {
    for entry in raw.split('|') {
        if entry.is_empty() {
            continue;
        }
        if let Some(rest) = entry.strip_prefix('~') {
            if !rest.is_empty() {
                exclude.push(rest.to_string());
            }
        } else {
            include.push(entry.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expect_ok(src: &str) -> NetworkOptions {
        let p = parse_options(src);
        assert!(
            p.errors.is_empty(),
            "expected no errors for {src:?}, got {:?}",
            p.errors
        );
        p.opts
    }

    #[test]
    fn empty_string_yields_default() {
        let p = parse_options("");
        assert!(p.errors.is_empty());
        assert!(p.opts.resource_types.is_empty());
        assert!(p.opts.domains_include.is_empty());
        assert_eq!(p.opts.third_party, None);
        assert!(!p.opts.match_case);
        assert!(!p.opts.important);
    }

    #[test]
    fn single_resource_type() {
        let o = expect_ok("script");
        assert_eq!(o.resource_types, vec![ResourceType::Script]);
        assert!(o.excluded_resource_types.is_empty());
    }

    #[test]
    fn multiple_resource_types_preserve_order() {
        // Order matters for deterministic output — downstream serializers
        // will hash this list for dedup, so "script,image" and "image,script"
        // must produce different NetworkOptions.
        let o = expect_ok("script,image,font");
        assert_eq!(
            o.resource_types,
            vec![
                ResourceType::Script,
                ResourceType::Image,
                ResourceType::Font
            ]
        );
    }

    #[test]
    fn subdocument_maps_to_subframe() {
        // Cross-vocabulary check: ABP `subdocument` must resolve to our
        // `SubFrame` variant, not a separate one. Same for `document` → MainFrame.
        let o = expect_ok("subdocument,document");
        assert_eq!(
            o.resource_types,
            vec![ResourceType::SubFrame, ResourceType::MainFrame]
        );
    }

    #[test]
    fn negated_resource_type_lands_in_excluded() {
        let o = expect_ok("~script");
        assert!(o.resource_types.is_empty());
        assert_eq!(o.excluded_resource_types, vec![ResourceType::Script]);
    }

    #[test]
    fn mixed_positive_and_negated_resource_types() {
        let o = expect_ok("script,~image,font");
        assert_eq!(
            o.resource_types,
            vec![ResourceType::Script, ResourceType::Font]
        );
        assert_eq!(o.excluded_resource_types, vec![ResourceType::Image]);
    }

    #[test]
    fn third_party() {
        assert_eq!(expect_ok("third-party").third_party, Some(true));
        assert_eq!(expect_ok("~third-party").third_party, Some(false));
    }

    #[test]
    fn first_party() {
        assert_eq!(expect_ok("first-party").third_party, Some(false));
        assert_eq!(expect_ok("~first-party").third_party, Some(true));
    }

    #[test]
    fn boolean_flags() {
        let o = expect_ok("match-case,important");
        assert!(o.match_case);
        assert!(o.important);
    }

    #[test]
    fn popup_flag_sets_bool() {
        let o = expect_ok("popup");
        assert!(o.popup);
        // Combined with third-party — the exact shape of 95%+ of EasyList's
        // popup rules. Prove the flag coexists with other options cleanly.
        let o = expect_ok("popup,third-party");
        assert!(o.popup);
        assert_eq!(o.third_party, Some(true));
    }

    #[test]
    fn popup_is_not_negatable() {
        // `~popup` is real uBO syntax but it inverts rule *applicability*
        // to popup context, which we can't implement without popup
        // detection. Reject with a clear diagnostic rather than silently
        // producing a rule that ignores the negation.
        let p = parse_options("~popup");
        assert_eq!(p.errors.len(), 1);
        match &p.errors[0] {
            ConversionError::MalformedOption { name, .. } => assert_eq!(name, "popup"),
            other => panic!("expected MalformedOption, got {other:?}"),
        }
        assert!(!p.opts.popup);
    }

    #[test]
    fn popup_rejects_value() {
        let p = parse_options("popup=x");
        assert_eq!(p.errors.len(), 1);
        assert!(matches!(
            p.errors[0],
            ConversionError::MalformedOption { .. }
        ));
    }

    #[test]
    fn important_is_not_negatable() {
        let p = parse_options("~important");
        assert_eq!(p.errors.len(), 1);
        match &p.errors[0] {
            ConversionError::MalformedOption { name, .. } => assert_eq!(name, "important"),
            other => panic!("expected MalformedOption, got {other:?}"),
        }
    }

    #[test]
    fn all_is_a_noop() {
        // `$all` is documented-but-dropped: it's ABP's explicit "any type"
        // marker, which is DNR's default. No effect on NetworkOptions and
        // no errors. See also `all_rejects_value_and_negation` below.
        let o = expect_ok("all");
        assert!(o.resource_types.is_empty());
        assert!(o.excluded_resource_types.is_empty());
    }

    #[test]
    fn all_rejects_value_and_negation() {
        assert_eq!(parse_options("~all").errors.len(), 1);
        assert_eq!(parse_options("all=script").errors.len(), 1);
    }

    #[test]
    fn domain_list_simple() {
        let o = expect_ok("domain=foo.com");
        assert_eq!(o.domains_include, vec!["foo.com"]);
        assert!(o.domains_exclude.is_empty());
    }

    #[test]
    fn domain_list_multiple() {
        let o = expect_ok("domain=foo.com|bar.com|baz.com");
        assert_eq!(o.domains_include, vec!["foo.com", "bar.com", "baz.com"]);
    }

    #[test]
    fn domain_list_with_exclusions() {
        let o = expect_ok("domain=foo.com|~bar.com|baz.com");
        assert_eq!(o.domains_include, vec!["foo.com", "baz.com"]);
        assert_eq!(o.domains_exclude, vec!["bar.com"]);
    }

    #[test]
    fn domain_list_empty_segments_are_dropped_silently() {
        // EasyList has historical malformed entries like `domain=|foo.com||bar.com|`.
        // These shouldn't abort compilation or produce errors — just drop the
        // empty segments. We explicitly assert zero errors to catch a future
        // regression that upgrades this to a warning.
        let p = parse_options("domain=|foo.com||bar.com|");
        assert!(p.errors.is_empty(), "got errors: {:?}", p.errors);
        assert_eq!(p.opts.domains_include, vec!["foo.com", "bar.com"]);
    }

    #[test]
    fn domain_missing_value_is_malformed() {
        let p = parse_options("domain=");
        assert_eq!(p.errors.len(), 1);
        match &p.errors[0] {
            ConversionError::MalformedOption { name, .. } => assert_eq!(name, "domain"),
            other => panic!("expected MalformedOption, got {other:?}"),
        }
    }

    #[test]
    fn domain_without_equals_is_malformed() {
        // `$domain` with no `=` — user probably meant `$domain=something`.
        // The option name is recognised; the missing value is the bug.
        let p = parse_options("domain");
        assert_eq!(p.errors.len(), 1);
        assert!(matches!(
            p.errors[0],
            ConversionError::MalformedOption { .. }
        ));
    }

    #[test]
    fn domain_cannot_be_outer_negated() {
        // `$~domain=foo.com` is malformed; ABP negates *individual* domains
        // via `~foo.com` inside the value, not the whole option.
        let p = parse_options("~domain=foo.com");
        assert_eq!(p.errors.len(), 1);
    }

    #[test]
    fn unknown_option_is_flagged() {
        let p = parse_options("thirdparty"); // missing hyphen
        assert_eq!(
            p.errors,
            vec![ConversionError::UnknownOption("thirdparty".into())]
        );
    }

    #[test]
    fn unsupported_options_are_distinguished_from_unknown() {
        // These are real ABP options that we specifically haven't implemented
        // yet — users shouldn't think it's a typo. The distinction between
        // Unknown and Unsupported is the whole reason for two variants.
        for (input, name) in [
            ("csp=default-src 'self'", "csp"),
            ("redirect=noop.js", "redirect"),
            ("webrtc", "webrtc"),
            ("generichide", "generichide"),
        ] {
            let p = parse_options(input);
            assert_eq!(p.errors.len(), 1, "input {input:?}");
            assert_eq!(
                p.errors[0],
                ConversionError::UnsupportedOption(name.into()),
                "input {input:?}"
            );
        }
    }

    #[test]
    fn trailing_comma_is_empty_option() {
        let p = parse_options("script,");
        assert_eq!(p.errors, vec![ConversionError::EmptyOption]);
        // ...but the script option before the comma still parsed fine.
        assert_eq!(p.opts.resource_types, vec![ResourceType::Script]);
    }

    #[test]
    fn errors_are_accumulated_not_short_circuited() {
        // Two bad segments and one good one: prove the parser doesn't bail
        // on the first error. Emitter decides what to do with the pile.
        let p = parse_options("bogus1,script,bogus2");
        assert_eq!(p.opts.resource_types, vec![ResourceType::Script]);
        assert_eq!(p.errors.len(), 2);
        assert_eq!(p.errors[0], ConversionError::UnknownOption("bogus1".into()));
        assert_eq!(p.errors[1], ConversionError::UnknownOption("bogus2".into()));
    }

    #[test]
    fn realistic_easylist_combo() {
        // Shape cribbed from a real EasyList line — third-party + resource
        // type filter + domain include/exclude, all at once.
        let o = expect_ok("third-party,script,domain=example.com|~safe.example.com");
        assert_eq!(o.third_party, Some(true));
        assert_eq!(o.resource_types, vec![ResourceType::Script]);
        assert_eq!(o.domains_include, vec!["example.com"]);
        assert_eq!(o.domains_exclude, vec!["safe.example.com"]);
        assert!(!o.match_case);
        assert!(!o.important);
    }

    #[test]
    fn case_insensitive_option_names() {
        // uBlock accepts `$Third-Party` and `$SCRIPT`. Real lists use
        // lowercase, but we shouldn't be brittle about it.
        let o = expect_ok("Third-Party,SCRIPT,Match-Case");
        assert_eq!(o.third_party, Some(true));
        assert_eq!(o.resource_types, vec![ResourceType::Script]);
        assert!(o.match_case);
    }
}
