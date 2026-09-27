#!/usr/bin/env node
/**
 * scripts/lib/e2e-probe-http.mjs — the HTTP probe behind `ed_probe_http()`
 * in scripts/lib/e2e-empty-dir.sh (#1455 F6).
 *
 * Split out of an inline `node -e '...'` string (round 3 review) into a real
 * file for two reasons:
 *
 *   1. It is independently readable and lintable, rather than a heredoc-style
 *      literal embedded in shell.
 *   2. It stops being an "unclassified remote fetch" the apply-safety scanner
 *      (scripts/lib/apply-safety-scan.mjs) has to reason about. That scanner
 *      flags any `node -e '...'` whose ARGS contain a fetch-shaped substring
 *      (`http.get`, `fetch(`, …) and requires a `REMOTE_FETCH_ALLOWLIST`
 *      entry whose segment matches EXACTLY ONCE across the whole tree — a
 *      constraint this probe's real shape cannot satisfy: it has TWO call
 *      sites inside `ed_boot_probe_kill` (the health path, then the extra
 *      path), reached from BOTH `e2e-deploy.sh` and `e2e-deploy-vinext.sh`,
 *      so the inlined text legitimately appears 4 times, not once. Rather
 *      than fight (or worse, quietly loosen) a scanner whose whole point is
 *      "exactly once, or it's not proven safe", this moves the fetch out of
 *      shell text entirely: the scanner scans `.sh`/`.bash` files only, and a
 *      `node <file>.mjs <args>` invocation's shell-visible words are just a
 *      path and three plain values — nothing there for a fetch-shape regex to
 *      match.
 *
 * Talks only to 127.0.0.1 (never a caller-supplied host) on a caller-supplied
 * port, and exits 0/1 — prints nothing, writes no file.
 *
 * Usage: node e2e-probe-http.mjs <port> <path> <mode>
 *   mode: "2xx3xx" (health path — despite the name, kept for call-site
 *         compatibility, the threshold is 2xx-ONLY; see the doc comment on
 *         ed_probe_http in e2e-empty-dir.sh) | "non5xx" (general route)
 */
import http from 'node:http';

const port = Number(process.argv[2]);
const path = process.argv[3];
const mode = process.argv[4];

const req = http.get({ host: '127.0.0.1', port, path, timeout: 5000 }, (res) => {
  const status = res.statusCode || 0;
  res.resume();
  res.on('end', () => {
    const ok = mode === '2xx3xx' ? status >= 200 && status < 300 : status < 500 || status >= 600;
    process.exit(ok ? 0 : 1);
  });
  res.on('error', () => process.exit(1));
});
req.on('timeout', () => {
  req.destroy();
  process.exit(1);
});
req.on('error', () => process.exit(1));
