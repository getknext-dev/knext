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

RESTORE IS SIGNAL-SAFE. An earlier harness restored only in `finally`, and a tool timeout
sent SIGTERM — which Python does not unwind — leaving a real mutation applied to the LIVE
hook (the git flag table silently truncated). It hid because the file was legitimately
modified at the time, so `git status` showing "M" looked expected.
"""
import argparse
import shutil
import signal
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOOK = ROOT / "block-dangerous-bash.sh"
TEST = ROOT / "block-dangerous-bash.test.sh"
BAK = Path("/tmp/block-dangerous-bash.mutation-proof.bak")

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


def failing() -> int:
    out = subprocess.run(["bash", str(TEST)], capture_output=True, text=True).stdout
    return sum(1 for line in out.splitlines() if line.startswith("FAIL"))


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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="verify every anchor resolves, without mutating")
    args = ap.parse_args()
    if args.check:
        return check_anchors()

    shutil.copy(HOOK, BAK)

    def restore_and_exit(signum, _frame):
        shutil.copy(BAK, HOOK)
        print(f"\nSIGNAL {signum} — hook restored before exit", flush=True)
        sys.exit(3)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, restore_and_exit)

    rc = 0
    try:
        base = failing()
        print(f"baseline failing: {base}", flush=True)
        if base:
            print("ABORT: baseline is not green — fix the suite before proving it")
            return 2
        for label, needle, repl in MUTATIONS:
            src = HOOK.read_text()
            n = src.count(needle)
            if n != 1:
                print(f"  ABORT  {label:44s} anchor occurs {n}x, expected 1", flush=True)
                rc = 1
                continue
            HOOK.write_text(src.replace(needle, repl, 1))
            f = failing()
            if f:
                print(f"  {label:44s} failing={f:<4} RED (real)", flush=True)
            else:
                print(f"  {label:44s} failing=0    *** GREEN — DECORATION ***", flush=True)
                rc = 1
            shutil.copy(BAK, HOOK)
    finally:
        shutil.copy(BAK, HOOK)
        body = HOOK.read_text()
        residue = any(m in body for m in ("__never", "__nr__", "__nd__", "__nf__", "__nfr__"))
        print(f"restored byte-identical={body == BAK.read_text()}  residue={residue}  "
              f"final failing={failing()}", flush=True)
    return rc


if __name__ == "__main__":
    sys.exit(main())
