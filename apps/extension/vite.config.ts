// Vite config for the Chrome MV3 extension.
//
// @crxjs/vite-plugin drives everything here: it reads manifest.json, walks
// every entry point (service worker, content scripts, popup HTML, options
// HTML), bundles each one correctly for its MV3 context, and rewrites the
// manifest's source-path references to the hashed output paths.
//
// Why v2-beta of @crxjs and not the v1 1.x stable line? The "beta" label
// is misleading — v2 has been the recommended track for new MV3 projects
// for some time. v1 has known friction with modern Vite (6.x), with the
// output manifest's handling of module service workers, and with
// content-script HMR. v2 also fixes v1's occasional habit of emitting
// stale lockfile-bundled wasm imports.
//
// Build order: this config assumes `apps/extension/rulesets/*.json` and
// `apps/extension/assets/cosmetic-<source>.json` (one per filter source)
// already exist on disk. They are written by `scripts/build-rulesets.ts`
// (pnpm run build:rulesets), which is chained ahead of `vite build` in the
// package.json scripts. If you run `vite build` directly without priming
// rulesets, crxjs will fail to resolve the manifest's
// declarative_net_request.rule_resources[].path entries — that's
// intentional; it keeps stale/missing rulesets from silently shipping.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';

import manifest from './manifest.json' with { type: 'json' };

// `__dirname` isn't defined in ESM — reconstruct it from `import.meta.url`.
// This is the one piece of boilerplate that's hard to avoid when running
// a TypeScript ESM config under Node.
const HERE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // All source paths in the manifest resolve relative to this root. Keeping
  // it as the extension package's root (the default for `vite build` when
  // run from here) means the existing paths in manifest.json — `src/...`,
  // `rulesets/...`, `assets/...` — don't need adjustment.
  root: resolve(HERE),

  // Output everything into apps/extension/dist. Chrome loads this folder
  // directly as an unpacked extension. Clearing it between builds is
  // important — stale files (old service worker hashes, removed content
  // scripts) that linger will confuse Chrome's extension loader into
  // "file missing" errors after a reload.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // MV3 requires ES modules for the service worker; keep `module` output
    // format and let @crxjs handle the SW-specific wrapping.
    target: 'esnext',
    // Sourcemaps are invaluable when debugging the SW in the extension
    // DevTools window. They stay out of the user's browser unless they
    // explicitly open devtools, so the size cost is local-only.
    sourcemap: true,
  },

  plugins: [
    // @crxjs reads the manifest, rewrites source paths, bundles entry
    // points, and copies every static asset the manifest references
    // (including `declarative_net_request.rule_resources[].path` and
    // `web_accessible_resources.resources[*]` globs).
    crx({ manifest }),
  ],
});
