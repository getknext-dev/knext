---
"@getknext/core": minor
---

The default build target is now `turbopack` (`next build` -> the standalone runtime image), not `vinext`. This is a default-behaviour change: a `kn-next.config.ts` that omits `build` now produces the standalone artifact instead of the compiled vinext single executable, and `runtime` (default `node`, or `bun` for the compiled bytecode executable) picks which standalone image is staged and built.

If your app relies on the vinext build, keep it by setting `build: 'vinext'` explicitly in `kn-next.config.ts`:

```ts
const config: KnativeNextConfig = {
  name: 'acme',
  registry: 'registry.example.com/acme',
  build: 'vinext',
};
```

Apps scaffolded by `kn-next create` are unaffected: the scaffold now pins `build: 'vinext'` explicitly, since its `next.config.ts` and `Dockerfile` are still vinext-shaped. A standalone-by-default scaffold is tracked as separate follow-up work.
