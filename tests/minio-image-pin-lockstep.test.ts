import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #1403: quay.io/minio/minio and docker.io/minio/minio (and their `mc` client
 * counterparts) now UNAUTHORIZE every anonymous pull, repo-wide — verified
 * with `crane manifest`/`crane ls` against several tags AND the previously
 * pinned "last-good" digest, not a transient flake or rate limit. Every kind
 * -based CI job and local drill that stood up a throwaway MinIO fixture broke
 * at once. Fixed by repinning to Bitnami's post-license-change "legacy" free
 * mirror (unmaintained but genuine MinIO software, proven S3-API-compatible:
 * bucket create, anonymous-read bucket policy, GetObject all verified live).
 *
 * This guard SCANS the repo (never a hand-maintained call-site list — that is
 * exactly how the drift class this file guards against gets missed) for any
 * `minio/minio` or `minio/mc` image reference and asserts it is either:
 *   (a) one of the two pinned, known-working Bitnami digests below, or
 *   (b) the ONE deliberate exception (packages/scale-zero-pg/deploy/50-minio.yaml
 *       — szpg's LIVE persistent plane, left for szpg's own review process; see
 *       the comment block this test also asserts is present).
 *
 * Mutation-prove: change either PINNED_MINIO_DIGEST/PINNED_MC_DIGEST, or add a
 * new unpinned/differently-pinned minio reference anywhere in the repo, and
 * this test goes red.
 */

const ROOT = join(import.meta.dirname, '..');

const PINNED_MINIO_DIGEST =
  'sha256:451fe6858cb770cc9d0e77ba811ce287420f781c7c1b806a386f6896471a349c';
const PINNED_MC_DIGEST = 'sha256:00dcc4e58ada0df45bb7d9ee435af98295f96c27c3c68292ce78ec700a87b511';

const ALLOWED_MINIO_REFS = new Set([
  `docker.io/bitnamilegacy/minio@${PINNED_MINIO_DIGEST}`,
  `docker.io/bitnamilegacy/minio-client@${PINNED_MC_DIGEST}`,
]);

/** The one deliberately-unfixed reference — szpg's live persistent plane. */
const EXEMPT_FILE = 'packages/scale-zero-pg/deploy/50-minio.yaml';

// Scan via git ls-files (tracked files only — never node_modules/.git/worktrees)
// and grep, so this can never silently skip a directory the way a hand-picked
// glob could.
function grepRepo(pattern: string): string[] {
  try {
    const out = execFileSync('git', ['grep', '-lE', pattern, '--', ':(exclude).claude/worktrees'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch (e) {
    // git grep exits 1 when there are no matches — that's a valid "found
    // nothing", not a tool failure. Any other exit code is a real error.
    const err = e as { status?: number };
    if (err.status === 1) return [];
    throw e;
  }
}

describe('MinIO image references are lockstep-pinned to the working mirror (#1403)', () => {
  it('finds at least one reference (the guard itself is alive)', () => {
    const files = grepRepo('docker\\.io/bitnamilegacy/minio(-client)?[:@]');
    expect(files.length).toBeGreaterThan(0);
  });

  it('no REAL image reference still points at the broken quay.io/docker.io minio/minio or minio/mc registries', () => {
    // A REAL reference has an actual tag or a real 64-hex digest attached —
    // this is what distinguishes an `image:`/`IMG_MC=`/const value from a
    // comment or a regex-pattern STRING that merely mentions the broken
    // registry name in prose (e.g. _validate.sh's own grep pattern, which
    // contains literal bracket-class syntax like `[0-9a-f]{64}`, never real
    // hex, and so never matches this).
    const brokenRefPattern =
      /(quay\.io|docker\.io)\/minio\/(minio|mc)(:[A-Za-z0-9][A-Za-z0-9._-]*)?@sha256:[0-9a-f]{64}|(quay\.io|docker\.io)\/minio\/(minio|mc):[A-Za-z0-9][A-Za-z0-9._-]*(?!["'`]?\s*(is|are|and|UNAUTHORIZ))/g;
    const files = grepRepo('(quay\\.io|docker\\.io)/minio/(minio|mc)[:@]');
    const offenders: string[] = [];
    for (const relPath of files) {
      if (relPath === EXEMPT_FILE) continue; // szpg's own review owns this one
      const text = readFileSync(join(ROOT, relPath), 'utf8');
      for (const line of text.split('\n')) {
        const matches = line.match(brokenRefPattern);
        if (matches) offenders.push(`${relPath}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every `docker.io/bitnamilegacy/minio(-client)?` reference uses one of the two pinned digests, never a mutable tag', () => {
    const files = grepRepo('docker\\.io/bitnamilegacy/minio(-client)?[:@]');
    const offenders: string[] = [];
    for (const relPath of files) {
      // Go source sometimes splits a long string literal across two lines
      // (`"...sha256:" + \n "<hex>"`) — join a quote-plus-newline-quote
      // continuation before scanning so that split doesn't look unpinned.
      const raw = readFileSync(join(ROOT, relPath), 'utf8');
      const text = raw.replace(/"\s*\+\s*\n\s*"/g, '');
      for (const line of text.split('\n')) {
        const refs = line.match(/docker\.io\/bitnamilegacy\/minio(-client)?[@:][A-Za-z0-9._:-]+/g);
        if (!refs) continue;
        for (const ref of refs) {
          const isPinned = [...ALLOWED_MINIO_REFS].some((allowed) => ref.startsWith(allowed));
          if (!isPinned) offenders.push(`${relPath}: ${ref}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the exempt file documents WHY it is exempt (not a silent skip)', () => {
    const text = readFileSync(join(ROOT, EXEMPT_FILE), 'utf8');
    expect(text).toContain('#1403');
    expect(text).toContain('UNPULLABLE');
  });

  it('the two pinned digests are well-formed sha256 hex', () => {
    expect(PINNED_MINIO_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(PINNED_MC_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(PINNED_MINIO_DIGEST).not.toBe(PINNED_MC_DIGEST);
  });
});
