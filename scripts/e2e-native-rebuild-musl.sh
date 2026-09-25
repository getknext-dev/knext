#!/bin/sh
#
# scripts/e2e-native-rebuild-musl.sh — rebuild native (*.node) addons for musl,
# run INSIDE the pinned standalone-on-Bun alpine image (scripts/e2e-deploy.sh).
#
# Review finding on PR #1230 (hypothesis A, confirmed): the compat harness
# installs every fixture's deps ONCE on the glibc ubuntu-latest runner —
# node-pre-gyp/prebuild-install resolve a GLIBC-linked prebuilt .node binary
# there (e.g. sqlite3's napi-v3-linux-x64 binding). Booting the compiled
# standalone-on-Bun exec inside the pinned musl alpine image (#1230) then
# tries to dlopen that same glibc binary and fails:
#
#   Error [ERR_DLOPEN_FAILED]: .../node_sqlite3.node is linked against glibc
#   (DT_NEEDED libm.so.6), but this Bun build uses musl. glibc-targeted
#   native addons cannot be loaded on Alpine/musl even with gcompat.
#
# The REAL shipped image does not hit this: its Dockerfile installs the app's
# deps INSIDE the alpine build stage, so native addons are musl-linked from
# the start. This script makes the harness match that.
#
# ROUND 2 (review finding on the round-1 fix): round 1 ran `npm run install
# --if-present` INSIDE the TRACED package directory
# (`.next/standalone/node_modules/<pkg>`). Next's output-file tracing keeps
# only what the RUNTIME require() graph reaches — sqlite3's own JS never
# requires `node-pre-gyp` (that is install-time-only, invoked by npm's
# lifecycle script), so the traced tree never carries it, and the "rebuild"
# died immediately: `sh: node-pre-gyp: not found`. The dlopen error then
# resurfaced unchanged. Reproduced directly against a TRACED tree (not a
# full install, which is what round 1's repro used and why it missed this).
#
# FIX: for each *.node-owning package, read its {name, version} from the
# TRACED copy's own package.json, then do a FRESH `npm install` of that exact
# spec into a scratch prefix. A fresh install brings its own install-time
# tooling (node-pre-gyp and friends) along as real dependencies, so it can
# fetch a musl prebuild if one exists or fall back to building from source —
# same as a real `npm install` on a musl host would. The resulting
# node_modules/<pkg> directory then REPLACES the traced copy wholesale (not
# just the .node file) — whatever the fresh musl install produced is what
# ships to the running server, consistent with how the standalone tree
# already treats native modules as pure on-disk files (never bundled).
#
# Toolchain tradeoff, stated rather than hidden: sqlite3@5.0.2 (and likely
# other npm-native-addon packages of its era) ships NO musl prebuild, so the
# fresh install falls back to compiling from source — which needs
# python3/make/g++ INSIDE this image. `apk add` costs a few seconds and the
# alpine repo carries a real gcc/musl toolchain, so that is the option taken
# here (over a second install into a throwaway node:22-alpine container and
# copying the result across, which would need docker-in-docker or a sibling
# container + volume dance for no correctness gain — same toolchain, same
# alpine base, just relocated).
#
# Usage (run INSIDE the alpine container, e.g. via `docker run ... sh
# e2e-native-rebuild-musl.sh <root>`):
#   sh e2e-native-rebuild-musl.sh <standalone-root>
#
# Best-effort per package: a rebuild failure (e.g. no source available, no
# musl prebuilt, a toolchain gap, a registry fetch failure) WARNS and
# continues — it must not brick the whole bun lane for fixtures unrelated to
# the addon that failed. The original dlopen error simply resurfaces for
# that one fixture, same as before this script existed; nothing is masked.
#
# ROUND 6 (adversarial re-review on a 16/16-green run, four defects, all
# confirmed from live CI logs — run 35868561131):
#
#   1. apk's stderr was being swallowed (`>/dev/null 2>&1`), so a real apk
#      failure under `set -eu` aborted with no diagnostic at all. FIX: only
#      stdout is silenced now (`>/dev/null`); apk's own error output flows.
#
#   2. `@img/sharp-linux-<arch>` (the glibc-only platform package Next's
#      output tracer keeps for a next/image fixture) has NO source fallback —
#      sharp is a prebuilt-binary-only distribution, unlike sqlite3. A fresh
#      install of that exact name under musl fails EBADPLATFORM outright.
#      FIX: `musl_install_sibling()` fresh-installs the MUSL counterpart
#      (`@img/sharp-linuxmusl-<arch>`) as a NEW sibling instead of trying to
#      rebuild the glibc one — sharp's own require() picks whichever platform
#      package is present at runtime. sharp also needs its libvips shared
#      library, packaged SEPARATELY as `@img/sharp-libvips-linux(musl)-<arch>`
#      with its OWN, DIFFERENT version number (sharp 0.34.5 pins libvips
#      1.2.4) — read from the traced package's own optionalDependencies and
#      installed the same way.
#
#   3. The walk-up to find an owning package.json for a *.node hit could land
#      on ROOT's own manifest (Next's tracer emits one at the standalone
#      root) or on any directory NOT nested under node_modules/, and then run
#      `npm install <name>@<version>` from the public registry AS ROOT — a
#      dependency-confusion risk, and on a *.node hit at the tree's own root
#      the subsequent unconditional replace could delete ROOT itself. FIX: a
#      package is only ever treated as an addon if its owning dir is (a) not
#      ROOT and (b) matches `*/node_modules/*` — anything else WARNS and is
#      skipped, never installed against.
#
#   4. The pid-attribution guard in scripts/e2e-deploy.sh
#      (`port_owned_by_server`) is silently defeated for compiled deploys:
#      `docker run` (no `--user`) boots the container as root, and an
#      unprivileged CI runner user calling `ss -ltnp` cannot see PID detail
#      for a different-uid socket (kernel sock_diag same-uid visibility) —
#      the check always fell back to "cannot verify" and only warned. This
#      lives in scripts/e2e-deploy.sh, not here, but is recorded in this
#      round-6 note because it was found and fixed alongside the three
#      defects above: `docker run` now passes `--user "$(id -u):$(id -g)"`,
#      which also stops the container leaving root-owned files behind.
#
# ROUND 7 (#1257 — CI supply-chain surface): this whole SCRIPT still runs as
# root inside the container (apk add needs it), and every `npm install`
# — install scripts included — ran as that same root, with no lockfile, so
# npm resolved whatever the registry currently serves for a name's
# TRANSITIVE deps on every single deploy. Two independent fixes, addressing
# each acceptance criterion in #1257:
#
#   - INSTALL SCRIPTS NO LONGER RUN AS ROOT. `apk add`s `su-exec` (the
#     standard Alpine lightweight `su`/`gosu` equivalent) alongside the
#     toolchain, creates an unprivileged `builder` user, and every
#     `npm install`/`npm ci` call is `su-exec`'d to that user, each into a
#     freshly `chown`'d scratch dir it owns. `apk add` itself is the only
#     step that still needs root — it is the last root-run step before any
#     package.json's install script (or npm/node-gyp's own machinery) ever
#     executes. The final ownership restore (the EXIT trap below) already
#     re-chowns everything under ROOT back to the invoking host user
#     regardless of which container-internal user wrote it, so this changes
#     WHO the install-time code runs as, not the end result on disk.
#   - NPM RESOLUTION IS REPRODUCIBLE FOR THE KNOWN CORPUS. For every
#     name@version this script has a COMMITTED, real `npm ci`-compatible
#     lockfile for (`scripts/musl-native-lockfiles/<safe-name>-<version>/`,
#     generated once via `npm install --package-lock-only`, mounted
#     alongside this script — see scripts/e2e-deploy.sh), it runs `npm ci`
#     against that lockfile instead of a fresh `npm install`: every
#     transitive dependency's exact version AND its registry-recorded
#     integrity hash are fixed, not re-resolved against whatever the
#     registry serves today. A name@version this script has NOT seen before
#     (no committed lockfile — e.g. a new fixture's addon) falls back to the
#     pre-existing best-effort fresh `npm install`, loudly marked as the
#     non-reproducible path so it is never confused with the pinned one.
#     `scripts/generate-musl-native-lockfile.sh` is the (real-network,
#     contributor-run, not CI-run) tool that adds a new pin to that corpus.
#
# NOT done here, and stated rather than left implicit (#1257's other
# acceptance leg): the `apk add` toolchain packages themselves are pinned by
# NAME only, not by an exact NEVRA version or content digest — this script
# cannot safely author those pins without a live container to resolve
# against (no local docker in this environment; guessing a version risks
# either being wrong, in which case CI reds outright, or being silently
# stale). Alpine's package index IS signature-verified by `apk` itself
# against Alpine's own trusted keys (not a bare unauthenticated mirror
# fetch), and the base image `apk add` runs inside is already pinned by OCI
# digest (`STANDALONE_BUN_IMAGE` in scripts/e2e-deploy.sh) — so this is a
# real, if narrower, gap than a full digest pin: a mirror-side security
# patch to python3/make/g++/npm/su-exec between two runs of this script can
# still shift the exact toolchain build without either pin changing. Tracked
# to close in a follow-up once a live CI run's `apk add` output supplies the
# exact resolved versions to pin against (see the PR description).
set -eu

ROOT="${1:?usage: e2e-native-rebuild-musl.sh <standalone-root> [lockfiles-dir]}"
# Optional: a bind-mounted copy of scripts/musl-native-lockfiles/ (#1257) —
# absent (back-compat / the pre-#1257 call shape) means every install falls
# back to the non-reproducible fresh-install path, same as before this
# round. See scripts/e2e-deploy.sh for how this is mounted in practice.
LOCKFILES_DIR="${2:-}"

HITS="$(find "${ROOT}" -name '*.node' -type f 2>/dev/null || true)"
if [ -z "${HITS}" ]; then
  echo "[native-rebuild] no *.node files under ${ROOT} — nothing to rebuild"
  exit 0
fi

echo "[native-rebuild] found native addon(s):"
echo "${HITS}"

# Ownership restore (review finding): this container runs as root (`apk add`
# needs it — see the toolchain tradeoff note below), so every file it
# creates or copies under the bind-mounted ROOT from here on is root-owned
# on the HOST when the container exits. ROOT itself is owned by the
# invoking runner user (it is a bind mount of the host's own checkout/
# scratch dir), so `stat`-ing it NOW, before any writes, captures the
# correct uid:gid to restore — done unconditionally at exit via a trap, so
# a mid-loop failure still leaves the tree owned by the runner, not root.
ROOT_OWNER="$(stat -c '%u:%g' "${ROOT}")"
restore_ownership() {
  chown -R "${ROOT_OWNER}" "${ROOT}" 2>/dev/null || true
}
trap restore_ownership EXIT

# python3/make/g++: the node-gyp toolchain a from-source rebuild needs (see
# the header's toolchain tradeoff note). npm: the pinned alpine base ships
# bun only (no npm) — see Dockerfile.standalone.hbs's "oven/bun ships bun
# ONLY" note. su-exec: what drops root before any install-time code runs
# (#1257 round 7 — see the header note). stdout only is suppressed — an apk
# failure under `set -eu` must not abort with zero diagnostic output (review
# finding): stderr reaches the caller's log.
apk add --no-cache python3 make g++ npm su-exec >/dev/null

# #1257 round 7 — an unprivileged user every npm install/ci below is
# `su-exec`'d to, so install scripts (and anything node-gyp/npm itself runs)
# never execute as root. `-D` (no password), `-H` (no default /home/<user>
# creation — BUILD_HOME below is created explicitly instead, since it needs
# to exist and be owned by `builder` before `adduser` would otherwise try to
# create+chown it under a path this script does not control).
BUILD_HOME="$(mktemp -d)"
# -s /bin/sh, not /sbin/nologin: su-exec execs the target command directly
# (never a login shell), so the shell field is inert either way — /bin/sh is
# used only because it is guaranteed present on every Alpine image via
# busybox, whereas /sbin/nologin is not always installed.
adduser -D -H -h "${BUILD_HOME}" -s /bin/sh builder
chown -R builder:builder "${BUILD_HOME}"

SCRATCH_ROOT="$(mktemp -d)"
# #1257 round 7 — LIVE-VERIFIED bug (a direct `docker run` repro, not
# reasoned from docs): `mktemp -d` makes SCRATCH_ROOT `drwx------` root-owned.
# Chowning a per-package dir NESTED under it to `builder` is not enough —
# directory TRAVERSAL requires execute permission on every ANCESTOR
# directory too, and SCRATCH_ROOT itself had none for `builder`. Without
# this, `su-exec builder ... npm ci` inside a per-package dir failed with
# npm's generic "can only install with an existing package-lock.json" (npm
# could not even STAT the files, let alone read them) — a misleading error
# that looks like a missing/corrupt lockfile, not a permissions problem.
# 0711: execute-only for group/other (traversal into a NAMED child works;
# `ls`/`cat` directly against SCRATCH_ROOT itself still does not) — the
# actual package dirs underneath stay individually `chown`'d to `builder`.
chmod 0711 "${SCRATCH_ROOT}"
DONE=""

# Run <cmd...> as the unprivileged `builder` user, with HOME pointed at the
# dedicated (builder-owned) home dir so npm's own cache/config never touches
# anything root-owned. `env` (not a bare `su-exec builder VAR=val cmd`,
# which su-exec/exec would treat `VAR=val` as the command name, not an
# assignment) applies the extra env vars to the exec'd process only.
run_as_builder() { # [VAR=val ...] -- <cmd...>
  su-exec builder:builder env HOME="${BUILD_HOME}" "$@"
}

# lockfile_key / pinned_lockfile_dir_for: pure lookup helpers, kept in a
# separate side-effect-free lib so they are independently testable without
# docker/apk — see that file's header and tests/musl-lockfile-lookup.test.ts.
# shellcheck source=./lib/musl-lockfile-lookup.sh
. "$(dirname "$0")/lib/musl-lockfile-lookup.sh"

# Install <spec> (name@version) for musl and copy the resulting
# node_modules/<dest-name> in at ${ROOT}/node_modules/<dest-name> — used by
# the sharp special-case below, where the destination name (the musl
# package) differs from nothing else in scope but must be threaded through
# explicitly. Best-effort: a failure WARNs and returns non-zero, never
# aborts the script (the caller decides whether that's fatal for it).
#
# #1257 round 7 — REPRODUCIBLE when a committed lockfile matches <spec>'s
# own name@version: `npm ci` against it installs the exact transitive
# closure (versions AND integrity hashes) that lockfile records, never
# re-resolving against whatever the registry serves right now. Otherwise
# falls back to the pre-existing fresh `npm install` (best-effort, not
# reproducible) — both paths now run as the unprivileged `builder` user.
musl_install_sibling() { # <spec> <dest-name>
  _spec="$1"
  _dest_name="$2"
  _spec_name="${_spec%@*}"
  _spec_version="${_spec##*@}"
  _pkg_scratch="$(mktemp -d "${SCRATCH_ROOT}/pkg.XXXXXX")"
  chown builder:builder "${_pkg_scratch}"
  _pinned_dir="$(pinned_lockfile_dir_for "${_spec_name}" "${_spec_version}")"
  if [ -n "${_pinned_dir}" ]; then
    cp "${_pinned_dir}/package.json" "${_pkg_scratch}/package.json"
    cp "${_pinned_dir}/package-lock.json" "${_pkg_scratch}/package-lock.json"
    chown builder:builder "${_pkg_scratch}/package.json" "${_pkg_scratch}/package-lock.json"
    echo "[native-rebuild] ${_spec}: using the committed, reproducible lockfile at ${_pinned_dir}"
    if ! (cd "${_pkg_scratch}" && run_as_builder npm ci --no-audit --no-fund >"${_pkg_scratch}.log" 2>&1); then
      echo "[native-rebuild] WARNING: reproducible 'npm ci' of ${_spec} failed (the committed lockfile may be stale)"
      tail -c 4096 "${_pkg_scratch}.log" 2>/dev/null || true
      return 1
    fi
  elif ! (cd "${_pkg_scratch}" && run_as_builder env npm_config_build_from_source=true npm install --no-save --no-audit --no-fund "${_spec}" >"${_pkg_scratch}.log" 2>&1); then
    echo "[native-rebuild] WARNING: fresh (non-reproducible — no committed lockfile for ${_spec}) musl install of ${_spec} failed"
    tail -c 4096 "${_pkg_scratch}.log" 2>/dev/null || true
    return 1
  fi
  _fresh_dir="${_pkg_scratch}/node_modules/${_dest_name}"
  if [ ! -d "${_fresh_dir}" ]; then
    echo "[native-rebuild] WARNING: install of ${_spec} produced no node_modules/${_dest_name}"
    return 1
  fi
  _dest="${ROOT}/node_modules/${_dest_name}"
  mkdir -p "$(dirname "${_dest}")"
  rm -rf "${_dest}"
  cp -a "${_fresh_dir}" "${_dest}"
  echo "[native-rebuild] added ${_dest_name} (from ${_spec}) at ${_dest}"
  return 0
}

echo "${HITS}" | while IFS= read -r f; do
  [ -z "${f}" ] && continue
  # Walk up from the .node file to the nearest package.json — the addon
  # package's own root, whatever depth node_modules nested it at.
  d="$(dirname "${f}")"
  while [ "${d}" != "/" ] && [ "${d}" != "${ROOT}" ] && [ ! -f "${d}/package.json" ]; do
    d="$(dirname "${d}")"
  done
  # Review finding: the loop above stops walking the instant `d` reaches
  # ROOT, WHETHER OR NOT ROOT itself has a package.json — and Next's own
  # output tracing DOES emit one at the standalone root. Without this guard,
  # a .node file the walk-up cannot pin to a node_modules-nested package
  # would fall through to ROOT's OWN manifest: NAME/VERSION below would
  # become the fixture app's own name (a real dependency-confusion risk —
  # `npm install <appname>@<version>` from the public registry, as root),
  # and the destructive `rm -rf "${d}"` further down would target ROOT
  # itself. Refuse BOTH failure shapes explicitly: `d` must be ROOT-nested
  # under a real `node_modules/` segment, never ROOT itself.
  if [ "${d}" = "${ROOT}" ]; then
    echo "[native-rebuild] WARNING: walked up to ROOT (${ROOT}) looking for a package.json above ${f} — refusing to treat ROOT's own manifest as an addon package; skipping"
    continue
  fi
  case "${d}" in
  */node_modules/*) : ;;
  *)
    echo "[native-rebuild] WARNING: ${d} is not nested under node_modules/ — refusing to treat it as an addon package; skipping ${f}"
    continue
    ;;
  esac
  if [ ! -f "${d}/package.json" ]; then
    echo "[native-rebuild] WARNING: no package.json found above ${f} — skipping"
    continue
  fi
  # A package can own more than one .node file (multiple napi targets) —
  # rebuild it once.
  case " ${DONE} " in
  *" ${d} "*)
    continue
    ;;
  esac
  DONE="${DONE} ${d}"

  NAME="$(node -e '
    try {
      process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).name || "");
    } catch { /* leave empty */ }
  ' "${d}/package.json" 2>/dev/null || true)"
  VERSION="$(node -e '
    try {
      process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version || "");
    } catch { /* leave empty */ }
  ' "${d}/package.json" 2>/dev/null || true)"
  if [ -z "${NAME}" ] || [ -z "${VERSION}" ]; then
    echo "[native-rebuild] WARNING: could not read name/version from ${d}/package.json — skipping"
    continue
  fi

  # sharp (review finding): `@img/sharp-linux-<arch>` is a GLIBC-ONLY
  # prebuilt-only package — there is no source to fall back to, and
  # `npm install @img/sharp-linux-x64@<ver>` under musl fails outright with
  # EBADPLATFORM (npm's own os/cpu/libc engine check refuses it before any
  # network call). The generic fresh-install-and-replace path below cannot
  # fix this package. sharp instead ships a SEPARATE package per libc
  # (`@img/sharp-linuxmusl-<arch>`, same version lockstep) and its OWN
  # runtime code tries each platform package by name at require() time — so
  # the fix is not to replace ${d} at all, but to ADD the missing musl
  # sibling under ITS OWN correct name; sharp's runtime then finds it. The
  # generic sibling-carry loop below cannot do this either: it globs
  # top-level node_modules/* entries by basename, and `@img` (the SCOPE
  # directory, not the package) already exists in ${ROOT} — its
  # already-present check would skip the whole @img scope and silently
  # drop the needed sibling.
  case "${NAME}" in
  @img/sharp-linux-*)
    MUSL_NAME="@img/sharp-linuxmusl-${NAME#@img/sharp-linux-}"
    echo "[native-rebuild] ${NAME} is glibc-only (no source fallback) — installing the musl counterpart ${MUSL_NAME}@${VERSION} as a NEW sibling instead (${d} is left as-is; sharp's own require() picks whichever platform package is present)"
    if musl_install_sibling "${MUSL_NAME}@${VERSION}" "${MUSL_NAME}"; then
      if [ -z "$(find "${ROOT}/node_modules/${MUSL_NAME}" -name '*.node' -type f 2>/dev/null)" ]; then
        echo "[native-rebuild] WARNING: ${MUSL_NAME}@${VERSION} produced no *.node file — sharp will still fail to load under musl at runtime"
      fi
    else
      echo "[native-rebuild] sharp will still fail to load under musl at runtime (original error will resurface, not masked)"
    fi
    # sharp's platform package dlopens a SEPARATE shared-library package at
    # runtime (measured: "Error loading shared library libvips-cpp.so...")
    # — @img/sharp-libvips-linux-<arch>, independently versioned from sharp
    # itself (e.g. sharp 0.34.5 pins sharp-libvips 1.2.4), so its exact spec
    # is read from THIS package's own optionalDependencies rather than
    # assumed to share ${VERSION}.
    LIBVIPS_INFO="$(node -e '
      try {
        const deps = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).optionalDependencies || {};
        for (const [k, v] of Object.entries(deps)) {
          if (/^@img\/sharp-libvips-linux-[a-z0-9]+$/.test(k)) { process.stdout.write(k + " " + v); break; }
        }
      } catch { /* leave empty */ }
    ' "${d}/package.json" 2>/dev/null || true)"
    if [ -n "${LIBVIPS_INFO}" ]; then
      LIBVIPS_NAME="${LIBVIPS_INFO%% *}"
      LIBVIPS_VERSION="${LIBVIPS_INFO#* }"
      LIBVIPS_MUSL_NAME="@img/sharp-libvips-linuxmusl-${LIBVIPS_NAME#@img/sharp-libvips-linux-}"
      echo "[native-rebuild] ${NAME} also needs its libvips shared-library sibling — installing ${LIBVIPS_MUSL_NAME}@${LIBVIPS_VERSION}"
      musl_install_sibling "${LIBVIPS_MUSL_NAME}@${LIBVIPS_VERSION}" "${LIBVIPS_MUSL_NAME}" || echo "[native-rebuild] sharp will still fail to load its libvips dependency under musl at runtime (original error will resurface, not masked)"
    else
      echo "[native-rebuild] WARNING: no @img/sharp-libvips-linux-* entry found in ${d}/package.json's optionalDependencies — sharp may still fail to load its libvips dependency under musl"
    fi
    continue
    ;;
  esac

  echo "[native-rebuild] installing ${NAME}@${VERSION} for musl (the traced tree at ${d} lacks install-time tooling like node-pre-gyp — a rebuild IN PLACE cannot run its own install script)"
  PKG_SCRATCH="$(mktemp -d "${SCRATCH_ROOT}/pkg.XXXXXX")"
  chown builder:builder "${PKG_SCRATCH}"
  # #1257 round 7 — reproducible via a committed lockfile when this exact
  # name@version has one (same mechanism as musl_install_sibling above);
  # otherwise the pre-existing best-effort fresh install, now non-root.
  PINNED_DIR="$(pinned_lockfile_dir_for "${NAME}" "${VERSION}")"
  if [ -n "${PINNED_DIR}" ]; then
    cp "${PINNED_DIR}/package.json" "${PKG_SCRATCH}/package.json"
    cp "${PINNED_DIR}/package-lock.json" "${PKG_SCRATCH}/package-lock.json"
    chown builder:builder "${PKG_SCRATCH}/package.json" "${PKG_SCRATCH}/package-lock.json"
    echo "[native-rebuild] ${NAME}@${VERSION}: using the committed, reproducible lockfile at ${PINNED_DIR}"
    if ! (cd "${PKG_SCRATCH}" && run_as_builder npm ci --no-audit --no-fund >"${PKG_SCRATCH}.log" 2>&1); then
      echo "[native-rebuild] WARNING: reproducible 'npm ci' of ${NAME}@${VERSION} failed (the committed lockfile may be stale) — this addon may still fail to dlopen under musl at runtime (original error will resurface, not masked)"
      tail -c 4096 "${PKG_SCRATCH}.log" 2>/dev/null || true
      continue
    fi
  else
    # npm_config_build_from_source=true (review finding, round 4 — live CI
    # evidence, run 35862123588): WITHOUT this, `npm install` runs sqlite3's
    # own `node-pre-gyp install --fallback-to-build`, which tries a PREBUILT
    # download FIRST. That old node-pre-gyp does not check libc at all when
    # picking a prebuilt — it only matches platform+arch (e.g.
    # "linux-x64") — so on a network-connected runner it happily downloads
    # the (only ever published) GLIBC prebuilt, "succeeds" with no warning,
    # and the exact same ERR_DLOPEN_FAILED resurfaces. `--fallback-to-build`
    # only triggers when the prebuilt fetch itself FAILS, which is what
    # happened in every local repro here (this sandbox's network could not
    # reach the prebuilt host) — that let round 2/3's local proof pass while
    # the identical fix still failed on CI's well-connected runner. Forcing
    # build-from-source removes the prebuilt-fetch path entirely, so the
    # result is never network-dependent.
    if ! (cd "${PKG_SCRATCH}" && run_as_builder env npm_config_build_from_source=true npm install --no-save --no-audit --no-fund "${NAME}@${VERSION}" >"${PKG_SCRATCH}.log" 2>&1); then
      echo "[native-rebuild] WARNING: fresh (non-reproducible — no committed lockfile for ${NAME}@${VERSION}) musl install failed — this addon may still fail to dlopen under musl at runtime (original error will resurface, not masked)"
      tail -c 4096 "${PKG_SCRATCH}.log" 2>/dev/null || true
      continue
    fi
  fi
  FRESH_PKG_DIR="${PKG_SCRATCH}/node_modules/${NAME}"
  if [ ! -d "${FRESH_PKG_DIR}" ]; then
    echo "[native-rebuild] WARNING: fresh install of ${NAME}@${VERSION} produced no node_modules/${NAME} — skipping"
    continue
  fi
  FRESH_NODE_COUNT="$(find "${FRESH_PKG_DIR}" -name '*.node' -type f 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${FRESH_NODE_COUNT}" = "0" ]; then
    echo "[native-rebuild] WARNING: fresh install of ${NAME}@${VERSION} produced NO *.node file — skipping (the traced copy is left as-is; it will still fail to dlopen)"
    continue
  fi
  echo "[native-rebuild] replacing the traced copy at ${d} with the freshly musl-built ${NAME}@${VERSION} (${FRESH_NODE_COUNT} *.node file(s))"
  rm -rf "${d}"
  cp -a "${FRESH_PKG_DIR}" "${d}"

  # Not just ${NAME} itself: sqlite3's OWN lib/sqlite3-binding.js does
  # `require('node-pre-gyp')` at RUNTIME (not merely install-time) to
  # locate its binding path — that dependency is a real, statically-visible
  # require(), so Next's output tracer DOES keep it in the traced tree, but
  # WITHOUT its `.bin/` shim (tracing follows require() calls, not npm's
  # lifecycle-script PATH setup — see the round-1 postmortem in the header).
  # ${NAME} alone therefore is not enough: a fresh install's OTHER
  # node_modules entries (node-pre-gyp and ITS transitive deps) must land
  # too, or a require() chain like this one 404s on the very dependency
  # `npm install` just proved musl-installable.
  #
  # ONLY if ABSENT from the traced tree (review finding, round 3): a bare
  # unconditional overwrite would replace whatever version the APP actually
  # built with — semver, tar, rc, minimist and friends are common hoisted
  # deps a real fixture ships too, at whatever version ITS OWN dependency
  # resolution chose. Overwriting those would test a dependency tree the app
  # never built, so a pass or fail would no longer reflect the product. A
  # sibling already present in ${ROOT}/node_modules is the app's own choice
  # and is left untouched; it is pure JS (no *.node file of its own, or the
  # outer loop already handles it on its own iteration) and needs no musl
  # rebuild regardless of version. Only a sibling genuinely ABSENT from the
  # traced tree (like node-pre-gyp usually is, being install-time-only from
  # the tracer's point of view) gets copied in.
  for sibling in "${PKG_SCRATCH}/node_modules"/*; do
    [ -e "${sibling}" ] || continue
    sibling_name="$(basename "${sibling}")"
    [ "${sibling_name}" = "${NAME}" ] && continue
    if [ -e "${ROOT}/node_modules/${sibling_name}" ]; then
      echo "[native-rebuild]   - keeping the traced copy of ${sibling_name} (already present — that is the app's own resolved version, not overwritten)"
      continue
    fi
    echo "[native-rebuild]   + carrying along runtime dependency ${sibling_name} (needed by ${NAME}'s require() graph, absent from the traced tree)"
    cp -a "${sibling}" "${ROOT}/node_modules/${sibling_name}"
  done
done
