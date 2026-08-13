#!/usr/bin/env python3
"""Mutation-prove block-dangerous-bash.sh, clause by clause.

    python3 .claude/hooks/mutation-proof.py --check   # anchors only, no mutation (fast)
    python3 .claude/hooks/mutation-proof.py           # full sweep

WHY THIS IS IN THE REPO RATHER THAN SOMEONE'S SCRATCH DIRECTORY. The claim "N clauses
mutation-proved red" was made in commit messages and a PR body for several rounds while
the script producing it existed only locally — so a reviewer could confirm the suite
passes but could not reproduce the number, and asked for it twice. A number nobody else
can derive is not evidence. `.claude/rules/workflow.md` requires mutation-proving every
new guard; this is that requirement made runnable.

WHAT IT PROVES. For each clause: delete or neuter the specific thing it protects, and
require the suite to notice. A clause whose removal leaves the suite green is decoration,
and decoration in a safety control is worse than absence because it reads as coverage.
Five alternatives in this hook were exactly that, three of them naming operations
`security.md` lists verbatim.

GRANULARITY IS THE POINT. Mutating a whole regex proves the regex matters, not that each
alternative inside it does. An earlier claim of "all mutation-proved" was true per rule
and false per clause, which is precisely where a bypass hides.

A MISSED ANCHOR IS AN ABORT, NEVER A PASS. If the anchor text is not found exactly once
the run reports ABORT for that clause and exits non-zero. `workflow.md` bans doing this
with `perl` for the same reason: a silently-failed substitution yields a green run that
proves nothing.

IT NEVER TOUCHES THE IN-REPO HOOK. The sweep copies the hook and its suite to a temp
directory and mutates the copy.

That is not tidiness — it is the fix for a defect this harness shipped with. The first
version mutated the live file and restored it in `finally` plus SIGTERM/SIGINT/SIGHUP
handlers. SIGKILL is uncatchable, and a reaped run left the working tree carrying
`true ||` in place of the awk fail-closed capability probe — ADR-0043 Decision 4's own
subject — DISARMED for about twenty minutes, while that same hook was gating the shell.
A later run then took the poisoned file as its baseline snapshot and reported
`restored byte-identical=True residue=False`, because both self-checks were unsound: the
comparison was against a snapshot that may already have been poisoned, and the residue
scan grepped only for sentinel strings that most clause mutations do not contain.

An evidence harness is a guard, and `workflow.md`'s rule applies to it: a guard that
cannot detect its own subject's removal is decoration. Copying removes the failure mode
instead of narrowing it — no signal, timeout or crash can damage a file the process never
opens for writing — and the one integrity claim printed at the end is checked against
`git show HEAD:…`, never against a snapshot this script took itself.
"""
import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HOOKS_DIR = Path(__file__).resolve().parent
ROOT = HOOKS_DIR.parent.parent
HOOK_REL = ".claude/hooks/block-dangerous-bash.sh"
HOOK = HOOKS_DIR / "block-dangerous-bash.sh"
TEST = HOOKS_DIR / "block-dangerous-bash.test.sh"

# (label, anchor-that-must-occur-exactly-once, replacement)
MUTATIONS = [
    # ── fail closed on the guard's own toolchain ──────────────────────────────
    ("dependency check", "for _t in jq tr awk grep; do", "for _t in ; do"),
    ("grep \\b capability probe",
     "printf 'a git b' | grep -qE '\\bgit\\b' 2>/dev/null &&\n"
     "  ! printf 'agitb' | grep -qE '\\bgit\\b' 2>/dev/null ||",
     "true ||"),
    ("awk subcommand probe",
     '''[ "$(git_subcommand 'git commit -m x')" = "commit" ] &&
  [ "$(git_subcommand 'git push origin x')" = "push" ] ||''', "true ||"),
    ("unparseable-payload deny",
     '''cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""') ||
  deny "unparseable PreToolUse payload — refusing to vet this command."''',
     '''cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")'''),
    ("empty-command deny",
     '[ -z "$cmd" ] &&\n  deny "PreToolUse payload carried no .tool_input.command',
     '[ -z "$cmd" ] && exit 0 && : "PreToolUse payload carried no .tool_input.command'),
    # ── the exemption and its boundary ────────────────────────────────────────
    ("has_subst (split-surviving markers)",
     "*'${'[[:space:]]* | *'${|'*) has_subst=1 ;;", "*'__never__'*) has_subst=1 ;;"),
    ("per-segment substitution case",
     "*'$('* | *'`'* | *'<('* | *'>('*) return 1 ;;", "*'__never__'*) return 1 ;;"),
    ("exemption: first word must be git",
     "    git | git[[:space:]]*) ;;", "    git | git[[:space:]]* | *) ;;"),
    ("exemption itself",
     '[ "$(git_subcommand "$1")" = "commit" ]',
     '[ "$(git_subcommand "$1")" = "__never__" ]'),
    ("has_comment refuses the exemption",
     'has_comment "$1" && return 1', 'false && return 1'),
    ("has_comment: word-start detection",
     'if (c == "#" && (i == 1 || substr($0, i - 1, 1) ~ /[[:space:]();&|]/)) { found = 1; break }',
     'if (c == "__never__") { found = 1; break }'),
    ("word-terminator class (round 11)",
     '~ /[[:space:]();&|]/)) { found = 1; break }', '~ /[[:space:]]/)) { found = 1; break }'),
    ("git_subcommand: unknown flag fails closed",
     "exit                    # unknown flag", "continue                # unknown flag"),
    ("git_subcommand: arg-taking table",
     'split("-C -c --git-dir --work-tree --namespace --super-prefix --config-env --exec-path", a, " ")',
     'split("-C -c --git-dir --work-tree", a, " ")'),
    ("git_subcommand: no-arg table",
     'if (no_arg[$j])        { continue }', 'if (no_arg[$j])        { j++; continue }'),
    # ── data context: nothing inside data may establish the exemption ─────────
    ("data_state guards the exemption",
     '[ "$seg_start_state" = "none" ] && [ "$in_hd" = 0 ] && is_literal_commit "$seg"',
     'is_literal_commit "$seg"'),
    ("heredoc tracker guards the exemption",
     '[ "$in_hd" = 0 ] && is_literal_commit "$seg"', 'is_literal_commit "$seg"'),
    ("heredoc: exact terminator (tabs only for <<-)",
     'if [ "$hd_dash" = 1 ]; then hd_cand=${seg#"${seg%%[!"$tab"]*}"}; else hd_cand=$seg; fi',
     'hd_cand=${seg#"${seg%%[![:space:]]*}"}'),
    ("heredoc: unparseable << fails closed",
     'for (i = n; i < extra; i++) print "0" tab "\\001UNPARSEABLE-HEREDOC\\001"',
     'for (i = n; i < 0; i++) print "0" tab "\\001UNPARSEABLE-HEREDOC\\001"'),
    ("heredoc: delimiter queue (stacked <<A <<B)",
     'hd_queue=${hd_queue#*"$nl"}\n      [ -z "$hd_queue" ] && in_hd=0',
     'hd_queue=""\n      [ -z "$hd_queue" ] && in_hd=0'),
    # ── carried message: the tail is command text ────────────────────────────
    ("msg_tail: vet the rest of the segment",
     '    seg=$tail_after_msg                     # the remainder is a real command',
     '    continue                                # the remainder is a real command'),
    ("msg_tail: cut position",
     'if (cut > 0 && cut < n) print substr($0, cut + 1)', 'if (0) print substr($0, cut + 1)'),
    ("quote_state: engages at all",
     '  if [ "$in_msg" != "none" ]; then', '  if false; then'),
    ("quote_state: never engages", '    END { print st }', '    END { print "none" }'),
    ("quote_state: always engages", '    END { print st }', '    END { print "sq" }'),
    ("quote_state: # starts a comment",
     'if (c == "#" && (i == 1 || substr($0, i - 1, 1) ~ /[[:space:]();&|]/)) break',
     'if (c == "__never__") break'),
    ("quote_state: ANSI-C quoting state",
     'else if (st == "esq") {\n          if (c == "\\\\") i++\n'
     '          else if (c == "\'"\'"\'") st = "none"\n        }',
     'else if (st == "__nomatch__") {\n          if (c == "\\\\") i++\n'
     '          else if (c == "\'"\'"\'") st = "none"\n        }'),
    # ── shared delimiter classes ─────────────────────────────────────────────
    ("seg_matches: stripped view",
     '  printf \'%s\' "$sseg" | grep -qE -- "$1"', '  false'),
    ("delim: quotes + metacharacters",
     'delim="[[:space:]\\"$sq()<>]"', 'delim="[[:space:]]"'),
    ("lead: quotes + backslash",
     'lead="(^|[;&|(){}!\\`]|[[:space:]\\"$sq\\\\])"', 'lead="(^|[[:space:]])"'),
    ("lead: backtick opens a command",
     'lead="(^|[;&|(){}!\\`]|', 'lead="(^|[;&|(){}!]|'),
    ("blead: branch-name class",
     'blead="(^|[;&|(){}!<]|[[:space:]\\"$sq\\\\:/+])"', 'blead="(^|[[:space:]])"'),
    ("ws: multi-word rules split on whitespace",
     'ws="[[:space:]]+"', 'ws=" "'),
    # ── normalisation ────────────────────────────────────────────────────────
    ("continuation join", "joined=${cmd//\\\\$nl/ }", "joined=$cmd"),
    ("CR strip", "cmd=${cmd//$cr/}", "cmd=$cmd"),
    # ── the rule families, clause by clause ──────────────────────────────────
    ("rm: command-word regex",
     'rm_cmd_re="${lead}(\\\\\\\\)?([^[:space:]]*/)?rm(${delim}|\\$)"', 'rm_cmd_re="__never__"'),
    ("rm: --recursive alternative",
     '(--recursive|--dir|-[A-Za-z]*[Rr][A-Za-z]*)(${delim}|=|\\$)" && has_r=1',
     '(__nr__|--dir|-[A-Za-z]*[Rr][A-Za-z]*)(${delim}|=|\\$)" && has_r=1'),
    ("rm: --dir alternative",
     '(--recursive|--dir|-[A-Za-z]*[Rr][A-Za-z]*)(${delim}|=|\\$)" && has_r=1',
     '(--recursive|__nd__|-[A-Za-z]*[Rr][A-Za-z]*)(${delim}|=|\\$)" && has_r=1'),
    ("rm: --force alternative",
     '(--force|-[A-Za-z]*f[A-Za-z]*)(${delim}|=|\\$)" && has_f=1',
     '(__nf__|-[A-Za-z]*f[A-Za-z]*)(${delim}|=|\\$)" && has_f=1'),
    ("push: token gate",
     "if seg_matches '\\bgit\\b' && seg_matches '\\bpush\\b'; then",
     "if seg_matches '__never__' && seg_matches '__never__'; then"),
    ("push: force/mirror/--all detection",
     "(--force|--force-with-lease|--mirror|--all)(${delim}|=|\\$)",
     "(__never__)(${delim}|=|\\$)"),
    ("history rewrite rule", "(filter-branch|filter-repo)", "(__never__)"),
    ("history rewrite: filter-repo alternative",
     "filter-branch|filter-repo", "filter-branch|__nfr__"),
    ("cluster delete rule (ADR-0001)", "\\bkubectl\\b.*\\bdelete\\b", "__never__"),
    # DOUBLED backslashes, and deliberately so: these three rules live inside a bash
    # DOUBLE-quoted string (they interpolate ${ws}), so the file literally contains `\\b`
    # where the single-quoted rules above contain `\b`. Writing them like their
    # single-quoted neighbours makes the anchor miss — which `--check` reports as ABORT
    # rather than quietly scoring them as passes.
    ("teardown: terraform", r"\\bterraform${ws}destroy\\b", "__never__tf"),
    ("teardown: oci cluster", r"\\boci${ws}ce${ws}cluster${ws}delete\\b", "__never__oci1"),
    ("teardown: oci node-pool", r"\\boci${ws}ce${ws}node-pool${ws}delete\\b", "__never__oci2"),
]


def check_anchors() -> int:
    src = HOOK.read_text()
    bad = 0
    for label, needle, _ in MUTATIONS:
        n = src.count(needle)
        if n != 1:
            print(f"  ABORT  {label:44s} anchor occurs {n}x, expected 1")
            bad += 1
    print(f"{len(MUTATIONS)} clauses; {bad} unresolvable anchor(s)")
    return 1 if bad else 0


def repo_hook_matches_head() -> bool:
    """Is the in-repo hook byte-identical to what version control holds?

    Compared against `git show HEAD:…`, NOT against a snapshot this script took.
    A self-taken snapshot is worthless as an integrity check the moment the file
    was already poisoned when the run started — which is exactly what happened.
    """
    committed = subprocess.run(
        ["git", "-C", str(ROOT), "show", f"HEAD:{HOOK_REL}"],
        capture_output=True,
    )
    if committed.returncode != 0:
        return True  # not committed yet (e.g. first landing); nothing to compare against
    return committed.stdout == HOOK.read_bytes()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="verify every anchor resolves, without mutating")
    args = ap.parse_args()
    if args.check:
        return check_anchors()

    # THE SWEEP RUNS ON A COPY. IT NEVER TOUCHES THE IN-REPO HOOK.
    #
    # The previous version mutated the live file and restored it in `finally` plus a
    # SIGTERM/SIGINT/SIGHUP handler. That is not enough, and the gap is not theoretical:
    # SIGKILL is uncatchable, and a reaped run left the working tree carrying `true ||`
    # in place of the awk fail-closed capability probe — ADR-0043 Decision 4's own
    # subject — DISARMED for roughly twenty minutes, while that same hook was gating the
    # shell. A later run then took the poisoned file as its baseline snapshot and
    # cheerfully reported `restored byte-identical=True residue=False`.
    #
    # Both of those self-checks were unsound. `byte-identical` compared against a
    # snapshot that may already have been poisoned, and `residue` grepped only for
    # sentinel strings that most clause mutations do not contain. A guard that cannot
    # detect its own subject's removal is decoration — `workflow.md` says so about
    # guards, and an evidence harness is a guard.
    #
    # Copying removes the failure mode rather than narrowing it: no signal, no timeout
    # and no crash can damage a file the process never opens for writing. The suite
    # locates the hook relative to its own directory, so a copied PAIR runs unchanged.
    if not repo_hook_matches_head():
        print("ABORT: the in-repo hook already differs from HEAD — refusing to measure a "
              "tree of unknown provenance. Inspect `git diff` first.")
        return 2

    workdir = Path(tempfile.mkdtemp(prefix="mutation-proof-"))
    hook = workdir / HOOK.name
    test = workdir / TEST.name
    shutil.copy(HOOK, hook)
    shutil.copy(TEST, test)

    def failing_copy() -> int:
        out = subprocess.run(["bash", str(test)], capture_output=True, text=True).stdout
        return sum(1 for line in out.splitlines() if line.startswith("FAIL"))

    pristine = hook.read_text()
    rc = 0
    done = 0
    try:
        base = failing_copy()
        print(f"baseline failing: {base}  (sweeping a copy in {workdir})", flush=True)
        if base:
            print("ABORT: baseline is not green — fix the suite before proving it")
            return 2
        for label, needle, repl in MUTATIONS:
            n = pristine.count(needle)
            if n != 1:
                print(f"  ABORT  {label:44s} anchor occurs {n}x, expected 1", flush=True)
                rc = 1
                continue
            # SELF-HEAL, because a vanished workdir must not end the sweep silently.
            # A real run died here with FileNotFoundError at clause 5 of 47 — something
            # removed the temp directory mid-sweep — and left a log that READ like a
            # partial success: five REDs, the integrity line, and a traceback below the
            # fold. A sweep that stops early must never be mistakable for one that
            # finished, which is why the completion count below is mandatory output.
            if not hook.exists() or not test.exists():
                workdir.mkdir(parents=True, exist_ok=True)
                shutil.copy(HOOK, hook)
                shutil.copy(TEST, test)
                print(f"  NOTE   workdir vanished — recreated before {label}", flush=True)
            hook.write_text(pristine.replace(needle, repl, 1))
            f = failing_copy()
            if f:
                print(f"  {label:44s} failing={f:<4} RED (real)", flush=True)
            else:
                print(f"  {label:44s} failing=0    *** GREEN — DECORATION ***", flush=True)
                rc = 1
            hook.write_text(pristine)
            done += 1
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        # Two claims, both mandatory. An INCOMPLETE sweep is a failure, not a partial
        # pass: quoting "N clauses proved" from a run that covered five of them is the
        # unreproducible-evidence problem this whole script exists to end.
        total = len(MUTATIONS)
        complete = done == total
        if not complete:
            print(f"INCOMPLETE: {done} of {total} clauses swept — this run proves NOTHING "
                  f"about the {total - done} it did not reach", flush=True)
            rc = 1
        else:
            print(f"swept {done} of {total} clauses", flush=True)
        # The only integrity claim worth printing: the REPO copy is what HEAD says it is.
        intact = repo_hook_matches_head()
        print(f"in-repo hook matches HEAD: {intact}", flush=True)
        if not intact:
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
