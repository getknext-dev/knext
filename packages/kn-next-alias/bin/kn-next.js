#!/usr/bin/env node
/**
 * `kn-next` — the bare-name alias for @getknext/core's CLI.
 *
 * Exists so the obvious first command works: `npx kn-next` 404'd for anyone
 * who had not already installed @getknext/core, because the bin name and the
 * package name differ and nobody owned the bare name on npm (ergonomics
 * ledger, finding 1a). This package owns it and does exactly one thing:
 * resolve @getknext/core's bin and re-exec it with the same argv.
 *
 * Spawn (not import) is deliberate: the core bin dispatches on load and owns
 * its own process semantics (exit codes, signal handling, stdio). A child
 * process with inherited stdio preserves all of that without this shim
 * needing to know any of it.
 */
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

let binPath;
try {
  // @getknext/core's exports map does not expose ./package.json
  // (ERR_PACKAGE_PATH_NOT_EXPORTED), so resolve the ROOT export and walk up
  // to the nearest package.json — works regardless of the exports map's
  // shape and needs no change to core.
  const req = createRequire(__filename);
  let dir = path.dirname(req.resolve('@getknext/core'));
  while (!existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('package.json not found above root export');
    dir = parent;
  }
  const corePkg = require(path.join(dir, 'package.json'));
  const rel = typeof corePkg.bin === 'string' ? corePkg.bin : corePkg.bin['kn-next'];
  binPath = path.join(dir, rel);
} catch {
  process.stderr.write(
    'kn-next: could not resolve @getknext/core — the alias package needs it installed.\n' +
      'Run `npm install @getknext/core` (or use `npx @getknext/core` directly).\n',
  );
  process.exit(1);
}

const child = spawn(process.execPath, [binPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
// Forward signals PARENT→CHILD: without this, a supervisor's SIGTERM (CI
// timeout, systemd, `timeout 300 npx kn-next deploy`) kills the wrapper and
// ORPHANS the still-running, cluster-mutating CLI — proven in review. The
// child-dies-first direction is the exit handler below.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) => {
  if (signal) {
    // Re-raise with DEFAULT disposition: our own forwarding listener must go
    // first, or it swallows the re-raise and the shim exits 0 — a supervisor
    // (timeout, systemd, CI) would read a SIGTERM'd deploy as success.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
