//! Token types emitted by the ABP line-lexer.
//!
//! Every variant stores `&str` slices that borrow from the input buffer — the
//! lexer does not allocate. Callers who need owned data can `.to_string()` the
//! slices at the boundary where they stop holding the input alive.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token<'a> {
    /// 1-indexed line number within the input, for diagnostics.
    pub line_no: u32,
    /// The raw (un-trimmed) line — preserved so emitters can echo it verbatim
    /// in error messages or round-trip tests.
    pub raw: &'a str,
    pub kind: TokenKind<'a>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenKind<'a> {
    /// Empty or whitespace-only line.
    Blank,
    /// Lines starting with `!` — ABP comment syntax. Metadata lines such as
    /// `! Title: EasyList` land here too; they are classified in Phase 2.
    Comment,
    /// `[Adblock Plus 2.0]` etc. A subset of comments; tagged separately so
    /// the parser can skip them when counting rules.
    Header,
    /// Network block rule — e.g. `||example.com^$third-party`.
    Network(NetworkRule<'a>),
    /// Network allow (exception) rule — `@@||allowed.com^`.
    NetworkException(NetworkRule<'a>),
    /// Cosmetic rule — element hide, extended CSS, script/CSS inject, HTML filter.
    Cosmetic(CosmeticRule<'a>),
    /// Cosmetic allow rule — `example.com#@#.ad`.
    CosmeticException(CosmeticRule<'a>),
}

/// A network rule split into its pattern and raw option string.
/// The option string is everything after the first `$` (not including it).
/// Phase 1 keeps it as a single slice; Phase 2 parses `domain=`, `third-party`, etc.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkRule<'a> {
    pub pattern: &'a str,
    pub options: &'a str,
}

/// A cosmetic rule: optional domain list + variant + body (selector/CSS/script).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CosmeticRule<'a> {
    /// Comma-separated domains before the separator. Empty = universal.
    pub domains: &'a str,
    pub variant: CosmeticVariant,
    /// Raw text after the separator: selector for hide/extended, CSS for inject,
    /// snippet name + args for script, HTML pattern for ##^.
    pub body: &'a str,
}

/// Cosmetic-rule dialect. uBlock Origin and Adblock Plus agree on the common
/// subset; the less-common inject variants differ slightly. Phase 1 recognizes
/// enough to classify; Phase 3 enforces per-variant semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CosmeticVariant {
    /// `##selector` — hide matching elements.
    ElementHide,
    /// `#?#selector` — procedural/extended filters (:has, :matches-css, ...).
    ExtendedHide,
    /// `#$#body` — inject a CSS rule (uBO) or snippet (ABP).
    CssInject,
    /// `#%#body` — inject a script snippet (ABP scriplets).
    ScriptInject,
    /// `##^html-filter` — strip matching HTML nodes (uBO).
    HtmlFilter,
}
