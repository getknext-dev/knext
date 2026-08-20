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

Two corollaries, both from the same review and both part of this decision:

- **Every dispatched verb parses its own argv.** A branch hands `process.argv.slice(3)` to a `*Main`
  that handles `-h/--help` and rejects unknown flags. This is not stylistic: the first
  implementation called `cleanup()` directly, so `kn-next cleanup --help` **deleted the app**.
- **`--help` is never destructive**, for any verb, and that is asserted end-to-end per verb against
  the built bin rather than argued.

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
  strictness the other verbs already promise), and no documented invocation passes one.
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
- [x] Guards: dispatcher-scanning contract test, per-verb `--help` exit-0 run against the built bin,
      unknown-verb and flags-only end-to-end assertions.
- [x] `apps/docs/content/docs/cli.mdx` updated (fall-through note, strict-flag promise).
