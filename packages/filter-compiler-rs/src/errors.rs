//! Error types for the filter-compiler pipeline.
//!
//! Phase 2 scope: everything here is about *converting* a lexed rule into a
//! DNR rule. Lexing itself never fails — blank/garbage lines just classify
//! into a TokenKind. Conversion, by contrast, has to reject or downgrade
//! rules that can't be expressed under Chrome's declarativeNetRequest.
//!
//! Carrying line numbers is the caller's job. An error value here describes
//! *what* went wrong with a single rule's options string; the emitter pairs
//! it with the token's `line_no` before surfacing it as a diagnostic.

use std::fmt;

/// Reasons a single rule can fail to convert to DNR.
///
/// Design notes:
/// - `Clone` so the caller can keep a copy in a `diagnostics` vec while also
///   logging it. Options are short strings; copying is cheap.
/// - `PartialEq` so tests can match on specific variants without boilerplate.
/// - No `std::error::Error` impl yet — we don't cross the FFI with these as
///   errors; they get serialized into JSON as diagnostic objects. If we later
///   want `?` interop with `std::io::Error` etc., it's a one-line addition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConversionError {
    /// Option name is not in any known ABP vocabulary (likely a typo).
    /// Example: `$thirdparty` (missing hyphen).
    UnknownOption(String),

    /// Option is known to exist in ABP but isn't implemented here yet.
    /// Example: `$csp=...` — valid ABP, maps to DNR `modifyHeaders`, but
    /// Phase 2 doesn't wire that up. Distinguishing this from `UnknownOption`
    /// matters because users shouldn't think their list has a typo when it
    /// actually hit a TODO on our side.
    UnsupportedOption(String),

    /// Option's value is syntactically wrong for its kind.
    /// Example: `$domain=` with no value, or `$domain=|foo.com` with a
    /// leading empty segment.
    MalformedOption { name: String, reason: String },

    /// Empty option segment — trailing comma, doubled comma, etc.
    /// Kept as its own variant so downstream code can decide whether to
    /// warn or silently drop; EasyList has historical lines with trailing
    /// commas that shouldn't abort compilation.
    EmptyOption,

    /// Cosmetic rule uses a dialect we don't implement in this phase.
    /// Examples: `#?#` (procedural/extended selectors), `#$#` (CSS/snippet
    /// inject), `#%#` (script inject), `##^` (HTML filter). Also used for
    /// shapes we *could* express but deliberately defer — generic cosmetic
    /// exceptions (`#@#` with no domain) and negated-domain-only includes
    /// (`~example.com##.ad`) both need a runtime engine we haven't built.
    ///
    /// The carried string is a short snake_case discriminator like
    /// `"extended-hide"` or `"negated-domain-only"`, suitable for the JS
    /// diagnostic UI to group by.
    UnsupportedCosmetic(String),
}

impl fmt::Display for ConversionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownOption(name) => {
                write!(f, "unknown option `${name}`")
            }
            Self::UnsupportedOption(name) => {
                write!(f, "option `${name}` is recognized but not yet supported")
            }
            Self::MalformedOption { name, reason } => {
                write!(f, "option `${name}` is malformed: {reason}")
            }
            Self::EmptyOption => write!(f, "empty option segment (stray comma?)"),
            Self::UnsupportedCosmetic(kind) => {
                write!(
                    f,
                    "cosmetic dialect `{kind}` is not supported in this phase"
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_formats_are_actionable() {
        // The Display impl is what shows up in diagnostics — these strings
        // get read by humans staring at a failing filter list. Asserting
        // shape, not exact wording, so minor copy edits don't break tests.
        let unknown = ConversionError::UnknownOption("thirdparty".into());
        assert!(unknown.to_string().contains("thirdparty"));
        assert!(unknown.to_string().contains("unknown"));

        let unsupported = ConversionError::UnsupportedOption("csp".into());
        assert!(unsupported.to_string().contains("csp"));
        assert!(unsupported.to_string().contains("not yet"));

        let malformed = ConversionError::MalformedOption {
            name: "domain".into(),
            reason: "empty value".into(),
        };
        let s = malformed.to_string();
        assert!(s.contains("domain") && s.contains("empty value"));

        assert!(ConversionError::EmptyOption.to_string().contains("empty"));

        let unsupported_cos = ConversionError::UnsupportedCosmetic("extended-hide".into());
        let s = unsupported_cos.to_string();
        assert!(s.contains("extended-hide"));
        assert!(s.contains("not supported"));
    }

    #[test]
    fn variants_compare_by_value() {
        // PartialEq is how integration tests will assert "got exactly the
        // error I expected"; verify the derive does the right thing.
        assert_eq!(
            ConversionError::UnknownOption("x".into()),
            ConversionError::UnknownOption("x".into())
        );
        assert_ne!(
            ConversionError::UnknownOption("x".into()),
            ConversionError::UnknownOption("y".into())
        );
        assert_ne!(
            ConversionError::UnknownOption("csp".into()),
            ConversionError::UnsupportedOption("csp".into())
        );
    }
}
