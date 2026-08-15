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

BLOCK_PAYLOADS=()
COLLECT=1
NL=$'\n'

run() {
  local label="$1" cmd="$2" want="$3" out rc got mark
  # Single-line must-block payloads only. The differential has NO oracle — it asserts
  # BLOCK unconditionally — so a payload that is itself a multi-line construct (a heredoc,
  # an open quoted block, a comment-continuation) can combine with a prefix into a shape
  # the shell does not execute, and then the assertion is wrong rather than the hook.
  # That has now bitten twice, both times costing a round to diagnose. Multi-line shapes
  # are covered by the oracle-gated cross product below, which asks a real shell first.
  case "$cmd" in *"$NL"*) ;; *)
    if [ "$want" = "BLOCK" ] && [ "$COLLECT" = 1 ]; then BLOCK_PAYLOADS+=("$cmd"); fi ;;
  esac
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

# A THIRD round. Both sign-off gates independently defeated the round-2 hook, and
# both landed on the same place: the `git commit` exemption. It was justified in the
# comments as "git commit cannot delete or push, so the exemption costs no coverage."
# That is measured false — a commit segment runs anything through command
# substitution, which is the exact wrapper class the command-word helper had just been
# deleted for, handed back for one command word. All three were ALLOWED.
run "commit -m with \$( ) push"              "git commit ${D}m \"\$(git push ${D}${D}force origin main)\"" BLOCK
run "commit -m with \$( ) rm ${D}rf"         "git commit ${D}m \"\$(rm ${D}rf /tmp/x)\""      BLOCK
run "commit -m with backtick push"           "git commit ${D}m \"\`git push ${D}${D}force origin main\`\"" BLOCK
run "commit -m with process substitution"    "git commit ${D}m x < <(git push origin main)"   BLOCK
# Round 2 fixed quotes-as-delimiters on the BRANCH rule and backslash-as-delimiter on
# the rm COMMAND WORD, and left the opposite side of each open. Both were ALLOWED.
# This is the "guards must assert both halves" class, in its asymmetric form: the fix
# was correct and applied to exactly one of the two places that needed it.
run "push origin backslash-main"             "git push origin \\main"                         BLOCK
run "rm with double-quoted flags"            "rm \"${D}rf\" /tmp/x"                           BLOCK
run "rm with single-quoted flags"            "rm '${D}rf' /tmp/x"                             BLOCK
run "quoted rm command word"                 "\"rm\" ${D}rf /tmp/x"                           BLOCK
# git_subcommand decides whether the ONE exemption applies, so a mis-parse there is a
# bypass rather than a cosmetic error. Its arg-skip list covered ${D}C/${D}c/git-dir/
# work-tree and nothing else, so a global flag taking a SEPARATE argument let that
# argument read as the subcommand: `commit` below is the VALUE of ${D}${D}namespace and
# the real subcommand is push. Both were ALLOWED — a genuine force push to main.
run "git ${D}${D}namespace commit push"      "git ${D}${D}namespace commit push ${D}${D}force origin main"  BLOCK
run "git ${D}${D}exec-path commit push"      "git ${D}${D}exec-path commit push ${D}${D}force origin main"  BLOCK
# Fail closed on a flag the table does not know: the subcommand is undetermined, and an
# undetermined subcommand must not earn the exemption. A new upstream git global flag
# therefore costs a false positive on message text — never a bypass.
run "unknown git global flag"                "git ${D}${D}not-a-real-flag commit ${D}m 'push ${D}${D}force to main'" BLOCK
# Spec review found these two rules had NO isolating case — deleting either left the
# suite green, which is decoration by this repo's standard.
run "oci ce cluster delete"                  "oci ce cluster delete ${D}${D}cluster-id x"     BLOCK
run "oci ce node-pool delete"                "oci ce node-pool delete ${D}${D}node-pool-id x" BLOCK
run "push ${D}${D}force-with-lease"          "git push ${D}${D}force-with-lease origin feature/x" BLOCK

# ROUND 5. Both sign-off gates BLOCKed round 3 and converged on the exemption again,
# from two new directions. git_subcommand scanned for a `git` token ANYWHERE in the
# segment, so everything to its left was invisible and two literal words on the END
# disabled all five rule families. Every one of these was ALLOWED.
run "rm ${D}rf then '# git commit'"          "rm ${D}rf /tmp/x # git commit"                  BLOCK
run "kubectl delete then '# git commit'"     "kubectl delete pod foo # git commit"            BLOCK
run "terraform destroy '# git commit'"       "terraform destroy # git commit"                 BLOCK
run "rm ${D}rf trailing git commit words"    "rm ${D}rf /tmp/x git commit"                    BLOCK
# An env-var prefix reached the exemption the same way — and this one EXECUTES: git runs
# GIT_EDITOR through sh -c, confirmed in a scratch repo by the architect gate.
run "GIT_EDITOR= push prefix"                "GIT_EDITOR='git push ${D}${D}force origin main' git commit" BLOCK
run "GIT_EDITOR= cluster-delete prefix"      "GIT_EDITOR='kubectl delete ns prod' git commit" BLOCK
run "GIT_SEQUENCE_EDITOR= rm prefix"         "GIT_SEQUENCE_EDITOR='rm ${D}rf /tmp/x' git commit" BLOCK
# bash 5.3 value substitution executes and contains neither \$( nor a backtick.
run "\${ cmd; } value substitution"          "git commit ${D}m \"\${ git push ${D}${D}force origin main; }\"" BLOCK
run "\${| cmd; } value substitution"         "git commit ${D}m \"\${| rm ${D}rf /tmp/x; }\"" BLOCK
# Quoting is a delimiter INSIDE a token too — these are the same words to the shell as
# their bare forms. Round 3 argued exactly this and then applied it only at token edges.
run "push origin ma\"in\""                   "git push origin ma\"in\""                       BLOCK
run "push origin \"ma\"in"                   "git push origin \"ma\"in"                       BLOCK
run "push origin ma\\in"                     "git push origin ma\\in"                         BLOCK
run "rm ${D}r\"f\" split by quote"           "rm ${D}r\"f\" /tmp/x"                           BLOCK
run "rm ${D}\"rf\" quoted flags"             "rm ${D}\"rf\" /tmp/x"                           BLOCK
run "r\"m\" ${D}rf quoted command word"      "r\"m\" ${D}rf /tmp/x"                           BLOCK
run "git p\"us\"h ${D}${D}force"             "git p\"us\"h ${D}${D}force origin feature/x"    BLOCK
run "push ${D}${D}for\"ce\""                 "git push ${D}${D}for\"ce\" origin feature/x"    BLOCK
# A backtick opens a command exactly as \$( does, and the rm rule died inside one while
# its \$( ) twin blocked. The file contradicted itself: is_literal_commit already
# treated a backtick as substitution-significant.
run "rm ${D}rf inside backticks"             "echo \`rm ${D}rf /tmp/x\`"                      BLOCK
run "assignment from backtick rm"            "x=\`rm ${D}rf /tmp/x\`"                         BLOCK
# Five clauses the spec review proved were DECORATION: deleting each left the suite
# ALL PASS while a real payload flipped BLOCK -> allow. Three of them name operations
# `security.md` lists verbatim. Round 4's "all 22 mutation-proved red" was true per RULE
# and false per CLAUSE — the same masking shape as the unparseable-payload clause, which
# is why granularity matters when claiming a mutation proof.
run "rm ${D}${D}recursive ${D}${D}force"     "rm ${D}${D}recursive ${D}${D}force /tmp/x"      BLOCK
run "rm ${D}${D}dir ${D}${D}force"           "rm ${D}${D}dir ${D}${D}force /tmp/x"            BLOCK
run "rm ${D}R ${D}${D}force"                 "rm ${D}R ${D}${D}force /tmp/x"                  BLOCK
run "git filter-repo"                        "git filter-repo ${D}${D}path x"                 BLOCK
# CRLF is the SAME continuation-bypass family as #712/#717 and §2.2: with the \\r strip
# removed, `\\` is followed by CR rather than LF, nothing joins, and the force flag lands
# in a segment with no push in it. The hook's own comment called the strip load-bearing
# and nothing asserted it.
run "CRLF continuation ${D}${D}force"        "$(printf 'git push \\\r\n  %s%sforce origin main' "$D" "$D")" BLOCK

# ROUND 7. The multi-line-message fix of round 5 introduced the only FAIL-OPEN path the
# hook has had: it counted PARITY of one quote character and ignored the other's
# context, so an apostrophe inside a double-quoted message opened the tracking and every
# following segment was skipped. The shell disagrees — "don't" is closed, so these are
# real commands. Data-dependent (two apostrophes -> even -> blocked), no obfuscation
# needed, and this repo's own messages contain apostrophes.
#
# These also assert the direction nothing else covers: that the tracking FAILS TO
# ENGAGE. Every other message case asserts it engages, so a mutation forcing it always
# on would have stayed green.
run "apostrophe in dq msg, then push"        "git commit ${D}m \"don't\" && git push ${D}${D}force origin main" BLOCK
run "apostrophe in dq msg, then rm"          "git commit ${D}m \"it's fine\" ; rm ${D}rf /tmp/x"                BLOCK
run "apostrophe in dq msg, then delete"      "git commit ${D}m \"won't\" && kubectl delete ns default"          BLOCK
run "dq inside sq msg, then push"            "git commit ${D}m 'say \"hi' && git push ${D}${D}force origin main" BLOCK
run "escaped dq inside dq msg, then push"    "git commit ${D}m \"a \\\"b\" && git push ${D}${D}force origin main" BLOCK
# Multi-word rules must separate on WHITESPACE, not a literal space. Each of these was
# ALLOWED while its single-space form blocked — the branch rule got the shared-class fix
# and the teardown rule did not.
run "terraform<TAB>destroy"                  "$(printf 'terraform\tdestroy')"                 BLOCK
run "kind  delete cluster (2 spaces)"        "kind  delete cluster ${D}${D}name x"            BLOCK
run "oci ce cluster  delete (2 spaces)"      "oci ce cluster  delete ${D}${D}cluster-id x"    BLOCK
# ${ws} between EVERY word, not just the last gap. Architect sign-off BLOCKed on exactly
# this: the round-9 fix worked, but reverting it to the round-7 form left the suite
# ALL PASS, because the rows above only vary the LAST separator. A working, untested fix
# lets the next round re-half-apply it identically and stay green — which is how this
# same shape has now recurred three times in this file.
run "oci  ce cluster delete (inner gap)"     "oci  ce cluster delete ${D}${D}cluster-id x"    BLOCK
run "oci ce<TAB>cluster delete"              "$(printf 'oci ce\tcluster delete %s%scluster-id x' "$D" "$D")" BLOCK
run "oci  ce  node-pool  delete"             "oci  ce  node-pool  delete ${D}${D}node-pool-id x" BLOCK

# ROUND 10. A REGRESSION AGAINST MAIN, needing no obfuscation and no unbalanced quote:
# a backslash is not a continuation inside a comment, so the shell ends the comment at
# the newline and runs line 2 — but `joined` resolves continuations BEFORE splitting, so
# line 2 was folded into the comment, the whole thing became one segment whose first
# word was `git commit`, and all five rule families were skipped.
run "comment + backslash, then force push"   "$(printf 'git commit %sm "subject" # note\\\ngit push %s%sforce origin main' "$D" "$D" "$D")" BLOCK
run "comment + backslash, then push main"    "$(printf 'git commit %sm "subject" # note\\\ngit push origin main' "$D")"                      BLOCK
run "comment + backslash, then rm ${D}rf"    "$(printf 'git commit %sm "subject" # note\\\nrm %srf /tmp/x' "$D" "$D")"                       BLOCK
run "comment + backslash, then delete"       "$(printf 'git commit %sm "subject" # note\\\nkubectl delete ns prod' "$D")"                    BLOCK
run "comment + backslash, then filter-branch" "$(printf 'git commit %sm "subject" # note\\\ngit filter-branch %s%sall' "$D" "$D" "$D")"      BLOCK
# `has_comment` refuses the exemption for a comment-bearing segment, which made
# quote_state's own `#` handling look like decoration — mutation-proving showed it green.
# It is NOT dead: has_comment only guards the segment that ENTERS the exemption, while
# quote_state also runs on CONTINUATION segments, where a multi-line message CLOSES
# mid-segment and a comment follows it. Without the `#` break the trailing apostrophe
# below reopens the state and the third line is skipped. Deleting a clause because no
# test reaches it, when the reachable path simply had no case, would have been the wrong
# correction — so this asserts the path instead.
run "msg closes, then comment, then push"    "$(printf "git commit %sm 'line1\nline2' # note '\ngit push %s%sforce origin main" "$D" "$D" "$D")" BLOCK

# ROUND 11, and the same class one door over. Bash starts a comment after ANY word
# terminator, not only whitespace — round 10's word-start test was `i==1 || prev is
# space`. `;`, `|` and `&` already land at i==1 because split_segments cut there, so `)`
# is the live one, and it reopened ALL EIGHT gated verbs as a regression against main:
#
#     (cd packages/lib && git commit -m "chore: bump")#TODO rebase\
#     <any gated verb>                                     -> ALLOWED  (main: BLOCK)
#
# The terminator must be ADJACENT to the `#` — a reviewer's first cross product missed
# this because its join strings carried a leading space, which is exactly the point.
run "subshell close then comment, push main" "$(printf '(cd p && git commit %sm "chore: bump")#TODO rebase\\\ngit push origin main' "$D")"                    BLOCK
run "subshell close then comment, force"     "$(printf '(cd p && git commit %sm "chore: bump")#TODO rebase\\\ngit push %s%sforce origin x' "$D" "$D" "$D")"   BLOCK
run "subshell close then comment, rm ${D}rf" "$(printf '( true; git commit %sm "a")#c\\\nrm %srf /tmp/x' "$D" "$D")"                                          BLOCK
run "subshell close then comment, delete"    "$(printf '( true; git commit %sm "a")#c\\\nkubectl delete ns prod' "$D")"                                       BLOCK
run "subshell close then comment, teardown"  "$(printf '( true; git commit %sm "a")#c\\\nterraform destroy' "$D")"                                            BLOCK
run "subshell close then comment, reset"     "$(printf '( true; git commit %sm "a")#c\\\ngit reset %s%shard HEAD~5' "$D" "$D" "$D")"                          BLOCK

# ROUND 12. A segment inside DATA could establish the exemption. `in_msg` only ever
# updated on segments it had already exempted, so a line that merely LOOKS like an
# unterminated `git commit -m "…` switched off every rule for the rest of the command —
# even where the shell treats that line as inert. Not a comment bug: the same
# stage-ordering defect one layer up. All shell-verified as executing; main blocks them.
run "heredoc body, then force push"          "$(printf 'cat <<EOF\ngit commit %sm "fix\nEOF\ngit push %s%sforce origin main' "$D" "$D" "$D")"  BLOCK
run "quoted heredoc body, then push main"    "$(printf "cat <<'EOF'\ngit commit %sm \"fix\nEOF\ngit push origin main" "$D")"                    BLOCK
run "heredoc body, then rm ${D}rf"           "$(printf 'cat <<EOF\ngit commit %sm "fix\nEOF\nrm %srf /tmp/x' "$D" "$D")"                        BLOCK
run "heredoc body, then cluster delete"      "$(printf 'cat <<EOF\ngit commit %sm "fix\nEOF\nkubectl delete ns prod' "$D")"                     BLOCK
run "heredoc body, then teardown"            "$(printf 'cat <<EOF\ngit commit %sm "fix\nEOF\nterraform destroy' "$D")"                          BLOCK
run "heredoc <<- dash form"                  "$(printf 'cat <<-EOF\n\tgit commit %sm "fix\n\tEOF\ngit push origin main' "$D")"                  BLOCK
# Same class without a heredoc: an open single-quoted block is data too.
run "quoted data block, then force push"     "$(printf "echo 'note:\ngit commit %sm \"fix\n'\ngit push %s%sforce origin main" "$D" "$D" "$D")"  BLOCK
# Two clauses the in-repo mutation harness reported GREEN on its first run. They were
# not decoration — both are load-bearing, and both shapes were live fail-opens before
# round 13 (verified against that commit). They simply had no case reaching them, which
# is the distinction between "delete it" and "test it": deleting either reopens a hole.
#
#   1. An opener the delimiter parser cannot read must keep us INSIDE data. `<<$'EOF'`
#      parses as nothing, so without the fail-closed counter the tracker never engages
#      and the body grants the exemption.
#   2. Stacked heredocs need a delimiter QUEUE. With a single slot, the first terminator
#      ends heredoc mode early and the SECOND body is read as commands.
run "unparseable heredoc opener"             "$(printf 'cat <<$%sEOF%s\ngit commit %sm "fix\nEOF\ngit push %s%sforce origin main' "'" "'" "$D" "$D" "$D")" BLOCK
run "stacked heredocs need a queue"          "$(printf 'cat <<A <<EOF\nx\nA\ngit commit %sm "fix\nEOF\ngit push %s%sforce origin main' "$D" "$D" "$D")"    BLOCK

# The architect gate reached the same class from the other side: the segment that CLOSES
# a carried message was `continue`d, discarding its tail unscanned. Its payload uses a
# multi-line message — this repo's own commit convention — so it needed no obfuscation
# at all. `msg_tail` vets the tail; these pin the exact shapes it measured.
run "multi-line msg, comment tail, force"    "$(printf 'git commit %sm "subject\nbody" # note\\\ngit push %s%sforce origin main' "$D" "$D" "$D")" BLOCK
run "multi-line msg, comment tail, main"     "$(printf 'git commit %sm "subject\nbody" # note\\\ngit push origin main' "$D")"                     BLOCK
run "multi-line msg, comment tail, rm"       "$(printf 'git commit %sm "subject\nbody" # note\\\nrm %srf /tmp/x' "$D" "$D")"                       BLOCK
run "multi-line msg, comment tail, delete"   "$(printf 'git commit %sm "subject\nbody" # note\\\nkubectl delete ns prod' "$D")"                    BLOCK
run "multi-line msg, comment tail, reset"    "$(printf 'git commit %sm "subject\nbody" # note\\\ngit reset %s%shard HEAD~5' "$D" "$D" "$D")"       BLOCK
run "multi-line msg, comment tail, teardown" "$(printf 'git commit %sm "subject\nbody" # note\\\nterraform destroy' "$D")"                         BLOCK
# The same discarded tail carrying a substitution rather than a comment.
run "multi-line msg, substitution tail"      "$(printf 'git commit %sm "subject\nbody" \$(git push %s%sforce origin main)' "$D" "$D" "$D")"        BLOCK
run "multi-line msg, process-sub tail"       "$(printf 'git commit %sm "subject\nbody" < <(git push origin main)' "$D")"                           BLOCK

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
# The message-text exemption used to cover only the rm and push rules. The last three
# rules matched the whole flattened command with no exemption at all, so writing a
# commit message ABOUT them was blocked — the same cry-wolf case, displaced rather
# than removed. workflow.md records where that leads: the human re-ran the tail of a
# blocked command and put a docs file on main.
run "commit msg naming kubectl delete"       "git commit ${D}m 'docs: why kubectl delete is gated'"         allow
run "commit msg naming terraform destroy"    "git commit ${D}m 'note that terraform destroy is gated'"      allow
run "commit msg naming reset ${D}${D}hard"   "git commit ${D}m 'explain why reset ${D}${D}hard is gated'"   allow
# Parameter expansion stays exempt: it substitutes TEXT into the message, it cannot
# execute anything. Only command/process substitution disqualifies the exemption.
run "commit msg with \${var} expansion"      "git commit ${D}m \"\${MSG} about push ${D}${D}force to main\"" allow
# The flag tables must not cost the exemption for ORDINARY global flags. These are the
# other half of the fail-closed change above: tightening git_subcommand is only correct
# if it still resolves the flags people actually use.
run "git ${D}c k=v commit (arg-taking)"      "git ${D}c user.name=x commit ${D}m 'push ${D}${D}force to main'" allow
run "git ${D}C dir commit (arg-taking)"      "git ${D}C /repo commit ${D}m 'the rm ${D}rf call'"             allow
run "git ${D}${D}no-pager commit (no-arg)"   "git ${D}${D}no-pager commit ${D}m 'push to main'"              allow
run "git ${D}${D}git-dir=x commit (=form)"   "git ${D}${D}git-dir=/r/.git commit ${D}m 'push to main'"        allow
# One case per arg-taking flag that the fail-closed default would otherwise mask.
# Mutation-proving caught this: shrinking the arg-taking table left the suite GREEN,
# because a removed flag falls through to "unknown" and still BLOCKS — so the
# must-block half cannot see the table at all. Its entire job is preventing a false
# positive, which only a must-ALLOW case can prove. Same both-halves lesson, arrived at
# from the opposite side.
run "git ${D}${D}namespace ns commit"        "git ${D}${D}namespace ns commit ${D}m 'push ${D}${D}force to main'"    allow
run "git ${D}${D}exec-path p commit"         "git ${D}${D}exec-path /usr/lib/git-core commit ${D}m 'push to main'"   allow
run "git ${D}${D}super-prefix p commit"      "git ${D}${D}super-prefix sub/ commit ${D}m 'push to main'"             allow
run "git ${D}${D}config-env k=V commit"      "git ${D}${D}config-env user.name=V commit ${D}m 'the rm ${D}rf call'"  allow
# A commit MESSAGE routinely contains the characters split_segments cuts on — this
# repo's own messages are multi-line and discuss these very verbs — so without carrying
# an unterminated quote across segments, a message BODY line reads as a fresh command.
# The architect gate flagged this as cry-wolf that would fire immediately. The shell
# agrees with the tracking rather than the splitting: while a quote is open, what
# follows is message content.
run "multi-line commit message"              "$(printf "git commit %sm 'subject line\n\nbody: why kubectl delete is gated'" "$D")" allow
run "commit message containing a semicolon"  "git commit ${D}m 'fix the thing; also note terraform destroy'"        allow
run "multi-line msg with push ${D}${D}force" "$(printf "git commit %sm 'subject\n\nnever push %s%sforce to main'" "$D" "$D" "$D")"  allow
# ...and the tracking must not swallow a REAL command after the message closes.
run "commit then real force push"            "git commit ${D}m 'subject line' && git push ${D}${D}force origin main" BLOCK
# has_subst is whole-command for ONLY the markers that cannot survive splitting. Testing
# every marker whole-command was over-broad in a way that lands on plausible work: a
# substitution in a DIFFERENT command blocked the commit. Cry-wolf is the mechanism
# workflow.md blames for the direct-push-to-main incident, so the granularity is not
# cosmetic.
run "substitution in a preceding command"    "V=\$(cat v) && git commit ${D}m 'docs: why kubectl delete is gated'" allow
run "apostrophe msg, no following command"   "git commit ${D}m \"don't ever push ${D}${D}force to main\""          allow
# `has_comment` is quote-aware, and this is the half that proves it. A `#` inside the
# message is not a comment, so the exemption must survive — refusing it here would block
# an ordinary commit and is exactly the cry-wolf the exemption exists to prevent.
run "hash inside a dq message"               "git commit ${D}m \"fix # 3 — never push to main\""                   allow
run "hash inside a sq message"               "git commit ${D}m 'closes #42, mentions rm ${D}rf'"                    allow
run "hash mid-token is not a comment"        "git commit ${D}m 'ref abc#def about main'"                            allow
# Widening the word-terminator class must not start refusing the exemption for ordinary
# messages. A `(` inside a quoted message is not a word terminator in shell terms, and
# conventional-commit scopes put one in almost every message this repo writes.
run "conventional-commit scope in message"   "git commit ${D}m \"fix(hooks): never push ${D}${D}force to main\""    allow
run "parens and hash inside a message"       "git commit ${D}m 'fix(scope): closes #42, no rm ${D}rf'"              allow

echo
echo "== DIFFERENTIAL PROPERTY: nothing a commit message contains may disarm a rule =="
# GENERATED, not enumerated — and that distinction is the whole point.
#
# Round 5's `in_msg` regression got past 112 hand-written cases, a full mutation proof,
# a CI job and four review gates. The suite ALREADY contained
# `git commit -m 'subject' && git push --force origin main` — balanced quotes, passed —
# while the apostrophe variant opened silently, because no row happened to carry one.
# `workflow.md` names this exactly: "Prefer scanning to enumerating. An enumerated list
# of call sites is how the second one gets missed; make an unparseable construct FAIL
# rather than pass." Another hand-written row is the wrong instrument; the seventh round
# of them would not have been better.
#
# So: take EVERY must-block payload above and re-run it behind a literal commit message
# carrying an unbalanced quote. The message is inert text — it cannot change what the
# following command does — so every one of them must still block. This one loop covers
# the entire class, including variants nobody thought to write down, and it goes red on
# the exact commit that introduced the regression.
# Each prefix is a BALANCED commit message that merely CONTAINS the other quote
# character — that is the whole trick, and getting it wrong is instructive: a first
# attempt used `git commit -m "don"t"`, which genuinely leaves a quote open, so the shell
# would not have executed the payload either and the hook was right to skip it. A
# property assertion has to be a claim the shell actually agrees with.
COLLECT=0
PROPS=("${BLOCK_PAYLOADS[@]}")
props_failed=0
#
# The MESSAGE SHAPE is generated too, not just the payload. Round 8 generated over
# payloads and left three hand-written prefixes, all quote-based and all `&&`-joined —
# and the very next defect lived on the un-generated axis: `#` starts a comment, so an
# apostrophe in a trailing comment opened the state and skipped everything after it.
# Adding two prefixes disarmed 178 of 182 generated cases. Generating one axis and
# enumerating the other just relocates the blind spot, so both vary here: quoting style
# AND joining construct (`&&`, `;`, newline, comment-then-newline).
prefixes=(
  "git commit ${D}m \"don't\" &&"
  "git commit ${D}m 'say \"hi\"' &&"
  "git commit ${D}m \"a \\\"b\\\"\" &&"
  "git commit ${D}m \"don't\" ;"
  "git commit ${D}m \$'it\\'s' &&"
  # $'\n' concatenation, NOT $(printf …\n): command substitution strips trailing
  # newlines, which silently turned these into single-line payloads where the comment
  # swallowed the whole command — the shell would not have run them either, so the
  # assertion was wrong rather than the hook. Second time a property assertion had to be
  # checked against what the shell actually does before trusting its failures.
  "git commit ${D}m \"fix\" # don't forget to rebase"$'\n'
  "git commit ${D}m \"subject\" # note: rm ${D}rf is gated"$'\n'
  "git commit ${D}m \"don't\""$'\n'
  # The join axis, which the previous eight prefixes left as hand-picked combos rather
  # than a real cross product — and the next defect sat in a missing combo. A backslash
  # is NOT a continuation inside a comment, so the shell runs the next line, but the
  # hook's join-before-split folded it into the comment and exempted everything.
  "git commit ${D}m \"subject\" # note\\"$'\n'
  "git commit ${D}m 'subject' # don't\\"$'\n'
)
for prefix in "${prefixes[@]}"; do
  for p in "${PROPS[@]}"; do
    printf '%s' "{\"tool_input\":{\"command\":$(printf '%s %s' "$prefix" "$p" | jq -Rs .)}}" |
      bash "$HOOK" >/dev/null 2>&1
    [ $? -eq 2 ] || { props_failed=$((props_failed + 1)); fails=1
                      printf 'FAIL  disarmed by [%.28s]: %.44s\n' "$prefix" "$p"; }
  done
done
printf '%s  %-46s %s payloads x %s messages\n' \
  "$([ "$props_failed" -eq 0 ] && echo 'ok  ' || echo 'FAIL')" \
  "differential: quotes in a commit message" "${#PROPS[@]}" "${#prefixes[@]}"

echo
echo "== ORACLE-GATED CROSS PRODUCT (the shell decides which shapes must block) =="
# The differential above still hand-picks its (quoting, join) pairs, and rounds 10 and 11
# both landed in a pair nobody picked. This is the cross product, with the missing
# dimension made explicit: the WORD TERMINATOR immediately before the join. `)#` was
# round 11's bug, and a reviewer's own first cross product missed it because every join
# string carried a leading space — adjacency is the whole point.
#
# The oracle is what makes a product usable. Two earlier property attempts produced false
# failures because they asserted on shapes the shell does not actually execute (an
# unterminated quote, a comment swallowing its own line). So: ask a real shell, and assert
# only where line 2 genuinely ran.
#
# SAFE BY CONSTRUCTION, and this is the reason it can exist at all. The shell is only ever
# handed an INERT payload — `printf`. The gated verbs are fed to the HOOK and never to
# bash, so nothing here can execute a destructive command. A naive oracle that ran the
# suite's real payloads would delete things; that hazard is why this is scoped this way
# rather than by being careful.
ORACLE_DIR=$(mktemp -d)
printf '#!/bin/sh\nexit 0\n' > "$ORACLE_DIR/git"
chmod +x "$ORACLE_DIR/git"

oracle_prefixes=(
  "git commit ${D}m \"m\""
  "git commit ${D}m \"m\" "
  "$(printf 'git commit %sm "m"\t' "$D")"
  "(cd . && git commit ${D}m \"m\")"
  "{ git commit ${D}m \"m\"; }"
  "git commit ${D}m 'm'"
  "git commit ${D}m \$'m'"
  # MULTI-SEGMENT prefixes. Every prefix above is one segment, so the CONTINUATION path
  # — a message that closes on a later segment — was unexercised, and the reviewer
  # demonstrated the gap precisely: reverting `quote_state` alone left the whole suite
  # ALL PASS while this shape flipped BLOCK to allow.
  "git commit ${D}m 'l1"$'\n'"l2'"
  "( git commit ${D}m \"l1"$'\n'"l2\" )"
  "( git commit ${D}m \"l1"$'\n'"l2\" )#don't"
  # DATA CONTEXT. A heredoc body and an open quoted block are inert to the shell, and a
  # segment inside them must not be able to establish the exemption. Note the oracle
  # sorts these out by itself: joins that break the heredoc delimiter simply do not
  # execute, so they are skipped rather than wrongly asserted.
  "cat <<EOF"$'\n'"git commit ${D}m \"fix"$'\n'"EOF"
  "cat <<'EOF'"$'\n'"git commit ${D}m \"fix"$'\n'"EOF"
  "echo 'note:"$'\n'"git commit ${D}m \"fix"$'\n'"'"
  # CARRIED-QUOTE prefixes — a shape where `in_msg` is ALREADY OPEN when the join lands.
  # The architect gate diagnosed the absence of exactly this as the reason 282 oracle
  # assertions went green over a live hole: liveness was being decided only for shapes
  # that start from a clean state.
  "git commit ${D}m \"subject"$'\n'"body\" # note"
  "git commit ${D}m \"subject"$'\n'"body\""
  "git commit ${D}m 'subject"$'\n'"body' #c"
)
oracle_joins=( " && " " ; " " | " " & " $'\n' "#c"$'\n' "#c\\"$'\n' "#don't\\"$'\n' "\\"$'\n' )
oracle_gated=(
  "git push ${D}${D}force origin main"
  "git push origin main"
  "rm ${D}rf /tmp/oracle-never-run"
  "kubectl delete ns prod"
  "terraform destroy"
  "git reset ${D}${D}hard HEAD~5"
)

oracle_shapes=0; oracle_live=0; oracle_asserted=0; oracle_failed=0
for pfx in "${oracle_prefixes[@]}"; do
  for jn in "${oracle_joins[@]}"; do
    oracle_shapes=$((oracle_shapes + 1))
    got=$(cd "$ORACLE_DIR" && PATH="$ORACLE_DIR:/usr/bin:/bin" bash -c "${pfx}${jn}printf ORACLE_EXEC" 2>/dev/null)
    case "$got" in *ORACLE_EXEC*) ;; *) continue ;; esac   # shell does not run it: allowing is correct
    oracle_live=$((oracle_live + 1))
    for g in "${oracle_gated[@]}"; do
      oracle_asserted=$((oracle_asserted + 1))
      printf '%s' "{\"tool_input\":{\"command\":$(printf '%s%s%s' "$pfx" "$jn" "$g" | jq -Rs .)}}" |
        bash "$HOOK" >/dev/null 2>&1
      [ $? -eq 2 ] || { oracle_failed=$((oracle_failed + 1)); fails=1
                        printf 'FAIL  shell RUNS it, hook allows: [%.30s] join=%q\n' "$pfx" "$jn"; }
    done
  done
done
rm -rf "$ORACLE_DIR"
printf '%s  %-46s %s shapes, %s live, %s asserted\n' \
  "$([ "$oracle_failed" -eq 0 ] && echo 'ok  ' || echo 'FAIL')" \
  "oracle-gated cross product" "$oracle_shapes" "$oracle_live" "$oracle_asserted"

echo
echo "== HEREDOC SPELLING GRID (oracle-gated) =="
# The oracle-gated product above covers the data-context CONSTRUCT but only one SPELLING
# of it. A reviewer's grid over delimiter spellings found 18 live bypasses in a tracker
# whose four hand-written shapes all passed — the same enumerate-versus-generate lesson,
# one level down: it is not enough to generate over joins if the construct itself has
# spellings you enumerated.
#
# THE DECOY IS THE POINT, and getting it wrong is instructive. An indented line that the
# HOOK accepts as the terminator but BASH does not ends the heredoc early in the hook's
# model only — so it starts reading heredoc BODY as commands, the `git commit …` line
# grants the exemption, and everything after is skipped. A first version of this grid put
# the indented line in the terminator position instead; bash then swallows the whole
# command, the oracle skips every row, and the grid proves nothing while looking green.
HD_ORACLE=$(mktemp -d)
for t in git kubectl terraform; do printf '#!/bin/sh\nexit 0\n' > "$HD_ORACLE/$t"; chmod +x "$HD_ORACLE/$t"; done
TAB=$'\t'
hd_shapes=(
  "cat <<EOF${TAB}EOF"
  "cat <<-EOF${TAB}${TAB}EOF"
  "cat <<\\EOF${TAB}EOF"
  "cat <<'EOF'${TAB}EOF"
  "cat <<\"EOF\"${TAB}EOF"
  "cat <<A <<EOF${TAB}A"
  # Architect sign-off measured 3 of 12 openers leaking at ed01a82, not 2 — and the
  # third, `<< \EOF` (a SPACE before the backslash), is a spelling neither of us had
  # written down. Both of these block today only because the unparseable-heredoc clause
  # fails closed, which is the design working; but Decision 5 says generate where you
  # would otherwise enumerate, and an opener set is exactly an enumeration.
  "cat <<-\\EOF${TAB}${TAB}EOF"
  "cat << \\EOF${TAB}EOF"
)
hd_decoys=( "" "  EOF" "${TAB}EOF" "   EOF" )
hd_verbs=(
  "git push ${D}${D}force origin main"
  "git push origin main"
  "rm ${D}rf /tmp/x"
  "kubectl delete ns prod"
)
hd_live=0; hd_asserted=0; hd_holes=0
for shp in "${hd_shapes[@]}"; do
  hd_op=${shp%%"$TAB"*}; hd_term=${shp#*"$TAB"}
  for dc in "${hd_decoys[@]}"; do
    hd_body="git commit ${D}m \"fix"
    [ -n "$dc" ] && hd_body="$dc"$'\n'"$hd_body"
    got=$(cd "$HD_ORACLE" && PATH="$HD_ORACLE:/usr/bin:/bin" \
          bash -c "$hd_op"$'\n'"$hd_body"$'\n'"$hd_term"$'\n'"printf ORACLE_EXEC" 2>/dev/null)
    case "$got" in *ORACLE_EXEC*) ;; *) continue ;; esac
    hd_live=$((hd_live + 1))
    for v in "${hd_verbs[@]}"; do
      hd_asserted=$((hd_asserted + 1))
      printf '%s' "{\"tool_input\":{\"command\":$(printf '%s' "$hd_op"$'\n'"$hd_body"$'\n'"$hd_term"$'\n'"$v" | jq -Rs .)}}" |
        bash "$HOOK" >/dev/null 2>&1
      [ $? -eq 2 ] || { hd_holes=$((hd_holes + 1)); fails=1
                        printf 'FAIL  heredoc spelling: opener=%q decoy=%q\n' "$hd_op" "$dc"; }
    done
  done
done
python3 -c "import shutil; shutil.rmtree('$HD_ORACLE', ignore_errors=True)" 2>/dev/null ||
  find "$HD_ORACLE" -type f -delete 2>/dev/null
printf '%s  %-46s %s live shapes, %s asserted\n' \
  "$([ "$hd_holes" -eq 0 ] && echo 'ok  ' || echo 'FAIL')" \
  "heredoc spelling grid" "$hd_live" "$hd_asserted"

echo
echo "== MUST FAIL CLOSED (a control that cannot run must not report success) =="
# Every rule above is text processing, so a missing tool does not degrade the check —
# it DELETES it. Measured on the previous revision: no jq -> exit 0 with no stderr at
# all; no grep -> exit 0 with all eleven rules dead; no tr -> exit 0 with the segment
# rules dead. The 58 cases above ALL assume a healthy environment, so deleting jq left
# the suite green and the hook wide open. security.md already states the principle for
# the action-pin checker: a checker that goes green when it cannot do its job is worse
# than none.
PRUNE_ROOT=$(mktemp -d)
BASH_ABS=$(command -v bash)
trap 'rm -rf "$PRUNE_ROOT"' EXIT

# pruned_path <tool-to-hide> — a PATH containing every tool the hook needs EXCEPT one.
pruned_path() {
  local drop="$1" d p t
  d="$PRUNE_ROOT/no-$drop"
  mkdir -p "$d"
  for t in jq tr awk grep sed cat mktemp; do
    [ "$t" = "$drop" ] && continue
    p=$(command -v "$t" 2>/dev/null) && ln -sf "$p" "$d/$t"
  done
  printf '%s' "$d"
}

# The 5th argument asserts the MESSAGE, for the same reason run_raw does and because
# leaving it off here was an asymmetry the system-designer gate caught: with the
# dependency loop deleted, `missing jq` STILL exits 2 — via the missing-field clause,
# since jq's absence yields an empty command — and scored "ok". Only tr/awk/grep carried
# that mutation. Asserting the message is what makes the dependency loop provable.
run_env() {
  local label="$1" path="$2" cmd="$3" want="$4" msg="${5:-}" out rc got mark
  # BASH_ABS, not `bash`: the pruned PATH is used to resolve the interpreter too, so a
  # bare `bash` here exits 127 — which this harness would have scored as "allow", i.e.
  # the fail-closed cases would have passed for entirely the wrong reason.
  out=$(printf '%s' "{\"tool_input\":{\"command\":$(printf '%s' "$cmd" | jq -Rs .)}}" |
        PATH="$path" "$BASH_ABS" "$HOOK" 2>&1)
  rc=$?
  got="allow"; [ "$rc" -eq 2 ] && got="BLOCK"
  mark="ok  "; [ "$got" != "$want" ] && { mark="FAIL"; fails=1; }
  if [ -n "$msg" ] && [ "$mark" = "ok  " ]; then
    case "$out" in
      *"$msg"*) ;;
      *) mark="FAIL"; fails=1; got="wrongmsg" ;;
    esac
  fi
  printf '%s  %-46s want=%-5s got=%-5s\n' "$mark" "$label" "$want" "$got"
}

for tool in jq tr awk grep; do
  run_env "missing $tool" "$(pruned_path "$tool")" "git push ${D}${D}force origin main" BLOCK "hook dependency"
done

# PRESENT IS NOT ENOUGH. `\b` is a GNU extension, not POSIX ERE, and four rule families
# are built on it — so a grep that exists but ignores `\b` kills them SILENTLY while the
# dependency loop above passes, because the binary is there. The two shims cover both
# directions of the probe: a `\b` that matches nothing and a `\b` that matches
# everything are equally broken, and only the second shim can prove the probe's
# negative half. Asserting the message is what distinguishes this from the dependency
# loop, which would otherwise take the credit.
shim_path() {
  local name="$1" body="$2" d t p
  d="$PRUNE_ROOT/shim-$name"
  mkdir -p "$d"
  for t in jq tr awk sed cat mktemp; do p=$(command -v "$t" 2>/dev/null) && ln -sf "$p" "$d/$t"; done
  printf '%s\n' "$body" > "$d/grep"
  chmod +x "$d/grep"
  printf '%s' "$d"
}
run_env "grep whose \\b never matches" \
  "$(shim_path never '#!/bin/sh
exit 1')" "git push ${D}${D}force origin main" BLOCK "word boundaries"
run_env "grep whose \\b matches anything" \
  "$(shim_path always '#!/bin/sh
exit 0')" "git push ${D}${D}force origin main" BLOCK "word boundaries"

# awk is the asymmetric one. A broken grep fails CLOSED — rules stop matching, nothing
# gets exempted. A broken awk fails OPEN: git_subcommand returns garbage, and if that
# garbage is "commit" the exemption fires on everything. Presence alone cannot see it,
# so awk is probed on known input like grep is.
awk_shim_path() {
  local name="$1" body="$2" d t p
  d="$PRUNE_ROOT/awkshim-$name"
  mkdir -p "$d"
  for t in jq tr grep sed cat mktemp; do p=$(command -v "$t" 2>/dev/null) && ln -sf "$p" "$d/$t"; done
  printf '%s\n' "$body" > "$d/awk"
  chmod +x "$d/awk"
  printf '%s' "$d"
}
run_env "awk that always says 'commit'" \
  "$(awk_shim_path commit '#!/bin/sh
echo commit')" "git push ${D}${D}force origin main" BLOCK "subcommands"
run_env "awk that outputs nothing" \
  "$(awk_shim_path empty '#!/bin/sh
exit 0')" "git push ${D}${D}force origin main" BLOCK "subcommands"

# A payload the hook cannot parse is an ERROR, not consent. The matcher is `Bash` only
# (.claude/settings.json), so there is no legitimate invocation without
# .tool_input.command — treating a missing field as "nothing to check" turns an
# upstream schema change into a permanent, silent, undetectable bypass.
# The 4th argument asserts the MESSAGE, not just the verdict, and it is load-bearing
# rather than cosmetic. Both bad-payload clauses deny, so exit code alone cannot tell
# them apart — mutation-proving showed the "unparseable" clause could be deleted
# entirely with the suite still green, i.e. decoration by this repo's own standard.
# Distinguishing the two messages is what makes each clause provable, and it is also
# the difference between an operator learning "your payload is malformed" and
# "the field is missing" when this fires for real.
run_raw() {
  local label="$1" payload="$2" want="$3" msg="${4:-}" out rc got mark
  out=$(printf '%s' "$payload" | bash "$HOOK" 2>&1)
  rc=$?
  got="allow"; [ "$rc" -eq 2 ] && got="BLOCK"
  mark="ok  "; [ "$got" != "$want" ] && { mark="FAIL"; fails=1; }
  if [ -n "$msg" ] && [ "$mark" = "ok  " ]; then
    case "$out" in
      *"$msg"*) ;;
      *) mark="FAIL"; fails=1; got="wrongmsg" ;;
    esac
  fi
  printf '%s  %-46s want=%-5s got=%-5s\n' "$mark" "$label" "$want" "$got"
}
run_raw "malformed JSON payload"        "{not json"                              BLOCK "unparseable"
run_raw "payload with no command field" '{"tool_input":{"file_path":"/tmp/x"}}'  BLOCK "carried no"
# Empty stdin is not a parse error — jq exits 0 with no output on empty input — so it
# lands on the missing-field clause. Asserted as measured, not as assumed.
run_raw "empty payload"                 ""                                       BLOCK "carried no"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; fi
exit "$fails"
