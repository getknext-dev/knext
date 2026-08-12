# ADR-0043: Safety-control guards — match broadly, exclude narrowly, and prove the exclusion

- **Status:** **Accepted (2026-08-12).** Recommended independently by the architect and
  system-designer sign-off gates on PR #725, after the same decision reversed three times across
  #712, #717 and #725 — and each reversal cost a real bypass in the sole enforcement of
  `.claude/rules/security.md`.
- **Applies to:** every deterministic guard that gates an agent action — the hooks in
  `.claude/hooks/`, and any future check that answers "may this run?". It does **not** apply to
  advisory linters, whose failure mode is noise rather than an executed forbidden operation.
- **Relates to:** ADR-0001 (the operator is the single source of truth — the `kubectl delete`
  gate is that invariant's enforcement for agents).

## Context

`.claude/hooks/block-dangerous-bash.sh` is the only thing enforcing the operations `security.md`
calls "never acceptable on the agent's behalf": force/mirror/`--all` push, direct push to
`main`/`master`, history rewrite, recursive-force removal, cluster deletes, infra teardown.

It has shipped a bypass **six times**, and the same argument was re-litigated each time:

| Round | The "improvement" | What it cost |
|---|---|---|
| #712 | Fix false positives on multi-line commands | A backslash-continuation bypass |
| #717 | Fix that continuation bypass | A worse one — and, on BSD `sed` only, an empty normalisation that disabled every segment rule |
| #725 r1–2 | Identify each segment's real command word so rules apply only to genuine invocations | One `=` anywhere disabled both rules; `xargs`, `find -exec`, `bash -c`, `$( )`, subshells, `if/then`, `for/do` all escaped |
| #725 r5–10 | Exempt `git commit` so message text stops crying wolf | Command substitution, an env-var prefix, a trailing `# git commit`, a global flag stealing its argument, and two quote-tracking fail-opens |
| #725 r11 | Treat `#` as starting a comment, so a comment can no longer disarm the exemption | The word-start test accepted only whitespace, but bash ends a word on `)` too — `(… git commit -m "x")#c\` + newline reopened **all eight** gated verbs |
| #725 r12 | Widen the word-terminator class so `)#` can no longer disarm it | Comment detection was now correct, but the segment that CLOSED a carried message was discarded unscanned — so the guard never ran on it, and a heredoc body could establish the exemption outright |

Every one looked correct on inspection. The recurring shape is not carelessness — it is that
**narrowing feels like precision**, and in a control whose failure mode is "the forbidden thing
happened", precision about *what to skip* is indistinguishable from a hole until someone finds it.

A second pattern recurs often enough to name: a fix gets applied to one of the two places that
need it. Quotes were made delimiters on the branch rule but not the `rm` command word; a backslash
on the command word but not the branch rule; `$( )` was handled but not its backtick twin; the
whitespace class replaced the last separator in a rule but not the ones inside it — three times.

## Decision

**1. Match broadly. Exclude narrowly.** A guard matches the text of what it is given and does not
try to work out which command is really running. Wrapper forms (`xargs`, `find -exec`, `bash -c`,
command substitution, subshells, brace groups, conditionals, loops) must be *covered*, not reasoned
around.

**2. An exclusion is admissible only if the excluded form provably cannot execute the operation.**
"It usually doesn't" is not a proof. `git commit` was excluded on the reasoning that it "cannot
delete or push" — measured false, because a commit segment executes anything inside `$( )`,
a backtick, `${ …; }`, an env-var prefix, or a following line folded in by a comment. The surviving
exclusion is narrower and states its proof: a **literal** commit message cannot execute anything.

**3. Narrowing an EXCLUSION is safe; narrowing a CHECK is not.** Both look like "being more
specific". Tightening what gets exempted can only add blocks. Tightening what gets checked removes
coverage silently, and the suite stays green because the removed cases were never written down.

**4. Fail closed on your own dependencies.** A guard built from `jq`/`grep`/`awk`/`tr` does not
degrade when one is missing — it *disappears*. Presence is also not enough: probe the capability
actually relied on (`grep -E \b` is a GNU extension; a broken `awk` fails **open** where a broken
`grep` fails closed, because `awk` decides the exclusion). This is `security.md`'s existing rule for
the action-pin checker — "a checker that goes green when it cannot reach upstream is worse than
none" — applied to the guard's own toolchain.

**5. Prove coverage by property, not by enumeration.** Hand-written cases encode the payload shapes
previous rounds got wrong. On PR #725, 112 enumerated cases, a full mutation proof, a CI job and
four review gates all went green on a regression whose balanced-quote twin was already *in the
suite* — no row happened to carry an apostrophe. Guards must carry at least one **generated**
property that permutes the dimensions an attacker controls, and generating one dimension while
enumerating another only relocates the blind spot.

**6. Mutation-prove at CLAUSE granularity.** Mutating a whole regex proves the regex matters, not
that each alternative inside it does. Five alternatives in this hook were decoration — deleting any
left the suite green while a real payload flipped to allowed, and three of them named operations
`security.md` lists verbatim.

**7. Assert both halves.** Must-block *and* must-allow. A guard that cries wolf gets routed around,
which is a security outcome, not a UX one — `workflow.md` records a hook firing on commit-message
text as the cause of a docs file reaching `main`. Some clauses exist *only* to prevent a false
positive and are therefore invisible to every must-block case; they need a must-allow case or they
cannot be proved at all.

**8. A guard may not DISCARD text it has not scanned.** Skipping is an exclusion wearing
different clothes, and it is the one that produced the most bypasses here. Three separate defects
were the same act: a heredoc body was allowed to establish an exemption; a segment that closed a
carried quote was `continue`d with its tail unread; a comment was assumed to run to the end of a
line that had been folded in from the next one. In each case the guard decided some text was inert
and stopped looking. If a guard sets text aside, it must be able to state *why the shell cannot
execute it* — the same proof obligation as Decision 2, applied to skipping rather than exempting.
The safe form is to narrow what may be *skipped*, never to widen it.

### The worked example: why one obvious false positive was NOT fixed

Decision 2 states the proof obligation abstractly. This is the case that shows what it costs
to honour it, and it is the strongest evidence in the series because the fix that *looked*
obvious was retroactively proven to be a bypass.

`git push origin feature/x # rebased onto main` is **blocked**, and the comment is inert, so
this is a false positive. It is pre-existing — `main` behaves identically — and the fix looks
trivial: the hook already knows `#` starts a comment (it must, to track where a commit message
ends), so teach the *rules* to ignore comment text too.

Under Decision 3 that is inadmissible, because it narrows what gets **checked** rather than what
gets **excluded**. It was deferred on that ground alone, before there was any evidence for it.

Rounds 10, 11 and 12 then supplied the evidence:

- **Round 10** — the hook's notion of "this is a comment" was wrong in a way that let a comment
  swallow a folded-in continuation line: `git commit -m "subject" # note\` + newline + a gated
  verb executed, and was allowed.
- **Round 11** — the corrected notion was *still* wrong, because bash ends a word on `)` as well
  as whitespace: `(… git commit -m "x")#c\` + newline reopened all eight gated verbs.
- **Round 12** — with comment detection itself finally right, the same payload was *still*
  allowed for a different reason: the segment that closed a carried message was discarded
  unscanned, so the comment guard never ran on it.

Had comment-stripping been granted when it was proposed, each of those defects would have been a
**silent hole in every rule** rather than a hole in one exemption — the rules would have skipped
text the hook wrongly believed was inert. The exemption is bounded; the rules are not.

Note what round 12 does to the claim this section could have made. It would have been natural to
write, after round 11, that the comment class was closed; that sentence would have been false
within a day. This ADR therefore records the class as **open and load-bearing**, not as solved —
the honest status, and the one that keeps the proof obligation in force.

The rule this yields, and the reason it is stated as an obligation rather than a preference:
**a guard may only act on a fact about the shell that it has demonstrated it can determine
correctly.** Comment detection was wrong twice in two rounds. Granting it authority over *matching*
is admissible when there is a real tokeniser whose comment handling is itself tested — not before.

## Options considered

| Option | Fewer bypasses? | Cost | Verdict |
|---|---|---|---|
| Status quo — fix each bypass as found | No; six rounds say otherwise | Low per round, unbounded in total | **Rejected** |
| Narrow the guard so it only inspects "real" invocations | No — this *is* the recurring bug | Low | **Rejected**; it is what #725 r1 did |
| Match broadly + prove every exclusion + generated property | Yes for the classes seen | Accepts false positives; needs a property harness | **Accepted** |
| Replace text matching with a real shell tokeniser | Structurally, yes | ~250 lines, 1–2 days, a new runtime dependency | **Deferred** — see below |

## Consequences

- **False positives are accepted, deliberately and by name.** A false positive is recoverable — the
  human reruns the command, or runs it themselves. A false negative on force-push-to-`main` is not.
  The accepted costs are listed in the hook header so a later round cannot trade them away by
  accident.
- **Guards get slower and longer.** The suite grew from 27 assertions on `main` to 1,726. That is the
  price of the property, and it is why it belongs in CI rather than in someone's memory.
- **CI must run the guard on every platform contributors use.** One bypass was live on macOS and
  absent on Linux, so a Linux-only gate would have gone green while the control was open on every
  developer machine.
- **This ADR does not claim the approach is sufficient.** It bounds the damage of a text-matching
  guard; it does not make one correct.

## Known limitation — the case for a tokeniser

Rounds 7–12 produced six defects that were all the same thing: `#` starts a comment after any
word terminator (not just whitespace), `$'…'`
escapes, a backslash is not a continuation *inside* a comment, and quote state is not parity. Each is
plain shell grammar. The hook resolves continuations, then splits, then scans quotes — three stages
— while the shell resolves all of it in **one** tokenising pass. Every one of those defects lives in
the gap between those stages, so they will keep arriving one construct at a time.

Round 11 is the prediction landing inside the same PR that made it: round 10 fixed comment handling,
and round 11 was a comment-handling defect one construct over, found by a reviewer rather than by the
fix's own tests. That is the strongest available evidence that the remaining cost here is per-round
rather than one-off.

The system-designer gate costed the replacement: a single tokeniser pass emitting `(segment, words)`
with comments, quotes, continuations and here-docs resolved together; the rules unchanged; the
existing suite kept verbatim as the oracle. ~250 lines of Python, 1–2 days, plus `python3` in the
fail-closed dependency probe.

The architect gate proposed the check that would make it verifiable either way: **differential
testing against the shell as oracle** — if `bash` actually executes a gated command, the guard must
deny. Note the hazard before building it: a naive harness would *execute* payloads like
`/bin/rm -rf …`, so it needs a real sandbox and is its own reviewable change.

## Action items

1. **(Done, PR #725)** Rebuild `block-dangerous-bash.sh` on the rules above; ship the generated
   property and the clause-granular mutation proof; run the suite in CI on Linux and macOS.
2. **(Human)** Add `.claude/hooks/` to the mechanically-detected escalation-trigger paths in
   `.claude/rules/workflow.md`. Ten rounds edited the sole enforcement of `security.md` and fired no
   trigger. This is deliberately **not** an agent edit: an agent that can edit the list of paths
   which fire a design-review trigger can delete its own trigger.
3. **(Follow-up)** Build the differential-against-`bash` oracle in a sandbox, then decide the
   tokeniser on its evidence rather than on argument.
