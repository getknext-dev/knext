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
#   * a PEM marker (3+ dashes, optional whitespace, BEGIN; newlines and CRs between them count);
#   * GitHub tokens: gh[pousr]_ + 36 alnum (and any further token characters: an over-long token is
#     matched, and so redacted, in full); github_pat_ + 22 or more [A-Za-z0-9_];
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
#   * A real hex secret of exactly 40 or 64 characters is let through (accepted, stated).
#   * KNOWN LIMIT, accepted: a token split across lines (`ghp_abc<newline>def...`) is matched per
#     line and is not caught; so is `://host:port/path@x` read as userinfo (over-redacted, harmless).
#   * PEM: redaction removes BEGIN through the LAST END marker (to the end of the text when there is
#     none, or when that END has no closing dashes); the detection rule only needs the marker.
#
# The screen does NOT skip on a hit any more (a skip let an attacker evade it by pasting one fake
# literal): jev_redact replaces every matched literal with a placeholder and the REDACTED text is
# screened. jev_redact uses the SAME patterns as detection (JEV_LITERAL_RE, JEV_ENTROPY_RUN_RE and
# _jev_strip_exempt below are the single source) and re-runs detection on its own output; if
# redaction errors or a literal survives it returns non-zero and the caller falls back to the old
# skip. pr-risk.sh keeps the skip (it sends no diff content at all).
JEV_Q="[\"']" # an optional quote around a header value (JSON / shell)
JEV_PEM_RE='---+[[:space:]]*BEGIN' # also checked on the line-flattened text (a marker split by a line break)
JEV_LITERAL_RE="$JEV_PEM_RE|"'gh[pousr]_[A-Za-z0-9]{36}[A-Za-z0-9_-]*|github_pat_[A-Za-z0-9_]{22,}|npm_[A-Za-z0-9]{36}[A-Za-z0-9_-]*|(^|[^a-z0-9])sk-[A-Za-z0-9_-]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}[A-Za-z0-9_-]*|://[^/@[:space:]]+:[^@[:space:]]+@|authorization'"$JEV_Q"'?[[:space:]]*:[[:space:]]*'"$JEV_Q"'?basic[[:space:]]+[^[:space:]]+|(authorization'"$JEV_Q"'?[[:space:]]*:[[:space:]]*'"$JEV_Q"'?|bearer[[:space:]]+'"$JEV_Q"'?)([A-Za-z]+[[:space:]]+)?([A-Za-z0-9._~+/=-]{16,}|[A-Za-z._~+/=-]*[0-9][A-Za-z0-9._~+/=-]{7,})'
JEV_ENTROPY_RUN_RE='[A-Za-z0-9+=]{32,}'
JEV_UNICODE_SPACES="$(printf '\302\240|\341\232\200|\342\200[\200-\212]|\342\200\257|\342\201\237|\343\200\200')"
# _jev_has_nul <file> — true (0) if the file holds a NUL byte OR the test itself failed.
_jev_has_nul() {
  local n_all n_nonul
  n_all=$(wc -c <"$1") || return 0
  n_nonul=$(tr -d '\000' <"$1" | wc -c) || return 0
  [ "$((n_all))" -eq "$((n_nonul))" ] || return 0
  return 1
}

# _jev_strip_exempt <text> — print the text with the exempt-from-ENTROPY things replaced (inline
# data URIs, 40/64-hex hashes). Non-zero on any sed error. Shared by detection and redaction.
_jev_strip_exempt() {
  local stripped pass
  stripped=$(sed -E -e 's#data:[A-Za-z0-9.+/-]+;base64,[A-Za-z0-9+/=]*#DATAURI#g' <<<"$1") || return 1
  # Two passes: two hashes sharing one separator ("<sha> <sha>") are both exempted.
  for pass in 1 2; do
    stripped=$(sed -E \
      -e 's#(^|[^A-Za-z0-9])[0-9a-fA-F]{64}([^A-Za-z0-9]|$)#\1SHA256\2#g' \
      -e 's#(^|[^A-Za-z0-9])[0-9a-fA-F]{40}([^A-Za-z0-9]|$)#\1GITSHA\2#g' <<<"$stripped") || return 1
  done
  printf '%s\n' "$stripped"
}

_jev_secret_check() { # <file>: the text, byte-exact
  # FAIL CLOSED. This check is the only thing between the text and the external jev API, so any
  # ERROR in it must read as "possibly a secret" (return 0 = skip the call), never "no secret".
  # Measured failure it closes: one non-UTF-8 byte made BSD sed (macOS) error ("illegal byte
  # sequence"), its output was empty, the entropy rule saw nothing, and the text was SENT.
  # Two layers: (1) LC_ALL=C so every byte is a valid character and invalid UTF-8 cannot error at
  # all (the rules match ASCII bytes; Unicode spaces are normalised first, see below); (2) every command's status is checked -- grep
  # exits 0 match / 1 no match / 2+ error, sed 0 / non-zero -- and an error returns 0.
  # Deliberate consequence: a CLEAN text with an invalid byte is not an error under LC_ALL=C and
  # is screened normally; only a genuine failure of the check skips the call.
  local LC_ALL
  export LC_ALL=C # local yet exported: children see it, the caller's locale is restored on return
  local orig flat stripped runs rc
  # NUL: bash cannot hold a NUL in a variable and `$(...)` silently DROPS it, so `a<NUL>sk-...` would
  # be checked as `ask-...` (the `sk-` word boundary is lost) while the file jev would be sent still
  # has the NUL. A NUL anywhere is treated as "possible secret": skip.
  _jev_has_nul "$1" && return 0
  # Unicode spaces -> ASCII space. [[:space:]] is ASCII-only under LC_ALL=C, so without this
  # `Authorization:<NBSP>Bearer<NBSP><token>` would stop matching the header rule. U+00A0, U+1680,
  # U+2000-200A, U+202F, U+205F, U+3000 (UTF-8 byte sequences).
  orig=$(sed -E -e "s/$JEV_UNICODE_SPACES/ /g" "$1") || return 0
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
  # 1b. A PEM marker split by a line break (`-----<CR><LF>BEGIN`): per-line grep cannot see it, so look
  #     for the marker alone on the text with CR and LF turned into spaces. Kept out of rule 1 so that
  #     rule keeps its per-line early exit on big texts (the SIGPIPE cases above).
  flat=$(tr '\r\n' '  ' <<<"$orig") || return 0
  grep -Eiq -- "$JEV_PEM_RE" <<<"$flat"
  rc=$?
  [ "$rc" -ne 1 ] && return 0
  # 2. Exemptions (inline data URIs, 40/64-hex hashes), then the entropy rule on what is left.
  stripped=$(_jev_strip_exempt "$orig") || return 0
  runs=$(grep -Eio -- "$JEV_ENTROPY_RUN_RE" <<<"$stripped")
  rc=$?
  [ "$rc" -le 1 ] || return 0 # 1 = no long run; 2+ = error: skip
  grep -q '[0-9]' <<<"$runs"
  rc=$?
  [ "$rc" -le 1 ] || return 0
  return "$rc"
}

# jev_has_literal_secret — see above. Reads stdin into a temp file (byte-exact, NULs kept) and checks
# that; any failure to do so is "possible secret".
jev_has_literal_secret() {
  local f rc
  f=$(mktemp 2>/dev/null) || return 0
  if cat >"$f"; then
    _jev_secret_check "$f"
    rc=$?
  else
    rc=0
  fi
  rm -f "$f"
  return "$rc"
}

# _jev_replace_fixed <patfile> <textfile> — print the text with every line of <patfile> (a literal
# string, not a regex) replaced by the placeholder. Reads the text from a FILE and tells the two
# inputs apart by name, not NR==FNR (an empty pattern file would make that wrong). Pattern order
# does not matter for safety: the caller re-runs detection on the result.
_jev_replace_fixed() {
  awk '
    FILENAME == ARGV[1] { if (length($0) > 0 && !($0 in seen)) { seen[$0] = 1; n++; p[n] = $0 } next }
    { line = $0
      for (k = 1; k <= n; k++) {
        s = p[k]; l = length(s); out = ""
        while ((i = index(line, s)) > 0) { out = out substr(line, 1, i - 1) "[REDACTED]"; line = substr(line, i + l) }
        line = out line
      }
      print line }' "$1" "$2"
}

# _jev_redact_pem <textfile> — print the text with PEM blocks replaced by a placeholder. The marker
# is loose on purpose (over-redaction is cheap): 3+ dashes, optional whitespace -- newlines and CRs
# included -- then BEGIN, any case. From a BEGIN marker the redaction runs through the LAST END
# marker's closing dashes anywhere after it, so a spoofed early END, a nested block or a second
# block cannot end it early; if that last END has no closing dashes, or there is no END at all, it
# runs to the end of the text. The whole text is read as ONE record (RS is a byte that is not in
# text) so a marker split across lines still matches.
_jev_redact_pem() {
  awk '
    BEGIN { RS = "\001" }
    { t = (NR > 1 ? t "\001" : "") $0 }
    END {
      out = ""; rem = t
      while (1) {
        low = tolower(rem)
        if (!match(low, /---+[ \t\r\n]*begin/)) { out = out rem; break }
        b = RSTART; off = b + RLENGTH; e = 0
        while (match(substr(low, off), /---+[ \t\r\n]*end/)) { e = off + RSTART - 1; elen = RLENGTH; off = e + elen }
        if (e == 0) { endpos = length(rem) }
        else {
          after = substr(low, e + elen)
          if (match(after, /---+/)) { endpos = e + elen - 1 + RSTART + RLENGTH - 1 } else { endpos = length(rem) }
        }
        out = out substr(rem, 1, b - 1) "[REDACTED]"
        rem = substr(rem, endpos + 1)
      }
      printf "%s", out
    }' "$1"
}

# jev_redact <in> <out> — write <in> to <out> with every matched literal replaced by [REDACTED].
# Returns 0 ONLY if redaction succeeded AND detection finds nothing in the result; anything else
# (NUL, an error in any command, a surviving literal) returns non-zero and the caller must NOT
# send. The literal is never printed. Same patterns as detection, run under LC_ALL=C.
jev_redact() {
  local LC_ALL
  export LC_ALL=C
  local in="$1" out="$2" w rc
  _jev_has_nul "$in" && return 1 # bash cannot carry a NUL; unredactable, so unsendable
  w=$(mktemp -d 2>/dev/null) || return 1
  _jev_redact_into "$in" "$out" "$w"
  rc=$?
  rm -r "$w" 2>/dev/null
  return "$rc"
}

_jev_redact_into() { # <in> <out> <workdir>
  local in="$1" out="$2" w="$3" cur stripped rc
  # Unicode spaces normalised, exactly as detection does.
  cur=$(sed -E -e "s/$JEV_UNICODE_SPACES/ /g" "$in") || return 1
  # PEM blocks first: the marker is only the first line of a secret; the body (short lines, lines
  # with no digit) and the END line match no rule of their own, so the whole block goes.
  printf '%s\n' "$cur" >"$w/t0" || return 1
  cur=$(_jev_redact_pem "$w/t0") || return 1
  # Pass 1: token shapes, user:pass@, headers (on the original text, as in detection).
  grep -Eio -- "$JEV_LITERAL_RE" <<<"$cur" >"$w/pat1"
  rc=$?
  [ "$rc" -le 1 ] || return 1
  printf '%s\n' "$cur" >"$w/t1" || return 1
  cur=$(_jev_replace_fixed "$w/pat1" "$w/t1") || return 1
  # Pass 2: the entropy rule on what is left, after the same exemptions; only digit-bearing runs.
  stripped=$(_jev_strip_exempt "$cur") || return 1
  grep -Eio -- "$JEV_ENTROPY_RUN_RE" <<<"$stripped" >"$w/runs"
  rc=$?
  [ "$rc" -le 1 ] || return 1
  grep '[0-9]' "$w/runs" >"$w/pat2"
  rc=$?
  [ "$rc" -le 1 ] || return 1
  printf '%s\n' "$cur" >"$w/t2" || return 1
  cur=$(_jev_replace_fixed "$w/pat2" "$w/t2") || return 1
  printf '%s\n' "$cur" >"$w/res" || return 1
  # A redactor that lost the text (empty output) must not read as "nothing left to leak".
  grep -q '[^[:space:]]' "$w/res" || return 1
  # Fail closed: a literal that survived (or an error in this check) means do not send.
  _jev_secret_check "$w/res"
  rc=$?
  [ "$rc" -eq 1 ] || return 1
  cp "$w/res" "$out" || return 1
}
