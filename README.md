# Ad Blocker

A Chrome MV3 ad blocker with a custom Rust/Wasm filter compiler.

See `ad-blocker-architecture.docx` for the full architecture + development plan, and `docs/adrs/0001-rust-wasm-compiler.md` for the compiler decision record.

## Repository layout

```
apps/
  extension/         Chrome MV3 extension (manifest, service worker, content script, popup, options)
  crawler/           (placeholder) Headless regression crawler
packages/
  filter-compiler-rs/  Rust crate that compiles to Wasm. Source of truth for the filter engine.
  filter-compiler-js/  TypeScript facade over the Wasm crate. Exposes `node.ts` (build-time) and `web.ts` (runtime).
  storage-schema/    Typed chrome.storage schema + migrations.
  ui-kit/            (placeholder) Shared UI primitives for popup + options.
scripts/             Repo-level scripts (release, list sync, size reports).
docs/adrs/           Architecture decision records.
.github/workflows/   CI (rust, wasm size budget, fuzz smoke, node).
```

## Toolchain

- **Node**: >=20
- **pnpm**: 9.x (pinned via `packageManager` in root `package.json`)
- **Rust**: 1.86.0 (pinned via `rust-toolchain.toml` at both repo root and crate)
- **wasm-pack**: latest stable
- **wasm-opt**: from Binaryen (required for release-size budget)

## Getting started

```sh
# Install Node deps
pnpm install

# Build everything (workspace-wide; no-ops on packages without a build script)
pnpm build

# Rust crate: test + build Wasm
cd packages/filter-compiler-rs
cargo test
wasm-pack build --target web --release
```

CI enforces a 1 MB size budget on the release Wasm artifact. Keep it lean.

## Status

Phase 0 — monorepo scaffolding. The Wasm binding is a stub; `filter-compiler-js/{node,web}.ts` throw `"not wired yet"` until Phase 1.
