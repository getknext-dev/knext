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
# .next/static, no .output/), then boot the binary with that directory as its
# cwd and confirm it serves at least two routes with nothing else present.
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

# ed_assert_clean <fresh_dir>
#
# Fails (logs + returns 1) if `node_modules/` or `.output/` is present, or if
# `.next/` contains anything other than a `static` entry. This is the
# mutation-proved guard (scripts/mutation-prove-empty-dir-guard.mjs): reaching
# a version that never inspects these must let a PLANTED node_modules pass.
ed_assert_clean() {
  local dir="$1"
  local forbidden
  for forbidden in node_modules .output; do
    if [ -e "${dir}/${forbidden}" ]; then
      ed_log "ERROR: ${dir}/${forbidden} is present — the empty-dir lane must boot from nothing but the binary + static assets + native/"
      return 1
    fi
  done
  if [ -e "${dir}/.next" ]; then
    if [ ! -d "${dir}/.next" ]; then
      ed_log "ERROR: ${dir}/.next exists and is not a directory"
      return 1
    fi
    local entry name
    for entry in "${dir}/.next"/* "${dir}/.next"/.[!.]*; do
      [ -e "${entry}" ] || continue
      name="$(basename "${entry}")"
      if [ "${name}" != "static" ]; then
        ed_log "ERROR: ${dir}/.next contains '${name}' — only .next/static may accompany a self-contained binary (the rest is the disk-mode tree leaking into the empty dir)"
        return 1
      fi
    done
  fi
  return 0
}

# ed_probe_http <port> <path>
#
# One request; ANY complete HTTP response counts — matches the
# KNEXT_WARM_ACCEPT_ANY_STATUS convention already used elsewhere in this
# harness (a rendered error page still proves the runtime is alive and
# routing). 5s timeout.
ed_probe_http() {
  local port="$1" path="$2"
  node -e '
    const http = require("node:http");
    const port = Number(process.argv[1]);
    const path = process.argv[2];
    const req = http.get({ host: "127.0.0.1", port, path, timeout: 5000 }, (res) => {
      res.resume();
      res.on("end", () => process.exit(0));
      res.on("error", () => process.exit(1));
    });
    req.on("timeout", () => { req.destroy(); process.exit(1); });
    req.on("error", () => process.exit(1));
  ' "${port}" "${path}"
}

# ed_boot_probe_kill <port> <health_path> <extra_path> <cmd...>
#
# Runs <cmd...> in the background (PORT must already be exported by the
# caller — the command reads it the same way it would in production), waits
# up to 20s for a TCP accept, probes <health_path> then <extra_path>, kills
# the process, and returns 0 only if the TCP probe AND both HTTP probes
# succeeded. Always kills whatever it started, on every exit path.
ed_boot_probe_kill() {
  local port="$1" health_path="$2" extra_path="$3"
  shift 3
  ( exec "$@" ) &
  local pid=$!
  local ready=0 i
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
    kill "${pid}" 2>/dev/null || true
    wait "${pid}" 2>/dev/null
    return 1
  fi
  local ok=0
  if ed_probe_http "${port}" "${health_path}" && ed_probe_http "${port}" "${extra_path}"; then
    ok=1
  else
    ed_log "ERROR: the empty-dir boot did not answer both ${health_path} and ${extra_path}"
  fi
  kill "${pid}" 2>/dev/null || true
  wait "${pid}" 2>/dev/null
  [ "${ok}" = "1" ]
}

# ed_check_or_die <label> <fresh_dir> <binary_src> <health_path> <extra_path> <port> [<src>:<dest_rel>]...
#
# The one call site scripts/e2e-deploy.sh and scripts/e2e-deploy-vinext.sh
# make: stage, assert clean, boot, probe — fail-closed and loud on ANY step,
# never a silent fallback to the disk-mode boot. <label> is only for the log
# line (which lane/target this run is). Caller must export PORT="${port}"
# itself if its own boot command reads it from the environment (this function
# does not export anything into the caller's shell).
ed_check_or_die() {
  local label="$1" fresh_dir="$2" binary_src="$3" health_path="$4" extra_path="$5" port="$6"
  shift 6
  ed_log "${label}: staging an empty-dir copy of $(basename "${binary_src}") into ${fresh_dir}"
  local staged
  staged="$(ed_stage "${fresh_dir}" "${binary_src}" "$@")" || {
    ed_log "ERROR: ${label}: staging into ${fresh_dir} failed"
    return 1
  }
  ed_assert_clean "${fresh_dir}" || {
    ed_log "ERROR: ${label}: the staged directory is not clean — see above"
    return 1
  }
  ed_log "${label}: booting ${staged} with cwd=${fresh_dir} and nothing else present"
  # Exported (not just a local var passed as $1): the boot command below reads
  # PORT from its own environment, exactly as it would in production
  # (scripts/e2e-deploy.sh / e2e-deploy-vinext.sh both export PORT the same way
  # before booting).
  export PORT="${port}"
  if ! (cd "${fresh_dir}" && ed_boot_probe_kill "${port}" "${health_path}" "${extra_path}" "./$(basename "${staged}")"); then
    ed_log "ERROR: ${label}: the empty-dir boot/probe failed — see above. Until N1 (#1456) / V1 (#1460) embed what this artifact still loads from disk, this is EXPECTED; KNEXT_SELF_CONTAINED stays off by default and dispatch-only for exactly this reason (ADR-0060)."
    return 1
  fi
  ed_log "${label}: empty-dir lane check passed — ${staged} served ${health_path} and ${extra_path} with nothing beside it but static assets"
  return 0
}
