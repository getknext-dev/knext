/**
 * Content hygiene gate for USER-FACING release notes under `docs/release/` (#1618).
 *
 * `apps/docs/content-hygiene.test.ts` scans only `apps/docs/content/docs/**` — it never saw
 * `docs/release/`. Release notes there (the `v<semver>.md` files, e.g. `v1.0.0-rc.1.md`) become
 * GitHub release bodies and launch material, so they are USER-FACING by the same standard the
 * docs site is held to: no ADR references, no issue/PR numbers, no internal codenames.
 *
 * Scoped DELIBERATELY to the `v<semver>*.md` naming, not every file in `docs/release/`. Most of
 * that directory is internal research/spike/validation notes (`compat-honesty-gate.md`,
 * `eks-bunexec-bench.md`, `effect-4.0-spike.md`, …) that legitimately cite issue/PR numbers as
 * engineering records — they are not release notes and were never meant to ship to a reader.
 * Widening the scope to the whole directory would either force those internal notes to stop
 * citing their own sources, or force an allowlist that has to be kept in sync by hand; the naming
 * convention already draws the line the released-artifact boundary needs.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RELEASE_DIR = resolve(import.meta.dirname, '..', 'docs', 'release');

/** Release-note files proper: `v<semver>[-prerelease].md` (e.g. `v1.0.0-rc.1.md`). */
const RELEASE_NOTE_RE = /^v\d+\.\d+\.\d+.*\.md$/;

function releaseNoteFiles(): string[] {
  return readdirSync(RELEASE_DIR)
    .filter((entry) => RELEASE_NOTE_RE.test(entry))
    .map((entry) => resolve(RELEASE_DIR, entry));
}

const FILES = releaseNoteFiles();

/** Every `file:line` in a release note whose text matches `re`. */
function hits(re: RegExp): string[] {
  const out: string[] = [];
  for (const file of FILES) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      if (re.test(line)) out.push(`${file.split('/').pop()}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

describe('release notes content hygiene (docs/release/v*.md)', () => {
  it('finds at least one release-note file (an over-narrowed pattern fails silently otherwise)', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  it('the naming pattern does not sweep in internal research/spike notes', () => {
    const names = FILES.map((f) => f.split('/').pop());
    for (const internal of [
      'compat-honesty-gate.md',
      'eks-bunexec-bench.md',
      'effect-4.0-spike.md',
      'public-release-readiness.md',
    ]) {
      expect(names).not.toContain(internal);
    }
  });

  it('contains no ADR references', () => {
    expect(hits(/\bADR-?\s?\d/i)).toEqual([]);
  });

  it('contains no issue or PR numbers', () => {
    expect(hits(/(?:\bPR |\bissue |\(|\s)#\d+\b/i)).toEqual([]);
  });
});
