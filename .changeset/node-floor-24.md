---
"@getknext/core": major
---

**Breaking: knext now requires Node.js 24 or newer.** The `engines.node` range moves from `>=22.18` to `>=24` on every published package, and the CLI checks the running Node.js at start-up: on an older Node, `knext` prints one line naming the floor and exits non-zero before loading anything else. `knext doctor` gains a row that reports the running Node.js version against the floor. The container images knext builds and the GitLab CI template `knext init-ci` writes now use Node.js 24 base images. Stay on knext 1.x if you cannot upgrade Node.js yet.
