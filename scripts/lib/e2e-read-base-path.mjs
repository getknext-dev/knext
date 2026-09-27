#!/usr/bin/env node
/**
 * scripts/lib/e2e-read-base-path.mjs — reads the Next `basePath` out of a
 * build's `.next/required-server-files.json`, for the empty-dir lane's
 * static-probe path (#1521 round-2, finding 2: "Standalone basePath probe
 * (R13) and helper-path fix (R14)").
 *
 * Extracted into its own file (mirrors e2e-probe-http.mjs, round 3) for two
 * reasons:
 *
 *   1. It is directly unit-testable (tests/e2e-empty-dir.test.ts) with real
 *      fixture files, without invoking the whole ~1300-line deploy script.
 *   2. The PREVIOUS shape — an inline `node -e 'try{...}catch{}'` — silently
 *      turned an UNREADABLE or malformed manifest into an empty basePath.
 *      That is a real defect, not a defensive fallback: a wrong probe path
 *      makes the empty-dir boot/probe fail for every fixture that sets
 *      `basePath` (or whose manifest happens to be unreadable for an
 *      unrelated reason), and the failure surfaces as "the empty-dir boot
 *      did not answer" — nothing points back at the manifest read. This file
 *      fails LOUD instead: a read/parse error exits non-zero with a message
 *      on stderr, and the caller (scripts/e2e-deploy.sh) treats that as a
 *      hard `exit 1`, never a silent `""`.
 *
 * "No basePath configured" is a LEGITIMATE, common case and must NOT error —
 * only an unreadable/malformed manifest does. `config.basePath` absent or
 * empty on an otherwise-readable manifest resolves to `""`, same as before.
 *
 * Usage: node e2e-read-base-path.mjs <required-server-files.json>
 * Exit 0, basePath on stdout: manifest read and parsed (basePath may be "").
 * Exit 1, message on stderr: manifest missing, unreadable, or not valid JSON.
 */
import { readFileSync } from 'node:fs';

const manifestPath = process.argv[2];
if (!manifestPath) {
  process.stderr.write('usage: e2e-read-base-path.mjs <required-server-files.json>\n');
  process.exit(2);
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  process.stderr.write(
    `ERROR: could not read/parse ${manifestPath} for basePath: ${err.message}\n`,
  );
  process.exit(1);
}

process.stdout.write(String(parsed?.config?.basePath || ''));
