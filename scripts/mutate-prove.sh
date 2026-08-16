#!/usr/bin/env bash
# Mutation-proof one clause safely: mutate a TRACKED file, run a command, restore.
#
# WHY THIS EXISTS. Restoring a mutation with `git checkout -- <file>` restores it
# to HEAD — so if the implementation under test is not COMMITTED, the restore
# silently DELETES it. That happened three times in a single session here: the
# tests went red after a "successful" proof run, and twice the wipe was noticed
# only because a later assertion failed. A memory note did not prevent the third
# occurrence, so the rule is mechanised instead of remembered.
#
# It refuses to start when:
#   * the tree is dirty          -> the restore would wipe uncommitted work;
#   * the anchor is not found    -> a silent no-op reported as "survived", the
#                                   exact trap workflow.md names for perl;
#   * the file is untracked      -> git checkout cannot restore it at all.
#
# And it verifies the restore afterwards rather than assuming it: a proof that
# leaves the inverse of the fix in the tree is worse than no proof.
#
# WHAT IT STILL CANNOT DO, stated so nobody reads more into a green run than is
# there: it checks that the FILE changed, not that the change was SEMANTIC. A
# mutation that only edits a comment changes the file, changes no behaviour, and
# is therefore reported as DECORATION — a false accusation against a guard that
# is fine. Choose an anchor that carries behaviour. (Measured, not theorised:
# appending text to a doc comment produced exactly that misreport here.)
#
# Usage:
#   scripts/mutate-prove.sh <file> <anchor> <replacement> <test-command...>
#
# Exit: 0 = the mutation made the command RED (the guard has teeth)
#       1 = the mutation left it GREEN (decoration) or setup failed
set -uo pipefail

die() { printf '\n[mutate-prove] ABORT: %s\n' "$*" >&2; exit 1; }

[ $# -ge 4 ] || die "usage: $0 <file> <anchor> <replacement> <test-command...>"
FILE=$1; ANCHOR=$2; REPLACEMENT=$3; shift 3

cd "$(git rev-parse --show-toplevel)" || die "not inside a git repository"

# 1. The tree must be clean — this is the check that would have saved three runs.
if [ -n "$(git status --porcelain -- "$FILE")" ]; then
  die "$FILE has uncommitted changes.
    Restoring the mutation runs 'git checkout -- $FILE', which restores to HEAD
    and would DELETE those changes. Commit the green implementation FIRST, then
    prove against the committed state."
fi
git ls-files --error-unmatch "$FILE" >/dev/null 2>&1 || die "$FILE is not tracked; git checkout could not restore it"

# 2. The anchor must occur EXACTLY once — never mutate on a guess.
#
# Counted in python, NOT with `grep -Fc`: grep matches line-by-line, so a
# MULTI-LINE anchor never matches and the harness reports "not found" for an
# anchor that is demonstrably present. That bug was in the first version of this
# script and cost a real proof run — a checker whose own failure mode looks like
# the failure it reports is worse than no checker.
COUNT=$(python3 - "$FILE" "$ANCHOR" <<'PY'
import sys
print(open(sys.argv[1]).read().count(sys.argv[2]))
PY
)
[ "$COUNT" = "1" ] || die "anchor occurs $COUNT times in $FILE (need exactly 1).
    A missed anchor yields a NO-OP that reports as 'the guard survived', which
    proves nothing."

restore() {
  git checkout -- "$FILE" || die "could not restore $FILE"
  git diff --quiet -- "$FILE" || die "$FILE still differs from HEAD after restore — MUTATION RESIDUE"
}
trap restore EXIT

# 3. Mutate, and prove the file actually changed.
python3 - "$FILE" "$ANCHOR" "$REPLACEMENT" <<'PY'
import sys
path, anchor, repl = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
assert s.count(anchor) == 1, "anchor count changed between check and write"
open(path, "w").write(s.replace(anchor, repl))
PY
git diff --quiet -- "$FILE" && die "the mutation did not change $FILE — nothing was proved"

# 4. The command MUST fail while the subject is removed.
printf '[mutate-prove] mutated %s; running the guard...\n' "$FILE"
if "$@" >/dev/null 2>&1; then
  printf '[mutate-prove] DECORATION: the guard stayed GREEN with its subject mutated.\n' >&2
  exit 1
fi
printf '[mutate-prove] ok — went RED as required.\n'
