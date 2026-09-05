# PR #962 round-2 verification — `agent/s3-scaffold-pins` @ `ac260406`

**Verdict: ISSUES_FOUND** (3 findings, all minor; nothing security- or runtime-correctness-breaking).
Measured in a shared clone at `/tmp/rev962/knext` (now removed), bun 1.3.5 / npm 11.9.0 / node 24.14.0.

## The 8 claimed fixes, measured

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | `nightly-red-alert` job | **HOLDS** | YAML parses; `permissions: {}` top-level and on `scaffold-install`; `issues: write` only on the alert job; `needs: [scaffold-install]` + `always() && (schedule\|\|release) && result == 'failure'` is reachable. Byte-for-byte the `anonymous-install-nightly.yml:95-160` pattern (same lookup/`--limit 100`/comment-or-create/`gh issue pin \|\| ::warning::`). Issue body has 0 lines indented ≥4 spaces after YAML block-scalar stripping — no accidental code blocks. Day-one reds named in header. |
| 2 | cli.mdx availability callout | **HOLDS with a gap** | `apps/docs/content/docs/cli.mdx:51-54`, `<Callout type="warn">` matches the file's existing convention (45 `warn` / 52 `info` in the docs tree), no internal refs. See finding 3. |
| 3 | `Refs #950` + merger flag | **HOLDS** | PR body opens `Refs #950 (S3-V Finding A-1). Deliberately **not** Closes`; `b94f7fe8` really does carry `Closes #950` (line 74 of its message); the note says GitHub "will act on it when the stack reaches `main`, so reopen #950 then" — correct for **both** squash (PR-body/commit-message concat) and merge-commit (commit messages landing on the default branch). Honest. |
| 4 | npm-view reason slices both streams | **FAILS AS CLAIMED** | See finding 1. |
| 5 | #964 filed and linked | **HOLDS** | `#964 [OPEN] Published @getknext/core@0.3.0 cannot scaffold: no 'create' verb, no templates/ in the tarball`; linked from the workflow header and the PR body. |
| 6 | warning reworded, no broken remedy | **HOLDS** | `scaffold-registry.ts:169-176` no longer names `npx @getknext/core@latest`; two honest options + "the app's files themselves are complete and correct". |
| 7 | pin regex widened | **HOLDS — independently mutation-proved** | Anchor-asserted mutation to `">=0.3.1"` in `templates/app/package.json.hbs` → `bun test scaffold-version-pins` **exit 1**, 3 fails incl. the scan test. Old regex `[~^=]?\d` misses `>=0.3.1` and `<2.0.0`; new `[~^=<>]{0,2}\s*\d` catches both and still passes `^{{ version }}` and `workspace:*` (no new false positives). Restored clean. |
| 8 | probe has its own try/catch | **HOLDS (structural, untested)** | `create.ts:449-461`: the probe's `try { … } catch { }` nests inside the outer `try` whose `catch` returns 1, so a probe throw cannot reach it. No test covers it — see minor notes. |

## Provers re-run independently (red → restored)

| Mutation | Result |
|---|---|
| `">=0.3.1"` hardcoded pin in `package.json.hbs` | **exit 1** (3 fails), restored `TREE-CLEAN` |
| `@getknext/lib` removed from `.changeset/config.json` `fixed` | **exit 1** (fixed-group test), restored `TREE-CLEAN` |
| probe unwired (`if (!values["dry-run"])` → `if (false)`) | **exit 1** (`scaffold succeeds AND stderr carries the warning`), restored `TREE-CLEAN` |

Harness honesty: every run branched on `$?` captured from an unpiped command, never on output-grep (a first attempt piped through `tail` and reported `EXIT=0` from the pipe — discarded). One mutation attempt produced a TS syntax error (`0 pass / 1 error`) and was rejected as a non-proof rather than counted as red. `scripts/bun-test.mjs:290` branches on `code === 0` — exit-code honest.

Regression skim: `bun test create-scaffold create-scaffold-parity scaffold-validates scaffold-version-pins` → **115 pass / 0 fail, exit 0**. Round-2 diff is 6 files, all reviewed; nothing unrelated.

## Findings

### 1. `scripts/verify-scaffold-install.mjs:88-94` — the stdout slice is inert on the npm version its own comment cites
Measured live with the script's exact argv (`npm view @getknext/core@^0.3.1 version --json`, npm **11.9.0**): exit **1**, **stderr = 441 chars** of `npm error 404 …` prose, stdout = the 300-char E404 JSON. The new code is
`[r.stderr, r.stdout].map(trim).filter(Boolean).join(' | ').slice(0, 400)` — stderr **alone exceeds the 400-char cap**, so the stdout JSON is truncated away entirely and the reported reason is byte-identical in content to the old stderr-only slice. The stated motivation ("a stderr-only slice reported the most common failure with an empty reason") does not reproduce.
**Fix:** order stdout first, or cap per stream (`.slice(0, 200)` each) so both survive.

### 2. `scripts/verify-scaffold-install.mjs:77-80` — the comment's model of `npm view` is wrong (pre-existing, but round 2 reasoned from it)
"`npm view <name>@<range> version` exits 0 with empty output when the range matches NOTHING" — measured false on npm ≥ 11: notarget **exits 1** with E404 on both streams, so it takes the `status !== 0` branch and the `else if (stdout === '')` branch is likely dead on modern npm. Both branches `fail()`, so no functional defect — but the round-2 rationale ("the most common failure (notarget)" landing in the non-zero branch with an empty reason) is built on a model the tree contradicts. Workflow rule: *re-read your own claims against the current tree before merging.*

### 3. `apps/docs/content/docs/cli.mdx:51-54` — the callout points users at a version that does not exist
"Available from `@getknext/core` **0.3.1** … If your installed CLI does not recognize `create`, upgrade to the newest release." 0.3.1 is **not published** (#853), and the newest release that *is* published (0.3.0) cannot run `create` at all (#964). A user who follows this upgrades and still has no `create`. This is precisely the defect class claim 6 removed from the CLI warning ("a remedy that fails is worse than none") — reintroduced in the docs. Suggest: state that `create` ships in an upcoming release and is not in any currently published version, without an upgrade instruction that cannot work yet.

## Minor, non-blocking

- `scaffold-version-pins.test.ts:298-307` — nothing asserts the broken `npx @getknext/core@latest` remedy stays *out* of `unpublishedPinsWarning`; reintroducing it goes green. Also `expect(text.toLowerCase()).toContain("not")` is near-vacuous (matches "notarget"/"cannot").
- `create.ts:449-461` — the new try/catch is structural only; deleting it reds nothing.
- Alert lookup `--limit 100` open issues could duplicate the alert on a repo with >100 open issues. Copied from the sibling nightly, so consistent — not new debt.
