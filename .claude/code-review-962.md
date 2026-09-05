# Adversarial code review — PR #962 (scaffold version pins, closes #950)

Branch `agent/s3-scaffold-pins`, base `agent/s2-tail`. Read-only. Verdict: **ISSUES_FOUND** — 5
findings, none blocking the shipped behaviour's correctness; #1–#3 are real.

## Findings

### 1. `scripts/verify-scaffold-install.mjs:105-112` — the real notarget failure has an empty reason
Measured live (npm 11.9.0): `npm view '@getknext/core@^0.3.1' version --json` exits **1** and writes
the E404 JSON to **stdout**, not stderr. So the actual #950 case lands in the `r.status !== 0`
branch, whose message is `(r.stderr || '').trim()` → renders as
`npm view @getknext/core@^0.3.1 exited 1: ` with no reason. The script's own header promises
"both phases always run so a failure is attributable at a glance."
Fix: include a stdout slice in that message. (The `status===0 && stdout===''` branch is effectively
dead on npm ≥ 11 — fine to keep as a defensive path, but it is not the branch that fires.)

### 2. The bonus finding has no durable home — and it is worse than stated
Independently verified by unpacking the published tarball: `@getknext/core@0.3.0` contains
**zero `templates/` entries** and no `dist/cli/create.*`. The published CLI cannot scaffold at all,
not merely "lacks the `create` verb" — even a hypothetical verb would hit `loadTemplates()`'s
"missing its templates/ directory" throw. This lives only in the PR body (`gh issue list` finds no
issue for it), i.e. it evaporates on merge, while the new nightly's phase 2 is red from day one.
File an issue, or link #853 from the workflow header so the red is attributable.
(It is *not* permanently red: once 0.3.1 publishes, `@latest` carries create+templates and phase 2
can green. Also verified `@getknext/db@^0.2.1` resolves, so phase 2's `npm exec` reaches the verb.)

### 3. `packages/kn-next/src/cli/scaffold-registry.ts:161-167` — the warning's remedy is broken today
The message tells the user to "re-run create with the latest published CLI
(`npx @getknext/core@latest ...` exposes `kn-next`)" — but per finding #2 that CLI cannot create.
Self-correcting at the next publish, but it is an honesty gap in the module whose thesis is honesty.

### 4. `packages/kn-next/src/__tests__/scaffold-version-pins.test.ts:249` — regex misses `>=` pins
`/@getknext\/[\w-]+["']?\s*[:@]\s*["']?[~^=]?\d/` does not match `"@getknext/lib": ">=0.3.1"`
(`>` is not in `[~^=]`). A scan-heuristic gap, not a live defect.

### 5. `packages/kn-next/src/cli/create.ts:440-447` — the probe sits inside the try/catch
Every throw path in `checkPinsPublished` is caught internally, so this is essentially unreachable —
but if it ever threw, the catch would turn a *successful* scaffold (files already written) into
exit 1. `.catch(() => undefined)` would make "best-effort, never a gate" structural, not incidental.

## Verified clean (the brief's attack list)

- **Timeout**: `Promise.all` + `AbortSignal.timeout(3000)` per request → **3 s total worst case**,
  not per package. Signal covers body read, so a hung `res.json()` also aborts → `unreachable`.
- **URL construction**: `encodeURIComponent(name).replace(/%40/i,"@")` (non-global is correct — one
  leading `@`), base trailing-slash stripped. Registry base is the user's own `npm_config_registry`;
  no injection surface. A private registry returning 401 → `!res.ok` → `unreachable` → silent
  (correct fail-safe; the probe deliberately sends no auth token).
- **Silent-with-exit-0**: every fetch/JSON throw caught; verdict `unreachable` prints nothing; no
  unhandled rejection. Context-mode hooks are agent tooling, irrelevant to the CLI's runtime fetch.
- **`{{ version }}`**: rendered by create.ts's own strict regex renderer (`create.ts:250`), *not*
  handlebars; an unsubstituted `{{` throws. `--dry-run` renders but skips the probe
  (`create.ts:440`; the test asserts `hits() === 0`). `cliVersion()` (`create.ts:185`) reads
  `packageRoot()/package.json` at runtime → **`0.3.1` in a source checkout**, not `0.0.0-dev`, so a
  checkout scaffolds `^0.3.1` and gets the warning — the designed behaviour. The `?? "0.0.0"`
  fallback yields `^0.0.0`, which is also probed and also warns.
- **Changesets `fixed` group**: **pre-existing**, not added here —
  `[["@getknext/core","@getknext/lib","@getknext/db","kn-next"]]`, and `git diff base...head --
  .changeset/` is empty. **No release-behaviour change**; matches CLAUDE.md §9 ("they must ship
  together"). Nothing to sanction or flag.
- **Would the nightly have caught #950?** Yes — phase 1 asserts the *rendered range*, not the latest
  CLI. Both branches proven live: `^0.3.1` → exit 1; `^0.3.0` → exit 0, `"0.3.0"`. Unreachable is a
  failure (any non-zero fails). All branching is on exit codes; no output-grep anywhere.
- **Same-class sweep**: `git grep -E '@getknext/(core|lib|db)@[~^]?[0-9]'` over `apps/docs`,
  `packages/*/templates`, `README.md` → only `apps/docs/CHANGELOG.md` (historical). Template
  third-party pins (`next 16.2.11`, `sharp ^0.35.2`, `vinext 1.0.0-beta.8`,
  `nitro 3.0.260610-beta`) all resolve live and are outside the #950 class.
- **Cross-lane risk the PR did not claim**: `create` now makes a live network call inside
  `scripts/install-smoke.mjs:385`. Harmless — install-smoke branches only on `create.status` and
  file existence, never greps `createOut`.
- Test imports are correct (`create-scaffold.test.ts:26` already imports `beforeEach`).
