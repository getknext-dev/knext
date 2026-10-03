---
"@getknext/core": minor
---

`knext create` now asks for the runtime (`bun` or `node`), builder (`turbopack`, `webpack` or
`vinext`), ISR/data cache (`none` or `redis`), object storage provider and React Compiler when it
runs on a terminal with no flags. Each question has a flag (`--runtime`, `--builder`, `--cache`,
`--storage`, `--react-compiler`), and `--yes` skips them all. With any flag, `CI` set, or no
terminal, it asks nothing and uses the defaults, which scaffold exactly the same app as before.

Choosing `node` adds `ioredis` to the app's dependencies, at the same range `@getknext/core` uses.
A Bun app gets nothing extra, because Bun has a Redis client built in.
`--builder` now accepts `turbopack` and `webpack`; `default` still works and means `turbopack`.

New apps now have React Compiler turned on by default, on every builder. On turbopack/webpack,
`next.config.ts` gets `reactCompiler: true` and `babel-plugin-react-compiler`. On vinext,
`vite.config.ts` gets `react: { compiler: true }` plus the four packages it needs. Pass
`--no-react-compiler` (or answer `n`) to leave it off, which scaffolds exactly the same app as
before.
