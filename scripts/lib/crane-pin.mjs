/**
 * Pure logic for the crane version+checksum pin guard (#1211 item 2).
 *
 * `operator-e2e-nightly.yml` (two copies — the preflight job and the scale
 * job) and `supply-chain.yml` each carry an "Install crane (version +
 * checksum pinned)" step. The PRIOR guard
 * (`tests/operator-e2e-scale-image-preflight.test.ts`) only asserted the step
 * NAME exists at the right position — the pin's actual VALUE had no guard,
 * so a hand-edited or drifted `CRANE_SHA256` on any one copy would pass
 * every existing test. #1210's review caught the current copies being
 * byte-identical only by eye.
 *
 * This module is dependency-free ESM, mirroring `scripts/verify-action-pins.mjs`'s
 * shape: pure scan/compare functions here, a thin CLI wrapper elsewhere for
 * the parts that need real `fetch`/filesystem access.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * The exact release asset this workflow downloads — the Linux x86_64
 * tarball, matching the `curl` URL in every "Install crane" step. A single
 * source of truth so the scanner and the upstream-verification script never
 * disagree on which asset a checksum is FOR.
 */
export function filenameForPin() {
  return 'go-containerregistry_Linux_x86_64.tar.gz';
}

/**
 * Recursively finds every object anywhere in a parsed workflow document that
 * carries BOTH `CRANE_VERSION` and `CRANE_SHA256` string values (an `env:`
 * block on an "Install crane" step, today) — a SCAN, not a fixed-path lookup,
 * so a pin moved to a different job/step shape is still found.
 */
function findPinsInDoc(doc, out) {
  if (!doc || typeof doc !== 'object') return;
  if (
    typeof doc.CRANE_VERSION === 'string' &&
    typeof doc.CRANE_SHA256 === 'string' &&
    /^v?\d+\.\d+\.\d+$/.test(doc.CRANE_VERSION)
  ) {
    const version = doc.CRANE_VERSION.startsWith('v') ? doc.CRANE_VERSION : `v${doc.CRANE_VERSION}`;
    out.push({ version, sha256: doc.CRANE_SHA256.toLowerCase() });
  }
  for (const value of Object.values(doc)) {
    if (value && typeof value === 'object') findPinsInDoc(value, out);
  }
}

/**
 * Scans every `.github/workflows/*.yml`/`*.yaml` file for CRANE_VERSION /
 * CRANE_SHA256 pairs. `deps.listFiles`/`deps.readSource` are injectable so
 * the test suite can exercise the parser against a synthetic fixture without
 * touching the real filesystem.
 *
 * @param {string} workflowsDir
 * @param {{ listFiles?: () => string[], readSource?: (file: string) => string }} [deps]
 * @returns {{file: string, version: string, sha256: string}[]}
 */
export function scanCranePins(workflowsDir, deps = {}) {
  const listFiles =
    deps.listFiles ??
    (() =>
      readdirSync(workflowsDir)
        .filter((f) => /\.ya?ml$/.test(f))
        .sort());
  const readSource =
    deps.readSource ?? ((file) => readFileSync(resolve(workflowsDir, file), 'utf8'));

  const found = [];
  for (const file of listFiles()) {
    let doc;
    try {
      doc = parseYaml(readSource(file));
    } catch {
      continue; // unparseable YAML is out of scope for this scan
    }
    const perFile = [];
    findPinsInDoc(doc, perFile);
    for (const p of perFile) found.push({ file, ...p });
  }
  return found;
}

/**
 * Throws unless every scanned pin is IDENTICAL (version and checksum both).
 * Throws on an empty set too — a scanner that finds nothing proves nothing,
 * and would otherwise let this guard go permanently, silently green.
 *
 * @param {{file: string, version: string, sha256: string}[]} pins
 */
export function assertLockstep(pins) {
  if (pins.length === 0) {
    throw new Error(
      'no crane pins found by the scan — the scanner is broken or every "Install crane" step was removed; either way this guard cannot vouch for anything.',
    );
  }
  const distinct = new Map();
  for (const p of pins) distinct.set(`${p.version}:${p.sha256}`, p);
  if (distinct.size > 1) {
    const lines = pins.map((p) => `  ${p.file}: ${p.version} ${p.sha256}`).join('\n');
    throw new Error(
      `crane pins are NOT in lockstep — ${distinct.size} distinct (version, checksum) pairs found:\n${lines}\n` +
        'Every copy of the "Install crane" pin must carry the identical version + checksum (#1211 item 2).',
    );
  }
}

/**
 * Parses a `checksums.txt` release asset (`<sha256>  <filename>` per line,
 * optionally with a leading `*` binary-mode marker on the filename — the
 * shape `sha256sum`/GoReleaser-style checksum files use) into a
 * filename -> sha256 map.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseChecksumsTxt(text) {
  const map = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^([0-9a-f]{64})\s+\*?(\S+)$/i);
    if (!m) continue;
    map.set(m[2], m[1].toLowerCase());
  }
  if (map.size === 0) {
    throw new Error(
      `parseChecksumsTxt: no parseable "<sha256>  <filename>" lines found in the given text (${text.length} chars) — refusing to treat an empty/malformed checksums file as evidence of anything.`,
    );
  }
  return map;
}

/**
 * Fail-closed comparison of a scanned pin against the REAL checksums a
 * release published. Throws on mismatch, and throws (never silently skips)
 * when the checksums map has no entry for the expected filename — a missing
 * entry is exactly as dangerous as a wrong one, since either would let a
 * bad pin through unverified.
 *
 * @param {{version: string, sha256: string}} pin
 * @param {Map<string, string>} checksums
 */
export function verifyPinAgainstChecksums(pin, checksums) {
  const filename = filenameForPin();
  const upstream = checksums.get(filename);
  if (upstream === undefined) {
    throw new Error(
      `no checksums entry for ${filename} in the ${pin.version} release's checksums.txt — cannot verify the pin.`,
    );
  }
  if (upstream.toLowerCase() !== pin.sha256.toLowerCase()) {
    throw new Error(
      `pinned CRANE_SHA256 (${pin.sha256}) does not match the real checksums.txt for ${pin.version} (${upstream}).`,
    );
  }
}
