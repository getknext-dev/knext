#!/usr/bin/env bash
# Shared helpers for jev-bash-gate.sh and jev-result-screen.sh. Sourced, never executed.
#
# Both hooks FAIL OPEN: jev is a calibrated second opinion, not an enforcement layer, so an
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

# jev_run <outfile> <jev args...> — run jev with a hard wall-clock cap ($JEV_GATE_TIMEOUT
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
  ( sleep "${JEV_GATE_TIMEOUT:-3}"; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 </dev/null &
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

# jev_has_credential_signal <text> — true if the text could carry a credential. Both hooks
# call this BEFORE any jev call and, on a hit, skip the call (fail open, silent): the text
# would otherwise leave the machine for TypeSafe. Hooks run in PARALLEL, so the deterministic
# hook blocking a command does not stop this one from sending it, and block-secrets.sh only
# covers Edit/Write. Measured: `gh secret set NPM_TOKEN --body <value>` was sent.
#
# OVER-MATCHING IS THE POINT. A false hit only means one command goes unjudged (the
# deterministic hook still applies); a false miss ships a secret. So: case-insensitive, bare
# words (`secret`, `token`, `password`), well-known prefixes, and any run of 32+ base64/hex
# characters (entropy proxy; `-` and `_` stay out of the class so kebab/snake-case names do
# not trip it, but a long unbroken path segment can). `sk-` needs a non-alphanumeric before
# it, else disk-/task- would match. Cost on the screen: a PR comment that merely says
# "token" is not screened.
JEV_CRED_RE='secret|token|authorization:|bearer |--password|password|passwd|--from-literal|api[_-]?key|private[_-]?key|-----BEGIN|ghp_|gho_|github_pat_|npm_|(^|[^a-z0-9])sk-[a-z0-9]|xox[bp]-|AKIA|[A-Za-z0-9+/=]{32,}'
jev_has_credential_signal() { printf '%s' "$1" | grep -Eiq -- "$JEV_CRED_RE"; }
