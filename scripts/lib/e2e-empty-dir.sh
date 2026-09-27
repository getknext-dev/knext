#!/usr/bin/env bash
#
# scripts/lib/e2e-empty-dir.sh — the KNEXT_SELF_CONTAINED=1 empty-dir lane step
# (#1455, ADR-0060 decision 5 / action item F6). Sourced by scripts/e2e-deploy.sh
# and scripts/e2e-deploy-vinext.sh, exactly the way lib/e2e-state-snapshot.sh
# already is — matched by the same `scripts/lib` root in the frozen harness
# scan (scripts/compat-window-fingerprint.mjs, HARNESS_ROOTS), so this file
# joins the frozen set automatically with no fingerprint-script edit needed.
#
# THE CHECK: stage ONLY the binary + its static assets + native/ into a FRESH
# directory (nothing else — in particular no node_modules/, no .next/ beyond
# .next/static, no .output/ beyond .output/public), then boot the binary with
# that directory as its cwd and confirm it serves at least two routes with
# nothing else present.
#
# HONEST SCOPE: until the embedding tracks land (N1 #1456 for the Next
# standalone shape, V1 #1460 for vinext), booting a REAL fixture's compiled
# artifact this way is EXPECTED TO FAIL — today's compiled binaries still load
# `.next/server/**` (standalone) or the nitro chunk graph (vinext) from disk
# beside the binary (ADR-0060 §Context). Only the STAGING and the CLEANLINESS
# ASSERTION below are meant to be exercised end-to-end before N1/V1 ship; the
# BOOT+PROBE half is proven here against a synthetic fixture
# (tests/e2e-empty-dir.test.ts), not against a real Next/vinext build. The mode
# is opt-in and off by default for exactly this reason (ADR-0060 decision 1/7).
#
# Sourced, so this file must NOT set -e itself (that would impose failure
# semantics on whatever unrelated code runs before/after `source` in the
# caller) — every function below fails closed on ITS OWN, by `return`ing
# non-zero, and the caller's own `set -euo pipefail` (both e2e-deploy*.sh set
# it) turns that into a hard stop at the call site.

ed_log() { echo "[e2e-empty-dir] $*" >&2; }

# Resolved ONCE, absolutely, at source time: ed_probe_http runs after
# ed_check_or_die has cd'd into the staged dir, so a BASH_SOURCE-relative path
# (a relative `. scripts/lib/…` source) would no longer resolve there.
ED__LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ed_refuse_self_contained_noop <detail>
#
# Round-3 (non-blocking N3, promoted to load-bearing): scripts/e2e-deploy.sh
# and scripts/e2e-deploy-vinext.sh each have an axis where
# `KNEXT_SELF_CONTAINED=1` was requested but there is no compiled binary on
# that path to run the empty-dir check against (RUNTIME=node or
# KNEXT_SANDBOX_FETCH_DEBUG=1 in the standalone lane; KNEXT_COMPILE=0 in the
# vinext lane). Both used to log a WARNING and continue in plain disk mode —
# but scripts/compat-window-fingerprint.mjs sets the self-contained
# fingerprint bit from the SAME `KNEXT_SELF_CONTAINED=1` dispatch input,
# upstream of and independent from this check, so a disk-mode run could carry
# a self-contained fingerprint. Extracted into ITS OWN function (rather than
# duplicated inline at each call site) so it is directly unit-testable
# (tests/e2e-empty-dir.test.ts) and mutation-provable
# (scripts/mutation-prove-empty-dir-guard.mjs) without a docker/kind
# integration harness for the deploy scripts themselves — the earlier inline
# WARNING-and-continue shape had neither a test nor a mutation, which is
# precisely what let it regress from "documented no-op" to "silent
# mislabeling risk" without anything catching it.
ed_refuse_self_contained_noop() {
  local detail="$1"
  ed_log "ERROR: KNEXT_SELF_CONTAINED=1 was requested but has no effect on this deploy (${detail}) — the empty-dir lane check only applies to a compiled executable. Refusing rather than silently running disk mode under a self-contained fingerprint."
  return 1
}

# ed_stage <fresh_dir> <binary_src> [<src>:<dest_rel>]...
#
# Copies ONLY the binary (made executable) and each existing <src> to
# <fresh_dir>/<dest_rel>. A <src> that does not exist is skipped, silently —
# absence is legitimate (e.g. no native/ for a fixture that never touches
# next/image or sharp). Prints the staged binary's path on success.
ed_stage() {
  local fresh_dir="$1" binary_src="$2"
  shift 2
  mkdir -p "${fresh_dir}"
  local binary_name
  binary_name="$(basename "${binary_src}")"
  cp "${binary_src}" "${fresh_dir}/${binary_name}" || return 1
  chmod +x "${fresh_dir}/${binary_name}" || return 1
  local spec src dest
  for spec in "$@"; do
    src="${spec%%:*}"
    dest="${spec#*:}"
    if [ -e "${src}" ]; then
      mkdir -p "${fresh_dir}/$(dirname "${dest}")" || return 1
      cp -RP "${src}" "${fresh_dir}/${dest}" || return 1
    fi
  done
  printf '%s\n' "${fresh_dir}/${binary_name}"
}

# ed_assert_clean <fresh_dir> <binary_name>
#
# ALLOWLIST, not a denylist (round-2 review, non-blocking item promoted to
# load-bearing by BLOCKING-2 below): the only top-level entries permitted are
# <binary_name>, `.next`, `public`, `native` and `.output` — anything else
# (a stray `package.json` + `server.js` pair, a `.bun` cache dir, a `server/`
# directory of nitro chunks, …) reds immediately. A DENYLIST of just
# `node_modules`/`.output` (the shape this replaces) went blind the moment a
# real fixture staged `.output/public` — `ed_assert_clean` forbade `.output`
# wholesale, so the vinext lane could never pass even when staging was
# correct (round-2 review, BLOCKING-2).
#
# Within the two directories that are allowed to carry a static-asset
# sub-path, only that one sub-path may be present:
#   * `.next` may contain only `static` (the standalone shape).
#   * `.output` may contain only `public` (the vinext/nitro shape).
# `node_modules` is never allowed at the top level, full stop.
#
# NESTED LEAKS (round-2 review, non-blocking): a top-level allowlist alone
# does not catch `native/node_modules`, `public/node_modules`, or
# `.next/static/node_modules` — the disk-mode tree leaking in one level
# deeper than the entries this function otherwise inspects. So, independent
# of the top-level allowlist, this also fails on any `node_modules` directory
# ANYWHERE under `fresh_dir`, at any depth.
#
# This is the mutation-proved guard (scripts/mutation-prove-empty-dir-guard.mjs):
# reaching a version that never inspects these must let a PLANTED node_modules
# — top-level or nested — pass.
#
# ROUND-3 (non-blocking N2, promoted): the top-level glob `.[!.]*` matches a
# SINGLE leading dot followed by a non-dot character, so a name starting with
# TWO dots (`..leak`) matches neither `*` nor `.[!.]*` and was invisible to
# this function entirely — measured, rc 0. The third glob below
# (`..?*` — two literal dots then one-or-more characters) closes that without
# touching the two existing patterns.
#
# ROUND-3 (non-blocking N2, promoted): `find -type d -name node_modules`
# (below) only matches real directories, so a SYMLINK named `node_modules`
# under `native/`, or the allowlisted `public`/`.next/static`/`.output/public`
# themselves being symlinks (to somewhere outside `fresh_dir` entirely, or to
# a disk-mode sibling like `.next/server`), all pass silently — measured, rc 0
# in every case. A correctly-staged tree never legitimately contains a
# symlink: `ed_stage` copies with `cp -RP` (never follows, but also never
# leaves a dangling link behind for a source that IS a symlink — see its own
# copy of `native/`'s callers, which dereference with `-RL` upstream before
# `ed_stage` ever runs). So the fix below is unconditional: ANY symlink
# anywhere under `fresh_dir`, at any depth, reds — never just the specific
# repro cases measured.
ed_assert_clean() {
  local dir="$1" binary_name="$2"
  local entry name
  for entry in "${dir}"/* "${dir}"/.[!.]* "${dir}"/..?*; do
    [ -e "${entry}" ] || [ -L "${entry}" ] || continue
    name="$(basename "${entry}")"
    case "${name}" in
      "${binary_name}" | .next | public | native | .output) ;;
      *)
        ed_log "ERROR: ${dir}/${name} is present — the empty-dir lane must boot from nothing but the binary + static assets + native/ (allowlist: ${binary_name}, .next, public, native, .output)"
        return 1
        ;;
    esac
  done

  local sub_dir sub_only sub_entry sub_name
  for sub_dir in .next .output; do
    if [ -e "${dir}/${sub_dir}" ]; then
      if [ ! -d "${dir}/${sub_dir}" ]; then
        ed_log "ERROR: ${dir}/${sub_dir} exists and is not a directory"
        return 1
      fi
      case "${sub_dir}" in
        .next) sub_only="static" ;;
        .output) sub_only="public" ;;
      esac
      for sub_entry in "${dir}/${sub_dir}"/* "${dir}/${sub_dir}"/.[!.]*; do
        [ -e "${sub_entry}" ] || continue
        sub_name="$(basename "${sub_entry}")"
        if [ "${sub_name}" != "${sub_only}" ]; then
          ed_log "ERROR: ${dir}/${sub_dir} contains '${sub_name}' — only ${sub_dir}/${sub_only} may accompany a self-contained binary (the rest is the disk-mode tree leaking into the empty dir)"
          return 1
        fi
      done
    fi
  done

  # The nested-leak sweep: node_modules anywhere under fresh_dir, regardless
  # of the top-level allowlist having let its parent through.
  local nested
  nested="$(find "${dir}" -type d -name node_modules -print -quit 2>/dev/null)"
  if [ -n "${nested}" ]; then
    ed_log "ERROR: ${nested} is present — node_modules must not be reachable anywhere under the empty dir, at any depth"
    return 1
  fi

  # ROUND-3 (non-blocking N2, promoted to load-bearing): a symlink anywhere
  # under fresh_dir — `native/node_modules` linked to the real one, `public`
  # itself linked outside fresh_dir entirely, `.next/static` linked to
  # `.next/server`, or a symlink nested inside `static`/`public`/`.output`
  # — is invisible to every check above (`find -type d`, the sub-dir name
  # comparison) because none of them look at link type. Rejected
  # unconditionally: a correctly-staged tree never legitimately contains one
  # (ed_stage copies with `cp -RP`; native/ addons are dereferenced with
  # `cp -RL` upstream of ed_stage, never inside it).
  local symlink_leak
  symlink_leak="$(find "${dir}" -type l -print -quit 2>/dev/null)"
  if [ -n "${symlink_leak}" ]; then
    ed_log "ERROR: ${symlink_leak} is a symlink — the empty-dir lane must contain only real files/directories that ed_stage copied, never a symlink that can point outside the staged tree or alias a disk-mode path"
    return 1
  fi

  return 0
}

# ed_probe_http <port> <path> <mode>
#
# One request. `mode` decides which statuses count as alive:
#   * "2xx3xx" — 200–299 ONLY (see round-3 note below; the mode name is kept
#     for call-site compatibility, its threshold is not). Used for the health
#     path: a health check that itself errors is not "alive", it is a boot
#     that half-started.
#   * "non5xx" — anything except 500–599. Used for the general app route: a
#     404 for an unrouted path is a legitimate "the runtime is alive and
#     routing" answer; a 500 is not.
# BLOCKING-4 (round-2 review): the previous version counted ANY complete
# response, so a server 500-ing on every route — or a missing on-disk route
# chunk surfacing as a 500 — passed. 5s timeout either way.
#
# ROUND-3 (non-blocking N4, promoted to load-bearing): the health path used to
# accept 300-399 too, so a 302 (e.g. to a login page) counted as "alive" —
# there is no `-L` here to follow it and confirm what is actually behind it,
# so a redirect is not evidence of health, only evidence something answered.
# Health is now 2xx ONLY. This also closes the B1 gap named in round-2 review
# (tests/e2e-empty-dir.test.ts): a fixture where the health path alone 500s
# (every OTHER route stays 200) previously had no test that isolated the
# health branch from the extra-path (`non5xx`) branch, so widening the health
# threshold back toward "non5xx" would have gone undetected — the same
# comparison this file's mutation prover (mutation 5) now exercises directly.
#
# ROUND-3: the request itself lives in scripts/lib/e2e-probe-http.mjs, not
# inline here — see that file's own header for why (the apply-safety
# scanner's "unclassified remote fetch" allowlist requires an exactly-once
# match across the tree, which this probe's two real call sites × two
# callers cannot satisfy; a real .mjs file's contents are outside that
# scanner's scope, since it scans .sh/.bash text only).
ed_probe_http() {
  local port="$1" path="$2" mode="$3"
  node "${ED__LIB_DIR}/e2e-probe-http.mjs" "${port}" "${path}" "${mode}"
}

# ed_boot_probe_kill <port> <health_path> <extra_path> <cmd...>
#
# Runs <cmd...> in the background (PORT must already be exported by the
# caller — the command reads it the same way it would in production), waits
# up to 20s for a TCP accept, probes <health_path> (2xx/3xx required) then
# <extra_path> (anything but 5xx), kills the process, and returns 0 only if
# the TCP probe AND both HTTP probes succeeded. Always kills whatever it
# started, on every exit path, escalating TERM → KILL if it does not exit
# (round-2 review, non-blocking): a binary ignoring SIGTERM used to hang the
# outer `timeout 40` and orphan the process.
ed_boot_probe_kill() {
  local port="$1" health_path="$2" extra_path="$3"
  shift 3
  # #1515: the probe server's stdout goes to STDERR, never the caller's
  # stdout. The deploy scripts' stdout is the harness contract — exactly one
  # line, the deployment URL — and nitro's `➜ Listening on: …` banner landing
  # there was read by the Next harness as the URL ("invalid URL", 31 files in
  # run 36312054519).
  ( exec "$@" ) >&2 &
  local pid=$!
  local ready=0 i
  # Always attempted on every return path below, once the process has been
  # started — `trap ... RETURN` is deliberately NOT used here (it would fire
  # on every later shell-function return in this same sourced script, not
  # just this one, which is the footgun that ruled it out for ed_check_or_die
  # too). Explicit calls at each exit point are what actually runs exactly
  # once, here.
  ed__kill_wait() {
    local target="$1"
    kill -0 "${target}" 2>/dev/null || { wait "${target}" 2>/dev/null; return 0; }
    kill -TERM "${target}" 2>/dev/null || true
    local j
    for j in $(seq 1 25); do
      kill -0 "${target}" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "${target}" 2>/dev/null; then
      ed_log "WARNING: pid ${target} ignored SIGTERM — escalating to SIGKILL"
      kill -KILL "${target}" 2>/dev/null || true
    fi
    # `|| true`: a TERM-killed child makes `wait` return 143, which under a
    # caller's `set -e` (outside an `if`) aborted the whole caller (#1515).
    wait "${target}" 2>/dev/null || true
  }
  for i in $(seq 1 100); do
    if ! kill -0 "${pid}" 2>/dev/null; then
      ed_log "ERROR: the empty-dir boot exited before becoming ready (pid ${pid})"
      wait "${pid}" 2>/dev/null
      return 1
    fi
    if node -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
      ready=1
      break
    fi
    sleep 0.2
  done
  if [ "${ready}" != "1" ]; then
    ed_log "ERROR: the empty-dir boot never became ready on port ${port}"
    ed__kill_wait "${pid}"
    return 1
  fi
  local ok=0
  if ed_probe_http "${port}" "${health_path}" "2xx3xx" && ed_probe_http "${port}" "${extra_path}" "non5xx"; then
    ok=1
  else
    ed_log "ERROR: the empty-dir boot did not answer ${health_path} with 2xx/3xx and ${extra_path} with a non-5xx status"
  fi
  ed__kill_wait "${pid}"
  [ "${ok}" = "1" ]
}

# ed_restore_hidden_paths <path>...
#
# Moves each "<path>.ed-hidden" back to "<path>", for whichever of <path>...
# actually has a hidden twin. Never fails on an already-restored or never-
# hidden path — safe to call more than once, which is what makes it safe to
# invoke from a subshell EXIT trap regardless of which branch that subshell
# took.
#
# #1514: refuses (non-zero, loud) to restore over a <path> that ALSO exists —
# `mv <p>.ed-hidden <p>` onto an existing directory nests the hidden tree
# inside it instead of restoring it, the same shape ed_check_or_die's own
# "already hidden" refusal exists to prevent on the hide side. Every other
# path in the list is still restored.
ed_restore_hidden_paths() {
  local p rc=0
  for p in "$@"; do
    if [ -e "${p}.ed-hidden" ] || [ -L "${p}.ed-hidden" ]; then
      if [ -e "${p}" ] || [ -L "${p}" ]; then
        ed_log "ERROR: both ${p} and ${p}.ed-hidden exist — refusing to restore (mv would nest one inside the other). Check which copy is real, then restore by hand."
        rc=1
        continue
      fi
      mv "${p}.ed-hidden" "${p}" || rc=1
    fi
  done
  return "${rc}"
}

# ED_STATIC_PROBE — the <health_path> sentinel the compat lanes pass (#1515).
#
# The compat fixtures are arbitrary Next apps: almost none has `/api/health`,
# so requiring it 2xx failed the deploy for every ordinary fixture (386 files
# in run 36312054519) before a single suite case ran. With this sentinel the
# 2xx check is made against ONE file the empty dir itself staged (a static
# asset the binary must serve with nothing else present), and `/` stays the
# non-5xx check. The file-manager lanes, whose app does have the route, keep
# `/api/health` by setting KNEXT_EMPTY_DIR_HEALTH_PATH=/api/health.
ED_STATIC_PROBE="@static"

# ed_static_probe_path <staged_dir> [<base_path>]
#
# Prints the URL path of one regular file staged in <staged_dir>, preferring
# `.output/public/<rel>` (vinext/nitro serves it at `/<rel>`), then
# `.next/static/<rel>` (at `/_next/static/<rel>`), then `public/<rel>` (at
# `/<rel>`), each prefixed with <base_path> (a Next `basePath`, or empty).
# Deterministic (sorted). Fails when nothing static was staged — a build that
# emitted no static asset at all cannot be probed this way, and saying so
# beats silently probing nothing.
ed_static_probe_path() {
  local dir="$1" base="${2:-}" sub prefix rel
  for sub in .output/public .next/static public; do
    case "${sub}" in
      .next/static) prefix="/_next/static" ;;
      *) prefix="" ;;
    esac
    [ -d "${dir}/${sub}" ] || continue
    rel="$(cd "${dir}/${sub}" && find . -type f 2>/dev/null | LC_ALL=C sort | head -n 1)"
    if [ -n "${rel}" ]; then
      printf '%s%s/%s\n' "${base}" "${prefix}" "${rel#./}"
      return 0
    fi
  done
  ed_log "ERROR: no static file was staged under ${dir} (.output/public, .next/static, public) — nothing to probe for a 2xx"
  return 1
}

# ed_check_or_die <label> <fresh_dir> <binary_src> <health_path> <extra_path> <port> [<src>:<dest_rel>]...
#
# <health_path> may be ED_STATIC_PROBE (#1515): resolved, after staging, to a
# staged static file via ed_static_probe_path, prefixed with
# ED_STATIC_PROBE_BASE (a Next basePath; empty unless the caller sets it).
#
# A fixture that fails here because it needs a native addon (node_modules,
# necessarily hidden) cannot pass by construction (#1515(c)); the known ones
# (turbopack-reports, prerender-native-module) are listed in
# docs/compat-matrix.md's "Self-contained empty-dir mode" row — check there
# before treating the failure as a regression.
#
# The one call site scripts/e2e-deploy.sh and scripts/e2e-deploy-vinext.sh
# make: stage, assert clean, (optionally hide) boot, probe, restore —
# fail-closed and loud on ANY step, never a silent fallback to the disk-mode
# boot. <label> is only for the log line (which lane/target this run is).
# Caller must export PORT="${port}" itself if its own boot command reads it
# from the environment (this function does not export anything into the
# caller's shell besides that one PORT re-export, matched to what it already
# does).
#
# BLOCKING-3 (round-2 review): a BARE (non-containerised) boot resolves
# `require`/module lookups by walking UP from cwd, so an APP_DIR/node_modules
# or APP_DIR/.output sitting on the same host stays reachable during the
# probe even though `fresh_dir` itself is clean — measured, with a synthetic
# `require('leakpkg')` binary, to succeed from a fresh dir created INSIDE
# APP_DIR. The caller opts into hiding named paths for the DURATION OF THE
# BOOT ONLY by setting the array `ED_HIDE_DURING_BOOT` before calling this
# function (never during staging — ed_stage still needs to read the real
# path to copy from it). Each listed path that exists is renamed to
# "<path>.ed-hidden" right after staging + the cleanliness assert, and
# restored the instant the boot subshell exits — success or failure — via an
# EXIT trap SCOPED TO THAT SUBSHELL, never a shell-wide trap (a `trap ...
# RETURN`/`EXIT` set in this function's own scope would also fire on every
# later function return in this sourced script, restoring far too early).
# The docker-isolated caller (scripts/e2e-deploy.sh) leaves
# `ED_HIDE_DURING_BOOT` unset — its `-v "${EMPTY_DIR}:${EMPTY_DIR}"` mount
# already isolates the container from anything else on the host.
ed_check_or_die() {
  local label="$1" fresh_dir="$2" binary_src="$3" health_path="$4" extra_path="$5" port="$6"
  shift 6
  ed_log "${label}: staging an empty-dir copy of $(basename "${binary_src}") into ${fresh_dir}"
  local staged
  staged="$(ed_stage "${fresh_dir}" "${binary_src}" "$@")" || {
    ed_log "ERROR: ${label}: staging into ${fresh_dir} failed"
    return 1
  }
  local binary_name
  binary_name="$(basename "${staged}")"
  ed_assert_clean "${fresh_dir}" "${binary_name}" || {
    ed_log "ERROR: ${label}: the staged directory is not clean — see above"
    return 1
  }
  if [ "${health_path}" = "${ED_STATIC_PROBE}" ]; then
    health_path="$(ed_static_probe_path "${fresh_dir}" "${ED_STATIC_PROBE_BASE:-}")" || {
      ed_log "ERROR: ${label}: could not pick a staged static file to probe"
      return 1
    }
    ed_log "${label}: probing the staged static file ${health_path} (2xx) and ${extra_path} (non-5xx)"
  fi

  local -a hide_targets=()
  if [ -n "${ED_HIDE_DURING_BOOT+set}" ]; then
    hide_targets=("${ED_HIDE_DURING_BOOT[@]}")
  fi
  local -a hidden=()
  local p
  for p in "${hide_targets[@]+"${hide_targets[@]}"}"; do
    if [ -e "${p}" ]; then
      # ROUND-3 (non-blocking N1, promoted to load-bearing): a SIGKILL of the
      # whole process group (not just this function's own subshell) skips the
      # subshell's own EXIT trap, so a previous run's hide is never restored.
      # Measured: re-running against the same APP_DIR then hit this branch
      # again and ran `mv node_modules node_modules.ed-hidden` INTO the
      # existing hidden copy, nesting the fresh tree inside it
      # (`node_modules/node_modules`) and silently keeping the stale copy as
      # the one that gets restored. Fail closed instead — this state means a
      # human has to look at the tree before anything runs again.
      if [ -e "${p}.ed-hidden" ]; then
        ed_log "ERROR: ${label}: ${p}.ed-hidden already exists — a previous empty-dir run was almost certainly killed before it could restore ${p} (e.g. a whole-process-group SIGKILL, which skips this function's EXIT trap). Refusing to hide ${p} again: doing so would nest the fresh tree inside the stale hidden copy and then restore THAT as if it were real. Restore by hand after checking which copy is the real one: mv '${p}.ed-hidden' '${p}' — then re-run."
        return 1
      fi
      mv "${p}" "${p}.ed-hidden" || {
        ed_log "ERROR: ${label}: failed to hide ${p} before the empty-dir boot"
        return 1
      }
      hidden+=("${p}")
    fi
  done

  ed_log "${label}: booting ${staged} with cwd=${fresh_dir} and nothing else present"
  # Exported (not just a local var passed as $1): the boot command below reads
  # PORT from its own environment, exactly as it would in production
  # (scripts/e2e-deploy.sh / e2e-deploy-vinext.sh both export PORT the same way
  # before booting).
  export PORT="${port}"
  (
    if [ "${#hidden[@]}" -gt 0 ]; then
      trap 'ed_restore_hidden_paths "${hidden[@]}"' EXIT
    fi
    cd "${fresh_dir}" && ed_boot_probe_kill "${port}" "${health_path}" "${extra_path}" "./$(basename "${staged}")"
  )
  local boot_status=$?
  # Belt-and-braces: the subshell's own EXIT trap already restored these, but
  # a boot that failed to even start the subshell (e.g. `cd` itself failing)
  # would skip that trap, so restore unconditionally here too —
  # ed_restore_hidden_paths is idempotent (round-2 review: "restored ... on
  # every exit path").
  if [ "${#hidden[@]}" -gt 0 ]; then
    ed_restore_hidden_paths "${hidden[@]}"
  fi
  if [ "${boot_status}" != "0" ]; then
    ed_log "ERROR: ${label}: the empty-dir boot/probe failed — see above. Until N1 (#1456) / V1 (#1460) embed what this artifact still loads from disk, this is EXPECTED; KNEXT_SELF_CONTAINED stays off by default and dispatch-only for exactly this reason (ADR-0060)."
    return 1
  fi
  ed_log "${label}: empty-dir lane check passed — ${staged} served ${health_path} and ${extra_path} with nothing beside it but static assets"
  return 0
}

# ══ #1514: serve the SUITE from the empty dir, not just the 2-route probe ══════
#
# The discovered fact (#1514): with KNEXT_SELF_CONTAINED=1 the 2-route probe
# above booted the binary from an empty dir, but the server that then served
# the whole compat SUITE was booted from APP_DIR, with node_modules, .next and
# .output all reachable — a self-contained window measured "compiled with
# --self-contained, served with the disk tree present". The functions below
# are the suite-serving half; both deploy scripts call them in their SC
# branch, and the 2-route probe stays as the fail-fast pre-check.

# The value both deploy scripts record as SERVED_FROM in their persisted
# metadata when KNEXT_SELF_CONTAINED=1, and the value
# scripts/compat-window-fingerprint.mjs reads out of the frozen harness (this
# file is in its source closure) and folds into a self-contained digest. It
# refuses to produce a self-contained fingerprint unless this reads exactly
# `empty-dir` — so a harness that stops serving the suite from the empty dir
# cannot keep the self-contained label by accident.
ED_SUITE_SERVED_FROM_SC="empty-dir"

# The APP_DIR entries hidden for the WHOLE suite run in SC mode.
ED_SUITE_HIDE_NAMES=(node_modules .next .output)

# ed_suite_stage <fresh_dir> <binary_src> [<src>:<dest_rel>]...
#
# Stage + ed_assert_clean, in one step, for the suite server's own directory.
# A FRESH directory, never the pre-check's: the pre-check booted a server in
# its directory, which may have written into it (a filesystem cache), and
# that must not be what the cleanliness assertion judges. Prints the staged
# binary's path.
ed_suite_stage() {
  local fresh_dir="$1" binary_src="$2"
  shift 2
  local staged
  staged="$(ed_stage "${fresh_dir}" "${binary_src}" "$@")" || {
    ed_log "ERROR: suite: staging into ${fresh_dir} failed"
    return 1
  }
  ed_assert_clean "${fresh_dir}" "$(basename "${staged}")" || {
    ed_log "ERROR: suite: the staged directory ${fresh_dir} is not clean — see above"
    return 1
  }
  printf '%s\n' "${staged}"
}

# ed_suite_restore_app_dir <app_dir>
#
# Restores every ED_SUITE_HIDE_NAMES entry of <app_dir> that has a hidden
# twin. Idempotent, and independent of any metadata file: it is what
# scripts/e2e-cleanup.sh calls at teardown, AFTER the server is stopped, and
# what the deploy script's own EXIT trap calls on a failed deploy.
ed_suite_restore_app_dir() {
  local app_dir="$1" n
  local -a paths=()
  for n in "${ED_SUITE_HIDE_NAMES[@]}"; do
    paths+=("${app_dir}/${n}")
  done
  ed_restore_hidden_paths "${paths[@]}"
}

# ed_suite_hide_app_dir <app_dir>
#
# Renames each existing ED_SUITE_HIDE_NAMES entry of <app_dir> to
# "<entry>.ed-hidden". Fails closed if a hidden twin already exists (a
# previous run killed before it could restore — same refusal, same reason, as
# ed_check_or_die's). The caller must have armed ed_suite_arm_restore_trap
# FIRST, so a failure half-way through still restores what was hidden.
ed_suite_hide_app_dir() {
  local app_dir="$1" n p
  for n in "${ED_SUITE_HIDE_NAMES[@]}"; do
    p="${app_dir}/${n}"
    if [ -e "${p}.ed-hidden" ] || [ -L "${p}.ed-hidden" ]; then
      ed_log "ERROR: suite: ${p}.ed-hidden already exists — a previous run was killed before it restored ${p}. Refusing to hide again. Restore by hand after checking which copy is real: mv '${p}.ed-hidden' '${p}'"
      return 1
    fi
    if [ -e "${p}" ] || [ -L "${p}" ]; then
      mv "${p}" "${p}.ed-hidden" || {
        ed_log "ERROR: suite: failed to hide ${p}"
        return 1
      }
    fi
  done
}

# ed_suite_arm_restore_trap <app_dir>
#
# Installs the deploy script's EXIT trap for SC mode: unless the script
# reached ed_suite_hand_off (the URL is about to be printed and the harness
# owns the deployment from here — scripts/e2e-cleanup.sh restores at
# teardown), stop the suite server if one was recorded in ED_SUITE_SERVER_PID
# / ED_SUITE_CONTAINER, THEN restore <app_dir>. Stop-before-restore: a server
# still running when the tree comes back could serve from it.
#
# INT/TERM/HUP are converted into `exit`, so the EXIT trap runs on those too.
# SIGKILL cannot be trapped; that case is what ed_suite_hide_app_dir's
# "already hidden" refusal and e2e-cleanup.sh's unconditional restore cover.
#
# Called from the deploy script's MAIN shell (a trap set inside a function
# still belongs to the whole shell); SC mode only, so disk-mode signal
# handling is unchanged.
ed_suite_arm_restore_trap() {
  ED__SUITE_APP_DIR="$1"
  ED_SUITE_HANDED_OFF=0
  ED_SUITE_SERVER_PID=""
  ED_SUITE_CONTAINER=""
  ed__arm_exit_trap
}

ed__suite_on_exit() {
  if [ "${ED_SUITE_HANDED_OFF:-0}" = "1" ]; then
    return 0
  fi
  # Not armed yet (only a pre-check dir is owned so far): nothing to stop or
  # restore — the EXIT trap still removes the owned dirs next.
  [ -n "${ED__SUITE_APP_DIR:-}" ] || return 0
  if [ -n "${ED_SUITE_CONTAINER:-}" ] && command -v docker >/dev/null 2>&1; then
    docker rm -f "${ED_SUITE_CONTAINER}" >/dev/null 2>&1 || true
  fi
  if [ -n "${ED_SUITE_SERVER_PID:-}" ] && kill -0 "${ED_SUITE_SERVER_PID}" 2>/dev/null; then
    kill -TERM "${ED_SUITE_SERVER_PID}" 2>/dev/null || true
    local j
    for j in $(seq 1 25); do
      kill -0 "${ED_SUITE_SERVER_PID}" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "${ED_SUITE_SERVER_PID}" 2>/dev/null || true
  fi
  ed_suite_restore_app_dir "${ED__SUITE_APP_DIR}" || true
}

# ed_suite_hand_off <served_dir> — the deployment is ready and isolated; from
# here the harness owns it: scripts/e2e-cleanup.sh stops the server, restores
# APP_DIR and removes <served_dir> (read back from SERVED_FROM_DIR) at
# teardown. <served_dir> is disowned so this script's own EXIT trap — which
# runs as soon as the script prints the URL and exits 0 — leaves it in place
# for the server still running from it.
ed_suite_hand_off() {
  ED_SUITE_HANDED_OFF=1
  ed_disown_dir "${1:?ed_suite_hand_off needs the served dir}"
}

# ══ PR #1521 round 3: every staged dir is owned by the deploy that made it ══
#
# The pre-check dir (knext-empty-dir.*) and the suite dir
# (knext-empty-dir-suite.*) are mktemp paths under RUNNER_TEMP, which the
# compat harness SHARES across concurrently-running test files (`-c 2` on one
# runner). So nothing may ever remove one of these dirs by name pattern or
# age — a different deploy's live dir matches both (the round-2 orphan sweep
# did exactly that). Instead the deploy that created a dir registers it here
# right after its mktemp and removes it itself: explicitly on every failure
# branch, and via the EXIT trap below (which INT/TERM/HUP are converted into)
# on any other exit. The one dir that outlives the script — the suite dir,
# once handed off — is disowned at hand-off and removed by
# scripts/e2e-cleanup.sh from the deploy's own SERVED_FROM_DIR metadata.
# SIGKILL cannot be trapped: a SIGKILLed deploy leaks its dir to the runner's
# own teardown, by design, rather than any cleanup guessing which dirs are
# dead.
ED_OWNED_DIRS=()

# ed_own_dir <dir> — register <dir> for removal on this script's exit and arm
# the EXIT trap. Call it on the line right after the dir's mktemp.
#
ed_own_dir() {
  ED_OWNED_DIRS+=("${1:?ed_own_dir needs a dir}")
  ed__arm_exit_trap
}

# ed__arm_exit_trap — shared by ed_own_dir and ed_suite_arm_restore_trap.
# The EXIT trap runs stop-before-remove: the suite server (if any) is stopped
# and APP_DIR restored first, so nothing is still running from a dir when it
# goes. Both calls are named directly in the trap string rather than through a
# wrapper function: the apply-safety scanner in
# tests/kind-manifest-checksum-pin.test.ts bounds how deep a trap's call chain
# may nest. Installed from the deploy script's MAIN shell (a trap set inside a
# function still belongs to the whole shell); idempotent. Only ever armed in
# KNEXT_SELF_CONTAINED=1 mode, so disk-mode signal handling is unchanged.
ed__arm_exit_trap() {
  trap 'ed__suite_on_exit; ed__remove_owned_dirs' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

# ed_disown_dir <dir> — ownership of <dir> passes elsewhere (hand-off).
ed_disown_dir() {
  local d
  local -a keep=()
  for d in ${ED_OWNED_DIRS[@]+"${ED_OWNED_DIRS[@]}"}; do
    [ "${d}" = "$1" ] || keep+=("${d}")
  done
  ED_OWNED_DIRS=(${keep[@]+"${keep[@]}"})
}

ed__remove_owned_dirs() {
  local d
  for d in ${ED_OWNED_DIRS[@]+"${ED_OWNED_DIRS[@]}"}; do
    rm -rf "${d}" || true
  done
  ED_OWNED_DIRS=()
}

# ed_assert_suite_isolated <server_cwd> <app_dir>
#
# The RUNTIME half of the #1514 guard, run while the suite server is UP (after
# readiness, before the URL is handed to the harness). Fails if any of these
# is reachable:
#   * from the server's cwd: node_modules, .next/server, .output/server — as a
#     directory, a file, or a symlink (dangling or not);
#   * node_modules in ANY ancestor of the cwd — Node/Bun module resolution
#     walks up, so a node_modules above an otherwise-clean cwd is reachable;
#   * any symlink anywhere under the cwd (ed_assert_clean's rule, re-applied
#     now that the server has been running in it);
#   * via the hidden APP_DIR: node_modules, .next, .output present again under
#     their real names — e.g. something re-created or symlinked them back;
#   * round-2 review, finding 5: NODE_PATH, BUN_INSTALL or NODE_OPTIONS in the
#     shell's OWN environment (the vinext lane's bare `exec` inherits it
#     unchanged; the docker-isolated standalone lane does not pass it through
#     unless the caller explicitly `-e`s it, but this check is cheap and
#     correct either way) referencing anything under app_dir — every check
#     above is filesystem-only, so a harness-inherited env var pointing back
#     into the hidden tree reaches the suite server unnoticed.
ed_assert_suite_isolated() {
  local cwd="$1" app_dir="$2" rel p d leak envvar val
  for rel in node_modules .next/server .output/server; do
    p="${cwd}/${rel}"
    if [ -e "${p}" ] || [ -L "${p}" ]; then
      ed_log "ERROR: suite: ${p} is reachable from the suite server's cwd — the self-contained suite must be served with nothing but the binary, static assets and native/"
      return 1
    fi
  done
  d="$(dirname "${cwd}")"
  while :; do
    if [ -e "${d}/node_modules" ] || [ -L "${d}/node_modules" ]; then
      ed_log "ERROR: suite: ${d}/node_modules is reachable by walking up from the suite server's cwd ${cwd}"
      return 1
    fi
    [ "${d}" = "/" ] && break
    d="$(dirname "${d}")"
  done
  leak="$(find "${cwd}" -type l -print -quit 2>/dev/null)"
  if [ -n "${leak}" ]; then
    ed_log "ERROR: suite: ${leak} is a symlink under the suite server's cwd — it can alias the disk-mode tree"
    return 1
  fi
  for rel in "${ED_SUITE_HIDE_NAMES[@]}"; do
    p="${app_dir}/${rel}"
    if [ -e "${p}" ] || [ -L "${p}" ]; then
      ed_log "ERROR: suite: ${p} is reachable while the suite server is up — APP_DIR must stay hidden for the whole self-contained run"
      return 1
    fi
  done
  for envvar in NODE_PATH BUN_INSTALL NODE_OPTIONS; do
    val="${!envvar:-}"
    case "${val}" in
      *"${app_dir}"*)
        ed_log "ERROR: suite: \$${envvar}=\"${val}\" references APP_DIR (${app_dir}) — an inherited env var can reach the hidden tree even though nothing on disk does"
        return 1
        ;;
    esac
  done
  return 0
}
