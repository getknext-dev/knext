---
"@getknext/core": minor
---

`knext build` and `knext deploy` now support an app in a workspace monorepo. Set `outputFileTracingRoot` and `turbopack.root` in the app's next.config to the workspace root and knext follows Next.js's nested layout, `.next/standalone/<app path>/server.js`, everywhere it looks for the server: the build, the bun-export heal, the compiled Bun executable, the generated Dockerfile and its build context (the workspace root), and the runtime image, which keeps the traced workspace files outside the app directory. Only an explicit setting enables this: a tracing root that Next merely inferred from a parent lockfile still stops `knext build` with an error that names the lockfile, and that error now says how to opt in. The flat layout is unchanged byte for byte, including the generated Dockerfile. See "Deploy from a workspace monorepo" in the docs.
