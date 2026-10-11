#!/usr/bin/env python3
"""Mutation-prove jev-hooks.test.sh, guard by guard.

    python3 .claude/hooks/jev-hooks-mutation-proof.py           # every mutation (about 8 min locally)
    python3 .claude/hooks/jev-hooks-mutation-proof.py --smoke   # one representative per guard family (CI)

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
FILES = [(HERE, f) for f in ["jev-bash-gate.sh", "jev-result-screen.sh", "jev-hook-lib.sh", "jev-redact.py", "jev-hooks.test.sh"]] + [
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
    ("gate: payloads over 64 KiB are judged", "jev-bash-gate.sh", '[ "$(printf \'%s\' "$input" | wc -c)" -gt 65536 ] && exit 0', ":"),
    ("lib: watchdog leaves its sleep orphaned", "jev-hook-lib.sh", "trap 'kill \"$sp\" 2>/dev/null; exit 0' TERM", ":"),
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
    ("screen: empty result still screened", "jev-result-screen.sh", "grep -q '[^[:space:]]' \"$tmp/text.txt\" 2>/dev/null || exit 0", ":"),
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


# The credential skips. Two predicates on purpose: the GATE skips on a broad list (words +
# literal formats), the SCREEN only on literal formats (its text is attacker-written, so a
# word-based skip would let an injection evade by saying "token"). Remove each skip, swap the
# predicates, then remove each pattern ONE AT A TIME. A pattern the suite does not need is a
# pattern nobody noticed breaking.
MUTATIONS += [
    ("gate: credential skip removed", "jev-bash-gate.sh", 'jev_has_credential_signal "$cmd" && exit 0', ":"),
    ("screen: literal-secret skip removed", "jev-result-screen.sh", 'jev_has_literal_secret "$(cat "$tmp/text.txt")" && exit 0', ":"),
    (
        "screen: skips on the broad WORD list again (injection evades by saying 'token')",
        "jev-result-screen.sh",
        'jev_has_literal_secret "$(cat "$tmp/text.txt")" && exit 0',
        'jev_has_credential_signal "$(cat "$tmp/text.txt")" && exit 0',
    ),
    (
        "gate: broad list loses the literal formats",
        "jev-hook-lib.sh",
        '"$JEV_WORDS_RE|$JEV_LITERAL_RE"',
        '"$JEV_WORDS_RE"',
    ),
    (
        "gate: broad list loses the plain words",
        "jev-hook-lib.sh",
        '"$JEV_WORDS_RE|$JEV_LITERAL_RE"',
        '"$JEV_LITERAL_RE"',
    ),
    ("lib: gate match is case-sensitive", "jev-hook-lib.sh", 'grep -Eiq -- "$JEV_WORDS_RE|$JEV_LITERAL_RE"', 'grep -Eq -- "$JEV_WORDS_RE|$JEV_LITERAL_RE"'),
    ("lib: literal match is case-sensitive", "jev-hook-lib.sh", 'grep -Eiq -- "$JEV_LITERAL_RE"', 'grep -Eq -- "$JEV_LITERAL_RE"'),
    ("lib: gate check never matches", "jev-hook-lib.sh", 'printf \'%s\' "$1" | grep -Eiq -- "$JEV_WORDS_RE|$JEV_LITERAL_RE"', "false"),
    ("lib: literal check never matches", "jev-hook-lib.sh", 'printf \'%s\' "$1" | grep -Eiq -- "$JEV_LITERAL_RE"', "false"),
    ("lib: entropy run lengthened to 64", "jev-hook-lib.sh", "{32,}", "{64,}"),
    ("lib: entropy run shortened to 16", "jev-hook-lib.sh", "{32,}", "{16,}"),
    ("lib: sk- loses its word boundary", "jev-hook-lib.sh", "(^|[^a-z0-9])sk-[a-z0-9]", "sk-"),
    ("lib: auth/bearer header-with-value rule removed", "jev-hook-lib.sh", "|(authorization:[[:space:]]*|bearer[[:space:]]+)", "|(zzzz)"),
    ("lib: header value may be any word (no length/digit rule)", "jev-hook-lib.sh", "([A-Za-z0-9._~+/=-]{16,}|[A-Za-z._~+/=-]*[0-9][A-Za-z0-9._~+/=-]{7,})", "[A-Za-z]+"),
    ("lib: header 16+ char value alternative removed", "jev-hook-lib.sh", "([A-Za-z0-9._~+/=-]{16,}|", "("),
    ("lib: header short-value-with-digit alternative removed", "jev-hook-lib.sh", "|[A-Za-z._~+/=-]*[0-9][A-Za-z0-9._~+/=-]{7,})", ")"),
    ("lib: header optional scheme word removed", "jev-hook-lib.sh", "([A-Za-z]+[[:space:]]+)?", ""),
    (
        "gate: oversize command truncated to head only",
        "jev-bash-gate.sh",
        "printf '%s\\n[... %d chars elided ...]\\n%s' \"${cmd:0:4000}\" \"$((${#cmd} - 8000))\" \"${cmd: -4000}\"",
        "printf '%s' \"${cmd:0:8000}\"",
    ),
]
# The REDACTION layer (jev-redact.py) and its gate wiring: delete or neuter each rule and the
# suite must notice. Anchors name the exact statement, so a refactor that moves one aborts.
R = "jev-redact.py"
MUTATIONS += [
    (
        "gate: raw command sent instead of the skeleton",
        "jev-bash-gate.sh",
        'cmd=$(printf \'%s\' "$cmd" | python3 "$HERE/jev-redact.py" 2>/dev/null) || exit 0\ncase "$cmd" in *[![:space:]]*) ;; *) exit 0 ;; esac',
        "",
    ),
    (
        "gate: unbuildable skeleton no longer fails open",
        "jev-bash-gate.sh",
        '2>/dev/null) || exit 0\ncase "$cmd" in *[![:space:]]*) ;; *) exit 0 ;; esac',
        "2>/dev/null) || true",
    ),
    ("redact: entropy scrub of kept paths removed", R, 'if re.search(r"[0-9]", t) or (re.search(r"[a-z]", t) and re.search(r"[A-Z]", t)):', "if False:"),
    ("redact: URL userinfo kept", R, 're.sub(r"^([A-Za-z][A-Za-z0-9+.-]*://)[^/?#]*@"', 're.sub(r"^NOMATCH"'),
    ("redact: URL query values kept", R, 're.sub(r"([?&])([^=&#]*)=([^&#]*)"', 're.sub(r"NOMATCH([?&])([^=&#]*)=([^&#]*)"'),
    ("redact: URL fragment kept", R, 'out = re.sub(r"#.*$", "#" + PH, out)', "out = out"),
    ("redact: paths no longer kept after =", R, "if is_path(value):  # RULE path", "if False:  # RULE path"),
    ("redact: non-path values after = kept", R, "    return PH\n\n\ndef inner(word, depth):", "    return value\n\n\ndef inner(word, depth):"),
    ("redact: quoted strings kept", R, "    return PH\n\n\ndef redact_arg", "    return word.raw\n\n\ndef redact_arg"),
    ("redact: unrecognised words kept", R, "    return PH\n\n\ndef redact_command_word", "    return raw\n\n\ndef redact_command_word"),
    ("redact: bash -c inner replaced whole (intent lost)", R, "out.append(inner(w, depth))", "out.append(PH)"),
    ("redact: ssh/eval inner replaced whole (intent lost)", R, "        return inner(w, depth)", "        return PH"),
    ("redact: recursion no longer redacts the inner string", R, "return q + redact(text, depth + 1) + q", "return q + text + q"),
    ("redact: -c of a shell not recognised", R, 'if re.fullmatch(r"-[A-Za-z]*c", raw) and st.last_plain in SHELLS:', "if False:"),
    ("redact: ssh/eval recursion never triggers", R, '("ssh" in st.seen or "eval" in st.seen)', "False"),
    ("redact: $( ) contents kept", R, '    return "$(" + redact(raw[2:-1], depth + 1) + ")"', "    return raw"),
    ("redact: backtick contents kept", R, 'return "`" + redact(raw[1:-1], depth + 1) + "`"', "return raw"),
    ("redact: k=v values kept", R, 'return kv.group(1) + "=" + redact_value(kv.group(2))', "return raw"),
    ("redact: --flag=value kept", R, 'return name + "=" + redact_value(value)', "return raw"),
    ("redact: NAME=value assignment kept", R, "return a.group(1) + a.group(2) + redact_value(a.group(3))", "return raw"),
    ("redact: argument after a value flag kept", R, "return scrub_entropy(raw) if is_path(raw) else PH", "return raw"),
    ("redact: attached -pSECRET kept", R, 'return "-" + m.group(1) + PH', "return raw"),
    ("redact: short value flags never take a value", R, "st.pending_value = len(raw) == 2 and raw[1] not in BOOL_SHORT", "st.pending_value = False"),
    ("redact: every short flag takes a value (bool list ignored)", R, " and raw[1] not in BOOL_SHORT", ""),
    ("redact: long value flags never take a value", R, 'st.pending_value = not (name in BOOL_LONG or name.startswith("no-"))', "st.pending_value = False"),
    ("redact: bool long flags (--force) take a value", R, "name in BOOL_LONG or ", ""),
    ("redact: find primaries read as -p<V>", R, "if raw in KNOWN_DASH:", "if False:"),
    ("redact: comments kept", R, 'out.append("#" + PH)  # RULE comment', "out.append(s[i:(n if e < 0 else e)])"),
    ("redact: heredoc body kept", R, 'out.append((PH + "\\n" if i > body_start else "") + line', "out.append(s[body_start:i] + line"),
    ("redact: unterminated heredoc accepted", R, 'raise Unparseable("heredoc without terminator")', 'return "".join(out)'),
    ("redact: unterminated single quote accepted", R, 'raise Unparseable("unterminated \'")', "e = len(s)"),
    ("redact: unterminated double quote accepted", R, "raise Unparseable('unterminated \"')", "return n"),
    ("redact: unbalanced $( accepted", R, 'raise Unparseable("unbalanced $(")', "return n"),
    ("redact: redirect target kept", R, "            else:\n                out.append(PH)\n            continue", "            else:\n                out.append(w.raw)\n            continue"),
    ("redact: mixed-case generated tokens kept", R, "if len(raw) >= 12 and re.search", "if False and re.search"),
    # denylist additions (first line of defence)
    ("lib: URL userinfo (no password) not a signal", "jev-hook-lib.sh", "|://[^/@[:space:]]+@|", "|"),
    ("lib: URL user:password@ not a literal secret", "jev-hook-lib.sh", "|://[^/@[:space:]]+:[^/@[:space:]]+@", ""),
    ("lib: curl -u user:pass not a signal", "jev-hook-lib.sh", "|(^|[[:space:]])-u[[:space:]]*[^[:space:]]+:[^[:space:]]+", ""),
    ("lib: pass/pw/pwd words not a signal", "jev-hook-lib.sh", "|(^|[^a-z])(pass|pw|pwd)([^a-z]|$)", ""),
    ("lib: 'pass' dropped from pass|pw|pwd", "jev-hook-lib.sh", "(pass|pw|pwd)", "(pw|pwd)"),
    ("lib: 'pw' dropped from pass|pw|pwd", "jev-hook-lib.sh", "(pass|pw|pwd)", "(pass|pwd)"),
    ("lib: cookie not a signal", "jev-hook-lib.sh", "|cookie'", "'"),
    ("lib: Authorization: Basic <anything> not a literal secret", "jev-hook-lib.sh", "|authorization:[[:space:]]*basic[[:space:]]+[^[:space:]]+", ""),
]
# (label, anchor, replacement). Each alternative must be covered by its own case in the suite.
# `--password` is a subset of `password`, so only the bare word is removable on its own.
# The first group is the GATE's plain words; the second is the literal formats both lists share.
for _label, _anchor, _repl in [
    ("secret", "secret|", ""),
    ("token", "token|", ""),
    ("authorization:", "authorization:|", ""),
    ("bearer", "bearer |", ""),
    ("password", "|password|passwd", "|passwd"),
    ("passwd", "|passwd", ""),
    ("--from-literal", "--from-literal|", ""),
    ("api key", "api[_-]?key|", ""),
    ("private key", "|private[_-]?key", ""),
    ("PEM block", "-----BEGIN|", ""),
    ("ghp_", "ghp_|", ""),
    ("gho_", "gho_|", ""),
    ("github_pat_", "github_pat_|", ""),
    ("npm_", "npm_|", ""),
    ("xox[bp]-", "|xox[bp]-", ""),
    ("AKIA", "|AKIA", ""),
]:
    MUTATIONS.append((f"lib: credential pattern removed: {_label}", "jev-hook-lib.sh", _anchor, _repl))


def run_suite(work: Path, test: str = "jev-hooks.test.sh") -> int:
    return subprocess.run(
        ["bash", str(work / test)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=300,
    ).returncode


# CI cost: the suite takes ~2.5 min on a hosted Linux runner, so ~110 mutations would be an hour.
# CI therefore runs one mutation per guard FAMILY; the full sweep stays the local evidence tool.
SMOKE = [
    "block branch removed",
    "credential skip removed",
    "raw command sent",
    "unbuildable skeleton",
    "bash -c inner replaced",
    "attached -pSECRET",
    "skips on the broad WORD",
    "watchdog leaves its sleep",
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
    print(f"\n{killed}/{len(todo)} mutations killed{' (smoke subset of ' + str(len(MUTATIONS)) + ')' if smoke else ''}; survivors={len(survivors)} aborts={len(aborts)}")
    return 0 if not survivors and not aborts else 1


if __name__ == "__main__":
    sys.exit(main())
