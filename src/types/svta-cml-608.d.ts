// `tsconfig.json` sets `moduleResolution: "node"`, which cannot read the
// `exports` map that @svta/cml-608 uses to point at its bundled types.
// Re-declare the bare specifier in terms of the concrete dist entry point,
// the same idiom already used for @svta/cml-iso-bmff.
declare module "@svta/cml-608" {
  export * from "@svta/cml-608/dist/index.js";
}
