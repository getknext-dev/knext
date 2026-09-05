# #948 — node-run vinext build, end-to-end with real Bun (2026-09-05)

Reproducible record for the claim in PR #956 that the bundled CLI under plain Node now
completes a vinext build with a **real** Bun — not only the test suite's spawning-contract
shim. Run on `agent/s3-node-build-fix` (fix commit `1c72633a` + the review round's
stderr-capture change), against a freshly rebuilt `dist/`.

## Setup

A minimal app dir (outside the repo): `kn-next.config.ts` with `name` + `registry` only
(default build = vinext, no storage), and a trivial pre-made `.output/server/index.mjs`
(`export default {};`) so `--skip-next` has an entry to compile. PATH built from scratch —
mise's Bun 1.4.0, Node 24's bin dir, `/usr/bin:/bin` — so no ambient tool leaks in.

## Transcript (condensed; timestamps/ANSI stripped)

```
$ node --version                                   # v24.14.0 (the CLI runtime)
$ /Users/banna/.local/share/mise/installs/bun/1.4.0/bin/bun --version   # 1.4.0
$ PATH="<mise-bun-1.4.0>/bin:<node24>/bin:/usr/bin:/bin" NODE_OPTIONS= \
    node <repo>/packages/kn-next/dist/cli/kn-next.js build --skip-next --skip-smoke
INFO (kn-next): 🔨 kn-next build (Next.js official adapter + standalone)
INFO (kn-next): Configuration loaded            app: "smoke-app" … runtime: "node"
INFO (kn-next): Skipping the standalone-tree post-build steps — … shape: "nitro-output-bun"
INFO (kn-next): Compiling the single executable (bun, bytecode, minified)...
INFO (kn-next): Single executable compiled      binary: "knext-exec-linux-x64"
WARN (kn-next): ⚠️  POST-COMPILE SMOKE SKIPPED (--skip-smoke): …
INFO (kn-next): ✨ Build complete! Run `kn-next deploy` to push the image and apply the NextApp CR.
$ echo $?                                          # 0
$ ls -l knext-exec-linux-x64                       # 76289496 bytes (~76 MB)
```

Before the fix, this exact invocation died at the detection step with *"needs `bun` on PATH
… and it was not found"* — Bun 1.4.0 on PATH notwithstanding (S3-V Finding B-1,
`sprint2-aggregate-2026-09-05.md` on `agent/s3-verification`): the tsup bundle's
`__require("child_process")` threw before any spawn, and the bare catch mislabelled it.
