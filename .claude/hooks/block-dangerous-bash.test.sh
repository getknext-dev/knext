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

# Four false negatives a code review found in a SAFETY CONTROL. Each one exited 0
# (allowed) on the shipped hook. A false negative here is far worse than the false
# positives the ALLOW block below records: those annoy, these let the forbidden
# operation through silently.
#
# 1. A backslash continuation is ONE command to the shell, but segment-splitting on
#    `\n` tore it in two, so the force flag landed in a segment with no `push` in it.
#    This is the shape the existing "multiline push --force" case does NOT cover:
#    there, --force is on the SAME line as the push.
run "push, continuation ${D}${D}force" "$(printf 'git push %s\n  %s%sforce origin main' '\' "$D" "$D")"  BLOCK
# 2. A leading `+` on a refspec force-updates the remote branch exactly like
#    --force, and carries no flag for the force rule to match. The FEATURE-branch
#    case is the one that isolates this rule: `+main` is caught by the main/master
#    rule too, so it cannot tell you whether the force rule works. Mutation proof
#    found exactly that — deleting the `+` clause left the suite green until this
#    case existed. Force-pushing ANY branch is forbidden, not just main.
run "refspec force origin +main"       "git push origin +main"                                          BLOCK
run "refspec force on a feature branch" "git push origin +feature/x"                                    BLOCK
# 3. A fully-qualified refspec still reaches main; the rule accepted only a space or
#    `:` before the branch name, so a `/` hid it.
run "push HEAD:refs/heads/main"        "git push origin HEAD:refs/heads/main"                           BLOCK
# 4. The rm flags do not have to share a token: `rm -r -f` is `rm -rf`.
run "rm ${D}r ${D}f split flags"       "rm ${D}r ${D}f /some/dir"                                       BLOCK

# Nine more false negatives, found by an adversarial code review of #717 — the PR that
# was itself fixing four of them. Every payload below was ALLOWED by the shipped hook.
# The worst were introduced BY the previous two fixes, which is why this block exists
# rather than a note in the header: this file is the only thing that has ever caught a
# regression here.
#
# 1-3. A trailing backslash disabled EVERY segment rule. BSD/macOS sed discards the
#      pattern space on `N` at EOF, so normalisation emitted the empty string. GNU sed
#      does not — the bypass was live on macOS and absent on Linux CI, so a test added
#      on CI would have gone green while the hook was open where it actually ran.
run "trailing ${D}${D}force + backslash EOF" "git push ${D}${D}force origin main \\"          BLOCK
run "trailing main + backslash EOF"          "git push origin main \\"                        BLOCK
run "trailing rm ${D}r ${D}f + backslash"    "rm ${D}r ${D}f /tmp/x \\"                        BLOCK
# 4-5. Quoting a branch is ordinary, not obfuscation; the rule required whitespace on
#      both sides of the name.
run "quoted branch name"                     "git push origin \"main\""                       BLOCK
run "single-quoted branch name"              "git push origin 'main'"                         BLOCK
# 6-7. -R is the POSIX/BSD synonym for -r; both patterns were lowercase-only.
run "rm ${D}Rf uppercase"                    "rm ${D}Rf /tmp/x"                               BLOCK
run "rm ${D}fR uppercase"                    "rm ${D}fR /tmp/x"                               BLOCK
# 8-9. The command-word class omitted / and \, so a path or escaped invocation slipped.
run "/bin/rm ${D}rf"                         "/bin/rm ${D}rf /tmp/x"                          BLOCK
run "backslash-escaped rm"                   "\\rm ${D}rf /tmp/x"                             BLOCK
# Rules that had NO case at all — deleting any of them left the whole suite green.
run "push ${D}${D}all"                       "git push ${D}${D}all origin"                    BLOCK
run "kubectl delete"                         "kubectl delete pod foo"                         BLOCK

# A SECOND review round found that the fix for the nine above had itself narrowed the
# control. Requiring each segment's COMMAND WORD to be `rm`/`git` read as precision and
# let every wrapper through; and the helper that identified it used a glob where `*` was
# a wildcard, so ONE `=` anywhere in a segment disabled BOTH rules. All fifteen below
# were blocked before that rewrite and allowed after it — a pure regression, invisible
# because every existing case was a bare invocation.
#
# They are here so the same trade cannot be made again quietly: a false positive costs
# an argument, a false negative costs the repository.
run "rm ${D}rf with = in a path"             "rm ${D}rf /tmp/a=b"                             BLOCK
run "rm ${D}rf with trailing comment"        "rm ${D}rf /tmp/x # k=v"                         BLOCK
run "push ${D}${D}force with push-option"    "git push ${D}${D}force origin main ${D}${D}push-option=x" BLOCK
run "push main with ${D}o x=y"               "git push origin main ${D}o x=y"                 BLOCK
run "git ${D}c a=b push ${D}${D}force main"  "git ${D}c a=b push ${D}${D}force origin main"   BLOCK
run "xargs rm ${D}rf"                        "echo /tmp/x | xargs rm ${D}rf /tmp/x"           BLOCK
run "find ${D}exec rm ${D}rf"                "find . ${D}name x ${D}exec rm ${D}rf {} \\;"    BLOCK
run "command substitution push"              "echo \$(git push ${D}${D}force origin main)"    BLOCK
run "bash ${D}c push ${D}${D}force main"     "bash ${D}c 'git push ${D}${D}force origin main'" BLOCK
run "subshell push to main"                  "( git push origin main )"                       BLOCK
run "brace group push ${D}${D}force"         "{ git push ${D}${D}force origin main; }"        BLOCK
run "if/then push to main"                   "if true; then git push origin main; fi"         BLOCK
run "for/do rm ${D}rf"                       "for x in 1; do rm ${D}rf /tmp/x; done"          BLOCK
run "negated push ${D}${D}force"             "! git push ${D}${D}force origin main"           BLOCK
run "sudo rm ${D}rf"                         "sudo rm ${D}rf /tmp/x"                          BLOCK
run "terraform destroy"                      "terraform destroy"                              BLOCK
run "kind delete cluster"                    "kind delete cluster ${D}${D}name x"             BLOCK

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
# `norm` flattens newlines to spaces, so splitting IT merged a command on one
# line with the command on the next. The segment split must use the original.
run "push + ${D}f on a PRECEDING line"       "$(printf 'pgrep %sf docker\ngit push origin chore/x' "$D")"    allow
run "push + ${D}f on a FOLLOWING line"       "$(printf 'git push origin chore/x\ngrep %sf pat file' "$D")"   allow
# ...and the real thing must still block when it spans lines.
run "multiline push ${D}${D}force"           "$(printf 'echo hi\ngit push %s%sforce origin x' "$D" "$D")"    BLOCK
# The widened rules must not start crying wolf. `rm -f` and `rm -r` alone are ordinary;
# only BOTH together are the destructive form. `maintenance` must not match `main`, and
# a branch path containing the word is not a push TO main.
run "rm ${D}f alone"                         "rm ${D}f /tmp/one-file"                                       allow
run "rm ${D}r alone"                         "rm ${D}r /tmp/one-dir"                                        allow
run "branch named maintenance"               "git push origin maintenance"                                  allow
run "branch path containing main"            "git push origin fix/main-menu-typo"                           allow
# Three false POSITIVES the same review found. The commit-message ones matter most:
# workflow.md records that a hook firing on MESSAGE TEXT is what led to a docs file
# being pushed straight to main, because the human re-ran only the tail of a blocked
# command. A guard that fires on ordinary work is how a real force push gets waved past.
run "rm ${D}${D}force on one file"           "rm ${D}${D}force /tmp/onefile.txt"                            allow
run "commit message quoting the words"       "git commit ${D}m 'do not push ${D}${D}force to main'"         allow
run "commit message mentioning rm ${D}rf"    "git commit ${D}m 'removed the rm ${D}rf call'"                allow

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; fi
exit "$fails"
