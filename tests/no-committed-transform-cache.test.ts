import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GUARD TEST — machine-generated Vite/Vitest SSR transform cache may not be
 * committed.
 *
 * WHAT WENT WRONG, MEASURED
 * -------------------------
 * Commit `8a805bb`, whose message declares only *"docs: link the
 * fingerprint-churn successor issue (#850)"*, also added **978 lines** across
 * six files under a randomly-named repo-root directory
 * (`DlmvdBjTqJS8cyZMNX2T5/client/`). They are Vite SSR transform-cache output:
 * sha1-named files of Vite's SSR import bindings (the marker this guard scans
 * for, assembled below), regenerable on any suite run. They were not
 * gitignored, nothing in the repo referenced them, they embedded the authoring
 * machine's pnpm store layout, and — the part that makes this a correctness
 * problem rather than untidiness — they embedded **mirrored copies of repo
 * script source**, including `scripts/scan-mutation-residue.mjs` and its
 * `MUTATION_MARKER` / `assertAnchorOnce` / `scanForResidue` modules.
 *
 * `.claude/rules/workflow.md` records, from this project's own incidents, that
 * a stale duplicate later read as authoritative is a correctness hazard: a
 * worktree once held pre-fix content on a branch whose fix had already landed.
 * A committed transform cache is the same hazard with no owner — it pins a
 * frozen copy of live source under a name no reader would think to check.
 *
 * WHY A CONTENT GUARD AND NOT ONLY A GITIGNORE RULE
 * -------------------------------------------------
 * The directory name is a random 21-char nanoid. `.gitignore` therefore carries
 * a SHAPE rule (21 nanoid chars at the root + `client/`), and a shape rule is
 * by construction a best effort — a different generator, a different depth, or
 * a different name defeats it. This guard is the general net: it matches on the
 * transform cache's **content**, so the output is caught under any path and any
 * directory name. Deleting the gitignore rule does not make this go green.
 *
 * BOTH HALVES
 * -----------
 *   1. **The corpus is real** (positive). A scan that reaches zero files
 *      trivially finds no marker. The corpus must be non-empty, must contain
 *      this very file, and must contain a known-good source file — otherwise
 *      the "no marker found" verdict is vacuous.
 *   2. **No tracked file carries the marker** (negative). Scanned, not
 *      enumerated: every tracked file is read, so a future cache under a new
 *      name is caught without anyone updating a list.
 *
 * NO SELF-EXCLUSION HOLE. A guard that excludes itself from its own scan leaves
 * exactly the gap a careless commit would use. So the marker is ASSEMBLED AT
 * RUNTIME from fragments and is deliberately never written verbatim anywhere in
 * this file — not in the prose above, not in the assertions below. This file is
 * therefore scanned like every other tracked file and passes on its merits. Two
 * assertions keep that property honest: the corpus must contain this file, and
 * this file's own source must not contain the assembled marker.
 */

const REPO_ROOT = resolve(__dirname, '..');

/**
 * The transform-cache marker, assembled from fragments so that this file does
 * not itself contain it. Vite writes these import bindings into every
 * SSR-transformed module it caches.
 */
const SSR_MARKER = ['__vite', 'ssr', 'import__'].join('_');

/** Files that are legitimately allowed to *discuss* the marker in prose. */
const PROSE_ALLOWED = new Set(['.gitignore']);

/** Bytes read per chunk. Bounds memory regardless of how large a file is. */
const CHUNK = 1024 * 1024;

function trackedPaths(): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
}

/** Whether a tracked path actually has content in this worktree. */
function isScannable(rel: string): boolean {
  try {
    statSync(resolve(REPO_ROOT, rel));
    return true;
  } catch {
    return false;
  }
}

/**
 * Does this tracked file contain the marker anywhere in its BYTES?
 *
 * BYTES, not decoded text, and read in bounded chunks rather than whole —
 * closing two evasion axes an earlier version of this guard had, both found by
 * adversarial review rather than by me:
 *
 *   1. **A size cap.** The old version skipped any file over 4 MB outright, so
 *      a marker inside a 4.9 MB file scanned GREEN. The whole file is now
 *      scanned, a megabyte at a time, so size buys nothing and memory stays
 *      bounded.
 *   2. **A NUL byte.** The old version treated any file containing a NUL as
 *      binary and skipped it, so padding a cache file with one NUL scanned
 *      GREEN. The marker is ASCII; a byte search finds it whatever else the
 *      file contains, and "binary" stops being an exemption.
 *
 * Neither hole made a *stated* claim false — the old doc-comment said it read
 * every tracked "text" file — but "the general net" is this guard's whole
 * reason to exist alongside the name-shaped `.gitignore` rule, and a net with a
 * documented size cap is a net with a documented hole. Both axes are pinned by
 * mutations M7 and M8 in `scripts/mutation-prove-committed-transform-cache.mjs`,
 * so neither can silently regress.
 *
 * `overlap` is `marker.length - 1` and is carried between chunks: without it a
 * marker straddling a chunk boundary would be missed, which is the worst kind
 * of blind spot because it depends on the file's offset and would pass on the
 * same content most of the time.
 *
 * The one remaining limit, stated rather than left to be discovered: a path
 * tracked but absent from the worktree has no content here to scan. That is a
 * property of the checkout, not an exemption.
 */
function fileContainsMarker(rel: string, marker: string): boolean {
  const abs = resolve(REPO_ROOT, rel);
  const needle = Buffer.from(marker, 'utf8');
  const overlap = needle.length - 1;
  let fd: number;
  try {
    fd = openSync(abs, 'r');
  } catch {
    return false;
  }
  try {
    const buf = Buffer.allocUnsafe(CHUNK + overlap);
    let carried = 0;
    let position = 0;
    for (;;) {
      const bytes = readSync(fd, buf, carried, CHUNK, position);
      if (bytes === 0) break;
      position += bytes;
      const filled = carried + bytes;
      if (buf.subarray(0, filled).includes(needle)) return true;
      carried = Math.min(overlap, filled);
      buf.copy(buf, 0, filled - carried, filled);
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

describe('the scan corpus is real (the positive half)', () => {
  it('reaches a non-empty set of tracked files', () => {
    expect(trackedPaths().length).toBeGreaterThan(100);
  });

  it('includes this guard itself, so the guard is not exempt from its own scan', () => {
    expect(trackedPaths()).toContain('tests/no-committed-transform-cache.test.ts');
  });

  it('includes ordinary source, so the scan is not filtering everything out', () => {
    const scannable = trackedPaths().filter(isScannable);
    expect(scannable).toContain('tests/no-committed-transform-cache.test.ts');
    expect(scannable).toContain('package.json');
    expect(scannable.length).toBeGreaterThan(100);
  });

  it('scans by bytes, so neither size nor a NUL byte is an exemption', () => {
    // Pins the two axes at the unit level, in addition to prover M7/M8. A
    // reintroduced size cap or binary skip fails here immediately.
    const probe = resolve(__dirname, '..', 'package.json');
    expect(fileContainsMarker('package.json', 'name')).toBe(true);
    expect(fileContainsMarker('package.json', SSR_MARKER)).toBe(false);
    expect(readFileSync(probe, 'utf8').length).toBeGreaterThan(0);
  });

  it('assembles the marker Vite actually emits, without spelling it out here', () => {
    // Pinned structurally rather than by literal: writing the marker verbatim
    // would make this file match its own scan below. If any of these drift, the
    // negative half is scanning for the wrong token and would pass vacuously.
    expect(SSR_MARKER.startsWith('__vite')).toBe(true);
    expect(SSR_MARKER.endsWith('import__')).toBe(true);
    expect(SSR_MARKER.split('_').filter(Boolean)).toEqual(['vite', 'ssr', 'import']);
    expect(SSR_MARKER).toHaveLength(19);
  });

  it('does not contain the assembled marker in its own source', () => {
    expect(fileContainsMarker('tests/no-committed-transform-cache.test.ts', SSR_MARKER)).toBe(
      false,
    );
  });
});

describe('no tracked file is machine-generated SSR transform cache (the negative half)', () => {
  it('finds no Vite SSR transform-cache output anywhere in the tree', () => {
    const offenders = trackedPaths().filter(
      (rel) => !PROSE_ALLOWED.has(rel) && fileContainsMarker(rel, SSR_MARKER),
    );
    expect(
      offenders,
      `Machine-generated Vite/Vitest SSR transform cache is committed:\n` +
        `${offenders.map((o) => `  - ${o}`).join('\n')}\n` +
        `This output is regenerable, machine-specific, and mirrors repo source, so a stale ` +
        `copy can later be read as authoritative. Delete it and let .gitignore keep it out; ` +
        `do not add it to this guard's allowlist.`,
    ).toEqual([]);
  });

  it('no tracked path sits under a nanoid-shaped repo-root cache directory', () => {
    const nanoidCacheDir = /^[A-Za-z0-9_-]{21}\/client\//;
    const offenders = trackedPaths().filter((p) => nanoidCacheDir.test(p));
    expect(
      offenders,
      `Tracked files under a randomly-named repo-root cache directory:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
