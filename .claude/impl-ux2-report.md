DONE

Branch `feat/ux-guided-first-contact` (worktree agent-ae7f3716102f30d03). Commits (local, unpushed,
--no-gpg-sign):

- `1b64c80` feat(cli): guide instead of crash when there is no config, and make --help honest
- `cb69312` test(cli): tighten the dispatched-verb scan to the routing branch, not the error label

## Files touched

New:
- `packages/kn-next/src/cli/help.ts` — `CLI_HELP`, `INTERNAL_ONLY_VERBS`, `DOCS_URL`
- `packages/kn-next/src/__tests__/cli-config-not-found.test.ts` (14 tests)
- `packages/kn-next/src/__tests__/cli-help-surface.test.ts` (18 tests)

Modified:
- `packages/kn-next/src/cli/shared.ts` — `CONFIG_NOT_FOUND_CODE`, `ConfigNotFoundError`,
  `formatConfigNotFound()`, `handleConfigNotFound()`; `loadConfig` throws the tagged error
- `packages/kn-next/src/cli/deploy.ts` — help moved to `help.ts`; `build`/`cleanup` dispatch;
  config-not-found handled before `log.fatal`; `loadConfig` now runs before the "kn-next deploy"
  banner (pino's async transport otherwise printed the banner *after* the guidance)
- `packages/kn-next/src/cli/build.ts`, `cleanup.ts`, `preview.ts`, `loadtest.ts` — same catch wiring
  (`cleanup()` is now exported so the bin can dispatch it)
- `packages/kn-next/src/__tests__/cli-node-runtime.test.ts` — help assertions; dist no-inline guard
  for `build`/`cleanup`; `kn-next cleanup` must not announce "kn-next deploy"
- `packages/kn-next/src/__tests__/loadtest-cli-run.test.ts` — its `../cli/shared` mock now uses
  `importOriginal` so `handleConfigNotFound` stays REAL (the generic error must NOT be claimed)
- `apps/docs/content/docs/cli.mdx` — command list (create first, build/cleanup as subcommands),
  the "not dispatched" callout now names only preview/loadtest, a no-config callout

`README.md` is UNCHANGED and now true as written: it advertised `npx @getknext/core build` and
`npx @getknext/core cleanup`, both of which previously fell through to a full DEPLOY. Reconciled by
making the bin route them, not by editing the line — a teardown command that deploys is the worse
half of that trade.

## Exact new text

Config-not-found (stderr, exit 1, no stack, no `FATAL`):

```
No kn-next.config.ts found in <cwd>

kn-next.config.ts is the file that tells knext about your app — its name,
where to push its container image, and where its static files go.

Starting a new app?
  npx @getknext/core create my-app

Adding knext to an app you already have?
  Add kn-next.config.ts to the project root (next to package.json),
  then run this command again from that directory.

  Docs: https://knext.dev
```

`kn-next --help`:

```
kn-next — deploy Next.js apps to Kubernetes (Knative), scaled to zero when idle

Usage: kn-next <command> [options]   (or: npx @getknext/core <command>)

Start here:
  create            scaffold a new knext-ready Next.js app (writes files only, no cluster changes)
  doctor            check the cluster has what knext needs (read-only; --json)

Deploy and operate:
  deploy (default)  build → push → apply the NextApp CR
  build             run the build + asset upload steps only, without deploying
  status            show the NextApp's honest conditions (read-only; --json, --watch)
  rollback          pin traffic to a prior Knative Revision (--to, --canary)
  cleanup           remove the app from the cluster (deletes its NextApp CR)
  gc                reap old _next/static/<build-id>/ asset prefixes (skew-protection GC)

Database:
  db bind           bind an existing Postgres Secret to the NextApp CR
  db migrate        apply pending migrations against the writer, once

Options (deploy):
  -r, --registry  Container registry (overrides config)
  -b, --bucket    Storage bucket (overrides config)
  -t, --tag       Image tag (default: timestamp)
  -n, --namespace Kubernetes namespace (default: default)
  --skip-build    Skip next build step
  --skip-upload   Skip asset upload step
  --dry-run       Print the NextApp CR without applying it
  -h, --help      Show this help
  -v, --version   Print the kn-next version

Examples:
  kn-next create my-app   scaffold a new app in ./my-app
  kn-next deploy          deploy the app in the current directory

Docs: https://knext.dev
```

## Decisions

- Excluded from help, with the reason in `help.ts`: `preview` (driven by
  `.github/workflows/preview.yml`) and `loadtest` (k6 runbook tool). Pinned by
  `INTERNAL_ONLY_VERBS`, so listing one requires deleting it there.
- No `--json` variant for config-not-found: `doctor` loads no config and `status` loads it only
  when the file exists, so no machine-readable verb can reach the branch. Adding a `--json` flag to
  `deploy` would be a CLI-surface expansion beyond this issue.
- Invalid-but-present config is untouched (explicitly out of scope).
- `build`/`cleanup` are now dispatched AND keep their self-entry blocks; the #263 inlining hazard is
  now *proved* rather than argued — the dist guard asserts each body is in its own `dist/cli/*.js`
  and NOT in `dist/cli/kn-next.js`.

## Verification

- `npx vitest run packages/kn-next` — 140 files / 1460 tests green.
- `tsc --noEmit` in `packages/kn-next` — clean. Root `tsc -p tsconfig.typecheck.json` — clean.
- `biome check` — clean on every touched file.
- Mutations (each run, exit code checked, then `git checkout` restore; tree verified clean):
  1. `loadConfig` throws a plain `Error` → RED
  2. drop `handleConfigNotFound` from the dispatcher catch → RED
  3. remove the `create` line from the help → RED
  4. delete the `cleanup` dispatch branch → **GREEN at first** (the guard was decoration: the
     catch block's label chain still matched a bare `sub === "x"`). Guard tightened to require the
     routing form `(sub === "x") {`; the same mutation then RED. This is commit `cb69312`.
  5. advertise `preview` in the help → RED

## Environment notes (not defects)

- This worktree shipped with no `node_modules`; I populated it by copying the parent repo's
  symlink trees (gitignored, nothing committed) so `tsc`/`tsup` could run. Before that, the
  dist-dependent suites (`publish-surface`, `public-api-surface`, `validate-public-export`) and
  `adapter-dev-edge-fence` failed for missing artifacts, not for this change.
- The full-repo `vitest run` has 7 unrelated failing files (`apps/file-manager/next-adapter`,
  `examples/bun-exec/*`, `tests/mutation-residue-scan`, `tests/compat-window-fingerprint`,
  `tests/bun-exec-example-suite-collection`) — none import `cli/shared`, `cli/help`, or the bin;
  they are worktree/environment-bound (git-relative scans and example workspaces).

## Deferred

- Not pushed (auth down, per instructions).
- No kind/OKE run: the change is CLI-local and touches no cluster path.
- An unknown first argument still falls through to `deploy` (`kn-next depoy` deploys). That is the
  general form of the `cleanup` footgun and is a CLI-surface decision beyond this issue —
  TODO(#ux-1d-followup): consider rejecting unknown verbs.
