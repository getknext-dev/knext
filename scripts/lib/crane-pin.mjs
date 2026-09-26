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
 * Strips full-line `#` comments (a line whose first non-blank character is
 * `#`, arbitrarily indented) before scanning — rev-ci-1390-1396 review: a
 * documentation comment describing the CORRECT pin (`# CRANE_VERSION: vX.Y.Z
 * CRANE_SHA256: ...`) sitting next to a REAL inline install of a WRONG
 * version (no named env vars — the shape the download-URL cross-check
 * exists to catch) can silently BALANCE the three counts: the comment
 * supplies the missing version/checksum matches, the real step supplies the
 * URL, and the scan reports the comment's (correct-looking) pin instead of
 * throwing on the real, unaccounted-for wrong one. Same rule this repo
 * already applies to `run:` block scalars elsewhere
 * (`tests/helpers/publish-markers.ts`'s `stripBashCommentLines`) — not a
 * YAML-level `#` comment (`effectiveWorkflowText` already strips those via
 * parse+re-serialise), but a bash `#`-comment INSIDE an opaque `run: |`
 * string, which survives re-serialisation untouched.
 */
function stripFullLineComments(text) {
  return text.replace(/^[ \t]*#.*$/gm, '');
}

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
 * One entry per `CRANE_SHA256` assignment, in the SAME order
 * `scanCraneChecksums`/`scanCraneVersions` already produce theirs in — the
 * position-based replacement for an earlier version of this scan that (a)
 * only matched this repo's exact two-line phrasing ("# sha256 of X from the
 * vX.Y.Z\n# release's checksums.txt"), so a single-line comment, "from
 * v0.21.7" without "the", or "checksum of vX.Y.Z" wording all slipped past
 * it, and (b) returned a flat, file-wide list, so the caller could only ask
 * "does this version appear ANYWHERE in the file" rather than "does THIS
 * pin's own comment match THIS pin" — on a file with two pins (this repo's
 * `operator-e2e-nightly.yml` has exactly that shape), two comments that
 * each named the OTHER pin's version passed undetected (#1429 follow-up).
 *
 * For each (non-comment) `CRANE_SHA256` line, walks UPWARD collecting the
 * contiguous block of full-line `#` comments directly above it (stopping at
 * the first non-comment line), then extracts EVERY `vX.Y.Z`-shaped token in
 * that block (v-prefix REQUIRED — accepts `vX.Y.Z` only, not bare X.Y.Z like
 * `go 1.22.3` or IP addresses like `10.0.0.1`, which are ignored; and never
 * followed by `.<digit>`, so `v0.20.2.1` is not read as v0.20.2). Deliberately loose about the
 * surrounding prose — only the version TOKEN is pinned to a shape, not the
 * sentence around it — because the point is which version the comment NAMES,
 * not which phrasing it uses. All tokens are returned (not just the first) so
 * the caller can also reject a block that names the pin's version AND a stale one.
 *
 * A `CRANE_SHA256` line that is itself a full-line `#` comment is skipped,
 * exactly as `scanCraneChecksums` never sees it (it runs on stripped text) —
 * otherwise a commented-out old pin would shift this list's ordinals off the
 * `versions`/`checksums` pairing the caller indexes by.
 *
 * An EMPTY array for an occurrence means it has no comment block at all (or
 * one with no parseable version token) — every pinned crane URL must carry
 * one, so `scanCranePins` treats that as a violation, not "comment optional."
 *
 * Operates on the RAW, un-stripped text: this function's whole job is to read
 * a `#` comment, not to have one stripped out from under it.
 *
 * @param {string} text
 * @returns {string[][]} one array of `vX.Y.Z` tokens per CRANE_SHA256 line
 */
export function scanCraneVersionComments(text) {
  const lines = text.split('\n');
  const shaAssignRe = /\bCRANE_SHA256\b\s*[:=]\s*['"]?[0-9a-f]{64}['"]?/i;
  const commentLineRe = /^[ \t]*#/;
  // v-prefix REQUIRED: matches vX.Y.Z only, so bare X.Y.Z like "go 1.22.3"
  // or IP addresses like "10.0.0.1" are never tokens (ignored, not rejected).
  // The trailing `\b` alone still matches BEFORE a "." — "v0.20.2.1" would
  // read as v0.20.2 — hence the `(?!\.\d)` exclusion: a token must not be
  // followed by ".<digit>". A sentence-ending "v0.20.2." is still a token.
  const versionTokenRe = /\bv\d+\.\d+\.\d+\b(?!\.\d)/gi;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (commentLineRe.test(lines[i]) || !shaAssignRe.test(lines[i])) continue;
    const block = [];
    for (let j = i - 1; j >= 0 && commentLineRe.test(lines[j]); j--) block.unshift(lines[j]);
    const tokens = block.join('\n').match(versionTokenRe) ?? [];
    out.push(tokens.map((t) => t.toLowerCase()));
  }
  return out;
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
    const text = stripFullLineComments(readSource(file));
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

    // #1429 follow-up — every pinned crane URL must carry its OWN version
    // comment, checked against its OWN CRANE_VERSION, not a file-wide
    // "does this version appear anywhere" scan: on a file with two pins
    // (operator-e2e-nightly.yml has exactly that shape), two comments that
    // each named the OTHER pin's version passed the old `.includes()` check
    // undetected. `scanCraneVersionComments` returns one entry per
    // CRANE_SHA256 occurrence, in the same order `versions`/`checksums`
    // above are already ordinally paired in, so index `i` here is the SAME
    // pin throughout.
    const commentVersions = scanCraneVersionComments(readSource(file));
    for (let i = 0; i < checksums.length; i++) {
      // `?? []` fails closed (as "no comment") should the raw-text ordinals
      // ever disagree with the stripped-text ones.
      const named = commentVersions[i] ?? [];
      if (named.length === 0) {
        throw new Error(
          `${file}: crane pin #${i + 1} (CRANE_VERSION ${versions[i]}) has no accompanying ` +
            `version comment directly above its CRANE_SHA256 line — every pinned crane URL must ` +
            `carry one naming the release its checksum came from (#1429).`,
        );
      }
      const stale = named.filter((cv) => cv !== versions[i]);
      if (stale.length > 0) {
        throw new Error(
          `${file}: crane pin #${i + 1}'s accompanying comment block names ${stale.join(', ')}, but its ` +
            `own CRANE_VERSION is ${versions[i]} — every vX.Y.Z token in the comment block must ` +
            `equal the pin's version. Tokens without a v prefix (e.g. 'go 1.22.3', '10.0.0.1') are ` +
            `ignored; a changelog note naming another release (e.g. 'was v0.20.2') is rejected by ` +
            `design — one version per block (#1429).`,
        );
      }
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
