//! Criterion benches. Phase 1 fills these in with real lexer throughput numbers.
//! For now they exist so `Cargo.toml`'s `[[bench]]` entry resolves and the CI job
//! that runs `cargo bench --no-run` on PRs compiles cleanly.

use criterion::{black_box, criterion_group, criterion_main, Criterion};

fn count_lines_bench(c: &mut Criterion) {
    let input = "||example.com^$script\n".repeat(10_000);
    c.bench_function("count_lines/10k", |b| {
        b.iter(|| filter_compiler_rs::count_lines(black_box(&input)))
    });
}

criterion_group!(benches, count_lines_bench);
criterion_main!(benches);
