APPROVE

# Spec review — ergonomics-ledger findings 1b + 1d

**Spec:** `docs/ux/ergonomics-ledger.md` @ `measure/ux-ergonomics-ledger-row1`
**Impl:** worktree `agent-ae7f3716102f30d03`, branch `feat/ux-guided-first-contact`
(`1b64c80`, `cb69312`), `origin/main...HEAD` = 12 files, +602/−53.
**Method:** empirical. Rebuilt `dist` from source (`npx tsup --clean`) and ran the real bin in
fresh `mktemp -d` directories. Nothing below is read-only inference.

## Binding exit criterion
> "a novice in a bare directory who types the default command is told, in plain words, what to
> do next — and `--help` shows them `create`."

**Both halves met, executed and observed.**

## Checklist

| criterion (ledger) | verdict | evidence |
|---|---|---|
| 1b — no-config is a **guided message**, not a crash | **met** | Ran `node dist/cli/kn-next.js` with no args in empty `/private/tmp/knext-novice-ZL2c69`. Output verbatim matches the report's block. |
| 1b — explains **what a config is**, plain English | **met** | "kn-next.config.ts is the file that tells knext about your app — its name, where to push its container image, and where its static files go." |
| 1b — **zero k8s jargon** in first contact | **met** | Scanned the live message for `CR, CRD, manifest, cluster-prereq, Kubernetes, Knative, kubectl, namespace, revision, operator, YAML, FATAL` → **all 14 absent**. |
| 1b — names `npx @getknext/core create` | **met** | "Starting a new app? / `npx @getknext/core create my-app`" — and the *existing*-app branch is covered separately. |
| 1b — **real** docs link, not invented | **met** | `https://knext.dev` (`help.ts:38 DOCS_URL`). Pre-existing repo URL: `CONTRIBUTING.md`, `docs/adr/0024-docs-site-in-monorepo.md`, `packages/kn-next/README.md`, `scripts/verify-anonymous-install.mjs`. |
| 1b — **no stack trace**, exit 1 | **met** | Observed `EXIT=1`, stdout empty, stderr = guidance only. No `FATAL`, no `chunk-*.js` frame. |
| 1d — `--help` shows `create`, **first**, under "start here" | **met** | Rendered real `--help`: `Start here:` → `create` is the first verb listed. `cli-help-surface.test.ts` + `cli-node-runtime.test.ts:288-292` (`/^ {2}create\s+/m` on real `node kn-next.js --help` stdout). |
| 1d — every user-facing verb present | **met (with a pinned, justified exclusion)** | Help lists 10: create, doctor, deploy, build, status, rollback, cleanup, gc, db bind, db migrate. Runnable dist entries not listed = only `preview` + `loadtest`, pinned in `INTERNAL_ONLY_VERBS` (`help.ts:35`) with reasons (CI-driven / k6 runbook); both still documented in `cli.mdx`. `validate.js` has **no shebang** and `exec` has no dist entry → library modules, so help.ts's "not a verb" claim is true, not a dodge. |
| 1d — **inverse lie**: any verb in help that isn't dispatched? | **met — none** | Executed all 10. `create/doctor/status/rollback/gc` render their own help; `build`/`cleanup` reach the guided message (proving dispatch, not fall-through); `db` renders its own subcommand help; `db bind`/`db migrate` reach their own real logic. |
| README consistency | **met** | `README.md:798` `npx @getknext/core build` and `:800` `… cleanup` previously fell through to a full **deploy**. Now genuinely routed — README is unchanged and true as written. Reconciling by routing rather than by editing the line is the right half of that trade: a teardown command that deploys is the worse failure. |
| Scope honesty (ledger said 1b+1d in one PR) | **met** | `preview.ts`/`loadtest.ts`/`build.ts`/`cleanup.ts` diffs are *exactly* the disclosed `handleConfigNotFound` catch wiring + one `export` on `cleanup()`. `cli.mdx` is the mandated docs step. **No unrelated work.** |

## Independent mutation proof (not taken on trust)
Removed the `create` line from `CLI_HELP` via a script asserting the anchor occurs **exactly once**
(never `perl`), then ran the guard: **RED, 2 tests failed** — it catches both *listed* and *first*.
Restored via `git checkout`; `git status --porcelain` clean apart from the untracked report; suite
re-run green (18/18). **No mutation residue.** The guard is real, not decoration.

## Verification performed
- `cli-config-not-found` (14) + `cli-help-surface` (18) + `cli-node-runtime` (24) → **56 passed**.
- The claimed e2e is real (`spawnSync` on the actual entry, empty `mkdtemp` dir, asserts exit 1 /
  `create` / docs URL / no `FATAL` / no stack frame). It has a bun-absent fallback that degrades to
  a near-vacuous `existsSync`, **but its stated justification checks out**: the same contract is
  asserted under plain Node against the dist bin in `cli-node-runtime.test.ts:288-332`. `bun 1.3.5`
  is on PATH here, so the e2e genuinely executed. Not an issue.

## Non-blocking observations (out of 1b/1d scope — recorded, not charged)
1. `kn-next db bind` with no args in a bare dir still prints `FATAL` + a stack trace. This is
   db-bind's own "app name required" error, **not** `ConfigNotFoundError` — `handleConfigNotFound`
   correctly declines to claim it. Not the default command, so outside 1b. A candidate for a later
   ledger row if `db` ever becomes an early-journey verb.
2. Unknown verbs still fall through to deploy (`kn-next depoy`). **Disclosed** in the report as
   `TODO(#ux-1d-followup)`, called out honestly in `cli.mdx`'s warn callout, and narrowed by this
   PR (in a bare dir the typo now yields guidance, not a deploy attempt).
3. `cli.mdx` asserts "`kn-next --help` lists exactly this set, `create` first" — true today, but
   nothing ties the docs list to `CLI_HELP`. Cheap future guard; not a defect now.

## Escalation check
The diff touches `packages/kn-next/src/cli/` and genuinely changes the CLI surface (build/cleanup
promoted to dispatched subcommands) — a **mechanically detectable trigger** under
`workflow.md`. It was **not** skipped: `.claude/architect-signoff-ux2.md` exists and reads
`SIGN-OFF — no ADR or hard rule … is contradicted`. Correctly handled.

## Verdict
**APPROVE.** Both ledger findings are closed by behaviour I executed, not by text I read. The
exit criterion is met verbatim in both halves, the guards are mutation-proved, the docs URL is
real, there is no inverse lie in `--help`, and the change stayed inside the scope the ledger
allotted it. Merging this honestly resolves iteration-2 (1b + 1d); 1a and 1c remain open by
design.
