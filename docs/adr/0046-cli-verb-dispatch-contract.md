# ADR-0046: the bin's first argument — bare invocation deploys, an unknown verb is an error

- **Status:** Accepted (2026-08-21). Raised by the architect sign-off on the guided-first-contact
  CLI work, and by the code review of that PR, which proved the hazard twice on a live cluster.
- **Relates to:** ADR-0001 (operator = sole cluster writer — the CLI's only cluster writes are the
  CR apply/patch/delete this dispatch routes to).

## Context

`kn-next` is one bin that dispatches subcommands, with a **default**: anything that is not a
recognised subcommand falls through to `deploy()`. That fall-through was documented
(`apps/docs/content/docs/cli.mdx`) and predates this decision, but two things made it untenable:

1. **`cleanup` became a routed verb.** README advertised `npx @getknext/core cleanup` while the bin
   routed no such verb, so a teardown command ran a full **deploy**. Routing it fixed that case and
   simultaneously made the fall-through *worse*: `kn-next celanup` — one transposed letter on a
   destructive command — now deploys.
2. **A typo is the common case, not the exotic one.** A code review demonstrated
   `kn-next deplyo --skip-build --skip-upload --dry-run` entering the deploy flow. The user's intent
   was unmistakably "run the verb I mis-typed"; the CLI's reading was "deploy this app".

The binding persona for this surface is a Next.js developer with no Kubernetes background. For that
reader, a command that does *something else, silently* is the worst outcome available — worse than
an error, and worse than doing nothing.

Two properties must not be lost while fixing it:

- **`npx @getknext/core` with no subcommand must keep deploying.** It is the advertised front door
  in README and in every docs walkthrough; changing it would break the one invocation users have
  actually copied.
- **A flags-only invocation is not a verb.** `kn-next --skip-build`, `kn-next -h`, `kn-next -v` all
  address the default deploy command.

## Decision

The bin classifies its **first argument** into exactly three cases:

| First argument | Behaviour |
|---|---|
| absent, or starts with `-` | **deploy** (unchanged; the advertised front door) |
| `deploy`, or any verb on the allowlist | dispatch that verb |
| anything else | **error**: `unknown command: <x>`, a `Did you mean: kn-next <y>?` line when a verb is within edit distance, a `kn-next --help` pointer, **exit 1**, no stack trace |

The **allowlist is derived from the same list that renders `--help`** (`cli/help.ts`
`COMMAND_GROUPS`), never a second enumeration; `cli/dispatch.ts` holds the pure classification and
suggestion logic, and a test cross-checks that set against the dispatcher's actual branches.

**The verb slot is not the only door.** A first token is not the only way to name a verb: the
default deploy path accepted positionals and ignored them, so `kn-next -n prod cleanup` deployed to
prod with `cleanup` swallowed — the same "opposite action" outcome, one flag further in. So the
decision covers **any** positional the deploy path did not consume as the verb: it is an error, and
when the swallowed word is itself a command the message leads with word order (`cleanup` is a
command, and the command comes first) rather than a generic complaint.

Three corollaries, all from reviews of this change and all part of the decision:

- **Every dispatched verb parses its own argv.** A branch hands `process.argv.slice(3)` to a `*Main`
  that handles `-h/--help` and rejects unknown flags. This is not stylistic: the first
  implementation called `cleanup()` directly, so `kn-next cleanup --help` **deleted the app**.
- **`--help` is never destructive**, for any verb, and that is asserted end-to-end per verb against
  the built bin rather than argued.
- **A usage mistake renders as a message, never as a fatal dump.** Unknown flags, stray positionals
  and unknown subcommands are the user mis-typing, not the tool breaking, so they are raised as a
  `UsageError` (`cli/shared.ts`) that the entries print and exit 1 on — no serialised `Error`, no
  stack frame, no absolute dist chunk path. Without this the CLI was internally inconsistent:
  `kn-next celanup` got a clean one-liner while `kn-next cleanup -v` got a stack dump, for the same
  class of mistake.

  **The guard for this inverts the default rather than enumerating wordings.** Two earlier versions
  matched a list of usage phrasings and both were defeated — once by a message that said "unknown
  argument" instead of "unknown flag" (which shipped), and once by hoisting the message into a
  variable so nothing remained at the throw site. So the rule is now: **every `throw new Error(`
  under `src/cli` fails the build unless its message is on an explicit allowlist**, each entry
  justified as an environment, cluster, registry or internal-invariant failure — something the user
  could not have avoided by typing a different command line. A novel wording, a hoisted message, or
  a new file all fail by default; adding to the allowlist is a deliberate, reviewable act.

## Options considered

| Option | For | Against | Verdict |
|---|---|---|---|
| **A. Keep the fall-through** | zero change; documented | a typo on a destructive verb ships a deploy; the routing of `cleanup` made it sharper | Rejected |
| **B. Require an explicit verb always** (bare `kn-next` prints help) | most predictable | breaks `npx @getknext/core`, the single most-copied invocation, and every docs walkthrough | Rejected |
| **C. Allowlist + suggestion, bare/flags-only still deploy** | kills the typo hazard; front door unchanged; suggestion turns the error into a fix | one behaviour change to document; a positional argument to `deploy` is now rejected | **Chosen** |
| **D. Prompt interactively on an unknown verb** | friendly | a CLI in CI must never block on stdin; adds a TTY dependency for no gain over a suggestion | Rejected |

## Consequences

- **Documented behaviour changes**: `cli.mdx` said any other first argument runs the deploy flow.
  It now documents the unknown-command error. Updated in the same PR — the docs site is dogfooded,
  so a stale line here is a shipped defect.
- **A positional argument to the default deploy is now an error.** `parseArgs` accepted positionals
  and ignored them; a stray word now fails loudly. That is the intended direction (the same
  strictness the other verbs already promise), and no documented invocation passes one. The explicit
  leading `deploy` is still accepted — it is the verb, not a stray. `--help`/`--version` are handled
  before the check, so `kn-next --help extra` still prints help: help is never an error, and nothing
  destructive follows it.
- **Adding a verb is a two-line change in one place** — a `COMMAND_GROUPS` entry plus a dispatch
  branch — and the tests fail if either half is missing.
- **The suggestion can be wrong.** Tolerance scales with input length (1 edit for short tokens, 2
  for longer) and no suggestion is offered when nothing is close, because a confidently wrong "did
  you mean" is worse than none.

## Action items

- [x] `cli/dispatch.ts` — `resolveInvocation`, `suggestVerb`, `formatUnknownCommand`, `KNOWN_VERBS`
      derived from `COMMAND_GROUPS`.
- [x] `build`/`cleanup` grow a `*Main` with `--help` and strict flag rejection; the bin and their
      direct entries both route through it.
- [x] `parseCliArgs` rejects a stray positional on the default deploy path (`formatStrayPositional`).
- [x] `UsageError` + `handleUsageError` in `cli/shared.ts`, raised by every usage rejection under
      `src/cli` — build, cleanup, create, doctor, gc, db-bind, db-migrate, preview, rollback, status,
      and the default deploy path's own `parseArgs` failure. Enforced by the inverted scan above, so
      this list is a description of the tree rather than a promise about it. The first sweep named
      four verbs and left six live dumps, which is exactly what an enumerated claim is worth.
- [x] Guards, all against the BUILT bin: per-verb `--help` exit-0 (derived from `KNOWN_VERBS`),
      per-verb unknown-flag rejection (also derived — the enumerated version had the same blind
      spots as the phrase list it was meant to back up), unknown-verb, flags-only, the three
      stray-positional invocations, and the six measured flag-combination/missing-argument cases.
      Every no-dump assertion reads **both streams**: pino writes `FATAL` to **stdout**, so a
      stderr-only check reports clean while the dump is on screen.
- [x] `apps/docs/content/docs/cli.mdx` updated (fall-through note, strict-flag promise).

## Amendment 1 (2026-08-21): `validate` joins the routed surface

`validate` existed as a library module (`cli/validate.ts`, the load-time schema checks) but was
never a routed verb — the one command that could have rescued a user from an unfinished config was
unreachable from the bin (UX ledger row 4). It is now a `COMMAND_GROUPS` entry ("Start here") with
a dispatch branch, exactly the two-line shape this ADR promises. The verb entry lives in
`cli/validate-cmd.ts` rather than `validate.ts` because `shared.ts` imports the library half — a
same-file `validateMain` importing `loadConfig` back from `shared.ts` would form an import cycle.
It runs config load + schema checks + the placeholder preflight (`cli/placeholder-preflight.ts`)
with no cluster access, and inherits every derived dist-bin guard (help exit-0, unknown-flag
rejection, no-dump) automatically. The placeholder preflight and the deps-not-installed (exit 127)
translation both raise through the `UsageError` family, extending the "renders as a message, never
a FATAL dump" contract from usage mistakes to these two expected config/environment states.

**Consequence:** deploy now refuses `<...>`-shaped values anywhere in the config, **except the
free-text `env` map** — a documented narrowing of what the CLI will ship relative to what
`config.ts` accepts, with a stated false-positive trade-off: `env` is arbitrary user data where
angle brackets are at least as likely real markup (`ALLOWED_TAGS: "<b><i>"`) as a forgotten
placeholder, and a confidently wrong refusal — or even a confidently wrong warning — on a
schema-valid value is worse than saying nothing, so `env` hits are skipped entirely rather than
warn-tiered. The carve-out is exactly the root `env` key (a type-level exemption of the one
`Record<string,string>` free-text surface), not a return to field enumeration; nested keys that
happen to be named `env` stay scanned, and dodge tests pin both sides.
