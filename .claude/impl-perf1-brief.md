# Perf iteration — #441: decompose and attack the 842ms knext wrapper overhead

Repo /Users/banna/alpheya/pocs/knext. Branch `perf/wrapper-overhead-decomp` from origin/main,
isolated worktree under /Users/banna/alpheya/pocs/knext-wt/. Commit --no-gpg-sign, push when
green, no PR.

Read #441 (gh issue view 441) fully, and #592 (the 'attribute the 842ms to specific phases'
workstream ticket) if it adds detail. Measured on OKE: knext's node-server wrapper (parent
spawns Next's standalone server.js as a child) costs 842ms / +43% over booting server.js
directly — entirely knext's own code, 2.1x what the baked compile cache saves.

Phase 1 — DECOMPOSE before optimizing (the loop's rule: measure, then choose the lever from the
measurement). In-repo, reproducible locally: instrument packages/kn-next/src/adapters/node-server.ts
(and whatever it imports at boot) to emit phase timings — process start → its own module graph
evaluated → child spawn issued → child's first listen → readiness. Use process.hrtime.bigint()
and a single structured line per phase (opt-in behind an env flag, e.g. KNEXT_BOOT_TRACE=1, so
production is untouched). Run it locally against the file-manager standalone build (or the
smallest faithful standalone app you can build) N>=10 and report the phase table.

Phase 2 — NAME the dominant term and propose the fix in your report (do NOT implement a large
change without the lead's go-ahead; a small obvious win — e.g. a lazily-required heavy import,
a redundant fs walk, a synchronous JSON parse of something large — you MAY implement, TDD'd,
if it is contained and provable).

Constraints: NEVER regress the runtime contract (the standalone server is the runtime; the
metrics sidecar and the compile-cache env must keep working); mutation-prove any new guard; the
adapter-migration test and cli-node-runtime tests must stay green.
Report → worktree .claude/impl-perf1-report.md: the phase table, the named dominant term, the
proposed lever with its expected size, and anything you implemented.
