#!/usr/bin/env node
/**
 * Snapshot-based mutation harness (#645, proposal B).
 *
 * WHY THIS EXISTS
 * ---------------
 * The repo's mutation-testing practice is: mutate the behaviour a guard protects,
 * watch the guard go RED, restore, verify. Two incidents in one session showed the
 * restore half is where it breaks:
 *
 *   1. An agent stalled BETWEEN mutate and restore, leaving a live mutation in
 *      `status_verdict.go`. Committing it would have shipped the exact behaviour
 *      the PR existed to remove.
 *   2. A harness restored TWO edits to one file by replaying the inverse edits in
 *      FORWARD order. The first inverse edit reinstated the INTERMEDIATE state and
 *      the second no longer matched, leaving a live mutation behind.
 *
 * In both cases `git status --porcelain` showed `M` for a file the PR legitimately
 * modified, so it proved nothing.
 *
 * THE CONTRACT
 * ------------
 *   - snapshot() captures the file's BYTES (and their sha256) before the first
 *     mutation. restore() writes those bytes back. Restoration is content-addressed;
 *     inverse edits are never replayed, which closes incident 2 by construction.
 *   - every mutation asserts its anchor occurs EXACTLY ONCE and refuses otherwise,
 *     at every stage. A silently-failed substitution yields a green run that proves
 *     nothing, which is worse than a red one.
 *   - every mutation carries the standard residue marker, so a mutation that
 *     survives a stall (incident 1) is findable by `scripts/scan-mutation-residue.mjs`
 *     rather than by luck.
 *   - after restore, every anchor used during the proof is re-asserted to occur
 *     exactly once. A restore that lands on the wrong content is loud, not green.
 *
 * Usable from non-Node harnesses (the operator's bash harness) via the CLI at the
 * bottom: `snapshot <file> <snap.json>` / `mutate <snap.json> <anchor> <repl>` /
 * `restore <snap.json>`.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The standard mutation-residue marker.
 *
 * Chosen as a repo-namespaced token rather than a bare `MUTATION`: the bare word
 * appears legitimately all over the place (GraphQL mutations, `useMutation`,
 * minified bundles), so a scan for it would be noise and would train people to
 * ignore it. Namespacing makes a hit unambiguous — it can only come from one of
 * our own harnesses.
 *
 * ASSEMBLED FROM PARTS ON PURPOSE. The scanner refuses any tracked file
 * containing the marker, and this file — plus the scanner, plus their tests — is
 * tracked. If the literal appeared here the guard would flag itself, and the
 * inevitable "fix" would be an allowlist, which is exactly the silent exemption
 * this guard must not have. So the only two places that know the string build it,
 * and nothing else ever needs to type it: harness authors call `mutate()`, which
 * emits the marker for them.
 */
export const MUTATION_MARKER = ['KNEXT', 'MUTATION'].join('-');

export class MutationHarnessError extends Error {}

/**
 * Line-comment syntax per file type, used to make the marker inert in-place.
 *
 * EXPORTED (#942 F5) so `tests/mutation-prover-lane.test.ts` can assert at PR
 * time that every prover subject is markable: an extension absent from this map
 * with no explicit `commentPrefix` makes `mutate()` THROW before writing — the
 * release-lane prover died that way at mutation 21 of 22 for weeks while
 * `declared==run` was cited as proved, because the miss was neither a bad
 * anchor nor a missing file, the only two things the PR-time audit checked.
 *
 * `.lock` is bun.lock — JSONC by bun's own description, `//` is legal.
 * `.json` carries a caveat: strict JSON has no comments, so a guard that
 * PARSES its subject will red on the marker line — that is a red for the
 * wrong reason, and such provers should embed a JSON-legal marker in the
 * replacement instead (the release-lane prover's mutation 19 shows the
 * `"//<marker>": …` key form). The entry exists so an unmarked `.json`
 * mutation FAILS AS A GRADED RED rather than throwing mid-run and leaving
 * the sweep half-reported.
 */
export const COMMENT_PREFIX = {
  '.json': '//',
  '.lock': '//',
  '.go': '//',
  '.ts': '//',
  '.tsx': '//',
  '.js': '//',
  '.jsx': '//',
  '.mjs': '//',
  '.cjs': '//',
  '.rs': '//',
  '.java': '//',
  '.c': '//',
  '.h': '//',
  '.css': '/*',
  '.sh': '#',
  '.bash': '#',
  '.py': '#',
  '.yml': '#',
  '.yaml': '#',
  '.toml': '#',
  '.env': '#',
  '.md': '<!--',
  '.html': '<!--',
};

function markerComment(filePath, explicitPrefix) {
  const prefix = explicitPrefix ?? COMMENT_PREFIX[extname(filePath).toLowerCase()];
  if (!prefix) {
    throw new MutationHarnessError(
      `no comment syntax known for ${filePath}; pass { commentPrefix } or embed ${MUTATION_MARKER} in the replacement yourself`,
    );
  }
  if (prefix === '/*') return `/* ${MUTATION_MARKER} */`;
  if (prefix === '<!--') return `<!-- ${MUTATION_MARKER} -->`;
  return `${prefix} ${MUTATION_MARKER}`;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Count of non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack, needle) {
  if (!needle) throw new MutationHarnessError('anchor must be a non-empty string');
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Throws unless `anchor` occurs EXACTLY once in the file. */
export function assertAnchorOnce(filePath, anchor) {
  let src;
  try {
    src = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new MutationHarnessError(`cannot read ${filePath}: ${err.message}`);
  }
  const n = countOccurrences(src, anchor);
  if (n !== 1) {
    throw new MutationHarnessError(
      `anchor occurs ${n} times in ${filePath} (expected exactly 1): ${JSON.stringify(anchor)}`,
    );
  }
}

/** Capture a file's bytes before the first mutation. */
export function snapshot(filePath) {
  const bytes = readFileSync(filePath);
  return { path: filePath, bytes, sha256: sha256(bytes), anchors: [] };
}

/**
 * Replace the single occurrence of `anchor` with `replacement`.
 *
 * Refuses — without touching the file — when the anchor does not occur exactly
 * once, when the substitution would change nothing, or when the result would not
 * carry the residue marker.
 */
export function mutate(snap, anchor, replacement, options = {}) {
  const { mark = true, commentPrefix } = options;
  const src = readFileSync(snap.path, 'utf8');

  const n = countOccurrences(src, anchor);
  if (n !== 1) {
    throw new MutationHarnessError(
      `anchor occurs ${n} times in ${snap.path} (expected exactly 1): ${JSON.stringify(anchor)}`,
    );
  }

  let text = replacement;
  if (!text.includes(MUTATION_MARKER)) {
    if (!mark) {
      // Refusing here is the point: an unmarked mutation is residue that no scan
      // can find, which is incident 1 all over again.
      throw new MutationHarnessError(
        `replacement carries no residue marker and mark:false was requested — an unmarked mutation is undetectable residue (${snap.path})`,
      );
    }
    const comment = markerComment(snap.path, commentPrefix);
    text = text.includes('\n')
      ? `${(text.match(/^[\t ]*/) ?? [''])[0]}${comment}\n${text}`
      : `${text} ${comment}`;
  }

  // Function replacement, not a string: `$&`/`$1` in a replacement string are
  // substitution patterns, so a literal `$` in the mutation would silently become
  // something else — a corrupted mutation is indistinguishable from a real red.
  const out = src.replace(anchor, () => text);
  if (out === src) {
    throw new MutationHarnessError(`substitution changed nothing in ${snap.path}`);
  }
  writeFileSync(snap.path, out, 'utf8');
  snap.anchors.push(anchor);
  return snap;
}

/**
 * Write the snapshotted bytes back, then re-assert every anchor exactly once.
 *
 * The bytes go back FIRST and unconditionally: an anchor re-assertion failure is a
 * report, never a reason to leave a mutated file on disk.
 */
export function restore(snap, options = {}) {
  const extra = options.anchors ?? [];
  writeFileSync(snap.path, snap.bytes);

  const onDisk = readFileSync(snap.path);
  if (sha256(onDisk) !== snap.sha256) {
    throw new MutationHarnessError(
      `${snap.path} was NOT restored byte-identically (sha256 mismatch) — do not commit`,
    );
  }

  const text = onDisk.toString('utf8');
  const problems = [];
  for (const anchor of [...snap.anchors, ...extra]) {
    const n = countOccurrences(text, anchor);
    if (n !== 1) {
      problems.push(
        `anchor occurs ${n} times in ${snap.path} (expected exactly 1): ${JSON.stringify(anchor)}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new MutationHarnessError(problems.join('\n'));
  }
  return snap;
}

/** Serialise a snapshot so a non-Node harness can hold it across processes. */
export function saveSnapshot(snap, snapPath) {
  writeFileSync(
    snapPath,
    JSON.stringify({
      path: snap.path,
      base64: snap.bytes.toString('base64'),
      sha256: snap.sha256,
      anchors: snap.anchors,
    }),
    'utf8',
  );
  return snapPath;
}

export function loadSnapshot(snapPath) {
  const raw = JSON.parse(readFileSync(snapPath, 'utf8'));
  return {
    path: raw.path,
    bytes: Buffer.from(raw.base64, 'base64'),
    sha256: raw.sha256,
    anchors: raw.anchors ?? [],
  };
}

/** Run `fn` with the file snapshotted, restoring it whatever happens. */
export function withSnapshot(filePath, fn) {
  const snap = snapshot(filePath);
  try {
    return fn(snap);
  } finally {
    restore(snap);
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// For bash/Go harnesses: they hold the snapshot as a JSON file between steps.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , cmd, ...rest] = process.argv;
  try {
    if (cmd === 'snapshot') {
      const [file, snapPath] = rest;
      saveSnapshot(snapshot(file), snapPath);
    } else if (cmd === 'mutate') {
      const [snapPath, anchor, replacement] = rest;
      const snap = loadSnapshot(snapPath);
      mutate(snap, anchor, replacement);
      saveSnapshot(snap, snapPath);
    } else if (cmd === 'restore') {
      const [snapPath] = rest;
      restore(loadSnapshot(snapPath));
    } else {
      console.error(
        'usage: mutation-harness.mjs snapshot <file> <snap.json>\n' +
          '       mutation-harness.mjs mutate <snap.json> <anchor> <replacement>\n' +
          '       mutation-harness.mjs restore <snap.json>',
      );
      process.exit(2);
    }
  } catch (err) {
    console.error(`mutation-harness: ${err.message}`);
    process.exit(1);
  }
}
