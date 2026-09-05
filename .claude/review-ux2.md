ISSUES_FOUND

# Adversarial code review — `feat/ux-guided-first-contact` (1b64c80 + cb69312)

Reviewed in worktree `agent-ae7f3716102f30d03` against `origin/main`. Built the package and ran the
full suite myself: **140 files / 1460 tests, exit 0** — the implementer's green claim is verified.
Mutation spot-checks were run by me, exit-code-branched, on a clean tree, with an anchor-count
harness that aborts on a failed substitution; the tree was restored and re-verified clean after each.

## Issues

### 1. `packages/kn-next/src/cli/deploy.ts:688-693` — `kn-next cleanup --help` now **tears the app down** instead of printing help. New destructive regression.
The two new dispatch branches parse **no arguments at all**: they call `cleanup()` / `build()`
unconditionally, so `-h`, `--help`, `-v`, `--dry-run`, and any typo'd flag are silently ignored.
Before this PR, `sub === "cleanup"` fell through to `deploy()` → `parseCliArgs()` → help, exit 0.

Proved, not inferred — same temp dir, a shimmed `kubectl` on PATH, a real-shaped config:

| build | `kn-next cleanup --help` |
|---|---|
| `main` (repo-root dist) | prints the help text, exit 0 |
| this branch (worktree dist) | `Deleting NextApp CR …` → `✨ Cleanup complete!` — the CR is destroyed |

Every other dispatched verb (`create`, `doctor`, `status`, `db`, `rollback`, `gc`) handles
`-h/--help` inside its own `*Main`; these two are the only ones that do not. `kn-next build --help`
has the same shape (runs `npm run build` + asset upload).

Why it matters: the PR's stated goal is the zero-Kubernetes newcomer, and `--help` is the first
thing that persona types. Turning `--help` into an irreversible cluster write is strictly worse than
the fall-through it replaces. It also makes the PR's own docs false — `apps/docs/content/docs/cli.mdx:28`
still asserts "The subcommands fail loudly on unknown flags, dangling values, and stray positionals",
which is now untrue for exactly the two subcommands this PR adds.

Minimum fix: an `-h/--help` (and `--version`) short-circuit in both branches before dispatch, plus a
strict-flag reject; and a guard that scans the dispatcher so a future branch cannot skip it.

### 2. `packages/kn-next/src/__tests__/cli-config-not-found.test.ts:129-132` — the "SCAN, not enumeration" guard is satisfied by the **import line**, so it is decoration for the half it advertises.
`expect(src).toContain("handleConfigNotFound")` matches
`import { handleConfigNotFound, loadConfig } from "./shared";`.

Mutation-proved: I removed the **entire** `if (handleConfigNotFound(err)) { process.exit(1); }` block
from `preview.ts`'s catch and left the import.
- `vitest run src/__tests__/cli-config-not-found.test.ts` → **exit 0, still green.**
- `npx biome check packages/kn-next/src/cli/preview.ts` → **"Found 1 warning", exit 0.** (Root
  `biome.json` sets `noUnusedImports: "error"`, but `packages/kn-next/biome.json` does not extend it,
  so the rule falls back to `recommended` = warn for this package.)

So an entry that imports the helper and forgets to call it ships silently, and the file's own
docblock claim — "a new entry that forgets it reds this file" — is false. This is the repo's own
named defect class ("a guard that stays green when its subject is removed is decoration",
`workflow.md`). Fix: anchor the assertion inside the `catch` block, or assert the *call* form
(`handleConfigNotFound(`) rather than the bare identifier.

The other three guards I attacked are solid: dropping the `cleanup` line from `CLI_HELP` → red;
removing the `cleanup` dispatch branch → red on two assertions (the cb69312 regex tightening genuinely
works — the pre-tightening version would have survived); appending the `cleanup` discriminator to
`dist/cli/kn-next.js` to simulate a tsup inline → the #263 guard goes red. All exit-code-branched.

### 3. `packages/kn-next/src/cli/deploy.ts:692-693` — an unknown verb still silently runs a full DEPLOY.
Proved: `kn-next deplyo --skip-build --skip-upload --dry-run` in a dir with a config logs
`kn-next deploy` and enters the deploy flow. This is the identical hazard class the PR set out to
fix — its own commit message calls a teardown-that-deploys "worse than a missing one" — and routing
`cleanup` makes it *more* surprising, not less: `kn-next celanup` now deploys. It is documented at
`cli.mdx:34`, and it predates this PR, so it is not a regression; but this is the change that made
the verb set authoritative and enumerated it in one place, which is where a `sub` allowlist +
"unknown command, did you mean …?" belongs.

## Process note (reviewer escalation, not a code defect)
The diff touches `packages/kn-next/src/cli/` and adds four exports
(`CONFIG_NOT_FOUND_CODE`, `ConfigNotFoundError`, `formatConfigNotFound`, `handleConfigNotFound`) to
`cli/shared`, which is a **published subpath** of `@getknext/core`, and it changes the bin's verb
set. That is two mechanically-detectable escalation triggers under `workflow.md` (public API / CLI
surface). Flagging it so the design gate is summoned rather than self-waived.

## Checks that came back clean
- **Error-tag contract:** `code === "ERR_KN_CONFIG_NOT_FOUND"` is knext-minted and checked in exactly
  one place (`handleConfigNotFound`); the constant is imported, never stringly duplicated. A genuine
  failure cannot wear the shape — a config that exists but fails to `import` (e.g. `ERR_MODULE_NOT_FOUND`)
  still reaches the FATAL path, correctly.
- **Coverage of config-loading entries:** all ten `loadConfig` call sites are accounted for.
  `status.ts:466` and `db-bind.ts:480` are `existsSync`-guarded so they cannot throw it; `gc.ts:556`
  and `rollback.ts:190` are unguarded but bin-dispatched, so the dispatcher's catch covers them
  (verified by reading, not assumed). No verb still dumps the raw FATAL for this state.
- **`--json` / structured-logging contract:** the dispatcher comment's claim holds — `--json` exists
  only in `status.ts:80` and `doctor.ts:922/929`, and neither can reach the branch. `runLoadTestCli`
  still returns `1`, so exit codes are unchanged.
- **`cleanup` works end-to-end** post-routing (config load → exactly one CR-scoped cluster write →
  clean exit); routing did not expose a broken command that fall-through had been masking.
- **Security:** no new endpoint, no secret, no `:latest`, no shell-string building (`runQuiet` is
  `execFileSync`, `shell:false`). Guidance text prints `process.cwd()` only.
- **Conventions:** biome-clean, no stray `console.log`, no dead code; the `as { code?: unknown }`
  narrowing casts are honest and documented.

## Test quality
Genuinely good and adversarially built — three of the four new guards die under mutation, the
help/verb sets are derived by scanning the dispatcher and README rather than enumerated (the repo's
known defect class), and the `loadtest` mock was deliberately narrowed via `importOriginal` so the
real discriminator still runs; the two soft spots are the import-line-satisfiable entry scan in
issue 2 and the bun-less fallback at `cli-config-not-found.test.ts:150` that degrades to an
`existsSync` tautology.

---

# Round 2 — commit 22c48d4

ISSUES_FOUND

Rebuilt (`tsup`, exit 0) and re-ran the suite myself: **141 files / 1512 tests, exit 0** (was
140/1460). All three round-1 findings are genuinely fixed, and I proved each rather than reading it.
Two smaller issues remain, both new to this round.

## Round-1 findings — re-verified as fixed

- **`cleanup --help` no longer destroys.** On the freshly-built dist bin, in a temp dir with a real
  config and a **shimmed `kubectl` on PATH**: `kn-next cleanup --help` → exit **0**, prints
  `CLEANUP_HELP`, and the shim is **never invoked** — zero cluster writes. `kn-next build --help` →
  exit 0, no build, no upload. **Mutation-proved** the guard that keeps it that way: reverting the
  `cleanup` branch to the round-1 `await cleanup(); process.exit(0)` shape reds
  `cli-dispatch-contract.test.ts` ("`cleanup` forwards process.argv.slice(3) to a *Main"), exit 1.
- **The decorative guard is dead.** I re-ran my **exact** round-1 escape — delete the whole
  `if (handleConfigNotFound(err)) {…}` block from `preview.ts`'s catch, keep the import — against the
  new catch-body-brace-matched CALL-form assertion: **red**, exit 1, with the intended message
  ("no catch block calls handleConfigNotFound(…)"). The escape is closed.
- **Unknown verbs no longer deploy.** `kn-next celanup` → exit 1, `unknown command: celanup` +
  `Did you mean: kn-next cleanup?`, nothing runs.

## The unification I was asked to attack — it holds

`KNOWN_VERBS` is derived from `COMMAND_GROUPS`, but `CliCommand` carries **two** fields (`verb` and
`display`), so my drift hypothesis was: set `{ verb: "teardown", display: "cleanup" }` — help still
renders a routable `cleanup`, while the allowlist silently gains `teardown`, which has no dispatcher
branch and would therefore fall through to `else { await deploy() }`. That is the round-1 hazard
re-armed through a new door. **Mutation-proved: it reds** — `cli-dispatch-contract.test.ts`'s
"KNOWN_VERBS matches the dispatcher's branches plus the default" is a set-equality in **both**
directions against brace-matched dispatcher branches, so neither a help-only verb nor an
allowlist-only verb can survive. The single-list claim is real, not decorative.

## Issues

### 1. `docs/adr/0046-cli-verb-dispatch-contract.md:62,70-71` — the ADR records a consequence the code does not have.
The ADR states, as an accepted consequence of the chosen option: *"A positional argument to the
default deploy is now an error. `parseArgs` accepted positionals and ignored them; a stray word now
fails loudly."* `cli.mdx:28` echoes it ("Every subcommand fails loudly on unknown flags, dangling
values, and stray **positionals**").

It is not implemented. `deploy.ts:101` is still `allowPositionals: true` with **no** check on
`positionals`. Only a stray word in the **first** slot is caught, and that is `resolveInvocation`'s
doing, not `parseArgs`'. Proved on the real bin (temp dir, real config, shimmed kubectl):

| invocation | actual |
|---|---|
| `kn-next deploy cleanup` | runs the **deploy** flow, `cleanup` silently swallowed |
| `kn-next --namespace prod cleanup` | runs the **deploy** flow against `prod`, `cleanup` silently swallowed |
| `kn-next -- cleanup` | runs the **deploy** flow, `cleanup` silently swallowed |

The middle row is the one that matters: a user who habitually puts flags before the verb types
`kn-next -n prod cleanup` and gets a **deploy to prod instead of a teardown** — the same
"opposite action" hazard ADR-0046 exists to kill, still reachable through the flags-first door. The
ADR is the durable artifact (`architecture.md` §3), so a false Consequence line is worse than the
gap itself. Either implement the rejection (reject any positional not consumed as the verb, keeping
bare/flags-only deploying) or correct both the ADR and `cli.mdx:28`. Note the fix is safe: see the
docs scan below — nothing documented passes a positional to `deploy`.

### 2. `cleanup.ts:106-111` / `build.ts:158-165` — the new strict-flag errors render as a FATAL stack dump, the exact presentation this PR exists to remove.
Both `*Main`s `throw`, so they land on the dispatcher's `log.fatal({ err }, label)`. What a user
typing `kn-next cleanup -v` actually sees:

```
FATAL (kn-next): cleanup failed
    err: { "type": "Error", "message": "unknown flag \"-v\" — …",
      "stack": Error: unknown flag "-v" …
          at cleanupMain (file:///…/dist/cli/cleanup.js:57:11)
```

A serialised Error, a stack frame, and an **absolute dist chunk path** — which this PR's own test
asserts against for the sibling path (`cli-config-not-found.test.ts`: "carries no stack frame and no
bundler chunk path"), and whose removal is the PR's whole thesis. It is also internally inconsistent:
`kn-next celanup` (a typo) gets a clean one-liner, while `kn-next cleanup -v` (also a typo) gets the
dump. `kn-next cleanup myapp` and `kn-next db frobnicate` are the same shape. The message text is
good — it just needs the `formatUnknownCommand`-style write-and-exit path rather than `throw`.

### Nits (not blocking)
- `cli-dispatch-contract.test.ts:17` docblock cites "help.ts `COMMANDS`"; the export is
  `COMMAND_GROUPS`.
- `kn-next ""` prints `unknown command: ` with an empty token (exit 1, no deploy — safe, just ugly).

## The two deliberate behaviour changes — judged, both clear
I scanned `README.md`, `apps/docs/content/**`, `.github/workflows/**` and `scripts/**`:
- **`-v` on a subcommand is now a hard error.** **Zero** documented invocations of the form
  `kn-next <verb> -v`. Top-level is untouched and I verified it on the bin: `kn-next -v` → `0.3.0`
  exit 0, `--version` → same, `-h` → help exit 0 (a leading `-` resolves to `deploy`, so
  `parseCliArgs` still owns them). Nothing breaks.
- **Positional to default deploy.** **Zero** documented `kn-next deploy <word>` forms, so
  implementing the rejection breaks nothing — which is why issue 1 is worth closing properly rather
  than by softening the ADR. (As shipped, it is not rejected at all.)

## Other fresh surfaces — clean
- `resolveInvocation`: `undefined` → deploy; `--`/any leading `-` → deploy; explicit `deploy` →
  deploy; `""` → unknown (exit 1, not a deploy). All confirmed on the bin, not just in unit tests.
- `db` with an unknown subverb (`kn-next db frobnicate`) → exit 1, no deploy (rendering per issue 2).
- Subcommands that legitimately take positionals (`status <app>`, `rollback <app>`, `db bind <app>`,
  `create my-app`) still receive them — `argv.slice(3)` is forwarded intact.
- `suggestVerb` tolerance scales with length and returns nothing for `xyzzy`; a confidently wrong
  suggestion is avoided.
- #263 no-inline guard still present and still mutation-solid (unchanged from round 1); the new
  per-verb `--help` dist test is derived from `KNOWN_VERBS` (scan, not enumeration) and asserts the
  destructive discriminators are absent — the right shape.
- Security: no new endpoint, no secret, no `:latest`, no shell-string building.

## Test quality
Materially stronger than round 1 and the additions are adversarial in the right way: the dispatcher
scan is brace-matched (so a nested block cannot make it vacuous), the verb allowlist is a
**two-way** set-equality against the dispatcher rather than a subset check, and the per-verb
`--help` exit-0 run happens against the **real built bin** with destructive-work assertions. Three
of three mutations I ran — the round-1 escape, the unparsed-branch revert, and the verb/display
drift — all red. The one soft spot from round 1 survives untouched: the bun-less fallback at
`cli-config-not-found.test.ts` still degrades to an `existsSync` tautology.

---

# Round 3 — commits 1dbce5a + ddde521 + 2d306dc

ISSUES_FOUND

Rebuilt (tsup, exit 0) and re-ran the suite: **1540 tests, exit 0**. Round-2 finding 1 is fully and
correctly fixed. Round-2 finding 2 is **half fixed** — the sweep covered four verbs and left six
verified usage mistakes still printing a FATAL stack dump — and the new scan guard cannot see the
gap. I defeated that guard with a mutation of my own design as well.

## Verified fixed — round-2 finding 1 (stray positionals)
All against the freshly-built dist bin, my three invocations verbatim:

| invocation | exit | output |
|---|---|---|
| `kn-next deploy cleanup` | 1 | `unexpected argument: cleanup` + "`cleanup` is a command, and the command comes first" |
| `kn-next --namespace prod cleanup` | 1 | identical |
| `kn-next -- cleanup` | 1 | identical |

No `FATAL`, no stack, no chunk path, and — importantly — **pre-config**: none of them prints
`No kn-next.config.ts found`, so it refuses before the deploy flow starts. The two forms that must
survive do: `kn-next deploy` alone reaches config loading (still deploys), and `kn-next --help extra`
exits 0 with help (ADR-recorded, and correct — help is never an error).

## Issue 1. The usage-error sweep is partial, and ADR-0046 records it as complete.
ADR-0046's action item now reads, checked: *"`UsageError` + `handleUsageError` in `cli/shared.ts`;
**every** CLI module's usage throws converted (build, cleanup, gc, db-bind, db-migrate, rollback,
status)."* `doctor.ts` and `preview.ts` were never touched, and inside `rollback.ts`, `status.ts` and
`db-bind.ts` only *some* throws were converted. Measured on the bin (both streams — pino writes the
FATAL to **stdout**, which is why a stderr-only check looks clean):

| invocation | rendering |
|---|---|
| `kn-next doctor --bogus` | **FATAL + stack + chunk path** (`doctor.ts:924`) |
| `kn-next status --json --watch` | **FATAL + stack + chunk path** (`status.ts:101`) |
| `kn-next status` (no app, no config) | **FATAL + stack + chunk path** (`status.ts:473`) |
| `kn-next rollback --canary 500` | **FATAL + stack + chunk path** (`rollback.ts:122`) |
| `kn-next rollback --canary 50` (no `--to`) | **FATAL + stack + chunk path** (`rollback.ts:142`) |
| `kn-next db bind myapp` (no `--secret`) | **FATAL + stack + chunk path** (`db-bind.ts:141`) |
| `kn-next cleanup -v` / `gc --bogus` / `build --bogus` / `db frobnicate` | clean message ✓ |

Two of these sting particularly:
- **`doctor --bogus` is an unknown-flag rejection** — the guard's own headline case — and
  `cli.mdx:28`, edited by this PR, still asserts "**Every** subcommand fails loudly on unknown flags,
  dangling values, and stray positionals". It fails, with a stack trace.
- **`rollback.ts:142`'s message already ends `(see kn-next rollback --help)`** — it was *authored* as
  a usage message, and `handleUsageError` has a dedicated branch for messages that already carry a
  help pointer. It simply never reaches it.

`preview.ts:369,383` are the same class (`expected subcommand "deploy" or "destroy"`, `--pr <n> is
required`), unreached by the bin but reachable via the documented direct entry.

## Issue 2. The ddde521 window scan is decoration for two distinct escapes — one of them already shipped.
The guard windows 240 chars after each `throw new Error(` and tests against `USAGE_PHRASE`, an
**enumerated alternation** of six phrasings. So the scan is over files but the *matching* is an
enumeration — the repo's own named defect class, relocated one level down.

- **Escape A (live, not hypothetical).** `doctor.ts:924` says `unknown argument "…"`. The phrase list
  has `unknown flag`, not `unknown argument`. Missed by one word, shipped green. Every message in
  issue 1's table escapes the same way.
- **Escape B (my mutation, of my own design).** Hoist the message out of the call — a one-line
  refactor no reviewer would blink at:
  ```
  const msg = a.startsWith("-") ? `unknown flag "${a}" (…)` : `unexpected positional …`;
  throw new Error(msg);
  ```
  in `buildMain`. The window after `throw new Error(` contains only `msg)`. **`vitest run
  cli-dispatch-contract.test.ts` → exit 0, green.** The `UsageError` is gone and the guard does not
  notice. (Anchor-asserted harness, restored, tree re-verified clean.)

ADR-0046 states as decision text: *"A source scan fails the build if any CLI module raises a usage
phrase as a plain `Error`."* Both escapes falsify it.

The dist behaviour test is the stated backstop, and it held for the verbs it names — but it is
**enumerated**: four invocations covering only `cleanup`, `build` and `db`. It covers **none** of
`doctor`, `status`, `rollback`, `preview`, which is precisely where the live bleed is. So the two
layers have correlated blind spots rather than independent ones. Deriving the invocation list from
`KNOWN_VERBS` (as the sibling `--help` test already does) would have caught issue 1 mechanically.

This is the **third** scan guard in this PR to pass reading and fail mutation. The implementer's own
disclosure about the ternary is exactly right and to their credit — the pattern is the finding, not
the individual slip.

### Nit
`gc-main.test.ts:84` asserts `rejects.toThrow(/unknown flag/)` — a **message** regex, which a plain
`Error` satisfies just as well. The new `importOriginal` comment claims it "exercises the class the
CLI actually throws" so "the presentation contract" cannot rot; it does not. The mock change itself
is a genuine strengthening (real `UsageError` instead of an undefined stub) and weakens nothing —
only the comment over-claims. `expect(...).rejects.toMatchObject({ code: USAGE_ERROR_CODE })` would
make it true.

## What would clear this
1. Convert the remaining usage throws (`doctor.ts:924`, `status.ts:101,473`, `rollback.ts:122,142`,
   `db-bind.ts:141,487`, `preview.ts:369,383`) — or narrow the ADR/`cli.mdx` claims to what is real.
2. Make the scan detect the *shape* rather than the *wording*: flag any `throw new Error(` in
   `src/cli/` that is not on an explicit, justified allowlist (env/cluster failures such as
   `exec.ts`'s empty-argv and `cr-builder.ts`'s digest checks), which inverts the default and makes
   an unparseable construct fail rather than pass. Then mutation-prove it against **both** escapes
   above.
3. Derive the dist usage-error invocation list from `KNOWN_VERBS`, as the `--help` test already does.

## Test quality
The behavioural half is excellent and keeps earning its keep — the three stray-positional
invocations and the explicit-`deploy` regression case are exactly right, asserted pre-config, and
they are what caught the ternary slip the implementer disclosed. The static half is the weak layer:
two of the three scan guards added in this PR were defeatable on first write, and the phrase-list
version is defeatable now, in two ways, one of which is already shipping.

---

# Round 4 — commits 82a47ff + 33de434

APPROVE

Rebuilt (tsup, exit 0), full suite **1557 tests, exit 0**. Every clearing criterion I set in round 3
is implemented as specified, and I verified each on the built bin rather than in the diff. Two named
residuals below are limitations the ADR now states accurately rather than claims away — which is the
difference from the previous three rounds.

## The six dumps are gone — measured, both streams, empty stdout

| invocation | exit | stdout | rendering |
|---|---|---|---|
| `doctor --bogus` | 1 | **0 B** | clean message |
| `status --json --watch` | 1 | **0 B** | clean message |
| `status` (no app) | 1 | **0 B** | clean message |
| `rollback --canary 500` | 1 | **0 B** | clean message |
| `rollback --canary 50` (no `--to`) | 1 | **0 B** | clean message |
| `db bind myapp` (no `--secret`) | 1 | **0 B** | clean message |

No `FATAL`, no stack frame, no chunk path anywhere. The **0 B stdout** is the validate-before-announce
fix landing: in round 3 these leaked a pino banner to stdout before failing.

The bonus catch is real and was outside my round-3 table: `kn-next --skip-buildd` used to surface
Node's raw `ERR_PARSE_ARGS_UNKNOWN_OPTION`; it now renders as a plain message, exit 1, 0 B stdout.
The two cases dropped from the enumerated dist list still behave correctly on the bin
(`cleanup myapp` → `unexpected positional "myapp"`; `db frobnicate` → `unknown db subcommand`), and
`create` — untouched until this round — is clean for both a bad name (`create "BAD NAME"` →
`invalid app name …`) and an unknown flag.

## The inverted guard holds where the phrase list did not

- **My Escape B, verbatim** (hoist the message into a `const`, downgrade to `Error` in `buildMain`):
  now **red**, exit 1, with per-file pointing — `build.ts: a plain Error prints a FATAL stack dump.
  If this is a user mistake, throw UsageError; if it is an environment/cluster failure, add a
  justified anchor to NON_USAGE_ALLOWLIST`. That is the right message: it tells the next person both
  legal moves.
- Inverting the default is the correct structural answer — a novel wording, a new file, and a
  hoisted message all fail by default now, and `schema/` is in scope.

### Residual 1 (named, not blocking): the scan matches the literal `throw new Error(`, so an Error *subclass* is invisible.
My own new mutation, designed against the inverted guard: introduce `class ScaffoldError extends
Error {}` in `create.ts` and throw it for the `invalid app name` rejection — the codebase's own
idiom, since `UsageError`, `ConfigNotFoundError` and `ConfigValidationError` are all exactly that
shape. **Scan stays green (exit 0)**, and `create <bad-name>` has no dist case (the derived probe
only sends `--unknown-flag`), so nothing else catches it either. `Object.assign(new Error(m), …)`
and a `throw`-ing helper defined outside `src/cli` dodge the same way.

I am **not** blocking on this, and the reason matters: ADR-0046 now states the contract as *"every
`throw new Error(` under `src/cli` fails the build unless its message is on an explicit allowlist"* —
which is precisely, literally what the guard does. It does not claim subclass coverage. That is the
round-3 defect corrected: the artifact describes the guard instead of flattering it, and the ADR even
records that the first sweep "named four verbs and left six live dumps, which is exactly what an
enumerated claim is worth." Widening the regex to `throw new [A-Z]\w*Error\(` with `UsageError` /
`ConfigNotFoundError` allowlisted would close it cheaply, as follow-up.

### Residual 2 (out of scope for this PR, worth a follow-up issue)
`kn-next deploy` with a **present but invalid** `kn-next.config.ts` still prints `FATAL` + stack +
1194 B of stdout. `ConfigValidationError` is a subclass thrown from `validate.ts:404`, so the scan is
right not to flag it and the ADR is right not to claim it — it is a config-file error, not an argv
mistake. But it is the most likely *next* first-contact failure for the exact persona this PR
targets: the developer who ran `create`, edited the config, and got a field wrong. Same treatment,
separate change.

## Allowlist audit — I checked five entries; all justified, one comment slightly generous
- **`exec.ts` × 4 (`runCapture: empty argv` …)** — internal programming errors on the injectable
  exec boundary, unreachable from argv. Correct.
- **`db-bind.ts: "buildDbBindPatch: secret is required"`** — the comment claims it is unreachable
  from argv because the CLI validates `--secret` first. **Verified true**: `validateDbBindOptions` now
  runs at `db-bind.ts:480` (the new early exit) *and* at `:338` inside `runDbBind`, both before
  `buildDbBindPatch`. It is a guard on an exported builder. Correct.
- **`status.ts: "not found in namespace" / "cluster unreachable" / "kubectl returned unparseable
  JSON"`** — cluster and kubectl state, not typeable. Correct.
- **`cr-builder.ts` × 5** — image refs and buildx metadata are produced by docker. Correct.
- **`create.ts` × 4** — install integrity and template hygiene; note the two genuine usage errors in
  that file (`invalid app name`, `refusing to overwrite`) are **not** on the allowlist, they were
  converted. Correct, and the right line was drawn.
- **`preview.ts: "exceeds the 63-char" / "is not a valid DNS-1123 label"`** — justified as "composed
  from the config's app name + PR id". Mostly true, but `parsePreviewArgs` declares
  `pr: { type: "string" }` with no integer validation (`preview.ts:364`), so a user-supplied `--pr`
  value does reach `derivePreviewName` and can trip these. Narrow in practice — `preview` is
  deliberately not a bin verb and `preview.yml` passes `github.event.number` — so this is a **nit**:
  validating `--pr` as a positive integer is the real fix and is independently correct.

## Nits
- `NON_USAGE_ALLOWLIST` is keyed by **basename** (`file.replace(/^.*\//, "")`), so a future
  `schema/status.ts` would silently inherit `status.ts`'s entries. Key by the relative path.
- The derived dist probe covers only unknown *flags*; positional and flag-combination mistakes are
  still enumerated on top. That is a sensible split and the enumeration is now the six measured
  cases rather than an invented four — noting it only so the next person keeps adding to it.

## Verification of the order-swap claim
`33de434` is what it says. `rollback.ts` moves `log.info("⏪ kn-next rollback")` from before to after
`parseRollbackArgs(argv)` — a pure reorder, no validation removed. `db-bind.ts` **adds**
`validateDbBindOptions(opts)` at `:480` as an early exit while `runDbBind` keeps its own call at
`:338`; validation is strictly increased, not relocated.

## Test quality
Now genuinely layered, with the correlation between layers broken: the static guard is
inverted-default over the whole `src/cli` tree including `schema/`, the behavioural guard is
**derived from `KNOWN_VERBS`** rather than enumerated, and every no-dump assertion reads **both
streams** — the specific mistake that let six dumps look clean for a round. Of the four mutations I
have run against this file across rounds, three are now killed and the surviving one is a documented
limitation rather than a false claim. Good to merge.
