// Ambient declarations for Vite's asset-import suffixes used by this package.
//
// We don't include `vite/client` in the project's tsconfig.types because
// the rest of the codebase doesn't depend on Vite's broader DOM-side type
// surface. Re-stating just the one suffix we use here keeps the type
// surface narrow and avoids accidentally pulling in HMR / `import.meta.env`
// declarations into a Node-side build script.
//
// Why this lives in a `.d.ts` file rather than inline at the top of
// `compile-browser.ts`: a `declare module 'pattern'` form inside a `.ts`
// file with imports/exports is treated by TS as a *module augmentation*
// (TS2664: "Invalid module name in augmentation"), which can only refine
// an existing module — not declare a new wildcard one. The `.d.ts` file
// is in ambient context, where `declare module 'pattern'` is the correct
// way to introduce new module shapes.

declare module '*?url' {
  const url: string;
  export default url;
}
