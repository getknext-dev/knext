/**
 * Boot-time claim hygiene for the public docs site.
 *
 * The ~61 ms figure is a LOCAL, warm-binary process-boot micro-benchmark
 * (examples/bun-exec, n=10, binary already page-cached) — it is not a cluster
 * cold-start number. On a real Knative cluster the measured cold start was a
 * TIE between build targets (~3.4-3.6 s, dominated by pod scheduling and
 * container start). Any user-facing mention of that figure must stay
 * qualified as a local/process-boot number, in a file that also carries the
 * cluster-dominates-cold-start caveat — so an unqualified "~61 ms boot"
 * headline (e.g. on the landing page hero) cannot silently return.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const APPS_DOCS_DIR = resolve(import.meta.dirname);

function textFiles(dir: string, exts: string[]): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === '.next') return [];
    const stat = statSync(full);
    if (stat.isDirectory()) return textFiles(full, exts);
    return exts.some((ext) => full.endsWith(ext)) ? [full] : [];
  });
}

// The landing page (app/(home)/page.tsx), the root layout metadata, and every
// docs content page are all rendered/served to real users.
const FILES = [
  ...textFiles(join(APPS_DOCS_DIR, 'app'), ['.tsx']),
  ...textFiles(join(APPS_DOCS_DIR, 'content/docs'), ['.mdx']),
];

const BOOT_FIGURE = /\b61\s*(&nbsp;|\s)?ms\b/i;
const LOCAL_QUALIFIER = /\blocal\b/i;
// The file must also carry the honest cluster-cold-start caveat somewhere,
// not just the word "local" next to the number.
const CLUSTER_CAVEAT =
  /cluster cold start|dominated by (the )?(platform|knative|pod scheduling)|knative activat|pod scheduling and container|scheduling dominates|dominates the (end-to-end )?cold start/i;

function readAll(file: string): string {
  return readFileSync(file, 'utf-8');
}

describe('docs content — boot-time claim hygiene (~61 ms)', () => {
  it('has files to check', () => {
    expect(FILES.length).toBeGreaterThan(5);
  });

  it('never states the unqualified landing-page headline "bytecode-baked binary itself boots"', () => {
    for (const file of FILES) {
      const content = readAll(file);
      expect(
        content,
        `${relative(APPS_DOCS_DIR, file)} must not carry the unqualified boot-time headline`,
      ).not.toMatch(/bytecode-baked binary itself boots/i);
    }
  });

  it('every file that mentions the 61 ms figure also carries the local and cluster-caveat qualifiers', () => {
    // File-level, not line-adjacency: docs prose puts the "local" qualifier
    // and the cluster-dominates-cold-start caveat in a different sentence (or
    // paragraph) than the number itself, which is fine — what must never
    // happen is a file citing the figure with NEITHER qualifier anywhere in
    // it (that is the landing-page-headline failure mode this guard exists
    // to catch; the landing page itself is additionally barred from citing
    // any number below).
    const violations: string[] = [];
    for (const file of FILES) {
      const content = readAll(file);
      if (!BOOT_FIGURE.test(content)) continue;
      const hasLocalQualifier = LOCAL_QUALIFIER.test(content);
      const hasClusterCaveat = CLUSTER_CAVEAT.test(content);
      if (!hasLocalQualifier || !hasClusterCaveat) {
        violations.push(
          `${relative(APPS_DOCS_DIR, file)} ` +
            `(local-qualifier=${hasLocalQualifier}, cluster-caveat-present=${hasClusterCaveat})`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('mutation control: the guard regexes actually match the stale forms they exist to catch', () => {
    expect(
      /bytecode-baked binary itself boots/i.test(
        'the bytecode-baked binary itself boots in ~61 ms',
      ),
    ).toBe(true);
    expect(BOOT_FIGURE.test('boots in ~61&nbsp;ms')).toBe(true);
    expect(BOOT_FIGURE.test('boots in 61 ms')).toBe(true);
    expect(BOOT_FIGURE.test('boots in 618 ms')).toBe(false);
    expect(LOCAL_QUALIFIER.test('a fresh local process')).toBe(true);
    expect(LOCAL_QUALIFIER.test('local warm-binary process boot')).toBe(true);
    expect(
      CLUSTER_CAVEAT.test('on a real cluster the pod scheduling and container start dominate'),
    ).toBe(true);
    expect(CLUSTER_CAVEAT.test('this is a fast binary')).toBe(false);
  });
});

describe('docs content — landing page / site metadata carry no boot-time number or superlative', () => {
  // Founder direction: the landing page hero and the site <meta description>
  // are the highest-visibility surfaces and must not cite any cold-start
  // millisecond/req-per-sec figure at all (qualified or not) — say only that
  // cold starts are "optimized". They must also not claim a superlative
  // ("fastest", "quickest", "best", "most optimal", etc.) — the measured
  // cluster cold start is a TIE between build targets, so any superlative
  // about speed would itself be an overclaim.
  const LANDING_PAGE = resolve(APPS_DOCS_DIR, 'app/(home)/page.tsx');
  const ROOT_LAYOUT = resolve(APPS_DOCS_DIR, 'app/layout.tsx');
  const HIGH_VISIBILITY_FILES = [LANDING_PAGE, ROOT_LAYOUT];

  const ANY_NUMERIC_FIGURE = /\b\d[\d,.]*\s*(&nbsp;|\s)?(ms|s|req\/s|requests?\/sec|x|%)\b/i;
  const SUPERLATIVE = /\b(fastest|quickest|speediest|most optimal|best-in-class|unbeatable)\b/i;

  it('the landing page and root layout exist', () => {
    for (const file of HIGH_VISIBILITY_FILES) {
      expect(statSync(file).isFile()).toBe(true);
    }
  });

  it('cites no boot-time/throughput number at all', () => {
    for (const file of HIGH_VISIBILITY_FILES) {
      const content = readAll(file);
      const hits = content
        .split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => ANY_NUMERIC_FIGURE.test(line));
      expect(
        hits.map((h) => `${relative(APPS_DOCS_DIR, file)}:${h.i + 1}: ${h.line.trim()}`),
        `${relative(APPS_DOCS_DIR, file)} must not cite a boot-time/throughput figure`,
      ).toEqual([]);
    }
  });

  it('claims no speed superlative', () => {
    for (const file of HIGH_VISIBILITY_FILES) {
      const content = readAll(file);
      expect(
        content,
        `${relative(APPS_DOCS_DIR, file)} must not claim a speed superlative (cluster cold start is a tie)`,
      ).not.toMatch(SUPERLATIVE);
    }
  });

  it('says cold starts are optimized', () => {
    const content = readAll(LANDING_PAGE) + readAll(ROOT_LAYOUT);
    expect(content).toMatch(/optimized cold start/i);
  });

  it('mutation control: the numeric-figure and superlative guards actually match', () => {
    expect(ANY_NUMERIC_FIGURE.test('boots in ~61 ms')).toBe(true);
    expect(ANY_NUMERIC_FIGURE.test('1103 req/s')).toBe(true);
    expect(ANY_NUMERIC_FIGURE.test('14x faster')).toBe(true);
    expect(ANY_NUMERIC_FIGURE.test('optimized cold starts')).toBe(false);
    expect(SUPERLATIVE.test('the fastest cold start on Knative')).toBe(true);
    expect(SUPERLATIVE.test('an optimized cold start')).toBe(false);
  });
});
