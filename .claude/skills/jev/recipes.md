# Jev recipes for the knext workflow

Exact commands for the patterns in [ten-levels-of-jev](https://github.com/disler/ten-levels-of-jev)
that fit how this repo is worked. `SKILL.md` explains the CLI; this file is what to type.
Everything here **informs** a decision, never makes it: a jev score is not a passing test, and
none of this replaces code review, spec review or CI.

Shell rule that bites every recipe: single-quote any instruction containing backticks, or zsh
runs them. Run `jev doctor` first if anything fails; with no key (`~/.config/typesafe/api_key`,
never print it) say "jev unavailable" in the report and judge it yourself.

The hook `.claude/hooks/jev-result-screen.sh` (offline suite `jev-hooks.test.sh`) is the
always-on half of Level 6 and needs nothing from this file: it screens fetched PR/issue/web text
for prompt injection and only ever adds a warning. The other half, a blocking jev gate for Bash
commands, is **not shipped**; it is open design work in getknext-dev/knext#2222. The
deterministic `block-dangerous-bash.sh` remains the only command gate.

## Where each level lands

| Level | Pattern | Here |
|---|---|---|
| 1 | one typed decision | L1/L4 below |
| 2 | fan-out, many questions in one `ask` | `pr-risk.sh` |
| 3 | composite score | `pr-risk.sh` |
| 4 | confidence gating | L1/L4 below |
| 5 | routing | `~/.claude/skills/jev/pick-route.sh` |
| 6 | hooks as guardrails | `jev-result-screen.sh` (advisory, shipped); a blocking Bash gate is open design work, #2222 |
| 7 | should I compact? | **does not apply**: Claude Code owns compaction, an agent cannot trigger it |
| 8/9 | cheap reads, scouting | below |
| 10 | CI triage, judge own diff | below |

## L1/L4 — gate lead decisions on confidence

Auto-pick the top option, report the choice and the scores, and flag it when jev itself is unsure.

```bash
jev pick 'Which approach should the fix take?' \
  narrow='Change only the failing call site' \
  shared='Fix the shared helper and every caller' \
  --field context=@context.md --json --compact | jq -r '"\(.choice) conf=\(.confidence)"'
# -> narrow conf=0.82      (without the jq: {"choice":"narrow","confidence":0.82,"probabilities":{...},...})
```

Rules:

- `confidence >= 0.5`: take `.choice`, report `choice (top p, conf)` in one line.
- `confidence < 0.5`: still take the top option so work is not blocked, but write
  **"low confidence"** next to it in the report so the founder can overrule it.
- Do not use `--min-confidence` as the gate for an unattended decision: it exits 1 and your
  fallback is then your own vibe. Read `.confidence` and branch on it explicitly.
- This does **not** widen what an agent may do alone. Irreversible or outward-facing actions
  (npm publish, repo settings, `CLAUDE.md` / `.claude/rules/` edits, cluster deletes, pushes to
  `main`, force-pushes) stay founder-only whatever jev says, per `workflow.md` and
  `security.md`.

## L3 — composite PR risk score

```bash
.claude/skills/jev/pr-risk.sh            # judges git diff origin/main...HEAD
.claude/skills/jev/pr-risk.sh origin/integration/v1.3
```

One `ask` call, four `--score` questions (security risk, complexity, convention drift, test
inadequacy), each a position 0..4. Arithmetic is in code, not in the model: the weights live on
**one line** at the top of the script,

```
W_SECURITY=0.40 W_COMPLEXITY=0.20 W_DRIFT=0.15 W_TESTS=0.25   # sum to 1.0; env-overridable
```

and the composite is `sum(w * position / 4)`. Output ends in `RISK 0.xx HIGH|normal`; exit
0 = normal, 10 = HIGH, 3 = jev unavailable (no opinion, not "safe").

- **`>= 0.6` (HIGH): spawn both reviewers at high effort and add a knext-tester pass.**
- The diff is truncated to 80,000 bytes (jev's ceiling is about 107,500 chars). Past that the
  tail is not judged, so a large PR is under-scored, not over-scored; say so in the report.
- **Nothing literally secret is sent.** The diff goes to a third party, and an unpushed branch can
  hold a real key that gitleaks has not seen yet. Before the call, the exact bytes to be sent are
  checked for literal secret formats (real-shaped key tokens, a PEM marker, `user:pass@`, an
  Authorization header with a value, a 32+ char alphanumeric run containing a digit; git SHAs and
  data URIs are exempt). On a hit the script prints `RISK unavailable (diff carries a literal
  secret)` and exits 3 without calling jev. Say so in the report; it means "no opinion", not "safe".
- Offline test with a stubbed jev: `bash .claude/skills/jev/pr-risk.test.sh`.

## L5 — routing

Do not reinvent it: `~/.claude/skills/jev/pick-route.sh "<task description>"` prints
`<model> <effort>` (design and sign-off gates: `pick-route.sh --gate "<task>"` is always
`opus high`). `pick-skills.sh` picks the skills. Fails open to `sonnet medium`.

## L8/L9 — cheap reads and scouting

Judge a file without putting it in context:

```bash
jev yes 'Does `content` read a secret from a config file instead of env or a K8s Secret?' \
  --field content=@packages/kn-next/src/cli/deploy.ts          # P(yes); exit 0 yes / 1 no
jev ask --field content=@some.ts \
  --noul has_tests 'Does `content` contain tests?' \
  --noul fail_open 'Does `content` continue when a dependency errors?' --json --compact
```

Judge a file set (one request per file, in parallel; cents per thousand):

```bash
rows=$(mktemp)
for f in .claude/hooks/*.sh; do jq -Rs --arg id "$f" '{id:$id,text:.}' "$f"; done | jq -c . >"$rows"
jev batch --input "$rows" --state-key text --id-key id \
  --noul fails_open 'Does this shell hook let the call proceed when its helper binary errors?' --compact
```

Scout before you read: rank first, open only the top few.

```bash
git ls-files 'packages/kn-next/src/**' >"$rows"
jev rank --query "where the CLI builds the NextApp custom resource" \
  --candidates-file "$rows" --top 3
```

Then read those files. Treat the ranking as a shortlist: if the top hit is not it, fall back to
`grep`. Jev does not count, do arithmetic or follow multi-hop reasoning; use code for those.

## L10A — triage a failed CI job before touching code

```bash
gh run view <run-id> --log-failed | tail -n 200 >/tmp/ci-tail.txt        # tail, not the whole log
jev pick 'Why did this CI job fail?' \
  bug_in_code='The change under test is wrong' \
  wrong_test='The test or fixture is wrong or stale' \
  flaky_or_runner='Network blip, runner or cache flake, timeout unrelated to the change' \
  environment='Missing tool, version drift, config or secret in CI' \
  other --field log=@/tmp/ci-tail.txt --json --compact
# read .probabilities.flaky_or_runner
```

- `flaky_or_runner >= 0.8`: **rerun once** (`gh run rerun <run-id> --failed`). If it fails the
  same way, treat it as real and fix.
- Anything else: do not rerun, read the failure and fix the cause. Never merge past a red gate on
  the guess that it is flaky (see the "CI red: identify before merge" rule).
- Note that a rerun replays the original merge ref, not current `main`.

## L10B — judge your own diff before you push

```bash
.claude/skills/jev/pr-risk.sh                       # risk, see L3
git diff origin/main...HEAD | head -c 80000 >/tmp/diff.txt
jev yes 'Does `diff` do what `claim` says, and nothing beyond it?' \
  --field diff=@/tmp/diff.txt --field claim=@/tmp/pr-body.md
```

`P(yes) < 0.7` means re-read the diff against the PR body: either the body over-claims or the
diff carries something the body does not mention. Fix whichever is wrong before pushing. A high
score is not evidence the tests prove it; run them.
