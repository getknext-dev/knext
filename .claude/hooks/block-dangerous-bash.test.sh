#!/usr/bin/env bash
# Regression test for block-dangerous-bash.sh.
#
#   bash .claude/hooks/block-dangerous-bash.test.sh
#
# WHY IT EXISTS. Eight hooks in this directory enforce security policy and none
# of them had a test, so the only way to learn a rule had drifted was to have it
# fire — or fail to. That is the shape `security.md` warns about: a documented
# expectation degrades, and its efficacy is unobservable until it has already
# failed.
#
# BOTH HALVES, deliberately. The MUST-BLOCK list is the guard's reason to exist;
# the MUST-ALLOW list is what keeps it trusted. A guard that cries wolf gets
# worked around — the reader stops reading the message and starts reordering
# flags until it shuts up, which is strictly worse than a narrower guard.
# Every MUST-ALLOW case below was a real block hit during ordinary work.
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/block-dangerous-bash.sh"
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }

# Assembled from a variable so this file does not trip the very guard it tests.
D='-'
fails=0

run() {
  local label="$1" cmd="$2" want="$3" out rc got mark
  out=$(printf '%s' "{\"tool_input\":{\"command\":$(printf '%s' "$cmd" | jq -Rs .)}}" | bash "$HOOK" 2>&1)
  rc=$?
  got="allow"; [ "$rc" -eq 2 ] && got="BLOCK"
  mark="ok  "; [ "$got" != "$want" ] && { mark="FAIL"; fails=1; }
  printf '%s  %-46s want=%-5s got=%-5s\n' "$mark" "$label" "$want" "$got"
}

echo "== MUST BLOCK =="
run "rm -rf a dir"              "rm ${D}rf /some/dir"                                        BLOCK
run "rm -fr, flags reversed"    "rm ${D}fr /some/dir"                                        BLOCK
run "rm -rf after a separator"  "echo hi; rm ${D}rf /some/dir"                               BLOCK
run "sudo rm -rf"               "sudo rm ${D}rf /"                                           BLOCK
run "push ${D}${D}force"        "git push ${D}${D}force origin feature/x"                    BLOCK
run "push ${D}${D}mirror"       "git push ${D}${D}mirror origin"                             BLOCK
run "push to main"              "git push origin main"                                       BLOCK
run "push ${D}f short flag"     "git push ${D}f origin feature/x"                            BLOCK
run "filter-branch"             "git filter-branch ${D}${D}all"                              BLOCK
run "reset ${D}${D}hard"        "git reset ${D}${D}hard HEAD~1"                              BLOCK

echo
echo "== MUST ALLOW (each one was a real false positive) =="
# `\brm\b` matched inside `--rm` because `-` is a word boundary, and `--platform`
# satisfied the `-…f…r` alternative (p-l-a-t-F-o-R-m).
run "docker run ${D}${D}rm ${D}${D}platform" "docker run ${D}${D}rm ${D}${D}platform linux/arm64 img /p.sh" allow
run "docker run ${D}${D}rm"                  "docker run ${D}${D}rm img /p.sh"                              allow
# The force-push rule scanned the WHOLE command line, so a `-f` belonging to any
# other command in a compound line read as a force push.
run "push + pgrep ${D}f elsewhere"           "git push origin chore/x | tail ${D}1; pgrep ${D}f docker"     allow
run "push + grep ${D}f elsewhere"            "git push origin feature/x && grep ${D}f pat file"             allow
run "plain feature-branch push"              "git push origin chore/adr-0042"                               allow

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; fi
exit "$fails"
