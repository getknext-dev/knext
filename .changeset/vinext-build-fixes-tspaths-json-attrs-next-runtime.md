---
"@getknext/core": patch
---

Three more apps now build on the vinext target, through new bundled vinext fixes:

- A tsconfig `paths` entry with several targets now falls back to the later targets when the first one does not resolve, and a `.d.ts` target is never used as a module, as in TypeScript and Next.js.
- `import data from "./data" with { type: "json" }` now loads the file as JSON even when it has no `.json` extension. This previously failed with a parse error.
- A `require()` in a branch that `process.env.NEXT_RUNTIME` rules out is no longer resolved. For example, an instrumentation file that requires a module only in its non-Node.js branch no longer fails the build.
