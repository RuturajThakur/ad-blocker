//! Criterion benches for the Phase 1 line-lexer.
//!
//! These are baseline numbers, not a final budget — they exist so we can spot
//! regressions as the lexer grows. The architecture doc's ADR-0001 listed
//! lexer throughput as a TBD decision driver; this bench is what populates
//! that number.
//!
//! Three fixtures:
//!   - network_only: 10k network-filter lines (the common case on EasyList).
//!   - cosmetic_only: 10k element-hide lines (the common case on EasyList
//!     and especially EasyPrivacy's country variants).
//!   - mixed: a repeating block of every variant the lexer recognises.

use criterion::{black_box, criterion_group, criterion_main, Criterion, Throughput};
use filter_compiler_rs::{lexer, TokenCounts};

const N: usize = 10_000;

fn fixture_network_only() -> String {
    "||ads.example.com^$third-party,domain=foo.com\n".repeat(N)
}

fn fixture_cosmetic_only() -> String {
    "example.com,sub.example.com##.ad-banner-wrapper\n".repeat(N)
}

fn fixture_mixed() -> String {
    // One repetition = 10 lines, so N/10 reps hit the same total line count.
    let block = "\
! header comment
[Adblock Plus 2.0]

||ads.example.com^$third-party
@@||good.example.com^
##.universal-ad
example.com##.domain-ad
example.com#@#.allowed-ad
example.com#?#.container:has(.ad)
example.com##^script:has-text(tracker)
";
    block.repeat(N / 10)
}

fn bench_tokenize(c: &mut Criterion) {
    let fixtures: [(&str, String); 3] = [
        ("network_only", fixture_network_only()),
        ("cosmetic_only", fixture_cosmetic_only()),
        ("mixed", fixture_mixed()),
    ];

    let mut group = c.benchmark_group("tokenize");
    for (name, src) in &fixtures {
        group.throughput(Throughput::Bytes(src.len() as u64));
        group.bench_function(*name, |b| {
            b.iter(|| {
                // Full iteration — counting forces the lazy iterator to complete.
                let n = lexer::tokenize(black_box(src)).count();
                black_box(n);
            })
        });
    }
    group.finish();
}

fn bench_tally(c: &mut Criterion) {
    // `TokenCounts::tally` is what the wasm-bindgen surface calls — measuring
    // it separately tells us how much of the wall-clock is the match arm vs
    // the iteration itself.
    let src = fixture_mixed();
    let mut group = c.benchmark_group("tally_mixed");
    group.throughput(Throughput::Bytes(src.len() as u64));
    group.bench_function("tally", |b| {
        b.iter(|| {
            let c = TokenCounts::tally(black_box(&src));
            black_box(c);
        })
    });
    group.finish();
}

criterion_group!(benches, bench_tokenize, bench_tally);
criterion_main!(benches);
