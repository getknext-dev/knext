#!/usr/bin/env node
/**
 * verify-crane-pin — resolve the pinned `crane` version+checksum against the
 * REAL `checksums.txt` its GitHub release published, at run time (#1211
 * item 2).
 *
 * WHY THIS IS NOT A UNIT TEST
 * ---------------------------
 * `tests/crane-pin-lockstep.test.ts` asserts LOCKSTEP — every copy of the
 * "Install crane (version + checksum pinned)" step across
 * `.github/workflows/**` carries the identical (version, checksum) pair —
 * and unit-tests the pure comparison logic against injected doubles. It
 * deliberately does NOT assert the checksum's VALUE is correct, for the same
 * reason `verify-action-pins.mjs` doesn't bake an action SHA into a committed
 * assertion: the answer lives upstream and legitimately changes on a crane
 * version bump, so freezing it into a PR-gated test would either reject every
 * correct bump or, worse, invite "just update the guard" as the routine way
 * to get green.
 *
 * WHAT IT CATCHES
 * ---------------
 *  - a checksum that was hand-edited (or bit-rotted) away from what the
 *    pinned CRANE_VERSION's release actually published;
 *  - a version bump where only the version string was updated and the
 *    checksum was left stale (or copy-pasted from the wrong release).
 *
 * FAIL CLOSED, ALWAYS
 * --------------------
 * Per security.md's nightly-pin precedent: a checker that goes green when it
 * cannot reach upstream is worse than none. An unreachable GitHub, a missing
 * `checksums.txt` asset, or a mismatched checksum are all FAILURES — never a
 * pass, never a silent skip.
 *
 * TESTABILITY
 * -----------
 * `scripts/lib/crane-pin.mjs` holds every pure function (scan, lockstep
 * assertion, checksums.txt parsing, comparison) — all unit-tested against
 * injected doubles in `tests/crane-pin-lockstep.test.ts`. This file is the
 * thin CLI wrapper: real filesystem scan, real `fetch` against the GitHub
 * release asset, real process exit code. Its own entrypoint only runs when
 * invoked directly (mirrors `resolve-scale-test-image.mjs`'s pattern), so
 * importing the functions above never triggers a live network call.
 *
 * Usage:  node scripts/verify-crane-pin.mjs
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertLockstep,
  filenameForPin,
  parseChecksumsTxt,
  scanCranePins,
  verifyPinAgainstChecksums,
} from './lib/crane-pin.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOWS_DIR = resolve(REPO_ROOT, '.github/workflows');

async function fetchChecksumsTxt(version) {
  const url = `https://github.com/google/go-containerregistry/releases/download/${version}/checksums.txt`;
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not reach ${url}: ${message}. Refusing to proceed: a pin verifier that goes green when it cannot reach upstream is worse than none.`,
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${url} returned HTTP ${res.status} — cannot verify the crane pin.`);
  }
  return res.text();
}

async function main() {
  const pins = scanCranePins(WORKFLOWS_DIR);
  assertLockstep(pins); // throws on empty set or any divergence

  const pin = pins[0];
  console.log(
    `Verifying crane pin ${pin.version} / ${pin.sha256} (${pins.length} lockstep copies across ${new Set(pins.map((p) => p.file)).size} file(s)) against the real release checksums.txt...`,
  );

  const text = await fetchChecksumsTxt(pin.version);
  const checksums = parseChecksumsTxt(text);
  verifyPinAgainstChecksums(pin, checksums);

  console.log(
    `OK: ${pin.version}'s pinned CRANE_SHA256 matches the real ${filenameForPin()} checksum published upstream.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${message}`);
    process.exit(1);
  });
}
