//! End-to-end `compile_to_report` benches.
//!
//! Why a separate file from `lexer_bench.rs`:
//!   - The lexer bench measures the tokenizer in isolation against
//!     synthetic 10k-line fixtures. That's a microbenchmark — useful for
//!     spotting lexer regressions, not for pricing the whole pipeline.
//!   - This file measures what callers actually pay end-to-end:
//!     `compile_to_report` walks the lexer, runs the network emitter
//!     (option parsing, host normalization, DNR rule construction),
//!     populates the cosmetic bundle, and accumulates diagnostics. A perf
//!     hit anywhere in that chain shows up here.
//!
//! Two fixtures:
//!   - `synthetic_60k`: a scaled-up replica of `fixtures/tiny.txt`.
//!     Always available, fixed shape — the deterministic baseline that
//!     trend lines compare across commits.
//!   - `real_easylist`: the live `apps/extension/vendor/easylist.txt`
//!     when present. Skipped gracefully on a fresh clone or in CI before
//!     `pnpm lists:fetch` has run. This is the reference number a
//!     maintainer cares about; the synthetic fixture is the apples-to-
//!     apples comparator.
//!
//! Why best-effort on `real_easylist` rather than a hard requirement:
//!   - vendor/*.txt is gitignored. A first-time contributor running
//!     `cargo bench` shouldn't have to set up the JS toolchain to populate
//!     it. The bench reports what it can and tells the user how to
//!     populate the real fixture if they want that data point too.
//!   - CI runs `cargo bench --no-run`; nothing here actually executes
//!     under CI today. The skip behavior keeps a future "run benches in
//!     CI" change from breaking on missing vendor/.

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use filter_compiler_rs::compile_to_report;
use std::fs;
use std::path::PathBuf;

/// Build a synthetic input shaped like `fixtures/tiny.txt`, scaled to
/// roughly real-list size. Each block contributes ~10 source lines
/// across every variant the compiler handles (network, network exception,
/// generic + domain-scoped cosmetic, cosmetic exception, header, blank,
/// comment) so the pipeline gets exercised proportionally.
fn synthetic_input(blocks: usize) -> String {
    // Keep this in sync with `fixtures/tiny.txt`'s shape — a representative
    // cross-section of what real EasyList looks like, scaled by `blocks`.
    let block = "\
! header comment
[Adblock Plus 2.0]

||ads.example.com^$third-party
||doubleclick.net^$third-party
||googlesyndication.com/pagead/$script,domain=example.com|foo.com
@@||good.example.com^
@@||partner.com^$image,domain=example.com
##.universal-ad
example.com##.sponsor-box
example.com#@#.sponsor-box
";
    block.repeat(blocks)
}

/// Locate the real EasyList file relative to the bench's working dir.
/// Cargo invokes benches with cwd set to the crate root
/// (`packages/filter-compiler-rs/`), so we walk up two levels to reach
/// the extension's vendor directory.
fn locate_real_easylist() -> Option<PathBuf> {
    let path = PathBuf::from("../../apps/extension/vendor/easylist.txt");
    path.is_file().then_some(path)
}

fn bench_compile(c: &mut Criterion) {
    let mut group = c.benchmark_group("compile");
    // Real EasyList compile is in the tens-of-ms range; criterion's default
    // 100-sample target would push the bench close to a minute. 20 samples
    // is plenty for the variance we care about (regression / no-regression)
    // while keeping `cargo bench` interactive.
    group.sample_size(20);

    // --- synthetic_60k ----------------------------------------------------
    // 6,000 blocks × 10 lines ≈ 60k source lines. That's in the same order
    // of magnitude as real EasyList, so the synthetic numbers are a useful
    // proxy when vendor/ isn't fetched — and they're fully deterministic,
    // which is what we want for trend tracking.
    let synthetic = synthetic_input(6_000);
    group.throughput(Throughput::Bytes(synthetic.len() as u64));
    group.bench_with_input(
        BenchmarkId::new("compile", "synthetic_60k"),
        &synthetic,
        |b, src| {
            b.iter(|| {
                let r = compile_to_report(black_box(src));
                black_box(r);
            })
        },
    );

    // --- real_easylist (best-effort) --------------------------------------
    match locate_real_easylist().map(|p| (p.clone(), fs::read_to_string(&p))) {
        Some((_, Ok(src))) => {
            group.throughput(Throughput::Bytes(src.len() as u64));
            group.bench_with_input(
                BenchmarkId::new("compile", "real_easylist"),
                &src,
                |b, src| {
                    b.iter(|| {
                        let r = compile_to_report(black_box(src));
                        black_box(r);
                    })
                },
            );
        }
        Some((path, Err(e))) => {
            // The file existed when we checked but failed to read — likely
            // a permission issue. Worth surfacing rather than silently
            // skipping, because the synthetic-only bench would mask it.
            eprintln!(
                "skipping real_easylist bench: failed to read {}: {}",
                path.display(),
                e
            );
        }
        None => {
            eprintln!(
                "skipping real_easylist bench: no vendor/easylist.txt found.\n\
                 run `pnpm -F @ad-blocker/extension lists:fetch` from the repo \
                 root to populate it; the synthetic_60k bench above is the \
                 apples-to-apples comparator either way."
            );
        }
    }

    group.finish();
}

criterion_group!(benches, bench_compile);
criterion_main!(benches);
