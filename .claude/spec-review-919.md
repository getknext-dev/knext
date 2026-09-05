# Spec review — PR #919 vs issue #894 (post-compile RuntimeContract smoke) / T3b

Reviewer: spec gate (read-only). Branch @ e4d2204b. Both new spec files RUN and pass in isolation
(11 pass / 12 pass, `bun test <file>` in the implementer worktree).

## Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1a | "A scaffolded app's build passes the smoke" | **PARTIAL** | No test compiles the scaffolded template and runs the real smoke on it. The passing case boots `__tests__/fixtures/smoke-server.mjs`, a hand-written node stand-in (`postcompile-smoke.test.ts:61` "passes, and reports the ports it actually probed"). Circumstantial support is strong and I verified it independently: `packages/kn-next/templates/app/knext-bun-entry.mjs.hbs:281` prints `LISTENING:${appServer.port} METRICS:${metricsServer.port}`, `:246` resolves the real bound port under `PORT=0`, `:168` honours `SHUTDOWN_GRACE_MS`, and the scaffold ships `src/app/api/health/route.ts.hbs`. But **nothing pins** `postcompile-smoke.ts`'s `STARTUP_LINE = /LISTENING:(\d+)\s+METRICS:(\d+)/` to that template line — drift breaks every build loudly (safe direction), yet the criterion as written is unproven by a test. |
| 1b | "removing the drain (or the health route) from the entry fails the build with the obligation named" | **MET** | `postcompile-smoke.test.ts` "names 'health' …", "names 'metrics' …", "names 'sigterm' when the drain never exits", "names 'boot' …" (one obligation removed per fixture mode); message assertions at `:153` ("names the obligation AND the binary"), `USAGE_ERROR_CODE` at `:164`. Build-level: `postcompile-smoke-wiring.test.ts` "rejects, and never uploads assets" (`rejects.toThrow(/health/)` + `uploadAssets` not called). |
| 2 | "skippable with an explicit flag … and the skip is LOUD" | **MET** | `build.ts` `smokeCompiledBinary()` warn names health/metrics/SIGTERM as UNVERIFIED; tests "skips only when asked, and says so at warn level" (asserts `SMOKE SKIPPED` + all three words), "is off by default — the compile alone never implies a skip", "is reachable from argv, and documented in `--help`". Flag parsing: `build.ts` `KNOWN = new Set(["--skip-next","--skip-smoke"])`; docs row in `apps/docs/content/docs/cli.mdx`. |

## Lead's questions

- **fail-never-skip vs `--skip-smoke`:** no contradiction. #894 explicitly requires the flag; T3b's
  "fail-never-skip" is about the module having no self-inferred escape, and it has none — every path
  in `postcompile-smoke.ts` is pass-or-throw, incl. missing binary and `hostSmokeArch()` throwing on
  an unsupported host rather than guessing. The skip is caller-supplied, explicit, warn-level.
- **Cross-target honesty:** genuine. `examples/bun-exec/test/alpine-image.docker-e2e.test.ts` runs the
  real `bun-linux-x64-musl` binary in a container and asserts `/api/health` 200 (`:331`), `/metrics`
  200 on the metrics port (`:586`), and SIGTERM drain + exit 0 (`:606`), with an explicit no-skip
  path. The host-arch trade is documented in the PR, in `build.ts`, and in the user docs.
- **Wired into the real build path:** yes — `build.ts` step 2d awaits `smokeCompiledBinary()` after the
  single-exec compile and **before** `uploadAssets`. Note `deploy.ts` does not call `build()`, so the
  smoke covers `kn-next build` only (pre-existing structure, not a regression).
- **Adversarial — anything green if the feature were deleted:** only "does not downgrade the failure
  to a warning" (`expect(logged(warn)).not.toContain("never drained")`), a negative assertion that
  survives deleting the smoke entirely. It is labelled as the non-vacuity companion to the rejection
  case, which is not vacuous. No other criterion rests on a mock: the obligation tests drive the real
  exported function against real child processes (11.35 s wall clock), and the `-gnu`/musl invariant
  is scan-pinned (`target.endsWith("-musl") === !arch.endsWith("-gnu")`).

## Non-criterion findings (advisory)

1. **`knext-smoke-<arch>` is untracked and never cleaned.** `.gitignore:163` covers `knext-exec*`
   only. Every cross-arch `kn-next build` (i.e. every darwin dev build) drops a ~100 MB binary in the
   app root that shows up in `git status`. One line in `.gitignore` (+ the app template's), or unlink
   after the smoke.
2. **Cross-file `mock.module` leak.** Running the two new files in ONE bun process fails 10 tests —
   the wiring file's `mock.module("../cli/postcompile-smoke")` replaces the real function for the
   behaviour file. `scripts/bun-test.mjs` is one-process-per-file so CI is unaffected, but an ad-hoc
   `bun test packages/kn-next/src/__tests__` is red.
3. **Scope:** `--skip-smoke` is a CLI-surface addition, correctly self-escalated; #894 mandates it, so
   it is anticipated, not drift. The `linux-*-gnu` compile keys are not user-reachable (`arch` has no
   CLI/config path; only two internal call sites).

## Verdict

**ISSUES_FOUND** — one blocking gap: **AC 1a** has no test. Cheapest honest close is a scan-pin
asserting `postcompile-smoke.ts`'s startup-line regex matches the literal in
`templates/app/knext-bun-entry.mjs.hbs:281` (and the `examples/bun-exec` copy), so the fixture cannot
drift away from the entry it stands in for. Findings 1–2 are advisory; 1 is a one-line fix worth
taking in the same round.
