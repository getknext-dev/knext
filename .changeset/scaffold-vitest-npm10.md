---
"@getknext/core": patch
---

Scaffolded apps now `npm install` cleanly on npm 10.x. The app template pinned `vitest@^4`, whose Vite peer range excludes the `vite@8` the template also pins; on npm 10 that unsatisfiable peer aborts the install with an internal `edgesOut` error instead of a clean message. The template now pins `vitest@^5`, which supports Vite 8. (The template source was already corrected; this releases it so the published CLI scaffolds an installable app.)
