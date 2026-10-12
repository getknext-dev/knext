---
"@getknext/core": major
---

**Breaking: knext now requires Node.js 24 or newer.** The `engines.node` range moves from `>=22.18` to `>=24` on `@getknext/core` and the `kn-next` alias (`@getknext/lib` and `@getknext/db` declare no engines). Every CLI entry checks the running Node.js at start-up: on an older Node, `knext` (and each directly runnable entry such as `preview`, `loadtest`, `build` and `cleanup`) prints one line naming the floor and exits non-zero before loading anything else. `knext doctor` gains a row that reports the running Node.js version against the floor. The container images knext builds and the GitLab CI template `knext init-ci` writes now use Node.js 24 base images, and the documented GitHub Actions examples use Node.js 24. Stay on knext 1.x if you cannot upgrade Node.js yet.
