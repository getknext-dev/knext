# Adversarial round-2 review — `fix/gate-file-unread-relations` @ `bea93a6` (#753)

Worktree: `/Users/banna/alpheya/pocs/knext-wt/gate-relations`. Branch is pushed; `HEAD == origin`.

Your job is to **defeat this**, not to confirm it. Round 1 (`.claude/review-debt3a.md`, verdict
ISSUES_FOUND) found that rule 6's closed-world scan over undeclared keys was genuine, but the
relational layer built on it was **enumeration**, defeated by two fresh contradictions built
entirely from registered keys — and that rule 6b, the guard meant to close rule 6's bypass, was
**decoration**: all three of its halves could be deleted with the suite staying green.

The implementer's fix round is in `<worktree>/.claude/impl-debt3a-report.md` (§7–§14). Read §7
first — it is the SCANNED-vs-ENUMERATED split it now claims.

## Acceptance criteria — all three must hold, each proven by a run, not by reading

1. **The round-1 contradictions must now FAIL.** Rebuild B1 (`read('<any label>')` as an unbound
   third door) and B2 (a relationally-named key declared `prose(...)`) yourself from the round-1
   review — do not trust the implementer's rebuilt copies — and confirm each exits non-zero with the
   rule's own message. Also re-run N1, N2, N3, N4 and the nested-object case from Attack 2.
2. **Each half of rule 6b must go red individually.** Round 1 killed all three halves at once and
   the suite stayed green; the fix claims the mutation is now anchored on the rule rather than on
   registry data. Delete each half **separately** and confirm each one reds on its own. A half that
   only reds in company with another is still decoration.
3. **One NEW contradiction of your own design**, not in round 1's R-list and not in the report's
   list. Build it from registered, bound keys so rules 6/6b/6c/6d are all satisfied. If it passes,
   that is a blocking finding.

## Also probe — the report's own stated limits are the obvious attack surface (§14)
- **Rule 6c proves existence, not correspondence** — a READ bound to code but citing the *wrong*
  rule passes. Is that reachable in the shipped file, and does it matter?
- **The `derived` exemption** is admitted as the one relation the file can state that nothing reads.
  Confirm whether that is a genuine residual hole or whether it, too, is now reachable.
- **`--declare` is a test seam in production code.** It is refused without `--file`, and that
  refusal is claimed mutation-killed. Verify that refusal cannot be bypassed — try to reach
  `--declare` without `--file`, and try `--file` pointing at the real gate dir.
- **The validator runs in no CI job of its own**; what gates the file is the first vitest case.
  Verify that case actually fails when the shipped gate file is made invalid — if it does not, the
  whole guard is unwired in practice.

## Discipline (non-negotiable — each has burned this project)
- **Branch on exit codes, never grep output.** vitest ANSI has already certified 14 decorative
  mutations as all-green here.
- **Prove your harness can see red first** — run a control mutation you know must be killed.
- **Never mutate with `perl`.** Use a script asserting the anchor occurs **exactly once**, aborting
  otherwise; a silently-failed substitution yields a green run that proves nothing.
- **Restore byte-identically and verify** — `git status --porcelain` clean afterwards, and grep the
  changed sources for residue (`if (false`, `of []`, `zzzz`). Mutation residue in a legitimately
  modified file is invisible to `git status`; this project has twice nearly shipped the inverse of
  a fix that way.
- Use your **own** harness, not the implementer's `.claude/mutate-gate-rules.mjs`.

## Verdict
Write `.claude/review-debt3b.md` in the worktree beginning with a single line: `# APPROVE` or
`# ISSUES_FOUND`. If ISSUES_FOUND, list blocking findings with the exact reproduction and the
one-line fix. Say plainly which claims you verified by running and which you only read.
