#!/usr/bin/env python3
"""Mutation-prove jev-hooks.test.sh, guard by guard.

    python3 .claude/hooks/jev-hooks-mutation-proof.py

For each guard in jev-bash-gate.sh / jev-result-screen.sh / jev-hook-lib.sh: neuter the one
thing it protects, run the suite, and require it to go RED. A guard whose removal leaves the
suite green is decoration (`.claude/rules/workflow.md`).

Rules, all from workflow.md / the block-dangerous-bash harness:
  * Verdicts come from EXIT CODES, never from grepping output (ANSI once certified 14
    decorative mutations all-green that way).
  * The unmutated suite must be GREEN first — a harness that cannot see green proves nothing
    about red.
  * Every anchor must occur EXACTLY once or the run ABORTS, non-zero. No silent no-ops.
  * Mutates a COPY in a temp directory; the in-repo hooks are never opened for writing.
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL = HERE.parent / "skills" / "jev"
# (source dir, file). pr-risk.sh is judged by its own suite, pr-risk.test.sh.
FILES = [(HERE, f) for f in ["jev-bash-gate.sh", "jev-result-screen.sh", "jev-hook-lib.sh", "jev-hooks.test.sh"]] + [
    (SKILL, "pr-risk.sh"),
    (SKILL, "pr-risk.test.sh"),
]

# (label, file, anchor, replacement)
MUTATIONS = [
    ("gate: block branch removed (exit 2 -> exit 0)", "jev-bash-gate.sh", "  exit 2\nfi", "  exit 0\nfi"),
    ("gate: irreversible threshold ignored", "jev-bash-gate.sh", 'jev_ge "$irr" 0.9 &&', "true &&"),
    ("gate: destructive threshold ignored", "jev-bash-gate.sh", '&& jev_ge "$des" 0.9', "&& true"),
    ("gate: threshold raised above 0.9 (>= -> never)", "jev-bash-gate.sh", 'jev_ge "$irr" 0.9 &&', 'jev_ge "$irr" 1.1 &&'),
    ("gate: jev error no longer fails open", "jev-bash-gate.sh", "  --json || exit 0", "  --json || exit 2"),
    ("gate: unparseable scores no longer fail open", "jev-bash-gate.sh", 'jev_is_prob "$des" || exit 0', 'jev_is_prob "$des" || exit 2'),
    ("gate: missing jev no longer fails open", "jev-bash-gate.sh", "jev_resolve || exit 0", "jev_resolve || exit 2"),
    ("gate: pre-filter disabled", "jev-bash-gate.sh", 'is_readonly "$cmd" && exit 0', 'false && exit 0'),
    ("gate: pre-filter drops the last segment again", "jev-bash-gate.sh", ' || [ -n "$seg" ]; do', "; do"),
    ("gate: pre-filter ignores redirects", "jev-bash-gate.sh", "case \"$c\" in *'>'* | ", "case \"$c\" in "),
    ("gate: pre-filter ignores --output", "jev-bash-gate.sh", "case \"$seg\" in *' --output'* | *' --pre'*) return 1 ;; esac", ":"),
    ("gate: empty command still calls jev", "jev-bash-gate.sh", '[ -z "$cmd" ] && exit 0', ":"),
    ("lib: timeout watchdog neutered", "jev-hook-lib.sh", 'sleep "${JEV_GATE_TIMEOUT:-3}"', "sleep 100"),
    ("lib: out-of-range scores accepted", "jev-hook-lib.sh", "x + 0 <= 1", "x + 0 <= 1000"),
    ("lib: non-numeric scores accepted", "jev-hook-lib.sh", "case \"$1\" in '' | *[!0-9.]* | *.*.*) return 1 ;; esac", "case \"$1\" in '') return 1 ;; esac"),
    ("screen: 0.7 threshold ignored", "jev-result-screen.sh", 'jev_ge "$p" 0.7 || exit 0', ":"),
    ("screen: threshold raised (never fires)", "jev-result-screen.sh", 'jev_ge "$p" 0.7 || exit 0', 'jev_ge "$p" 1.1 || exit 0'),
    ("screen: 32 KiB cap removed", "jev-result-screen.sh", "head -c 32768", "head -c 32768000"),
    ("screen: every tool screened", "jev-result-screen.sh", "  *) exit 0 ;;", "  *) : ;;"),
    ("screen: every Bash command screened", "jev-result-screen.sh", "((pr|issue)[[:space:]]+view|api[[:space:]].*comments)", "(.*)"),
    ("screen: jev error no longer fails open", "jev-result-screen.sh", "  --json || exit 0", "  --json || exit 2"),
    ("screen: unparseable score no longer fails open", "jev-result-screen.sh", 'jev_is_prob "$p" || exit 0', 'jev_is_prob "$p" || exit 2'),
    ("screen: missing jev no longer fails open", "jev-result-screen.sh", "jev_resolve || exit 0", "jev_resolve || exit 2"),
    ("screen: empty result still screened", "jev-result-screen.sh", '[ -z "${text//[[:space:]]/}" ] && exit 0', ":"),
    ("screen: advisory context dropped", "jev-result-screen.sh", "additionalContext:", "ignoredKey:"),
    ("pr-risk: security weight dropped", "pr-risk.sh", ":-0.40}", ":-0.00}"),
    ("pr-risk: tests weight dropped", "pr-risk.sh", ":-0.25}", ":-0.00}"),
    ("pr-risk: threshold ignored", "pr-risk.sh", "high = (r >= th)", "high = 0"),
    ("pr-risk: no rounding before compare", "pr-risk.sh", "r = int(r * 10000 + 0.5) / 10000", "r = r"),
    ("pr-risk: diff not truncated", "pr-risk.sh", 'head -c "$MAX_BYTES" "$PR_RISK_DIFF_FILE"', 'cat "$PR_RISK_DIFF_FILE"'),
    ("pr-risk: jev failure no longer fails open", "pr-risk.sh", 'echo "RISK unavailable (jev call failed)"; exit 3', 'echo "RISK 0.00 normal"; exit 0'),
    ("pr-risk: unparseable scores accepted", "pr-risk.sh", "case \"$v\" in '' | *[!0-9.]* | *.*.*) echo \"RISK unavailable (unparseable scores)\"; exit 3 ;; esac", ":"),
    ("pr-risk: empty diff still calls jev", "pr-risk.sh", 'if [ ! -s "$tmp/diff.txt" ]; then', 'if false; then'),
    ("screen: becomes blocking (decision field)", "jev-result-screen.sh", "{hookSpecificOutput:{hookEventName", '{decision:"block",hookSpecificOutput:{hookEventName'),
]


def run_suite(work: Path, test: str = "jev-hooks.test.sh") -> int:
    return subprocess.run(
        ["bash", str(work / test)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=300,
    ).returncode


def main() -> int:
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
        for i, (label, fname, anchor, repl) in enumerate(MUTATIONS):
            work = Path(td) / f"m{i}"
            shutil.copytree(base, work)
            src = (work / fname).read_text()
            n = src.count(anchor)
            if n != 1:
                aborts.append(label)
                print(f"ABORT  {label}: anchor occurs {n}x in {fname}, expected exactly 1")
                continue
            out = src.replace(anchor, repl, 1)
            if out == src:
                aborts.append(label)
                print(f"ABORT  {label}: substitution produced no change")
                continue
            (work / fname).write_text(out)
            rc = run_suite(work, "pr-risk.test.sh" if fname == "pr-risk.sh" else "jev-hooks.test.sh")
            if rc != 0:
                killed += 1
                print(f"RED    {label} (suite exit {rc})")
            else:
                survivors.append(label)
                print(f"GREEN  {label}  <-- SURVIVED, the guard is decoration")
    print(f"\n{killed}/{len(MUTATIONS)} mutations killed; survivors={len(survivors)} aborts={len(aborts)}")
    return 0 if not survivors and not aborts else 1


if __name__ == "__main__":
    sys.exit(main())
