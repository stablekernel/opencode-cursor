// opencode v2 loads a `file://` directory plugin by probing literal root
// entrypoints (<dir>/server, <dir>/index, ...) — it never consults this
// package's `exports` map for path plugins. Re-export the dual plugin entry
// so the worktree/checkout directory is loadable by both v1 (via package.json
// `exports["./server"]`) and v2 (via this root file).
export * from "./dist/plugin/index.js";
export { default } from "./dist/plugin/index.js";
