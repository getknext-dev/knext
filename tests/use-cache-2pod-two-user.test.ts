import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Two users of ONE `'use cache'` function get separate entries, across two pods,
 * on a REAL Redis. The proof runs on kind (.github/workflows/use-cache-2pod-kind-e2e.yml,
 * the users section of scripts/use-cache-2pod-e2e-assert.sh); these tests keep
 * its pieces honest where a PR can see them:
 *
 * - the fixture's per-user route really passes the user as an ARGUMENT to the
 *   cached function (Next derives the cache key from the arguments, so an
 *   argument-less function would make the two-user check meaningless);
 * - the assertion script reads both users on both pods and fails at a named
 *   message when one user is served the other's entry;
 * - the lane has an expected-red leg that collapses knext's entry key in the
 *   SHIPPED tarball, and that leg must go red at that message;
 * - the mutation script that builds that leg refuses unless its anchor occurs
 *   exactly once (a silently-failed substitution would make the red leg green
 *   for the wrong reason).
 */

const ROOT = resolve(import.meta.dir, '..');
const FIXTURE = join(ROOT, 'packages/kn-next/src/__tests__/fixtures/use-cache-kind-app');
const USER_ROUTE = join(FIXTURE, 'app/api/uc/user/[user]/route.ts');
const REVALIDATE_ROUTE = join(FIXTURE, 'app/api/uc/revalidate/route.ts');
const ASSERT = join(ROOT, 'scripts/use-cache-2pod-e2e-assert.sh');
const WF = join(ROOT, '.github/workflows/use-cache-2pod-kind-e2e.yml');
const MUTATE = join(ROOT, 'scripts/use-cache-collapse-keys-mutation.mjs');
const HANDLER_SRC = join(ROOT, 'packages/kn-next/src/adapters/use-cache-handler.js');

const COLLAPSED_MSG = 'cache keys collapsed';

describe('the per-user fixture route', () => {
  const src = readFileSync(USER_ROUTE, 'utf8');

  it('caches a function that takes the user as its argument', () => {
    // `async function profileFor(user: string) { "use cache"; ... }`
    const fn = /async function (\w+)\(\s*user\s*:\s*string\s*\)\s*\{\s*["']use cache["'];/.exec(
      src,
    );
    expect(fn).not.toBeNull();
    // ...and the route calls it WITH the user, not with a constant.
    expect(src).toMatch(new RegExp(`await ${fn?.[1]}\\(\\s*user\\s*\\)`));
  });

  it('tags each entry with the user, so one user can be invalidated alone', () => {
    expect(src).toContain('cacheTag("uc-2pod", `uc-user-${user}`)');
  });

  it('echoes the subject the entry was built for', () => {
    expect(src).toMatch(/return\s*\{\s*user,/);
  });

  it('the authenticated revalidate route accepts only the allow-listed tags', () => {
    const rev = readFileSync(REVALIDATE_ROUTE, 'utf8');
    // Auth runs before the tag is read.
    expect(rev.indexOf('authorized(')).toBeLessThan(rev.indexOf('searchParams'));
    expect(rev).toContain('/^uc-(2pod|user-[a-z0-9-]{1,32})$/');
  });
});

describe('the assertion script reads both users on both pods', () => {
  const sh = readFileSync(ASSERT, 'utf8');

  it('requests both users through each pinned pod', () => {
    expect(sh).toContain('user_stamp "$PORT_A" alice');
    expect(sh).toContain('user_stamp "$PORT_A" bob');
    expect(sh).toContain('user_stamp "$PORT_B" alice');
    expect(sh).toContain('user_stamp "$PORT_B" bob');
  });

  it("fails at a named message when one user is served the other user's entry", () => {
    expect(sh).toContain(COLLAPSED_MSG);
  });

  it("invalidates one user and requires the other user's entry to survive", () => {
    expect(sh).toContain('revalidate "$PORT_A" "$POD_A" uc-user-alice');
    expect(sh).toContain("bob's entry did not survive alice's invalidation");
  });
});

describe('the lane has an expected-red collapsed-keys leg', () => {
  const wf = readFileSync(WF, 'utf8');

  it('declares the variant in the matrix', () => {
    expect(wf).toContain('- { runtime: node, variant: collapsed-keys }');
  });

  it('mutates the SHIPPED tarball in the staged app, only for that variant', () => {
    expect(wf).toContain("if: matrix.variant == 'collapsed-keys'");
    expect(wf).toContain(
      'node scripts/use-cache-collapse-keys-mutation.mjs "$APP_DIR/node_modules/@getknext/core/dist"',
    );
  });

  it('requires the collapsed build to go red at the two-user assertion', () => {
    const step = wf.slice(wf.indexOf('Expected red — keys collapsed'));
    expect(step).toContain(`grep -F "${COLLAPSED_MSG}"`);
    expect(step).toContain('if [ "$rc" -eq 0 ]; then');
  });

  it('the passing variants also run the users section (no section is opt-in)', () => {
    expect(readFileSync(ASSERT, 'utf8')).not.toMatch(/UC_SKIP_USERS|UC_SECTIONS/);
  });

  it('re-runs when the mutation script changes', () => {
    expect(wf).toContain("- 'scripts/use-cache-collapse-keys-mutation.mjs'");
  });
});

describe('the collapse-keys mutation script', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'uc-collapse-'));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    return dir;
  };
  const run = (dir: string) =>
    spawnSync('node', [MUTATE, dir], { encoding: 'utf8', timeout: 30000 });

  const handler = readFileSync(HANDLER_SRC, 'utf8');
  // tsup renames the parameter when it bundles (cacheKey -> cacheKey2).
  const bundled = handler.replace(
    /const entryKey = \(cacheKey\) => `\$\{core\.keyPrefix\(\)\}:uc:\$\{kind\}:\$\{cacheKey\}`;/,
    'const entryKey = (cacheKey2) => `${core.keyPrefix()}:uc:${kind}:${cacheKey2}`;',
  );

  it('the shipped handler still has the anchor (the test is about the real line)', () => {
    expect(bundled).not.toBe(handler);
  });

  for (const [label, body] of [
    ['source', handler],
    ['bundled', bundled],
  ] as const) {
    it(`collapses every entry onto one key in the ${label} form`, () => {
      const dir = tmp({ 'chunk-ABC.js': body, 'chunk-ABC.js.map': body, 'other.js': 'x' });
      const r = run(dir);
      expect(r.status).toBe(0);
      const out = readFileSync(join(dir, 'chunk-ABC.js'), 'utf8');
      expect(out).toContain(':uc:${kind}:collapsed`');
      expect(out).not.toMatch(/:uc:\$\{kind\}:\$\{cacheKey2?\}`/);
      // Source maps are not code: left alone.
      expect(readFileSync(join(dir, 'chunk-ABC.js.map'), 'utf8')).toBe(body);
    });
  }

  it('refuses when the anchor is absent', () => {
    const r = run(tmp({ 'a.js': 'const x = 1;' }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('found 0');
  });

  it('refuses when the anchor occurs more than once', () => {
    const r = run(tmp({ 'a.js': bundled, 'nested/b.js': bundled }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('found 2');
  });
});
