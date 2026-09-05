ISSUES_FOUND

# Adversarial review — placeholder preflight + validate routing (UX row 4)

Worktree `/Users/banna/alpheya/pocs/knext-wt/feat-placeholder-preflight`, commit `0b31428`
vs `origin/main`. All six attack vectors from the brief executed. One substantive issue
(the exact false-positive class the brief flagged), everything else verified clean.

## Issue 1 — confirmed false positive: a legitimate `<...>` value hard-blocks deploy with no escape hatch and a false message

**Where:** `packages/kn-next/src/cli/placeholder-preflight.ts:34` (`PLACEHOLDER_RE = /<[^<>]+>/`),
message at `:98-100`, enforced unconditionally at `deploy.ts:375` and `validate-cmd.ts:95`.

**Reproduced E2E on the real dist bin:** a config with
`env: { BADGE_HTML: "<b>hi</b>" }` (registry and everything else real) fails both
`kn-next validate` and `kn-next deploy`, exit 1:

```
  env.BADGE_HTML: "<b>hi</b>"
    This value is still the placeholder from the scaffold.
    Replace it with a real value before deploying.
```

Three stacked defects in that behavior:

1. **Functional regression for valid configs.** Env values are arbitrary strings Kubernetes
   accepts; the realistic case is an RFC-5322 mailbox in env — `MAIL_FROM: "Support
   <support@acme.com>"` — which deployed fine before this branch and now cannot deploy at all.
2. **No escape hatch.** I verified there is no skip flag, no `--env` override path, and no
   allowlist — the preflight runs unconditionally on the effective config in both verbs. A user
   who hits this is bricked, and the message tells them to "replace it with a real value" when it
   already IS the real value.
3. **The generic message asserts a falsehood.** "This value is still the placeholder from the
   scaffold" is stated for any `<...>` string anywhere, including fields the scaffold never
   contained.

**Judged against the spec:** the ledger row-4 lever mandates detecting "`<...>`-shaped" values, so
the broad regex itself is spec-compliant — the defect is the combination hard-block + no-escape +
false claim. Smallest honest fixes (implementer's choice): soften the generic guidance to "if this
is a real value…" **plus** an escape (e.g. scope the hard block to fields whose value came from a
known scaffold shape, or exempt/soft-warn `env.*`, or a documented skip). Per the brief, the
false-positive axis is as real as the false-negative one; this is that axis, confirmed live.

## Everything else — verified clean

**Attack 1 (scan genericity):** truly generic — recursive walk of every string field, arrays
(`domains[1]`), unknown deeply-nested keys (`custom.deeply.nested`), cycle-safe. Verified E2E:
nested-array and unknown-key placeholders both caught. Absent `storage` (post-#825 image-served
mode) does not trip — exit 0 E2E. Lone `<` not flagged (unit test). Numeric fields can't carry
placeholders without failing schema first.

**Attack 2 (`validate` verb):** all scenarios run on the real dist bin with PATH stripped to
node-only (no kubectl/docker):
- no config → dispatcher's guidance, exit 1 ✓; placeholder config → per-field stderr, exit 1 ✓;
- valid config (with and without storage) → exit 0, verdict on stdout ✓;
- schema-invalid → validator's plain message, no stack, exit 1 ✓ (note: the report's "schema
  errors first" claim holds — my first probe's `name: "Bad_Name!"` simply passes schema, which is
  the pre-existing validator's looseness, not this branch's);
- `validate --help` exit 0 in empty dir ✓; `--zzz` and stray positional → one-line plain errors ✓;
  `validat` → "Did you mean: kn-next validate?" ✓; top-level `--help` lists it under Start here ✓;
- dist-bin probes cover it automatically: `KNOWN_VERBS` derives from `COMMAND_GROUPS`
  (`dispatch.ts:26`), and the help/no-dump `it.each` iterates that set.

**Attack 3 (base-branch guards):** full suite in the worktree: **152 files / 1696 tests, all
passed, exit 0** (the 18 pre-existing base failures the implementer reported are gone after the
rebase onto main). `tsc --noEmit` exit 0. Biome clean on all eight touched source files.
Dispatcher-scan, inverted-throw guard, no-storage announcements all green in that run.

**Attack 4 (deps-missing 127):** triggered for real — scratch app, `build: "next build"`, no
`node_modules`, `kn-next build` on the dist bin: shell's own `sh: next: command not found` on
stderr directly above the plain "Run `npm install`" guidance, exit 1, no stack, no FATAL
(the one `at `-grep hit is the word "That"). Same seam now routes deploy, build, AND preview
(the scan guard caught the third call site, as reported).

**Attack 5 (mutations — anchored, count==1-asserted, exit-code-branched, restored + tree
verified clean):**
- M1 disable preflight (`findings.length > 9999`) → red: `deploy-placeholder-preflight` +
  `validate-cmd` (2 files).
- M2 delete validate from `COMMAND_GROUPS` → red in **both halves**: `cli-dispatch-contract` +
  `cli-help-surface` (2 files).
- M3 (my own adversarial mutation) kill recursion into non-string children → red: 5 tests in
  `placeholder-preflight.test.ts` (the dodge cases doing their job).

**Attack 6 (docs vs tree):** `cli.mdx` claims verified — "no kubectl, no docker, no network"
proven by the stripped-PATH run; "deploy runs the same checks before its first build step" matches
`deploy.ts:375`; anchor `#kn-next-validate` resolves; no internal refs (ADR/issue numbers) leaked
into the user-facing page. ADR-0046 Amendment 1's claims each check out: two-line dispatch branch,
separate `validate-cmd.ts` for the real import cycle (`shared.ts` imports `validate.ts`), derived
guards inherited (proven by M2), UsageError-family rendering (proven E2E).

**Deploy-path extras:** placeholder blocks BEFORE any build (nothing created in scratch);
`--registry ghcr.io/realuser` rescues a placeholder-registry file (0 findings); a placeholder
typed AS the override is caught. Implementer's judgment calls all reviewed; all sound. The gate
note stands: this PR fires the CLI-surface escalation trigger (new `COMMAND_GROUPS` verb +
ADR-0046 amendment) — the design gate is owed at PR time regardless of this review.

## Verdict

ISSUES_FOUND — Issue 1 only. It is small to fix and everything around it is solid; a fix round
that adjusts the generic message and adds an escape (or scopes the hard block) plus one FP test
case would clear it.

# Round 2

APPROVE

Verified against the new head `46d4278` ("exempt the free-text env map from the placeholder
hard-fail"), the fix for round-1 Issue 1 / the architect gate's block. Everything checks out.

**The carve-out matches the gate's smallest-change spec exactly.** `findPlaceholders` skips
exactly `path === "" && key === "env"` — the config's one `Record<string,string>` free-text
surface — skipped rather than warn-tiered, with the reasoning recorded in-code and in ADR-0046
Amendment 1's new Consequences paragraph. The generic walk is otherwise untouched.

**Round-1 repro cases re-run on the freshly rebuilt dist bin:**
- `env.BADGE_HTML: "<b>hi</b>"` → `kn-next validate` exit 0, "ready for kn-next deploy". Fixed.
- `env.MAIL_FROM: "Support <support@acme.com>"` → deploy proceeds PAST the preflight with zero
  placeholder findings; it then fails downstream at `requireBuildContext` (the scratch dir has no
  package.json) — expected, pre-existing behavior this branch does not touch (0 hits in the diff).
- Registry placeholder (`ghcr.io/<your-user>`) → still hard-fails with the per-field message,
  exit 1. The scaffold-placeholder catches are not weakened.

**The carve-out cannot widen silently — mutation-proved.** Widening it to every key named `env`
(dropping the root-only condition) → red on exactly the new pinning test ("the env carve-out is
exactly the root `env` map, not every key named env"), 1 failed / 19 passed. Restored. The
deploy layer gained its own dodge (markup in env → deploy proceeds, no refusal).

**The original mutations still bite at the new head.** Re-ran M1 (disable the preflight) → 5
tests red across `deploy-placeholder-preflight` + `validate-cmd`. Restored, tree clean. M2's
target (`COMMAND_GROUPS`) is untouched by the fix commit; no re-run needed.

**Version-sensitive round-1 items re-checked:** full suite at head **152 files / 1699 tests all
green** (3 net-new tests from the fix), `tsc --noEmit` clean, biome clean on the fix's files. The
round-1 unit test "env values are scanned like everything else" was correctly replaced by the
exemption + dodge-3 + root-only trio. cli.mdx's deploy section now documents the env exemption in
user terms (no internal refs), and the ADR states the narrowing and its false-positive trade-off
honestly — claims verified against the tree. The large test-file diff is quote-style reformatting
only; test substance is the three new cases.

No new issues. Round-1 Issue 1 is closed as specced by the gate.
