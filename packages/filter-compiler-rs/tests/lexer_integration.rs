//! Integration test — runs the lexer over a fixture file that mimics a
//! scrubbed subset of EasyList's real shape.
//!
//! Unit tests in `src/lexer.rs` cover one-line classification. This test
//! proves the iterator can walk a whole file and produces the counts the
//! eyeball count below expects.

use filter_compiler_rs::{lexer, token::TokenKind};

const TINY: &str = include_str!("fixtures/tiny.txt");

#[test]
fn tokenize_tiny_fixture_has_expected_counts() {
    let mut n_blank = 0u32;
    let mut n_comment = 0u32;
    let mut n_header = 0u32;
    let mut n_network = 0u32;
    let mut n_network_exc = 0u32;
    let mut n_cosmetic = 0u32;
    let mut n_cosmetic_exc = 0u32;

    for tok in lexer::tokenize(TINY) {
        match tok.kind {
            TokenKind::Blank => n_blank += 1,
            TokenKind::Comment => n_comment += 1,
            TokenKind::Header => n_header += 1,
            TokenKind::Network(_) => n_network += 1,
            TokenKind::NetworkException(_) => n_network_exc += 1,
            TokenKind::Cosmetic(_) => n_cosmetic += 1,
            TokenKind::CosmeticException(_) => n_cosmetic_exc += 1,
        }
    }

    // Expected counts — eyeball-audited against tests/fixtures/tiny.txt.
    // Keep this sync'd when the fixture changes.
    assert_eq!(n_header, 1, "headers");
    assert_eq!(n_network, 5, "network block rules");
    assert_eq!(n_network_exc, 2, "network exceptions");
    assert_eq!(n_cosmetic, 8, "cosmetic rules (all non-exception variants)");
    assert_eq!(n_cosmetic_exc, 1, "cosmetic exceptions");
    // Comments and blanks aren't worth asserting exactly — they'll wiggle as
    // the fixture's section headers change. Just confirm we found some.
    assert!(
        n_comment >= 5,
        "expected at least 5 comment lines, got {n_comment}"
    );
    assert!(
        n_blank >= 5,
        "expected at least 5 blank lines, got {n_blank}"
    );
}

#[test]
fn line_numbers_are_one_indexed_and_contiguous() {
    let tokens: Vec<_> = lexer::tokenize(TINY).collect();
    for (i, tok) in tokens.iter().enumerate() {
        assert_eq!(tok.line_no, (i as u32) + 1, "line_no must be 1-indexed");
    }
}

#[test]
fn raw_slices_reconstitute_the_input() {
    // Round-trip: joining every token.raw with '\n' should equal the input
    // (modulo a trailing newline, which str::lines() strips).
    let tokens: Vec<_> = lexer::tokenize(TINY).collect();
    let joined = tokens.iter().map(|t| t.raw).collect::<Vec<_>>().join("\n");
    let expected = TINY.trim_end_matches('\n');
    assert_eq!(joined, expected);
}
