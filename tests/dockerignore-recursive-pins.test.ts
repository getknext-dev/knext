import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
// double-star prefix) AND cross-checks it against every actual `COPY` in the
// two Dockerfiles whose build context resolves to this workspace root
// (`apps/file-manager/Dockerfile`, `apps/docs/Dockerfile`,
// `apps/docs/Dockerfile.oke`) — a `COPY --from=<stage>` reads a PREVIOUS
// BUILD STAGE's filesystem (never `.dockerignore`-filtered), but any
// non-`--from` `COPY` reading a HOST path matching an excluded directory
// would silently break; asserting none exists keeps this file's own
// "audited every COPY before widening" claim honest, not just documented.

const ROOT = join(import.meta.dirname, '..');
const DOCKERIGNORE = readFileSync(join(ROOT, '.dockerignore'), 'utf8');

const ROOT_CONTEXT_DOCKERFILES = [
  'apps/file-manager/Dockerfile',
  'apps/docs/Dockerfile',
  'apps/docs/Dockerfile.oke',
];

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

    for (const dockerfile of ROOT_CONTEXT_DOCKERFILES) {
      it(`${dockerfile}: no non-'--from' COPY reads an excluded directory from the host context`, () => {
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
            const firstSegment = src.replace(/^\.\//, '').split('/')[0];
            if (excludedBasenames.includes(firstSegment)) {
              offenders.push(
                `${line}  (source path "${src}" starts with excluded "${firstSegment}")`,
              );
            }
            if (src.endsWith('.log') || src.match(/\.log$/)) {
              offenders.push(`${line}  (source path "${src}" matches excluded *.log)`);
            }
          }
        }
        expect(offenders).toEqual([]);
      });
    }
  });
});
