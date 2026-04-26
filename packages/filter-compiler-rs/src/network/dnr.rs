//! Chrome declarativeNetRequest rule types, serde-tuned to match Chrome's
//! exact on-the-wire shape.
//!
//! These types are what gets serialized into the ruleset JSON that ships
//! in the extension's `rule_resources`. Every `#[serde(...)]` attribute in
//! this file is load-bearing: Chrome rejects rulesets with unexpected field
//! names, unknown enum strings, or missing required fields.
//!
//! Field reference (kept in sync with the Chrome docs):
//! <https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#type-Rule>
//!
//! Why two resource-type enums exist in this crate:
//!   - `network::options::ResourceType` is "what ABP filter syntax can
//!     express" — the 12 options ABP gives users.
//!   - [`ResourceTypeWire`] in this module is "what DNR accepts" — 15
//!     types including three with no ABP spelling (csp_report,
//!     webtransport, webbundle). The options enum is a strict subset of
//!     the wire enum; converting ABP → wire is total via [`From`].
//!
//! Scope of this module is *types + serialization only*. Building a rule
//! from a parsed `NetworkRule` + `NetworkOptions` lives in `emit.rs`
//! (Phase 2 slice 4). Keeping the construction logic out lets us unit-test
//! the wire format independently.

use serde::{Deserialize, Serialize};

use crate::network::options;

/// Chrome DNR action type. Phase 2 implements block + allow; redirect,
/// modifyHeaders, allowAllRequests, and upgradeScheme are deferred to
/// later phases.
///
/// Serde emits this as `{ "type": "block" }` / `{ "type": "allow" }` —
/// the `tag = "type"` + `rename_all = "camelCase"` combo matches Chrome's
/// documented shape exactly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DnrAction {
    Block,
    Allow,
}

/// Chrome DNR domain-type discriminator. `$third-party` / `$first-party`
/// map here; absence means the rule matches both.
///
/// Chrome's JSON uses camelCase (`thirdParty`, `firstParty`). Our
/// `rename_all = "camelCase"` produces exactly those strings from the
/// variant names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DomainType {
    FirstParty,
    ThirdParty,
}

/// Chrome DNR resource-type enum. Superset of what ABP syntax can express.
///
/// Wire names are mostly snake_case (matching the variant names), with one
/// exception: `xmlhttprequest` is one word on the wire, not `xml_http_request`,
/// so it gets an explicit `#[serde(rename)]`. That rename is the single most
/// fragile line in this file — if a future Chrome release changes it, the
/// snapshot tests in this module fail loud and we know to update.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceTypeWire {
    MainFrame,
    SubFrame,
    Stylesheet,
    Script,
    Image,
    Font,
    Object,
    #[serde(rename = "xmlhttprequest")]
    XmlHttpRequest,
    Ping,
    CspReport,
    Media,
    Websocket,
    Webtransport,
    Webbundle,
    Other,
}

impl From<options::ResourceType> for ResourceTypeWire {
    /// Total mapping — every ABP-expressible type has a DNR equivalent.
    /// The reverse direction is *not* total (csp_report, webtransport,
    /// webbundle have no ABP spelling) and we never need it: emitter
    /// always goes ABP → wire.
    fn from(t: options::ResourceType) -> Self {
        match t {
            options::ResourceType::Script => Self::Script,
            options::ResourceType::Image => Self::Image,
            options::ResourceType::Stylesheet => Self::Stylesheet,
            options::ResourceType::XmlHttpRequest => Self::XmlHttpRequest,
            options::ResourceType::SubFrame => Self::SubFrame,
            options::ResourceType::MainFrame => Self::MainFrame,
            options::ResourceType::Object => Self::Object,
            options::ResourceType::Ping => Self::Ping,
            options::ResourceType::Media => Self::Media,
            options::ResourceType::Font => Self::Font,
            options::ResourceType::WebSocket => Self::Websocket,
            options::ResourceType::Other => Self::Other,
        }
    }
}

/// Serde helper: skip boolean fields when they equal the DNR default (`false`).
/// We emit a field only when the user explicitly asked for non-default behavior,
/// so hand-written golden JSON stays compact and readable.
fn is_false(b: &bool) -> bool {
    !*b
}

/// Chrome DNR condition — the match predicate. All fields are optional.
///
/// Field-naming note: Chrome 101 renamed `domains` → `initiatorDomains` and
/// `excludedDomains` → `excludedInitiatorDomains`. The old names still work
/// for compat but are deprecated. We emit only the new names since we ship
/// on Manifest V3 which postdates the rename.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnrCondition {
    /// ABP-ish pattern string (`||ads.example.com^`, `/banner/*`, etc.).
    /// Optional only because Chrome also accepts regex-only conditions;
    /// we never emit those in Phase 2.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_filter: Option<String>,

    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub resource_types: Vec<ResourceTypeWire>,

    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub excluded_resource_types: Vec<ResourceTypeWire>,

    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub initiator_domains: Vec<String>,

    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub excluded_initiator_domains: Vec<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_type: Option<DomainType>,

    /// DNR's default is case-insensitive URL matching, so we omit the field
    /// unless `$match-case` was specified — keeps the output minimal.
    #[serde(skip_serializing_if = "is_false", default)]
    pub is_url_filter_case_sensitive: bool,
}

/// A single Chrome DNR rule. This is the unit Chrome consumes from
/// `rule_resources[*].path` JSON files.
///
/// Constraints Chrome enforces at load time:
///   - `id` must be unique within a ruleset.
///   - `id` and `priority` must be `>= 1`.
///   - `priority` range is u32 but Chrome caps it lower in practice; our
///     priority ladder (1..=4) is well within any limit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DnrRule {
    pub id: u32,
    pub priority: u32,
    pub action: DnrAction,
    pub condition: DnrCondition,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Snapshot: the most common case — a block rule with resource types,
    /// initiator domains, and a third-party modifier. If this test fails, a
    /// serde attribute got edited in a way that breaks Chrome compatibility.
    #[test]
    fn block_rule_matches_chrome_shape() {
        let rule = DnrRule {
            id: 1,
            priority: 1,
            action: DnrAction::Block,
            condition: DnrCondition {
                url_filter: Some("||ads.example.com^".into()),
                resource_types: vec![ResourceTypeWire::Script, ResourceTypeWire::Image],
                initiator_domains: vec!["example.com".into()],
                excluded_initiator_domains: vec!["safe.example.com".into()],
                domain_type: Some(DomainType::ThirdParty),
                ..Default::default()
            },
        };
        let got = serde_json::to_value(&rule).unwrap();
        let want = json!({
            "id": 1,
            "priority": 1,
            "action": { "type": "block" },
            "condition": {
                "urlFilter": "||ads.example.com^",
                "resourceTypes": ["script", "image"],
                "initiatorDomains": ["example.com"],
                "excludedInitiatorDomains": ["safe.example.com"],
                "domainType": "thirdParty"
            }
        });
        assert_eq!(got, want);
    }

    #[test]
    fn allow_rule_emits_allow_type() {
        let rule = DnrRule {
            id: 2,
            priority: 2,
            action: DnrAction::Allow,
            condition: DnrCondition {
                url_filter: Some("||good.example.com^".into()),
                ..Default::default()
            },
        };
        let got = serde_json::to_value(&rule).unwrap();
        assert_eq!(got["action"]["type"], "allow");
    }

    #[test]
    fn empty_fields_are_omitted() {
        // The whole point of skip_serializing_if: a rule with only the required
        // fields + a bare urlFilter should produce a minimal JSON object, not
        // one stuffed with empty arrays and nulls. Chrome accepts both, but
        // minimal is smaller and easier to read in golden files.
        let rule = DnrRule {
            id: 7,
            priority: 1,
            action: DnrAction::Block,
            condition: DnrCondition {
                url_filter: Some("/banner/*".into()),
                ..Default::default()
            },
        };
        let s = serde_json::to_string(&rule).unwrap();
        assert!(!s.contains("resourceTypes"), "got: {s}");
        assert!(!s.contains("excludedResourceTypes"), "got: {s}");
        assert!(!s.contains("initiatorDomains"), "got: {s}");
        assert!(!s.contains("excludedInitiatorDomains"), "got: {s}");
        assert!(!s.contains("domainType"), "got: {s}");
        assert!(!s.contains("isUrlFilterCaseSensitive"), "got: {s}");
        assert!(s.contains("\"urlFilter\":\"/banner/*\""), "got: {s}");
    }

    #[test]
    fn xmlhttprequest_serializes_as_one_word() {
        // The single most fragile wire-format detail — pin it. snake_case
        // of `XmlHttpRequest` would be `xml_http_request`; Chrome wants
        // `xmlhttprequest`, so the variant has a manual `#[serde(rename)]`.
        let v = serde_json::to_value(ResourceTypeWire::XmlHttpRequest).unwrap();
        assert_eq!(v, json!("xmlhttprequest"));
    }

    #[test]
    fn main_and_sub_frame_use_underscores() {
        assert_eq!(
            serde_json::to_value(ResourceTypeWire::MainFrame).unwrap(),
            json!("main_frame")
        );
        assert_eq!(
            serde_json::to_value(ResourceTypeWire::SubFrame).unwrap(),
            json!("sub_frame")
        );
    }

    #[test]
    fn websocket_is_lowercase_one_word() {
        // Chrome uses plain "websocket" (no underscore) even though the
        // enum variant is one PascalCase word. snake_case-of-Websocket is
        // just "websocket", which happens to be correct — but the test
        // pins it so a future case-convention change can't break us silently.
        assert_eq!(
            serde_json::to_value(ResourceTypeWire::Websocket).unwrap(),
            json!("websocket")
        );
    }

    #[test]
    fn domain_type_is_camel_case() {
        assert_eq!(
            serde_json::to_value(DomainType::FirstParty).unwrap(),
            json!("firstParty")
        );
        assert_eq!(
            serde_json::to_value(DomainType::ThirdParty).unwrap(),
            json!("thirdParty")
        );
    }

    #[test]
    fn case_sensitive_flag_appears_when_true() {
        let rule = DnrRule {
            id: 1,
            priority: 1,
            action: DnrAction::Block,
            condition: DnrCondition {
                url_filter: Some("/Tracking/*".into()),
                is_url_filter_case_sensitive: true,
                ..Default::default()
            },
        };
        let s = serde_json::to_string(&rule).unwrap();
        assert!(s.contains("\"isUrlFilterCaseSensitive\":true"), "got: {s}");
    }

    #[test]
    fn resource_type_mapping_is_total() {
        // If we ever add a new `options::ResourceType` variant without updating
        // the `From` impl, the compiler will break — this test just proves the
        // mapping produces the wire variant we expect for every current variant.
        use options::ResourceType as O;
        let pairs: &[(O, ResourceTypeWire)] = &[
            (O::Script, ResourceTypeWire::Script),
            (O::Image, ResourceTypeWire::Image),
            (O::Stylesheet, ResourceTypeWire::Stylesheet),
            (O::XmlHttpRequest, ResourceTypeWire::XmlHttpRequest),
            (O::SubFrame, ResourceTypeWire::SubFrame),
            (O::MainFrame, ResourceTypeWire::MainFrame),
            (O::Object, ResourceTypeWire::Object),
            (O::Ping, ResourceTypeWire::Ping),
            (O::Media, ResourceTypeWire::Media),
            (O::Font, ResourceTypeWire::Font),
            (O::WebSocket, ResourceTypeWire::Websocket),
            (O::Other, ResourceTypeWire::Other),
        ];
        for (abp, wire) in pairs {
            assert_eq!(ResourceTypeWire::from(*abp), *wire);
        }
    }

    #[test]
    fn deserializes_round_trip() {
        // Serialize → deserialize → compare. Cheap insurance against a
        // serialize-only field mismatch: if serde can read back what we wrote,
        // the attribute set is internally consistent.
        let rule = DnrRule {
            id: 42,
            priority: 3,
            action: DnrAction::Block,
            condition: DnrCondition {
                url_filter: Some("||tracker.net^".into()),
                resource_types: vec![ResourceTypeWire::XmlHttpRequest],
                initiator_domains: vec!["example.com".into(), "foo.com".into()],
                domain_type: Some(DomainType::ThirdParty),
                is_url_filter_case_sensitive: true,
                ..Default::default()
            },
        };
        let s = serde_json::to_string(&rule).unwrap();
        let back: DnrRule = serde_json::from_str(&s).unwrap();
        assert_eq!(rule, back);
    }
}
