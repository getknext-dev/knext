#!/usr/bin/env node
/**
 * Mutation-residue scan (#645, proposal A).
 *
 * WHAT IT REPLACES
 * ----------------
 * The documented mutation-safety check was `git status --porcelain` after a
 * restore. That check is unsound in the common case: **it cannot see residue in a
 * file the change legitimately modifies**, because the file reads `M` either way.
 * Both #645 incidents hid in exactly that blind spot, and one of them would have
 * shipped the inverse of its own fix.
 *
 * So this scan never consults git's *status*. It asks a different question, whose
 * answer does not depend on what the PR intends to change: does any TRACKED file
 * contain the standard mutation marker?
 *
 * SCANNING, NOT ENUMERATING
 * -------------------------
 * Every tracked file is read — no list of "files harnesses are allowed to mutate",
 * because an enumerated list is how the second call site gets missed. The file set
 * comes from `git ls-files`, which is also what keeps the scan honest AND fast:
 * a naive repo-wide grep matches minified vendor output under `.next/` and
 * `node_modules/` (observed), producing noise that trains people to ignore the
 * result. Tracked-only excludes both by construction.
 *
 * KNOWN GAP, stated rather than hidden: residue in an UNTRACKED file is not
 * reported. Mutations edit existing source, so residue lands in a tracked file by
 * construction — but a brand-new file carrying the marker passes until it is added.
 *
 * NO ALLOWLIST. There is deliberately no exemption mechanism: an exemption is how
 * a real hit gets silenced. The marker is assembled from parts in
 * `lib/mutation-harness.mjs`, so neither that file, nor this one, nor their tests
 * ever contain the literal string — which is why this guard does not flag itself
 * and needs no exemption to avoid doing so.
 *
 * Usage:  node scripts/scan-mutation-residue.mjs     (exit 1 on any hit)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTATION_MARKER } from './lib/mutation-harness.mjs';

/** Files larger than this are not plausible hand-edited source. */
const MAX_BYTES = 8 * 1024 * 1024;

/** Git's own heuristic: a NUL in the first 8000 bytes means binary. */
function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function trackedFiles(cwd) {
  return execFileSync('git', ['ls-files', '-z'], { cwd, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

/**
 * Scan every tracked file and report both halves: how many files were actually
 * read, and which of them carry residue.
 *
 * The `scanned` count is not decoration — a scan whose file set silently
 * collapsed to nothing reports "clean" forever, so callers assert on it.
 *
 * @param {{ cwd?: string }} options
 * @returns {{ scanned: number, offenders: Array<{path: string, line: number, text: string}> }}
 */
export function scanTracked(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const offenders = [];
  let scanned = 0;

  for (const rel of trackedFiles(cwd)) {
    let buf;
    try {
      buf = readFileSync(join(cwd, rel));
    } catch {
      continue; // deleted in this working tree
    }
    if (buf.length > MAX_BYTES || isBinary(buf)) continue;
    scanned += 1;

    const text = buf.toString('utf8');
    const idx = text.indexOf(MUTATION_MARKER);
    if (idx === -1) continue;
    const line = text.slice(0, idx).split('\n').length;
    offenders.push({ path: rel, line, text: text.split('\n')[line - 1].trim() });
  }

  return { scanned, offenders };
}

/** The offenders alone — the common case. */
export function scanForResidue(options = {}) {
  return scanTracked(options).offenders;
}

export function formatReport(offenders) {
  return [
    `Mutation residue in ${offenders.length} tracked file(s):`,
    ...offenders.map((o) => `  ${o.path}:${o.line}  ${o.text}`),
    '',
    'A mutation-testing proof was not restored. `git status` cannot catch this when',
    'the file is one the change legitimately modifies — that is why this scan exists (#645).',
    'Restore from the byte snapshot (scripts/lib/mutation-harness.mjs), never by replaying',
    'inverse edits, and re-assert every anchor occurs exactly once. See',
    'docs/guides/mutation-testing.md.',
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const offenders = scanForResidue();
  if (offenders.length > 0) {
    console.error(formatReport(offenders));
    process.exit(1);
  }
  console.log('No mutation residue in tracked files.');
}
