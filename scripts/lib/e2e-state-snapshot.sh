#!/usr/bin/env bash
# Pristine-state guard for the node compile-cache bake (sourced by e2e-deploy.sh).
#
# The bake renders a route through server.js IN the standalone dir the fixture
# then boots from (the V8 compile cache is keyed by module path, so it cannot be
# baked in a copy elsewhere). That render can write ISR / fetch-cache / prerender
# state into the tree. So: snapshot the whole tree BEFORE the bake, and after it
# restore that snapshot — keeping ONLY the compile-cache dir the bake produced.
#
#   snapshot_state <dir> <tarfile> <keep-relative-dir>
#   restore_state  <dir> <tarfile> <keep-relative-dir>
#
# <keep-relative-dir> is relative to <dir> (e.g. .next/compile-cache).
snapshot_state() {
  local dir="$1" tarfile="$2" keep="$3"
  tar -C "${dir}" --exclude="./${keep}" -cf "${tarfile}" .
}

restore_state() {
  local dir="$1" tarfile="$2" keep="$3"
  local keepabs="${dir}/${keep}" keepparent
  keepparent="$(dirname "${keepabs}")"
  # FAIL CLOSED: nothing here is silenced. A leftover dirty file would let the
  # fixture boot from state the bake created, which is what this guard prevents.
  # A dir the bake made read-only (or that was read-only in the snapshot) must
  # be writable before it can be deleted; symlinks are not followed.
  find "${dir}" -mindepth 1 ! -path "${keepabs}" ! -path "${keepabs}/*" \( -type f -o -type d \) -exec chmod u+w {} +
  find "${dir}" -mindepth 1 ! -path "${keepabs}" ! -path "${keepabs}/*" ! -path "${keepparent}" -depth -delete
  tar -C "${dir}" -xf "${tarfile}"
  # Verify: the set of paths equals the snapshot's (minus the kept dir).
  local want have
  want="$(tar -tf "${tarfile}" | sed -e 's#^\./##' -e 's#/$##' | grep -v '^\.\?$' | sort)"
  have="$(cd "${dir}" && find . -mindepth 1 ! -path "./${keep}" ! -path "./${keep}/*" | sed -e 's#^\./##' | sort)"
  if [ "${want}" != "${have}" ]; then
    echo "restore_state: tree does not match the pre-bake snapshot after restore (extra/missing paths):" >&2
    diff <(printf '%s\n' "${want}") <(printf '%s\n' "${have}") >&2
    return 1
  fi
}
