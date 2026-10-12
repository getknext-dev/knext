#!/usr/bin/env python3
"""Mutation-prove jev-hooks.test.sh and pr-risk.test.sh, guard by guard.

    python3 .claude/hooks/jev-hooks-mutation-proof.py           # every mutation
    python3 .claude/hooks/jev-hooks-mutation-proof.py --smoke   # one representative per guard family (CI)

For each guard in jev-result-screen.sh / jev-hook-lib.sh / pr-risk.sh: neuter the one thing it
protects, run the owning suite, and require it to go RED. A guard whose removal leaves the suite
green is decoration (`.claude/rules/workflow.md`).

Rules, all from workflow.md / the block-dangerous-bash harness:
  * Verdicts come from EXIT CODES, never from grepping output (ANSI once certified 14
    decorative mutations all-green that way).
  * The unmutated suites must be GREEN first — a harness that cannot see green proves nothing
    about red.
  * Every anchor must occur EXACTLY once or the run ABORTS, non-zero. No silent no-ops.
  * Mutates a COPY in a temp directory; the in-repo hooks are never opened for writing.
  * No mutation may target code that is not in the tree: every anchor is looked up in the real
    file, so a mutation of removed code aborts instead of passing.
"""
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL = HERE.parent / "skills" / "jev"
# (source dir, file, path inside the temp copy). The temp copy keeps the repo layout because
# pr-risk.sh sources ../../hooks/jev-hook-lib.sh. pr-risk.sh is judged by its own suite,
# pr-risk.test.sh; the lib is shared, so a lib mutation must turn EITHER suite red.
FILES = [(HERE, f, f"hooks/{f}") for f in ["jev-result-screen.sh", "jev-hook-lib.sh", "jev-hooks.test.sh"]] + [
    (SKILL, "pr-risk.sh", "skills/jev/pr-risk.sh"),
    (SKILL, "pr-risk.test.sh", "skills/jev/pr-risk.test.sh"),
]
DEST = {f: dest for _, f, dest in FILES}
SUITE = {
    "hooks": ["hooks/jev-hooks.test.sh"],
    "pr-risk": ["skills/jev/pr-risk.test.sh"],
    "both": ["hooks/jev-hooks.test.sh", "skills/jev/pr-risk.test.sh"],
}

SCREEN = "jev-result-screen.sh"
LIB = "jev-hook-lib.sh"

# (label, file, anchor, replacement)
MUTATIONS = [
    # --- the watchdog and score parsing every call goes through -----------------------------
    ("lib: watchdog leaves its sleep orphaned", LIB, "trap 'kill \"$sp\" 2>/dev/null; exit 0' TERM", ":"),
    ("lib: timeout watchdog neutered", LIB, 'sleep "${JEV_HOOK_TIMEOUT:-3}"', "sleep 100"),
    ("lib: out-of-range scores accepted", LIB, "x + 0 <= 1", "x + 0 <= 1000"),
    ("lib: non-numeric scores accepted", LIB, "case \"$1\" in '' | *[!0-9.]* | *.*.*) return 1 ;; esac", "case \"$1\" in '') return 1 ;; esac"),
    # --- the screen --------------------------------------------------------------------------
    ("screen: 0.7 threshold ignored", SCREEN, 'jev_ge "$p" 0.7 || exit 0', ":"),
    ("screen: threshold raised (never fires)", SCREEN, 'jev_ge "$p" 0.7 || exit 0', 'jev_ge "$p" 1.1 || exit 0'),
    ("screen: 32 KiB cap removed", SCREEN, "head -c 32768", "head -c 32768000"),
    ("screen: every tool screened", SCREEN, "  *) exit 0 ;;", "  *) : ;;"),
    ("screen: every Bash command screened", SCREEN, "((pr|issue)[[:space:]]+view|api[[:space:]].*comments)", "(.*)"),
    ("screen: jev error no longer fails open", SCREEN, "  --json || exit 0", "  --json || exit 2"),
    ("screen: unparseable score no longer fails open", SCREEN, 'jev_is_prob "$p" || exit 0', 'jev_is_prob "$p" || exit 2'),
    ("screen: missing jev no longer fails open", SCREEN, "jev_resolve || exit 0", "jev_resolve || exit 2"),
    ("screen: empty result still screened", SCREEN, "grep -q '[^[:space:]]' \"$tmp/text.txt\" 2>/dev/null || exit 0", ":"),
    ("screen: advisory context dropped", SCREEN, "additionalContext:", "ignoredKey:"),
    ("screen: becomes blocking (decision field)", SCREEN, "{hookSpecificOutput:{hookEventName", '{decision:"block",hookSpecificOutput:{hookEventName'),
    # --- the credential skip: literal formats only, never plain words ------------------------
    ("screen: literal-secret skip removed", SCREEN, 'jev_has_literal_secret <"$tmp/text.txt" && exit 0', ":"),
    (
        "lib: screen skips on plain WORDS again (an injection evades by saying 'token')",
        LIB,
        "JEV_LITERAL_RE='-----BEGIN|",
        "JEV_LITERAL_RE='secret|token|password|passwd|api[_-]?key|private[_-]?key|cookie|-----BEGIN|",
    ),
    ("lib: literal match is case-sensitive", LIB, 'grep -Eiq -- "$JEV_LITERAL_RE"', 'grep -Eq -- "$JEV_LITERAL_RE"'),
    ("lib: literal check never matches", LIB, 'grep -Eiq -- "$JEV_LITERAL_RE" <<<"$orig"', "false"),
    ("lib: literal check goes back to a pipeline (SIGPIPE under pipefail sends the secret)", LIB, 'grep -Eiq -- "$JEV_LITERAL_RE" <<<"$orig"', 'printf \'%s\' "$orig" | grep -Eiq -- "$JEV_LITERAL_RE" && return 0'),
    ("lib: literal check fed by printf process substitution again (Broken pipe noise when SIGPIPE is ignored)", LIB, 'grep -Eiq -- "$JEV_LITERAL_RE" <<<"$orig"', 'grep -Eiq -- "$JEV_LITERAL_RE" < <(printf \'%s\' "$orig") && return 0'),
    (
        "lib: the data-URI strip runs BEFORE the token checks (a token after data:x/y;base64, is eaten)",
        LIB,
        'grep -Eiq -- "$JEV_LITERAL_RE" <<<"$orig"',
        'grep -Eiq -- "$JEV_LITERAL_RE" < <(printf \'%s\' "$orig" | sed -E \'s#data:[A-Za-z0-9.+/-]+;base64,[A-Za-z0-9+/=]*#DATAURI#g\') && return 0',
    ),
    ("lib: entropy run lengthened to 64", LIB, "{32,}", "{64,}"),
    ("lib: entropy run shortened to 16", LIB, "{32,}", "{16,}"),
    ("lib: entropy rule no longer needs a digit (long identifiers skip the screen)", LIB, "grep -q '[0-9]' <<<\"$runs\"", "grep -q . <<<\"$runs\""),
    ("lib: entropy rule counts '/' (a path becomes one long run)", LIB, "grep -Eio '[A-Za-z0-9+=]{32,}'", "grep -Eio '[A-Za-z0-9+/=]{32,}'"),
    ("lib: data URIs no longer exempt", LIB, "data:[A-Za-z0-9.+/-]+;base64,[A-Za-z0-9+/=]*", "DATAURI_NEVER_MATCHES"),
    ("lib: 40-hex git SHAs no longer exempt", LIB, "[0-9a-fA-F]{40}", "[0-9a-fA-F]{999}"),
    ("lib: 64-hex sha256 digests no longer exempt", LIB, "[0-9a-fA-F]{64}", "[0-9a-fA-F]{999}"),
    ("lib: the SHA exemption widens to any hex run of 40+", LIB, "[0-9a-fA-F]{40}", "[0-9a-fA-F]{40,}"),
    ("lib: sk- loses its word boundary", LIB, "(^|[^a-z0-9])sk-", "sk-"),
    ("lib: sk- loses its body length", LIB, "sk-[A-Za-z0-9_-]{20,}", "sk-"),
    ("lib: gh[pousr]_ loses its body length", LIB, "gh[pousr]_[A-Za-z0-9]{36}", "gh[pousr]_"),
    ("lib: github_pat_ loses its body length", LIB, "github_pat_[A-Za-z0-9_]{22,}", "github_pat_"),
    ("lib: npm_ loses its body length", LIB, "npm_[A-Za-z0-9]{36}", "npm_"),
    ("lib: xox[bp]- loses its body", LIB, "xox[bp]-[A-Za-z0-9-]{10,}", "xox[bp]-"),
    ("lib: AKIA loses its body length", LIB, "AKIA[0-9A-Z]{16}", "AKIA"),
    ("lib: auth/bearer header-with-value rule removed", LIB, "|(authorization:[[:space:]]*|bearer[[:space:]]+)", "|(zzzz)"),
    ("lib: header value may be any word (no length/digit rule)", LIB, "([A-Za-z0-9._~+/=-]{16,}|[A-Za-z._~+/=-]*[0-9][A-Za-z0-9._~+/=-]{7,})", "[A-Za-z]+"),
    ("lib: header 16+ char value alternative removed", LIB, "([A-Za-z0-9._~+/=-]{16,}|", "("),
    ("lib: header short-value-with-digit alternative removed", LIB, "|[A-Za-z._~+/=-]*[0-9][A-Za-z0-9._~+/=-]{7,})", ")"),
    ("lib: header optional scheme word removed", LIB, "([A-Za-z]+[[:space:]]+)?", ""),
    ("lib: URL user:password@ not a literal secret", LIB, "|://[^/@[:space:]]+:[^/@[:space:]]+@", ""),
    ("lib: Authorization: Basic <anything> not a literal secret", LIB, "|authorization:[[:space:]]*basic[[:space:]]+[^[:space:]]+", ""),
    # --- fail closed: an ERROR in the secret check must read as "possible secret" (no call) ----
    ("lib: LC_ALL=C dropped (invalid UTF-8 makes BSD sed error: the macOS leak)", LIB, "export LC_ALL=C", ":"),
    ("lib: stage-1 grep error read as 'no secret'", LIB, '[ "$rc" -eq 1 ] || return 0', '[ "$rc" -ne 0 ] || return 0'),
    ("lib: data-URI sed error no longer fails closed", LIB, '<<<"$orig") || return 0', '<<<"$orig") || :'),
    ("lib: hash-strip sed error no longer fails closed", LIB, '<<<"$stripped") || return 0', '<<<"$stripped") || :'),
    ("lib: entropy-run grep error no longer fails closed", LIB, '[ "$rc" -le 1 ] || return 0 # 1 = no long run; 2+ = error: skip', ":"),
    ("lib: digit-check grep error no longer fails closed", LIB, '  [ "$rc" -le 1 ] || return 0\n  return "$rc"', '  return "$rc"'),
    # --- pr-risk -----------------------------------------------------------------------------
    ("pr-risk: security weight dropped", "pr-risk.sh", ":-0.40}", ":-0.00}"),
    ("pr-risk: tests weight dropped", "pr-risk.sh", ":-0.25}", ":-0.00}"),
    ("pr-risk: threshold ignored", "pr-risk.sh", "high = (r >= th)", "high = 0"),
    ("pr-risk: no rounding before compare", "pr-risk.sh", "r = int(r * 10000 + 0.5) / 10000", "r = r"),
    ("pr-risk: input not truncated", "pr-risk.sh", 'head -c "$MAX_BYTES" "$tmp/change.full" >"$tmp/change.txt"', 'cat "$tmp/change.full" >"$tmp/change.txt"'),
    ("pr-risk: SENDS DIFF CONTENT again (numstat replaced by the full patch)", "pr-risk.sh", 'diff_part --numstat "$tmp/numstat"', 'diff_part -p "$tmp/numstat"'),
    ("pr-risk: SENDS DIFF CONTENT again (name-status replaced by the full patch)", "pr-risk.sh", 'diff_part --name-status "$tmp/names"', 'diff_part -p "$tmp/names"'),
    ("pr-risk: SENDS DIFF CONTENT again (diffstat replaced by the full patch)", "pr-risk.sh", 'diff_part --stat=200 "$tmp/stat"', 'diff_part -p "$tmp/stat"'),
    ("pr-risk: the base-ref verify removed (a nonexistent base reads as an empty diff)", "pr-risk.sh", '{ echo "RISK unavailable (base ref \'$BASE\' does not resolve to a commit with a merge base)"; exit 3; }', ":"),
    ("pr-risk: the merge-base check removed", "pr-risk.sh", ' && git merge-base "$BASE" HEAD >/dev/null 2>&1', ""),
    ("pr-risk: a failing git diff is read as an empty diff", "pr-risk.sh", '{ echo "RISK unavailable (git diff failed)"; exit 3; }', ":"),
    ("pr-risk: PR body no longer capped", "pr-risk.sh", ' | head -c "$MAX_BODY_BYTES"', ""),
    ("pr-risk: gh is called without a PR number", "pr-risk.sh", 'if [ -n "$PR" ]; then', "if true; then"),
    ("pr-risk: jev failure no longer fails open", "pr-risk.sh", 'echo "RISK unavailable (jev call failed)"; exit 3', 'echo "RISK 0.00 normal"; exit 0'),
    ("pr-risk: unparseable scores accepted", "pr-risk.sh", "case \"$v\" in '' | *[!0-9.]* | *.*.*) echo \"RISK unavailable (unparseable scores)\"; exit 3 ;; esac", ":"),
    ("pr-risk: the literal-secret check on the diff removed", "pr-risk.sh", 'if jev_has_literal_secret <"$tmp/change.txt"; then echo "RISK unavailable (input carries a literal secret)"; exit 3; fi', ":"),
    ("pr-risk: a missing secret-check lib no longer stops the call", "pr-risk.sh", '. "$LIB" 2>/dev/null || { echo "RISK unavailable (secret check unavailable)"; exit 3; }', '. "$LIB" 2>/dev/null || :'),
    ("pr-risk: empty diff still calls jev", "pr-risk.sh", 'if ! grep -q \'^[A-Z][0-9]*[[:space:]]\' "$tmp/names"; then', 'if false; then'),
]

# Each literal-format alternative must be covered by its own case in the suite, so remove them ONE
# AT A TIME. (label, anchor, replacement)
for _label, _anchor, _repl in [
    ("PEM block", "-----BEGIN|", ""),
    ("gh[pousr]_", "gh[pousr]_[A-Za-z0-9]{36}|", ""),
    ("github_pat_", "github_pat_[A-Za-z0-9_]{22,}|", ""),
    ("npm_", "npm_[A-Za-z0-9]{36}|", ""),
    ("sk-", "|(^|[^a-z0-9])sk-[A-Za-z0-9_-]{20,}", ""),
    ("xox[bp]-", "|xox[bp]-[A-Za-z0-9-]{10,}", ""),
    ("AKIA", "|AKIA[0-9A-Z]{16}", ""),
]:
    MUTATIONS.append((f"lib: literal pattern removed: {_label}", LIB, _anchor, _repl))


def run_suite(work: Path, test: str) -> int:
    return subprocess.run(
        ["bash", str(work / test)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=300,
    ).returncode


# CI cost: a suite run takes minutes on a hosted runner, so the full sweep would be too long for a
# CI step. CI therefore runs one mutation per guard FAMILY; the full sweep stays the local
# evidence tool.
SMOKE = [
    "literal-secret skip removed",
    "plain WORDS again",
    "watchdog leaves its sleep",
    "screen: 0.7 threshold ignored",
    "screen: becomes blocking",
    "screen: jev error no longer fails open",
    "screen: 32 KiB cap removed",
    "pr-risk: threshold ignored",
    "pr-risk: the literal-secret check",
    "SENDS DIFF CONTENT again (numstat",
    "SENDS DIFF CONTENT again (diffstat",
    "base-ref verify removed",
    "a failing git diff is read",
    "BEFORE the token checks",
    "goes back to a pipeline (SIGPIPE",
    "LC_ALL=C dropped",
    "entropy-run grep error",
    "data URIs no longer exempt",
    "40-hex git SHAs no longer exempt",
]


def main() -> int:
    smoke = "--smoke" in sys.argv[1:]
    todo = [(i, m) for i, m in enumerate(MUTATIONS) if not smoke or any(k in m[0] for k in SMOKE)]
    aborts, survivors, killed = [], [], 0
    with tempfile.TemporaryDirectory() as td:
        base = Path(td) / "base"
        base.mkdir()
        for d, f, dest in FILES:
            (base / dest).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(d / f, base / dest)
        for t in SUITE["both"]:
            rc = run_suite(base, t)
            if rc != 0:
                print(f"ABORT: the UNMUTATED suite {t} is not green (exit {rc}); cannot prove anything")
                return 2
        print("baseline: green (exit 0)")

        def prove(item):
            i, (label, fname, anchor, repl) = item
            work = Path(td) / f"m{i}"
            shutil.copytree(base, work)
            target = work / DEST[fname]
            src = target.read_text()
            n = src.count(anchor)
            if n != 1:
                return "ABORT", f"ABORT  {label}: anchor occurs {n}x in {fname}, expected exactly 1"
            out = src.replace(anchor, repl, 1)
            if out == src:
                return "ABORT", f"ABORT  {label}: substitution produced no change"
            target.write_text(out)
            which = "pr-risk" if fname == "pr-risk.sh" else "both" if fname == LIB else "hooks"
            rc = max(run_suite(work, t) for t in SUITE[which])
            if rc != 0:
                return "RED", f"RED    {label} (suite exit {rc})"
            return "GREEN", f"GREEN  {label}  <-- SURVIVED, the guard is decoration"

        # Independent temp copies, so mutations run in parallel (each suite keeps its own TMP).
        # Results print in declaration order.
        with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 2)) as pool:
            for status, line in pool.map(prove, todo):
                print(line)
                if status == "RED":
                    killed += 1
                elif status == "GREEN":
                    survivors.append(line)
                else:
                    aborts.append(line)
    suffix = f" (smoke subset of {len(MUTATIONS)})" if smoke else ""
    print(f"\n{killed}/{len(todo)} mutations killed{suffix}; survivors={len(survivors)} aborts={len(aborts)}")
    return 0 if not survivors and not aborts else 1


if __name__ == "__main__":
    sys.exit(main())
