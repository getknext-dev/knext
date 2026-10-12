'use strict';
/**
 * The Node.js floor, enforced at CLI start.
 *
 * `engines.node` makes a package manager warn; it does not stop `npx knext` on
 * an old Node. This file is the first thing the bin loads (deploy.ts imports it
 * before everything else) and exits non-zero with one actionable line when the
 * running Node is below the floor.
 *
 * CommonJS and dependency-free ON PURPOSE: it must be loadable on a Node too
 * old for the rest of the bundle, and tsup keeps it as its own file beside the
 * bin so an ESM import of it is evaluated before the bundle's other imports.
 * `node-floor.ts` is its typed twin (used by the doctor row); the test asserts
 * the two agree on every verdict and message.
 *
 * Bun reports a Node-compat version in `process.versions.node` (26.x on Bun
 * 1.4), so the same check is correct there without special-casing Bun.
 */

const NODE_FLOOR_MAJOR = 24;

function checkNodeFloor(version) {
  const major = typeof version === 'string' ? /^v?(\d+)(?:\.|$)/.exec(version.trim()) : null;
  const ok = major !== null && Number(major[1]) >= NODE_FLOOR_MAJOR;
  return {
    ok,
    message: `knext requires Node.js ${NODE_FLOOR_MAJOR} or later; you are running ${version}. Upgrade Node: https://nodejs.org`,
  };
}

exports.NODE_FLOOR_MAJOR = NODE_FLOOR_MAJOR;
exports.checkNodeFloor = checkNodeFloor;

const verdict = checkNodeFloor(process.versions.node);
if (!verdict.ok) {
  // writeSync, not process.stderr.write: the process exits on the next line and
  // an async pipe write could be cut off.
  require('node:fs').writeSync(2, `${verdict.message}\n`);
  process.exit(1);
}
