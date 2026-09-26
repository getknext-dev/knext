import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// #1293: the root `.dockerignore`'s bare patterns (`node_modules`, `.next`,
// `.turbo`, `dist`, `coverage`, `*.log`, `.git`) matched ONLY at the build
// context root — Docker's `.dockerignore` is NOT recursive the way
// `.gitignore` is, unlike the already-fixed `.vinext`/`.output` lines (#1284)
// this file's own comment explains at length. Every one of those directories
// ALSO exists nested under `apps/*`/`packages/*`, so the bare form left every
// nested copy reachable by `COPY . .`.
//
// `docs` is the ONE deliberate exception: a recursive form would also match
// `apps/docs` (a real Next.js app whose own Dockerfile needs its directory
// in the build context), so it MUST stay bare.
//
// This guard asserts the SHAPE (every pattern but `docs` uses the recursive
// double-star prefix) AND cross-checks it against every actual `COPY` in
// every Dockerfile a GitHub Actions workflow ACTUALLY builds with
// `context: .` (a `COPY --from=<stage>` reads a PREVIOUS BUILD STAGE's
// filesystem, never `.dockerignore`-filtered, but any non-`--from` `COPY`
// reading a HOST path matching an excluded directory would silently break;
// asserting none exists keeps this file's own "audited every COPY before
// widening" claim honest, not just documented).
//
// #1413 review (round 1411): the earlier version of this file (a) hardcoded
// the Dockerfile list by hand — it named `apps/docs/Dockerfile` and
// `apps/docs/Dockerfile.oke`, NEITHER of which any workflow actually builds
// with `context: .` (Dockerfile.oke is built manually for the OKE deploy,
// outside CI entirely) — and (b) the COPY cross-check only looked at a
// source path's FIRST segment, so a nested `COPY packages/kn-next/dist ...`
// (excluded basename in the SECOND segment) would sail through unnoticed.
// Both are fixed: the Dockerfile list is DERIVED by parsing every workflow's
// `docker/build-push-action` steps (including matrix-driven `file:` values),
// and the COPY check scans every path SEGMENT, not just the first.

const ROOT = join(import.meta.dirname, '..');
const WORKFLOWS_DIR = join(ROOT, '.github/workflows');
const DOCKERIGNORE = readFileSync(join(ROOT, '.dockerignore'), 'utf8');

interface BuildPushStep {
  uses?: string;
  with?: { context?: string; file?: string; [k: string]: unknown };
}
interface Job {
  strategy?: { matrix?: { include?: Array<Record<string, string>> } };
  steps?: BuildPushStep[];
}
interface Workflow {
  jobs?: Record<string, Job>;
}

/**
 * Every Dockerfile actually built with `context: .` by a `docker/build-
 * push-action` step across all workflows — resolved for real, including the
 * matrix-driven `file: ${{ matrix.file }}` form (supply-chain.yml's
 * built-image-trivy job), never a hand-maintained list.
 */
function rootContextDockerfiles(): string[] {
  const found = new Set<string>();
  for (const name of readdirSync(WORKFLOWS_DIR)) {
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
    const doc = parse(readFileSync(join(WORKFLOWS_DIR, name), 'utf8')) as Workflow;
    for (const job of Object.values(doc.jobs ?? {})) {
      const matrixFiles = (job.strategy?.matrix?.include ?? [])
        .map((entry) => entry.file)
        .filter((f): f is string => typeof f === 'string');
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith('docker/build-push-action')) continue;
        const context = step.with?.context;
        const file = step.with?.file;
        if (context !== '.' || !file) continue;
        if (/^\s*\$\{\{\s*matrix\.file\s*\}\}\s*$/.test(file)) {
          for (const f of matrixFiles) found.add(f);
        } else if (!file.includes('${{')) {
          // A literal path. An interpolated-but-non-matrix expression (none
          // exist today) is deliberately left unresolved rather than guessed.
          found.add(file);
        }
      }
    }
  }
  return [...found].sort();
}

/** Non-comment, non-blank lines — the actual ignore patterns. */
function patterns(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

describe('.dockerignore patterns are recursion-correct (#1293)', () => {
  const lines = patterns(DOCKERIGNORE);

  it('the file actually has patterns (guard is alive)', () => {
    expect(lines.length).toBeGreaterThanOrEqual(9);
  });

  it('every pattern except `docs` is `**/`-prefixed (recursive)', () => {
    const nonRecursive = lines.filter((p) => p !== 'docs' && !p.startsWith('**/'));
    expect(nonRecursive).toEqual([]);
  });

  it('`docs` is present and is DELIBERATELY bare, not `**/docs`', () => {
    expect(lines).toContain('docs');
    expect(lines).not.toContain('**/docs');
  });

  it('the known set of previously-bare, now-recursive patterns is present', () => {
    const expected = [
      '**/node_modules',
      '**/dist',
      '**/.next',
      '**/.open-next',
      '**/.git',
      '**/.turbo',
      '**/*.log',
      '**/coverage',
    ];
    for (const p of expected) {
      expect(lines).toContain(p);
    }
  });

  it('no duplicate patterns (a recursive AND a bare form of the same name would be redundant/confusing)', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const p of lines) {
      if (seen.has(p)) dupes.push(p);
      seen.add(p);
    }
    expect(dupes).toEqual([]);
  });

  it('the Dockerfile scan itself is alive (finds the known, currently-CI-built set)', () => {
    const found = rootContextDockerfiles();
    expect(found).toContain('apps/file-manager/Dockerfile');
    expect(found).toContain('apps/docs/Dockerfile.trivyscan');
    expect(found).toContain('examples/bun-exec/Dockerfile.node.trivyscan');
    // Never built with context: . by any workflow — a manual/OKE-deploy
    // artifact, not a CI-audited one. If a workflow ever DOES build it,
    // this scan picks it up automatically; nothing to update by hand.
    expect(found).not.toContain('apps/docs/Dockerfile.oke');
  });

  describe('cross-check against every root-context Dockerfile COPY', () => {
    // Directory/file BASENAMES the recursive patterns exclude. `docs` is
    // excluded from this list deliberately — `apps/docs` legitimately needs
    // itself in context, so a COPY under a `docs` path is expected there.
    const excludedBasenames = [
      'node_modules',
      'dist',
      '.next',
      '.open-next',
      '.git',
      '.turbo',
      'coverage',
    ];

    for (const dockerfile of rootContextDockerfiles()) {
      it(`${dockerfile}: no non-'--from' COPY reads an excluded directory from the host context, at ANY path depth`, () => {
        const text = readFileSync(join(ROOT, dockerfile), 'utf8');
        const copyLines = text
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('COPY ') && !l.includes('--from='));

        const offenders: string[] = [];
        for (const line of copyLines) {
          // `COPY <src...> <dest>` — everything but the last token is a
          // source path (multi-src COPY is rare but valid syntax).
          const tokens = line.split(/\s+/).slice(1, -1);
          for (const src of tokens) {
            // Check EVERY path segment, not just the first — a nested
            // `COPY packages/kn-next/dist ...` has the excluded basename
            // ("dist") in the SECOND segment, and `**/`-prefixed
            // .dockerignore patterns exclude it at any depth, so the COPY
            // check must match that same "any depth" semantics (#1413
            // review, round 1411).
            const segments = src.replace(/^\.\//, '').split('/');
            const hitSegment = segments.find((seg) => excludedBasenames.includes(seg));
            if (hitSegment) {
              offenders.push(
                `${line}  (source path "${src}" contains excluded segment "${hitSegment}")`,
              );
            }
            if (src.endsWith('.log')) {
              offenders.push(`${line}  (source path "${src}" matches excluded *.log)`);
            }
          }
        }
        expect(offenders).toEqual([]);
      });
    }
  });
});
