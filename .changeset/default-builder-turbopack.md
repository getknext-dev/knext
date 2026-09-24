---
"@getknext/core": minor
---

**Existing apps without a `build` key switch builders on upgrade.** The default build target changed from `vinext` (the compiled single executable) to `turbopack` (`next build` -> the standalone runtime image), and the default runtime for that shape is `bun` (the compiled bytecode executable) — the credentialed v1.0 default per ADR-0054/ADR-0058. If your `kn-next.config.ts` omits `build`, your next deploy will try to build and ship a completely different artifact.

**If your app builds with vinext (its build script runs `vite build`), you MUST add `build: 'vinext'` to `kn-next.config.ts` before upgrading**, or `kn-next build`/`deploy` will look for a `.next/standalone` tree your build script never produces and fail:

```ts
const config: KnativeNextConfig = {
  name: 'acme',
  registry: 'registry.example.com/acme',
  build: 'vinext',
};
```

Apps already on the standalone target (`build: 'turbopack'`/`'webpack'`, or building with `next build`) are unaffected by the `build` change. If you had `runtime` unset there too, it now defaults to `bun` (compiled bytecode) instead of `node` — set `runtime: 'node'` explicitly if you want the uncompiled fallback.

Apps scaffolded by `kn-next create` are unaffected: the scaffold now pins `build: 'vinext'` explicitly, since its `next.config.ts` and `Dockerfile` are still vinext-shaped. A standalone-by-default scaffold is tracked as separate follow-up work.
