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
