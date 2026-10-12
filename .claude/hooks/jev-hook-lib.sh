#!/usr/bin/env bash
# Shared helpers for jev-result-screen.sh. Sourced, never executed.
#
# The hook FAILS OPEN: jev is a calibrated second opinion, not an enforcement layer, so an
# unreachable model must degrade to "no opinion", never to "stop the agent". The deterministic
# gate (block-dangerous-bash.sh) is the one that fails closed.

# jev_resolve — fill JEV_CMD with the command that runs jev, or return 1 if there is none.
#   $JEV_BIN                          explicit binary (the offline test points this at a fake)
#   `jev` on PATH                     the installed CLI
#   $CLAUDE_PROJECT_DIR/.claude/skills/jev/jev.py   a checkout that vendors the script
jev_resolve() {
  JEV_CMD=()
  if [ -n "${JEV_BIN:-}" ]; then
    [ -x "$JEV_BIN" ] || return 1
    JEV_CMD=("$JEV_BIN")
  elif command -v jev >/dev/null 2>&1; then
    JEV_CMD=(jev)
  elif [ -f "${CLAUDE_PROJECT_DIR:-.}/.claude/skills/jev/jev.py" ] && command -v python3 >/dev/null 2>&1; then
    JEV_CMD=(python3 "${CLAUDE_PROJECT_DIR:-.}/.claude/skills/jev/jev.py")
  else
    return 1
  fi
}

# jev_run <outfile> <jev args...> — run jev with a hard wall-clock cap ($JEV_HOOK_TIMEOUT
# seconds, default 3, decimals allowed). Returns jev's status; a killed run is non-zero.
#
# No `timeout(1)`: it is absent on stock macOS. The watchdog's fds are all redirected,
# otherwise the orphaned `sleep` holds the hook's stdout pipe open and the caller waits for
# it to exit — which would turn a 3 s cap into a 3 s STALL on every call.
jev_run() {
  local out="$1" pid wd rc
  shift
  "${JEV_CMD[@]}" "$@" >"$out" 2>/dev/null </dev/null &
  pid=$!
  # The watchdog runs its `sleep` in the background and traps TERM to kill it. Killing only the
  # subshell leaves the `sleep` orphaned (re-parented to init) for the rest of the timeout, which
  # piles up on a CI runner across hundreds of hook calls.
  ( sleep "${JEV_HOOK_TIMEOUT:-3}" & sp=$!
    trap 'kill "$sp" 2>/dev/null; exit 0' TERM
    wait "$sp"
    kill "$pid" 2>/dev/null ) >/dev/null 2>&1 </dev/null &
  wd=$!
  wait "$pid" 2>/dev/null
  rc=$?
  kill "$wd" 2>/dev/null
  wait "$wd" 2>/dev/null
  return "$rc"
}

# jev_is_prob <x> — a plain decimal in [0,1]. Anything else (a string, an object, 7) is an
# unparseable answer and the caller fails open.
jev_is_prob() {
  case "$1" in '' | *[!0-9.]* | *.*.*) return 1 ;; esac
  awk -v x="$1" 'BEGIN { exit !(x + 0 >= 0 && x + 0 <= 1) }'
}

# jev_ge <x> <threshold> — x >= threshold, as floats.
jev_ge() { awk -v x="$1" -v t="$2" 'BEGIN { exit !(x + 0 >= t + 0) }'; }

# jev_has_literal_secret — reads TEXT ON STDIN; true if it carries a LITERAL secret format. The
# screen and pr-risk.sh call it BEFORE any jev call and, on a hit, skip the call (fail open,
# silent): the text would otherwise leave the machine for TypeSafe. Case-insensitive. For
# pr-risk.sh it is only a backstop (that script sends no diff content at all; see its header); for
# the screen it is the guard, and a deliberately narrow, best-effort one.
#
# NARROW on purpose, in BOTH directions:
#   * Literal formats only, never plain words. The screened text is public GitHub/web content an
#     ATTACKER writes, so a word-based skip would let any injection comment evade the screen just
#     by saying "token".
#   * Real token SHAPES, not bare prefixes. Every `gh api .../comments` response carries a 40-hex
#     `commit_id` and a commit URL; prose says `npm_config`; pages carry base64 data URIs. A rule
#     loose enough to skip those blinds the screen to nearly all real GitHub output.
#
# What counts (each alternative is mutation-proved):
#   * a PEM marker;
#   * GitHub tokens: gh[pousr]_ + 36 alnum; github_pat_ + 22 or more [A-Za-z0-9_];
#   * npm_ + 36 alnum; `sk-` + 20 or more (needs a non-alphanumeric before it, so disk-/task-
#     never match); xox[bp]- + a body; AKIA + 16 [0-9A-Z];
#   * scheme://user:pass@host;
#   * `Authorization: Basic <anything>`; for any other scheme (and `Bearer`) a value of 16+ token
#     characters, or 8+ with a digit, so "Authorization: ignore previous instructions" is not one;
#   * a run of 32+ [A-Za-z0-9+=] characters that contains a digit. `/`, `-` and `_` are NOT in the
#     class, so a path or a kebab/snake-case name never forms one long run, and a digit-free run
#     (a long identifier) is not a token.
# What is exempt from the ENTROPY rule only (token shapes, PEM and headers are checked on the
# original text first, so a token right after `data:x/y;base64,` is still caught), because it is
# everywhere and is not secret:
#   * a pure-hex run of exactly 40 or 64 characters (a git SHA, a sha256 digest);
#   * a `data:...;base64,...` URI (an inline image or font).
#   * RESIDUAL, accepted and stated: an attacker who knows this list can still evade the screen
#     by pasting one fake literal. Not closable with a skip; redacting the matched literals before
#     sending would close it (follow-up). A real hex secret of exactly 40 or 64 characters is
#     likewise let through.
JEV_LITERAL_RE='-----BEGIN|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|npm_[A-Za-z0-9]{36}|(^|[^a-z0-9])sk-[A-Za-z0-9_-]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|://[^/@[:space:]]+:[^/@[:space:]]+@|authorization:[[:space:]]*basic[[:space:]]+[^[:space:]]+|(authorization:[[:space:]]*|bearer[[:space:]]+)([A-Za-z]+[[:space:]]+)?([A-Za-z0-9._~+/=-]{16,}|[A-Za-z._~+/=-]*[0-9][A-Za-z0-9._~+/=-]{7,})'
jev_has_literal_secret() {
  # FAIL CLOSED. This check is the only thing between the text and the external jev API, so any
  # ERROR in it must read as "possibly a secret" (return 0 = skip the call), never "no secret".
  # Measured failure it closes: one non-UTF-8 byte made BSD sed (macOS) error ("illegal byte
  # sequence"), its output was empty, the entropy rule saw nothing, and the text was SENT.
  # Two layers: (1) LC_ALL=C so every byte is a valid character and invalid UTF-8 cannot error at
  # all (the rules are ASCII-only, nothing is lost); (2) every command's status is checked -- grep
  # exits 0 match / 1 no match / 2+ error, sed 0 / non-zero -- and an error returns 0.
  # Deliberate consequence: a CLEAN text with an invalid byte is not an error under LC_ALL=C and
  # is screened normally; only a genuine failure of the check skips the call.
  local LC_ALL
  export LC_ALL=C # local yet exported: children see it, the caller's locale is restored on return
  local orig stripped runs pass rc
  orig=$(cat) || return 0
  # NO PIPELINES IN THE CHECKS: the callers run under `set -o pipefail`, and `grep -q` exits on the
  # first match while `printf` is still writing a large text, so printf dies of SIGPIPE and
  # pipefail turns a HIT into a failure: a big text with an early secret would be SENT. Here-strings
  # feed grep with no writer process at all, so nothing can hit a closed pipe -- not even when the
  # caller ignores SIGPIPE (GitHub's macOS runners do), where printf would print "Broken pipe" to
  # the hook's stderr instead of dying quietly.
  #
  # 1. Token shapes, PEM, user:pass@, headers: on the ORIGINAL text. No exemption may run first: a
  #    token placed right after `data:x/y;base64,` must not be eaten by the data-URI strip.
  grep -Eiq -- "$JEV_LITERAL_RE" <<<"$orig"
  rc=$?
  [ "$rc" -eq 1 ] || return 0 # 1 = no match; 0 = hit, 2+ = error: both skip the call
  # 2. Exemptions (inline data URIs, 40/64-hex hashes), then the entropy rule on what is left.
  stripped=$(sed -E -e 's#data:[A-Za-z0-9.+/-]+;base64,[A-Za-z0-9+/=]*#DATAURI#g' <<<"$orig") || return 0
  # Two passes: two hashes sharing one separator ("<sha> <sha>") are both exempted.
  for pass in 1 2; do
    stripped=$(sed -E \
      -e 's#(^|[^A-Za-z0-9])[0-9a-fA-F]{64}([^A-Za-z0-9]|$)#\1SHA256\2#g' \
      -e 's#(^|[^A-Za-z0-9])[0-9a-fA-F]{40}([^A-Za-z0-9]|$)#\1GITSHA\2#g' <<<"$stripped") || return 0
  done
  runs=$(grep -Eio '[A-Za-z0-9+=]{32,}' <<<"$stripped")
  rc=$?
  [ "$rc" -le 1 ] || return 0 # 1 = no long run; 2+ = error: skip
  grep -q '[0-9]' <<<"$runs"
  rc=$?
  [ "$rc" -le 1 ] || return 0
  return "$rc"
}
