//! Line-based lexer for ABP filter syntax.
//!
//! This is deliberately a *line* lexer, not a streaming char-by-char one:
//! ABP rules are one-per-line, and line-at-a-time classification keeps the
//! state machine trivial (no carry-over, easy to parallelize later).
//!
//! The lexer does no allocation: every token stores slices that borrow from
//! the original input string. The caller keeps the buffer alive.
//!
//! Scope — Phase 1:
//!   - classify every line into one TokenKind variant
//!   - preserve pattern/options/domains/body as raw &str
//!
//! Out of scope — Phase 2+:
//!   - validating CSS selectors or network-option syntax
//!   - domain exclusion parsing (~excluded.com in domain lists)
//!   - snippet argument splitting

use crate::token::{CosmeticRule, CosmeticVariant, NetworkRule, Token, TokenKind};

/// Tokenize an entire filter-list source. Lazy iterator — costs nothing until
/// consumed, so the caller can count, filter, or collect as needed.
pub fn tokenize(src: &str) -> impl Iterator<Item = Token<'_>> + '_ {
    src.lines().enumerate().map(|(idx, raw)| Token {
        line_no: (idx as u32).saturating_add(1),
        raw,
        kind: classify(raw),
    })
}

/// Classify a single raw line. Public so tests and Phase 2 emitters can
/// re-run classification on a mutated slice without re-splitting the file.
pub fn classify(raw: &str) -> TokenKind<'_> {
    let trimmed = raw.trim();

    if trimmed.is_empty() {
        return TokenKind::Blank;
    }
    if trimmed.starts_with('!') {
        return TokenKind::Comment;
    }
    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        return TokenKind::Header;
    }

    // Cosmetic separator detection comes before network exception detection.
    // Rationale: `@@` is a network-exception prefix only; a line with any
    // cosmetic separator is a cosmetic rule even if it accidentally starts
    // with `@@` (rare, but EasyList has historical malformed lines).
    if let Some(cos) = find_cosmetic(trimmed) {
        let rule = CosmeticRule {
            domains: cos.domains,
            variant: cos.variant,
            body: cos.body,
        };
        return if cos.is_exception {
            TokenKind::CosmeticException(rule)
        } else {
            TokenKind::Cosmetic(rule)
        };
    }

    // Not cosmetic → network. Strip the exception prefix first.
    let (pattern_src, is_exception) = match trimmed.strip_prefix("@@") {
        Some(rest) => (rest, true),
        None => (trimmed, false),
    };
    let (pattern, options) = match pattern_src.find('$') {
        Some(i) => (&pattern_src[..i], &pattern_src[i + 1..]),
        None => (pattern_src, ""),
    };
    let rule = NetworkRule { pattern, options };
    if is_exception {
        TokenKind::NetworkException(rule)
    } else {
        TokenKind::Network(rule)
    }
}

/// Internal match result for the cosmetic scanner.
struct CosmeticMatch<'a> {
    domains: &'a str,
    variant: CosmeticVariant,
    body: &'a str,
    is_exception: bool,
}

/// Scan for a cosmetic separator. Returns the earliest separator; on a tie at
/// the same position, prefers the longer match (`##^` beats `##`).
fn find_cosmetic(s: &str) -> Option<CosmeticMatch<'_>> {
    // (literal, variant, is_exception). Listed longest-first so a same-position
    // tie lets the first hit win under the `idx == best.idx && len > best.len`
    // rule below — but we also verify the length comparison explicitly.
    const SEPS: &[(&str, CosmeticVariant, bool)] = &[
        ("##^", CosmeticVariant::HtmlFilter, false),
        ("#@#", CosmeticVariant::ElementHide, true),
        ("#?#", CosmeticVariant::ExtendedHide, false),
        ("#$#", CosmeticVariant::CssInject, false),
        ("#%#", CosmeticVariant::ScriptInject, false),
        ("##", CosmeticVariant::ElementHide, false),
    ];

    let mut best: Option<(usize, &'static str, CosmeticVariant, bool)> = None;
    for &(sep, variant, is_exception) in SEPS {
        if let Some(idx) = s.find(sep) {
            let replace = match best {
                None => true,
                Some((b_idx, b_sep, _, _)) => {
                    idx < b_idx || (idx == b_idx && sep.len() > b_sep.len())
                }
            };
            if replace {
                best = Some((idx, sep, variant, is_exception));
            }
        }
    }

    best.map(|(idx, sep, variant, is_exception)| CosmeticMatch {
        domains: &s[..idx],
        variant,
        body: &s[idx + sep.len()..],
        is_exception,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn first_kind(src: &str) -> TokenKind<'_> {
        tokenize(src).next().unwrap().kind
    }

    #[test]
    fn blank_lines() {
        // `""` and `"\n"` both yield *zero* lines from `str::lines` — covered
        // by `empty_input_yields_no_tokens` below. Here we only assert that
        // whitespace-only lines that actually exist are classified Blank.
        assert_eq!(first_kind("   "), TokenKind::Blank);
        assert_eq!(first_kind("\t\t"), TokenKind::Blank);
    }

    #[test]
    fn empty_input_yields_no_tokens() {
        // `str::lines` on `""` yields zero lines — no content, nothing to split.
        assert_eq!(tokenize("").count(), 0);
    }

    #[test]
    fn bare_newline_yields_one_blank() {
        // `str::lines` on `"\n"` yields one empty line: the `\n` is a
        // terminator, and the empty slice *before* it counts as a line.
        // That empty slice classifies as Blank. This is different from
        // `"foo\n"` vs `"foo"` both yielding `["foo"]` — the "trailing
        // newline is optional" rule doesn't collapse a lone `\n` to zero
        // lines, because the line before the terminator still exists.
        let tokens: Vec<_> = tokenize("\n").collect();
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].kind, TokenKind::Blank);
        assert_eq!(tokens[0].line_no, 1);
    }

    #[test]
    fn comment_lines() {
        assert_eq!(first_kind("! comment"), TokenKind::Comment);
        assert_eq!(first_kind("!   Title: EasyList"), TokenKind::Comment);
    }

    #[test]
    fn header_line() {
        assert_eq!(first_kind("[Adblock Plus 2.0]"), TokenKind::Header);
    }

    #[test]
    fn simple_network_block() {
        match first_kind("||example.com^") {
            TokenKind::Network(r) => {
                assert_eq!(r.pattern, "||example.com^");
                assert_eq!(r.options, "");
            }
            other => panic!("expected Network, got {:?}", other),
        }
    }

    #[test]
    fn network_with_options() {
        match first_kind("||ads.example.com^$third-party,domain=foo.com") {
            TokenKind::Network(r) => {
                assert_eq!(r.pattern, "||ads.example.com^");
                assert_eq!(r.options, "third-party,domain=foo.com");
            }
            other => panic!("expected Network, got {:?}", other),
        }
    }

    #[test]
    fn network_exception() {
        match first_kind("@@||good.example.com^") {
            TokenKind::NetworkException(r) => {
                assert_eq!(r.pattern, "||good.example.com^");
                assert_eq!(r.options, "");
            }
            other => panic!("expected NetworkException, got {:?}", other),
        }
    }

    #[test]
    fn universal_cosmetic_hide() {
        match first_kind("##.ad-banner") {
            TokenKind::Cosmetic(r) => {
                assert_eq!(r.domains, "");
                assert_eq!(r.variant, CosmeticVariant::ElementHide);
                assert_eq!(r.body, ".ad-banner");
            }
            other => panic!("expected Cosmetic, got {:?}", other),
        }
    }

    #[test]
    fn domain_scoped_cosmetic_hide() {
        match first_kind("example.com,foo.com##.banner") {
            TokenKind::Cosmetic(r) => {
                assert_eq!(r.domains, "example.com,foo.com");
                assert_eq!(r.variant, CosmeticVariant::ElementHide);
                assert_eq!(r.body, ".banner");
            }
            other => panic!("expected Cosmetic, got {:?}", other),
        }
    }

    #[test]
    fn cosmetic_exception() {
        match first_kind("example.com#@#.banner") {
            TokenKind::CosmeticException(r) => {
                assert_eq!(r.domains, "example.com");
                assert_eq!(r.variant, CosmeticVariant::ElementHide);
                assert_eq!(r.body, ".banner");
            }
            other => panic!("expected CosmeticException, got {:?}", other),
        }
    }

    #[test]
    fn extended_cosmetic() {
        match first_kind("example.com#?#.container:has(.ad)") {
            TokenKind::Cosmetic(r) => {
                assert_eq!(r.variant, CosmeticVariant::ExtendedHide);
                assert_eq!(r.body, ".container:has(.ad)");
            }
            other => panic!("expected Cosmetic(ExtendedHide), got {:?}", other),
        }
    }

    #[test]
    fn css_inject_cosmetic() {
        match first_kind("example.com#$#body { overflow: auto !important; }") {
            TokenKind::Cosmetic(r) => {
                assert_eq!(r.variant, CosmeticVariant::CssInject);
                assert!(r.body.contains("overflow"));
            }
            other => panic!("expected Cosmetic(CssInject), got {:?}", other),
        }
    }

    #[test]
    fn html_filter_cosmetic() {
        // ##^ must beat ## because it's longer at the same index.
        match first_kind("example.com##^script:has-text(adsense)") {
            TokenKind::Cosmetic(r) => {
                assert_eq!(r.variant, CosmeticVariant::HtmlFilter);
                assert_eq!(r.body, "script:has-text(adsense)");
            }
            other => panic!("expected Cosmetic(HtmlFilter), got {:?}", other),
        }
    }

    #[test]
    fn mixed_list_counts() {
        let src = "\
! EasyList header
[Adblock Plus 2.0]

||ads.example.com^$third-party
@@||good.example.com^
##.universal-ad
example.com##.domain-ad
example.com#@#.allowed-ad
example.com#?#.has-child:has(.ad)
example.com##^script:has-text(tracker)
";
        let kinds: Vec<_> = tokenize(src).map(|t| t.kind).collect();
        // str::lines() drops the empty "line" after a trailing '\n', so we
        // expect exactly 10 tokens for 10 source lines.
        assert_eq!(kinds.len(), 10, "token count");
        let mut n_blank = 0;
        let mut n_comment = 0;
        let mut n_header = 0;
        let mut n_net = 0;
        let mut n_net_exc = 0;
        let mut n_cos = 0;
        let mut n_cos_exc = 0;
        for k in &kinds {
            match k {
                TokenKind::Blank => n_blank += 1,
                TokenKind::Comment => n_comment += 1,
                TokenKind::Header => n_header += 1,
                TokenKind::Network(_) => n_net += 1,
                TokenKind::NetworkException(_) => n_net_exc += 1,
                TokenKind::Cosmetic(_) => n_cos += 1,
                TokenKind::CosmeticException(_) => n_cos_exc += 1,
            }
        }
        assert_eq!(n_comment, 1, "comments");
        assert_eq!(n_header, 1, "headers");
        assert_eq!(n_blank, 1, "blanks");
        assert_eq!(n_net, 1, "network");
        assert_eq!(n_net_exc, 1, "network exceptions");
        // Four non-exception cosmetics in the fixture:
        //   ##.universal-ad                           (ElementHide, universal)
        //   example.com##.domain-ad                   (ElementHide, scoped)
        //   example.com#?#.has-child:has(.ad)         (ExtendedHide)
        //   example.com##^script:has-text(tracker)    (HtmlFilter)
        assert_eq!(n_cos, 4, "cosmetic (non-exception)");
        assert_eq!(n_cos_exc, 1, "cosmetic exceptions");
    }
}
