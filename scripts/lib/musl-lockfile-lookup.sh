#!/bin/sh
#
# scripts/lib/musl-lockfile-lookup.sh — pure lookup helpers for the
# committed musl-native-addon lockfiles (#1257 round 7).
#
# Deliberately SIDE-EFFECT-FREE (no apk/adduser/network) and portable POSIX
# sh — unlike scripts/e2e-native-rebuild-musl.sh, this file can be sourced
# and its functions exercised directly on ANY POSIX shell (a contributor's
# host, macOS's /bin/sh, a plain CI runner), with no container and no
# Alpine-specific tooling required. That is what makes it independently
# testable without docker — see tests/musl-lockfile-lookup.test.ts.
#
# Sourced by scripts/e2e-native-rebuild-musl.sh, which supplies
# `LOCKFILES_DIR` before calling `pinned_lockfile_dir_for`.

# The sanitized <safe-name>-<version> lookup key this script's committed
# lockfiles are keyed by (scripts/musl-native-lockfiles/) — strip a leading
# npm scope's `@`, and turn the remaining `/` into `-` so e.g.
# `@img/sharp-linuxmusl-x64` -> `img-sharp-linuxmusl-x64`.
lockfile_key() { # <name>
  printf '%s' "$1" | sed 's#^@##; s#/#-#g'
}

# The committed lockfile dir for <name>@<version>, if one exists under
# LOCKFILES_DIR — empty otherwise (the caller then falls back to a fresh,
# non-reproducible install). Empty/unset LOCKFILES_DIR (the back-compat call
# shape, or a caller that never wired a lockfiles mount) always misses,
# never errors — this is a lookup, not a requirement.
pinned_lockfile_dir_for() { # <name> <version>
  if [ -z "${LOCKFILES_DIR:-}" ]; then
    return 0
  fi
  _key="$(lockfile_key "$1")-$2"
  _dir="${LOCKFILES_DIR}/${_key}"
  if [ -f "${_dir}/package.json" ] && [ -f "${_dir}/package-lock.json" ]; then
    printf '%s' "${_dir}"
  fi
}

# #1620 — the "<name> <version>" pins the musl rebuild will look up for the
# standalone tree at <root>, one per line, deduplicated. Mirrors the walk in
# scripts/e2e-native-rebuild-musl.sh: each *.node file's nearest
# node_modules-nested package.json; a glibc-only `@img/sharp-linux-<arch>`
# maps to its `@img/sharp-linuxmusl-<arch>` sibling at the same version PLUS
# the `@img/sharp-libvips-linuxmusl-<arch>` version its own
# optionalDependencies pin; any other addon is looked up as itself. It lets
# scripts/e2e-deploy.sh mount the lockfiles for the sharp the app ACTUALLY
# resolved instead of one hardcoded version (the rc.2 bun credential outage:
# Next 16.3.5 resolved sharp 0.35.5 while the mounts named only 0.34.5).
# Reads JSON with `node`, which the host runner has.
musl_lockfile_specs_for_root() { # <root>
  _root="$1"
  find "${_root}" -name '*.node' -type f 2>/dev/null | while IFS= read -r _f; do
    [ -z "${_f}" ] && continue
    _d="$(dirname "${_f}")"
    while [ "${_d}" != "/" ] && [ "${_d}" != "${_root}" ] && [ ! -f "${_d}/package.json" ]; do
      _d="$(dirname "${_d}")"
    done
    [ "${_d}" = "${_root}" ] && continue
    case "${_d}" in
    */node_modules/*) : ;;
    *) continue ;;
    esac
    [ -f "${_d}/package.json" ] || continue
    node -e '
      try {
        const p = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
        if (!p.name || !p.version) process.exit(0);
        const m = /^@img\/sharp-linux-([a-z0-9]+)$/.exec(p.name);
        if (!m) {
          process.stdout.write(`${p.name} ${p.version}\n`);
          process.exit(0);
        }
        process.stdout.write(`@img/sharp-linuxmusl-${m[1]} ${p.version}\n`);
        for (const [k, v] of Object.entries(p.optionalDependencies || {})) {
          const l = /^@img\/sharp-libvips-linux-([a-z0-9]+)$/.exec(k);
          if (l) {
            process.stdout.write(`@img/sharp-libvips-linuxmusl-${l[1]} ${v}\n`);
            break;
          }
        }
      } catch { /* unreadable manifest: the rebuild script skips it too */ }
    ' "${_d}/package.json"
  done | sort -u
}

# #1620 — the docker `-v` mount specs (one "host:container:ro" per line) for
# every committed lockfile FILE the tree at <root> needs, derived from
# musl_lockfile_specs_for_root, never from a hardcoded version list. Files are
# mounted one by one (not the directory) so only committed pins reach the
# container (scripts/compat-window-audit.mjs's MUSL_NATIVE_LOCKFILE_FILES
# freezes them; tests/musl-lockfile-credential-sharp-coverage.test.ts keeps
# that list in lockstep with the directory). A needed pin with no committed
# lockfile FAILS CLOSED under KNEXT_COMPAT_MODE=credential: non-zero, naming
# the missing directory and the command that adds it. The rebuild script
# would refuse it anyway, but only after the whole toolchain install and with
# a less actionable message. Any other mode warns and omits it, leaving the
# rebuild script's best-effort fallback in place.
musl_lockfile_mounts() { # <root> <host-lockfiles-dir> <container-lockfiles-dir>
  _specs="$(musl_lockfile_specs_for_root "$1")" || return 1
  _missing=0
  _nl='
'
  _oldifs="${IFS}"
  IFS="${_nl}"
  for _spec in ${_specs}; do
    IFS="${_oldifs}"
    _name="${_spec% *}"
    _version="${_spec#* }"
    _key="$(lockfile_key "${_name}")-${_version}"
    if [ -n "$(LOCKFILES_DIR="$2" pinned_lockfile_dir_for "${_name}" "${_version}")" ]; then
      printf '%s\n' "$2/${_key}/package.json:$3/${_key}/package.json:ro"
      printf '%s\n' "$2/${_key}/package-lock.json:$3/${_key}/package-lock.json:ro"
    elif [ "${KNEXT_COMPAT_MODE:-}" = "credential" ]; then
      echo "::error::[musl-lockfiles] the app resolves ${_name}@${_version} but there is no committed lockfile at $2/${_key}/ and KNEXT_COMPAT_MODE=credential refuses the non-reproducible fallback. Add it with: scripts/generate-musl-native-lockfile.sh ${_name} ${_version} (and list both files in MUSL_NATIVE_LOCKFILE_FILES)" >&2
      _missing=1
    else
      echo "::warning::[musl-lockfiles] no committed lockfile at $2/${_key}/ for ${_name}@${_version}; the musl rebuild will take the non-reproducible fallback" >&2
    fi
    IFS="${_nl}"
  done
  IFS="${_oldifs}"
  [ "${_missing}" -eq 0 ]
}
