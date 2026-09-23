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
  # Remove everything except the kept dir (and its ancestors' other children),
  # then unpack the pristine snapshot over the top.
  find "${dir}" -mindepth 1 ! -path "${dir}/${keep}" ! -path "${dir}/${keep}/*" \
    ! -path "$(dirname "${dir}/${keep}")" -depth -delete 2>/dev/null || true
  tar -C "${dir}" -xf "${tarfile}"
}
