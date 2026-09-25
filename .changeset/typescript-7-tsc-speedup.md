---
"@getknext/core": patch
---

The monorepo's own toolchain now runs `tsc` typechecking on TypeScript 7
(the native compiler) for speed, while its `typescript` devDependency stays
on 5.9.x — `tsup`'s declaration-file bundler needs the classic TypeScript
compiler API, which TypeScript 7 does not yet expose.

Scaffolded apps are unaffected: `knext create` still pins
`typescript@^5.9.3` by default. TypeScript 7 works for a scaffolded app's
own build and typecheck, but breaks your standard `eslint`/editor
TypeScript tooling today (`typescript-eslint` doesn't support it yet, and
TypeScript 7 ships no language server) — see the TypeScript version doc for
the opt-in path and what it costs.
