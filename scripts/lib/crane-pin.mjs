/**
 * Pure logic for the crane version+checksum pin guard (#1211 item 2).
 *
 * `operator-e2e-nightly.yml` (two copies — the preflight job and the scale
 * job), `supply-chain.yml`, and `operator-supply-chain.yml` each carry an
 * "Install crane (version + checksum pinned)" step. The PRIOR guard
 * (`tests/operator-e2e-scale-image-preflight.test.ts`) only asserted the step
 * NAME exists at the right position — the pin's actual VALUE had no guard,
 * so a hand-edited or drifted `CRANE_SHA256` on any one copy would pass
 * every existing test. #1210's review caught the current copies being
 * byte-identical only by eye.
 *
 * BUILT-INS ONLY, DELIBERATELY (rev-1390 finding 1) — an earlier revision
 * imported the `yaml` package to parse workflow files into objects, which
 * is a devDependency: the nightly job that runs `verify-crane-pin.mjs`
 * installs no dependencies (mirroring `verify-action-pins.mjs`'s own
 * "dependency-free ESM on the runner's built-in Node" design, so the job
 * auditing the supply chain cannot itself become part of it), so every
 * night hit `ERR_MODULE_NOT_FOUND` and filed a false RED issue. This module
 * now scans raw TEXT with regular expressions, never a YAML parser — which
 * also removes the "YAML parse failure silently skipped" failure mode the
 * old `try { parseYaml(...) } catch { continue; }` had: there is no parse
 * step left to fail.
 *
 * TWO INDEPENDENT SIGNALS, CROSS-CHECKED (rev-1390 finding 2) — matching
 * only `CRANE_VERSION`/`CRANE_SHA256` key occurrences missed several real
 * drift shapes a reviewer named directly: the version written as an
 * unresolved `${{ }}` expression (which the version regex correctly refuses
 * to match, silently dropping that copy from the count instead of flagging
 * it), the version and checksum split across separate `env:` blocks far
 * enough apart that a naive proximity window would miss the pairing, or the
 * values inlined directly into a `curl`/`sha256sum` `run:` step with no
 * `CRANE_VERSION`/`CRANE_SHA256` names at all. None of those shapes is
 * individually distinguishable from "this file has no crane pin" by the
 * `CRANE_VERSION`/`CRANE_SHA256` scan alone. So this module ALSO scans for
 * the literal download URL host+path
 * (`go-containerregistry/releases/download`, unconditionally present in
 * every real "Install crane" step regardless of how the version got there)
 * and requires the two counts — download-URL occurrences and matched
 * (version, checksum) pairs — to be EQUAL per file. A mismatch in EITHER
 * direction throws: more URLs than pairs means some copy's version/checksum
 * pair went unrecognised (silent drift the whole point of this guard is to
 * catch); more pairs than URLs would mean this scan is itself
 * double-counting. Ordinal pairing (i-th `CRANE_VERSION` value with the
 * i-th `CRANE_SHA256` value, by their order of appearance in the file) is
 * what makes the "separate env blocks" shape safe to accept: there is no
 * proximity requirement between them at all.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The exact release asset this workflow downloads — the Linux x86_64
 * tarball, matching the `curl` URL in every "Install crane" step. A single
 * source of truth so the scanner and the upstream-verification script never
 * disagree on which asset a checksum is FOR.
 */
export function filenameForPin() {
  return 'go-containerregistry_Linux_x86_64.tar.gz';
}

/** Every real, well-formed `vX.Y.Z` value assigned to `CRANE_VERSION`, in
 * order of appearance. A value shaped like `${{ ... }}` (an unresolved
 * GitHub Actions expression) never matches this regex, so it is correctly
 * absent from the result rather than mis-parsed as a version string. */
function scanCraneVersions(text) {
  const re = /\bCRANE_VERSION\b\s*[:=]\s*['"]?(v?\d+\.\d+\.\d+)['"]?/g;
  const out = [];
  for (const m of text.matchAll(re)) {
    out.push(m[1].startsWith('v') ? m[1] : `v${m[1]}`);
  }
  return out;
}

/** Every 64-hex value assigned to `CRANE_SHA256`, in order of appearance. */
function scanCraneChecksums(text) {
  const re = /\bCRANE_SHA256\b\s*[:=]\s*['"]?([0-9a-f]{64})['"]?/gi;
  const out = [];
  for (const m of text.matchAll(re)) out.push(m[1].toLowerCase());
  return out;
}

/** How many times the crane release download URL's host+path appears —
 * present in EVERY real "Install crane" step regardless of how its
 * version/checksum got there (named env vars, inline literals, a different
 * variable name entirely). */
function countDownloadUrlOccurrences(text) {
  const re = /go-containerregistry\/releases\/download/g;
  return (text.match(re) ?? []).length;
}

/**
 * Scans every `.github/workflows/*.yml`/`*.yaml` file for CRANE_VERSION /
 * CRANE_SHA256 pairs, TEXT-based (no YAML parser — see the module header).
 * `deps.listFiles`/`deps.readSource` are injectable so the test suite can
 * exercise the parser against a synthetic fixture without touching the real
 * filesystem.
 *
 * Throws (fail closed) when a file's download-URL count and matched-pair
 * count disagree — see the module header for what that catches.
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
    const text = readSource(file);
    const versions = scanCraneVersions(text);
    const checksums = scanCraneChecksums(text);
    const urlCount = countDownloadUrlOccurrences(text);

    if (versions.length === 0 && checksums.length === 0 && urlCount === 0) {
      continue; // no crane pin anywhere in this file
    }

    if (versions.length !== checksums.length || versions.length !== urlCount) {
      throw new Error(
        `${file}: crane pin scan found an UNACCOUNTED-FOR occurrence — ` +
          `${versions.length} CRANE_VERSION value(s), ${checksums.length} CRANE_SHA256 value(s), ` +
          `${urlCount} download-URL occurrence(s). All three must match; a mismatch means at least ` +
          `one copy has a version/checksum shape this scan cannot recognise (an unresolved ` +
          `\${{ }} expression, an inline literal with no named env var, or a genuinely missing ` +
          `half of a pair) — #1211 item 2 exists precisely to catch that, not to skip past it.`,
      );
    }

    for (let i = 0; i < versions.length; i++) {
      found.push({ file, version: versions[i], sha256: checksums[i] });
    }
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
