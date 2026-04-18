# ADR-0001: Filter Compiler in Rust/WebAssembly

- **Status:** Accepted
- **Date:** 2026-04-17
- **Deciders:** Architecture Team
- **Supersedes:** —
- **Superseded by:** —

## Context

The Chrome ad blocker (MV3) needs a component that ingests Adblock Plus-style filter lists (EasyList and friends) and produces two artefacts: a set of `declarativeNetRequest` rule JSON files and a cosmetic-selector bundle. This component is on the critical path for both build-time (pre-compiling shipped rulesets) and runtime (compiling user-subscribed lists inside the service worker).

Three implementation paths were considered:

1. **Off-the-shelf library** — e.g. `@ghostery/adblocker`. Fastest time-to-first-block, but the library is a runtime matcher, not a DNR JSON emitter; adapting it would require wrestling its internals. Licensing entanglement and a moving target.
2. **TypeScript compiler** — lowest friction, one language, but no realistic path to sub-second compile times on large lists and no shared code with build-time tooling.
3. **Rust compiled to WebAssembly** — higher up-front cost, but gives us control over the two things that actually matter at scale: compile-time performance and the rule-compaction algorithm.

The 30,000-rule static DNR ceiling is going to bite us early. Compaction quality is the single biggest lever on whether we hit the 95% block-accuracy target (§7 of the architecture doc) without dropping important rules. That lever is easier to pull in Rust with strongly typed IRs, property-testing, and cargo-fuzz than in adapted JavaScript.

## Decision

**Implement the filter compiler as a single Rust crate (`packages/filter-compiler-rs`), compiled to WebAssembly, and shared between build-time and runtime.**

Two Wasm build targets from one source:

| Target | Tool | Consumer |
|--------|------|----------|
| `--target nodejs` | `wasm-pack` | CI build script; pre-compiles shipped static rulesets into the extension `.zip`. |
| `--target web` | `wasm-pack` | Extension service worker; compiles user-subscribed lists at runtime. |

The TypeScript side consumes the Wasm via a thin wrapper in `packages/filter-compiler-js`. No TypeScript re-implementation of any parsing logic.

## Consequences

### Positive

- Single source of truth for the parser, classifier, and emitters. No drift between build-time and runtime behaviour.
- Compile-time performance target (< 1 s for EasyList) is achievable in Rust; it is not achievable in TypeScript without building a JIT.
- `cargo fuzz` on the lexer gives us cheap, continuous bug-finding before users see crashes.
- Clean licensing story: our compiler under our chosen license, not entangled with a third-party runtime.
- Strongly typed IR catches classifier bugs at compile time instead of in production.

### Negative

- Additional toolchain in CI: Rust stable, `wasm-pack`, `wasm-opt`, `cargo` caches. Adds roughly 3–4 weeks to the Phase 1 schedule (see updated §9.2).
- Two languages in the codebase (Rust + TypeScript). Smaller contributor pool; onboarding notes required.
- Wasm binary size risk: a naive Rust build can easily hit 2 MB. Mitigated by the build flags below and a hard CI budget of 500 KB compressed.
- Wasm cold-start risk in the service worker. Mitigated by keeping the Wasm module resident after first load and by the escape hatch below.

### Neutral

- We inherit Rust's stability guarantees on stable. We pin the toolchain in `rust-toolchain.toml` to avoid surprises.

## Decision drivers (measured during Phase 0 spike)

These numbers are the quantitative basis for the decision. They must be re-measured and entered here at the end of the spike (Day 7 of the plan). If any target is missed, the spike is failed and the decision is reopened.

| Metric | Target | Measured |
|--------|--------|----------|
| Wasm binary size (compressed, post-`wasm-opt`) | ≤ 1 MB for hello-world, ≤ 500 KB for full compiler at RC | TBD |
| Service worker cold start (load + first Wasm call) | ≤ 100 ms | TBD |
| EasyList parse throughput (Node build target) | ≥ 20k lines/sec | TBD |
| Toolchain CI wall-clock (cold cache) | ≤ 3 min | TBD |

## Escape hatch

If runtime cold start in the service worker proves unacceptable despite optimisation, we fall back to a **build-time-only** variant: ship the Wasm only in the Node CI target, pre-compile every subscribed list on our CI infrastructure (GitHub Actions running on a cron), and push compiled rulesets to users as static CDN assets (GitHub raw or Pages). Runtime Wasm is removed from the extension `.zip`. This preserves the compiler-in-Rust benefit while dropping the browser-runtime complication. Cost: we lose the ability to support user-entered custom lists without publishing them, which is acceptable if we surface a clear "submit your list for compilation" flow.

## Alternatives considered (not chosen)

- **`@ghostery/adblocker`** — rejected: runtime matcher, not a DNR emitter; licensing entanglement; we'd still need to write the emitter.
- **Pure TypeScript compiler** — rejected: cannot meet the compile-time performance target; no realistic path to sub-second EasyList compilation.
- **AssemblyScript (TS-like → Wasm)** — rejected: immature ecosystem for our use case; no `cargo fuzz` equivalent; smaller library ecosystem than Rust for things like IDN/punycode.
- **C++ → Wasm via Emscripten** — rejected: worse DX than Rust, weaker safety, and no benefit we'd actually realise.

## Implementation notes

- Pin the Rust toolchain in `rust-toolchain.toml`. Check in `Cargo.lock`.
- Release profile: `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `opt-level = "z"`.
- Post-build: `wasm-opt -O3 --strip-debug`.
- Wasm↔JS boundary discipline: few calls with large payloads. One call per whole filter list, not per line.
- Fuzz targets live in `packages/filter-compiler-rs/fuzz/`. Run on every PR for 30s; run 100 CPU-hours in Phase 4.

## References

- Architecture doc §4.1.4, §4.1.5, §7, §9.1, §9.2
- Chrome declarativeNetRequest limits: <https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest>
- `wasm-bindgen` docs: <https://rustwasm.github.io/wasm-bindgen/>
- Binaryen / `wasm-opt`: <https://github.com/WebAssembly/binaryen>
