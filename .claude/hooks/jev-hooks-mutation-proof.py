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
# (source dir, file). pr-risk.sh is judged by its own suite, pr-risk.test.sh.
FILES = [(HERE, f) for f in ["jev-result-screen.sh", "jev-hook-lib.sh", "jev-hooks.test.sh"]] + [
    (SKILL, "pr-risk.sh"),
    (SKILL, "pr-risk.test.sh"),
]

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
    ("screen: literal-secret skip removed", SCREEN, 'jev_has_literal_secret "$(cat "$tmp/text.txt")" && exit 0', ":"),
    (
        "lib: screen skips on plain WORDS again (an injection evades by saying 'token')",
        LIB,
        "JEV_LITERAL_RE='-----BEGIN|",
        "JEV_LITERAL_RE='secret|token|password|passwd|api[_-]?key|private[_-]?key|cookie|-----BEGIN|",
    ),
    ("lib: literal match is case-sensitive", LIB, 'grep -Eiq -- "$JEV_LITERAL_RE"', 'grep -Eq -- "$JEV_LITERAL_RE"'),
    ("lib: literal check never matches", LIB, 'printf \'%s\' "$1" | grep -Eiq -- "$JEV_LITERAL_RE"', "false"),
    ("lib: entropy run lengthened to 64", LIB, "{32,}", "{64,}"),
    ("lib: entropy run shortened to 16", LIB, "{32,}", "{16,}"),
    ("lib: sk- loses its word boundary", LIB, "(^|[^a-z0-9])sk-[a-z0-9]", "sk-"),
    ("lib: auth/bearer header-with-value rule removed", LIB, "|(authorization:[[:space:]]*|bearer[[:space:]]+)", "|(zzzz)"),
    ("lib: header value may be any word (no length/digit rule)", LIB, "([A-Za-z0-9._~+/=-]{16,}|[A-Za-z._~+/=-]*[0-9][A-Za-z0-9._~+/=-]{7,})", "[A-Za-z]+"),
    ("lib: header 16+ char value alternative removed", LIB, "([A-Za-z0-9._~+/=-]{16,}|", "("),
    ("lib: header short-value-with-digit alternative removed", LIB, "|[A-Za-z._~+/=-]*[0-9][A-Za-z0-9._~+/=-]{7,})", ")"),
    ("lib: header optional scheme word removed", LIB, "([A-Za-z]+[[:space:]]+)?", ""),
    ("lib: URL user:password@ not a literal secret", LIB, "|://[^/@[:space:]]+:[^/@[:space:]]+@", ""),
    ("lib: Authorization: Basic <anything> not a literal secret", LIB, "|authorization:[[:space:]]*basic[[:space:]]+[^[:space:]]+", ""),
    # --- pr-risk -----------------------------------------------------------------------------
    ("pr-risk: security weight dropped", "pr-risk.sh", ":-0.40}", ":-0.00}"),
    ("pr-risk: tests weight dropped", "pr-risk.sh", ":-0.25}", ":-0.00}"),
    ("pr-risk: threshold ignored", "pr-risk.sh", "high = (r >= th)", "high = 0"),
    ("pr-risk: no rounding before compare", "pr-risk.sh", "r = int(r * 10000 + 0.5) / 10000", "r = r"),
    ("pr-risk: diff not truncated", "pr-risk.sh", 'head -c "$MAX_BYTES" "$PR_RISK_DIFF_FILE"', 'cat "$PR_RISK_DIFF_FILE"'),
    ("pr-risk: jev failure no longer fails open", "pr-risk.sh", 'echo "RISK unavailable (jev call failed)"; exit 3', 'echo "RISK 0.00 normal"; exit 0'),
    ("pr-risk: unparseable scores accepted", "pr-risk.sh", "case \"$v\" in '' | *[!0-9.]* | *.*.*) echo \"RISK unavailable (unparseable scores)\"; exit 3 ;; esac", ":"),
    ("pr-risk: empty diff still calls jev", "pr-risk.sh", 'if [ ! -s "$tmp/diff.txt" ]; then', 'if false; then'),
]

# Each literal-format alternative must be covered by its own case in the suite, so remove them ONE
# AT A TIME. (label, anchor, replacement)
for _label, _anchor, _repl in [
    ("PEM block", "-----BEGIN|", ""),
    ("ghp_", "ghp_|", ""),
    ("gho_", "gho_|", ""),
    ("github_pat_", "github_pat_|", ""),
    ("npm_", "npm_|", ""),
    ("xox[bp]-", "|xox[bp]-", ""),
    ("AKIA", "|AKIA", ""),
]:
    MUTATIONS.append((f"lib: literal pattern removed: {_label}", LIB, _anchor, _repl))


def run_suite(work: Path, test: str = "jev-hooks.test.sh") -> int:
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
]


def main() -> int:
    smoke = "--smoke" in sys.argv[1:]
    todo = [(i, m) for i, m in enumerate(MUTATIONS) if not smoke or any(k in m[0] for k in SMOKE)]
    aborts, survivors, killed = [], [], 0
    with tempfile.TemporaryDirectory() as td:
        base = Path(td) / "base"
        base.mkdir()
        for d, f in FILES:
            shutil.copy2(d / f, base / f)
        for t in ("jev-hooks.test.sh", "pr-risk.test.sh"):
            rc = run_suite(base, t)
            if rc != 0:
                print(f"ABORT: the UNMUTATED suite {t} is not green (exit {rc}); cannot prove anything")
                return 2
        print("baseline: green (exit 0)")

        def prove(item):
            i, (label, fname, anchor, repl) = item
            work = Path(td) / f"m{i}"
            shutil.copytree(base, work)
            src = (work / fname).read_text()
            n = src.count(anchor)
            if n != 1:
                return "ABORT", f"ABORT  {label}: anchor occurs {n}x in {fname}, expected exactly 1"
            out = src.replace(anchor, repl, 1)
            if out == src:
                return "ABORT", f"ABORT  {label}: substitution produced no change"
            (work / fname).write_text(out)
            rc = run_suite(work, "pr-risk.test.sh" if fname == "pr-risk.sh" else "jev-hooks.test.sh")
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
