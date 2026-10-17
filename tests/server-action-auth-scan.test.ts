/**
 * Every Server Action and every mutating route handler authenticates before it
 * writes, or is on a counted, reasoned allowlist.
 *
 * The scan (scripts/lib/server-action-auth-scan.mjs) reads `apps/` and the app
 * scaffold templates. This spec has three halves, and each matters: RED
 * fixtures (the shapes that must be refused, including everything the scan
 * cannot read), GREEN fixtures (the shapes that must pass, so the scan is not
 * just refusing everything), and the REAL TREE (clean today, and seeing the
 * surfaces it should see - a scan that reads nothing is green too).
 *
 * Mutation proof: scripts/mutation-prove-2532-server-action-auth.mjs.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ALLOWLIST,
  AUTH_CALLS,
  SCAN_ROOTS,
  SENSITIVE_READS,
  scanSource,
  scanTree,
} from '../scripts/lib/server-action-auth-scan.mjs';

const REPO_ROOT = resolve(import.meta.dir, '..');
const ACTIONS = 'apps/demo/src/app/actions.ts';
const ROUTE = 'apps/demo/src/app/api/thing/route.ts';

const grade = (src: string, file = ACTIONS, opts = {}) => scanSource(src, file, opts);
const ungated = (src: string, file = ACTIONS, opts = {}) =>
  grade(src, file, opts).surfaces.filter((s) => !s.gated);
const problems = (src: string, file = ACTIONS) => grade(src, file).problems;

const IMPORTS = `import { authorizeMutation } from '@/app/_auth/mutation-auth';\nimport { isAuthorized } from './auth';\n`;

describe('RED: a Server Action that is not gated', () => {
  it.each([
    [
      'no check at all',
      `'use server';\n${IMPORTS}export async function up(fd: FormData) { await db.query('x'); }`,
    ],
    [
      'a write BEFORE the check',
      `'use server';\n${IMPORTS}export async function up(fd: FormData) {\n await db.query('x');\n if (!(await authorizeMutation(fd))) return { error: 'no' };\n}`,
    ],
    [
      'a call before the check, even a harmless-looking one',
      `'use server';\n${IMPORTS}export async function up(fd: FormData) {\n const f = fd.get('file');\n if (!(await authorizeMutation(fd))) return { error: 'no' };\n}`,
    ],
    [
      'the check does not return or throw',
      `'use server';\n${IMPORTS}export async function up(fd: FormData) {\n if (!(await authorizeMutation(fd))) { console.log('no'); }\n await db.query('x');\n}`,
    ],
    [
      'a non-negated check',
      `'use server';\n${IMPORTS}export async function up(fd: FormData) {\n if (await authorizeMutation(fd)) { return; }\n await db.query('x');\n}`,
    ],
    [
      'the call is not in the condition (result ignored)',
      `'use server';\n${IMPORTS}export async function up(fd: FormData) {\n await authorizeMutation(fd);\n await db.query('x');\n}`,
    ],
    [
      'a check hidden behind another condition',
      `'use server';\n${IMPORTS}export async function up(fd: FormData) {\n if (fd && !(await authorizeMutation(fd))) return;\n await db.query('x');\n}`,
    ],
    [
      'an auth function that is not imported (a local stub)',
      `'use server';\nasync function authorizeMutation(_f: FormData) { return true; }\nexport async function up(fd: FormData) {\n if (!(await authorizeMutation(fd))) return;\n await db.query('x');\n}`,
    ],
    [
      'an unrelated function with a similar name',
      `'use server';\nimport { authorizeMutationLater } from './x';\nexport async function up(fd: FormData) {\n if (!(await authorizeMutationLater(fd))) return;\n await db.query('x');\n}`,
    ],
    [
      'an expression-bodied action',
      `'use server';\n${IMPORTS}export const up = async (fd: FormData) => db.query('x');`,
    ],
    [
      'an exported arrow function',
      `'use server';\n${IMPORTS}export const up = async (fd: FormData) => {\n await db.query('x');\n};`,
    ],
    [
      'a default export',
      `'use server';\n${IMPORTS}export default async function (fd: FormData) { await db.query('x'); }`,
    ],
    [
      'a function exported through an export list',
      `'use server';\n${IMPORTS}async function up(fd: FormData) { await db.query('x'); }\nexport { up as renamed };`,
    ],
    [
      'a wrapper call around an ungated function',
      `'use server';\n${IMPORTS}export const up = wrap(async (fd: FormData) => { await db.query('x'); });`,
    ],
    [
      'an inline action in a page',
      `${IMPORTS}export default function Page() {\n async function add(fd: FormData) {\n 'use server';\n await db.query('x');\n }\n return null;\n}`,
    ],
    [
      'an inline action arrow in a page',
      `${IMPORTS}const add = async (fd: FormData) => {\n 'use server';\n await db.query('x');\n};`,
    ],
  ])('flags %s', (_why, src) => {
    expect(ungated(src).length).toBeGreaterThan(0);
  });

  it('flags only the ungated one when a module mixes gated and ungated actions', () => {
    const src = `'use server';\n${IMPORTS}export async function ok(fd: FormData) {\n if (!(await authorizeMutation(fd))) return;\n await db.query('a');\n}\nexport async function bad(fd: FormData) {\n await db.query('b');\n}`;
    const r = grade(src);
    expect(r.surfaces.map((s) => [s.name, s.gated])).toEqual([
      ['ok', true],
      ['bad', false],
    ]);
  });
});

describe('RED: what the scan cannot read FAILS', () => {
  it('a use-server file that does not parse', () => {
    expect(problems(`'use server';\nexport async function up( {`)[0]).toContain('does not parse');
  });

  it('a route file that does not parse', () => {
    expect(problems(`export async function POST( {`, ROUTE)[0]).toContain('does not parse');
  });

  it('a use-server module that re-exports from another module', () => {
    expect(problems(`'use server';\nexport { up } from './elsewhere';`)[0]).toContain('re-exports');
  });

  it('a use-server `export *`', () => {
    expect(problems(`'use server';\nexport * from './elsewhere';`).length).toBeGreaterThan(0);
  });

  it('a non-function export of a use-server module', () => {
    expect(ungated(`'use server';\nexport const limit = 5;`)[0]?.why).toContain('not a function');
  });

  it('a pages/api route', () => {
    expect(
      problems(`export default function handler() {}`, 'apps/demo/src/pages/api/x.ts')[0],
    ).toContain('pages/api');
  });

  it('a route method re-exported from another module', () => {
    expect(ungated(`export { POST } from './impl';`, ROUTE)[0]?.why).toContain('re-exported');
  });

  it('a route `export *`', () => {
    expect(problems(`export * from './impl';`, ROUTE)[0]).toContain('export *');
  });

  it('a route method assigned from an identifier', () => {
    expect(ungated(`import { h } from './h';\nexport const POST = h;`, ROUTE).length).toBe(1);
  });
});

describe('RED: a mutating route handler that is not gated', () => {
  it.each([
    ['POST', `export async function POST(req: Request) { await db.query('x'); }`],
    ['PUT', `export const PUT = async (req: Request) => { await db.query('x'); };`],
    [
      'PATCH',
      `export const PATCH = withRed('/x', async (req: Request) => { await db.query('x'); });`,
    ],
    [
      'DELETE with the check after the write',
      `${IMPORTS}export async function DELETE(req: Request) {\n await db.query('x');\n if (!isAuthorized(req.headers.get('authorization'), process.env.T)) return new Response(null, { status: 401 });\n}`,
    ],
  ])('flags %s', (_m, src) => {
    expect(ungated(src, ROUTE).length).toBe(1);
  });

  it('flags a body read before the check', () => {
    const src = `${IMPORTS}export async function POST(req: Request) {\n const body = await req.json();\n if (!isAuthorized(req.headers.get('authorization'), process.env.T)) return new Response(null, { status: 401 });\n}`;
    expect(ungated(src, ROUTE).length).toBe(1);
  });

  it('flags a wrapped handler whose inner function is ungated even if a sibling is gated', () => {
    const src = `${IMPORTS}export const POST = wrap(async (a: Request) => {\n if (!isAuthorized(a.headers.get('authorization'), process.env.T)) return null;\n}, async (b: Request) => { await db.query('x'); });`;
    expect(ungated(src, ROUTE).length).toBe(1);
  });
});

describe('GREEN: the shapes that pass', () => {
  it('an action gated by authorizeMutation, returning', () => {
    const src = `'use server';\n${IMPORTS}export async function up(fd: FormData) {\n if (!(await authorizeMutation(fd))) {\n return { error: 'Unauthorized' };\n }\n await db.query('x');\n}`;
    expect(grade(src).surfaces).toMatchObject([{ name: 'up', gated: true }]);
  });

  it('an action gated by a throw, with inert declarations before the check', () => {
    const src = `'use server';\n${IMPORTS}export async function up(fd: FormData) {\n const limit = 5;\n let n: number;\n if (!(await authorizeMutation(fd))) throw new Error('Unauthorized');\n await db.query('x');\n}`;
    expect(ungated(src)).toEqual([]);
  });

  it('an inline page action', () => {
    const src = `${IMPORTS}export default function Page() {\n async function add(fd: FormData) {\n 'use server';\n if (!(await authorizeMutation(fd))) throw new Error('no');\n await db.query('x');\n }\n return null;\n}`;
    const r = grade(src, 'apps/demo/src/app/page.tsx');
    expect(r.surfaces).toMatchObject([{ name: 'add', gated: true }]);
  });

  it('a route gated by isAuthorized, directly and through a wrapper', () => {
    const direct = `${IMPORTS}export async function POST(req: Request) {\n if (!isAuthorized(req.headers.get('authorization'), process.env.T)) {\n return new Response(null, { status: 401 });\n }\n await db.query('x');\n}`;
    const wrapped = `${IMPORTS}export const DELETE = withRed('/x', async (req: Request) => {\n if (!isAuthorized(req.headers.get('authorization'), process.env.T)) {\n return Response.json({ error: 'Unauthorized' }, { status: 401 });\n }\n await db.query('x');\n});`;
    expect(ungated(direct, ROUTE)).toEqual([]);
    expect(ungated(wrapped, ROUTE)).toEqual([]);
    expect(grade(wrapped, ROUTE).surfaces).toHaveLength(1);
  });

  it('a GET handler and non-handler exports are not surfaces', () => {
    const src = `export const dynamic = 'force-dynamic';\nexport function GET() { return new Response('ok'); }`;
    expect(grade(src, ROUTE).surfaces).toEqual([]);
  });

  it('type-only exports of a use-server module are ignored', () => {
    const src = `'use server';\nexport type R = { ok: boolean };\nexport interface I { a: 1 }\n${IMPORTS}export async function up(fd: FormData) {\n if (!(await authorizeMutation(fd))) return;\n}`;
    expect(grade(src).surfaces.map((s) => s.name)).toEqual(['up']);
  });

  it('a non-action, non-route file is not read at all', () => {
    expect(grade(`export const x = (`, 'apps/demo/src/lib/x.ts')).toEqual({
      surfaces: [],
      problems: [],
    });
  });

  it('a sensitive GET is graded like a mutation, only when listed', () => {
    const open = `export async function GET() { return new Response('rows'); }`;
    expect(grade(open, ROUTE).surfaces).toEqual([]);
    expect(ungated(open, ROUTE, { extraGetNames: ['GET'] }).length).toBe(1);
    const gated = `${IMPORTS}export async function GET(req: Request) {\n if (!isAuthorized(req.headers.get('authorization'), process.env.T)) return new Response(null, { status: 401 });\n return new Response('rows');\n}`;
    expect(ungated(gated, ROUTE, { extraGetNames: ['GET'] })).toEqual([]);
  });

  it('a Handlebars template with a use-server action is graded like source', () => {
    const src = `'use server';\n${IMPORTS}export async function up(fd: FormData) { await db.query('x'); }`;
    expect(ungated(src, 'packages/kn-next/templates/app/src/app/actions.ts.hbs').length).toBe(1);
  });
});

describe('the allowlist is counted, reasoned and tight', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tree = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'sa-auth-scan-'));
    dirs.push(root);
    for (const [rel, body] of Object.entries(files)) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    return root;
  };
  const scan = (root: string, o: Partial<Parameters<typeof scanTree>[1]>) =>
    scanTree(root, { roots: ['apps'], sensitiveReads: [], ...o });
  const OPEN = `'use server';\nexport async function up(fd: FormData) { await db.query('x'); }`;
  const SHUT = `'use server';\n${IMPORTS}export async function up(fd: FormData) {\n if (!(await authorizeMutation(fd))) return;\n}`;
  const entry = (reason = 'a reason that is long enough to count as one') => ({
    file: ACTIONS,
    name: 'up',
    reason,
  });

  it('an ungated action fails; the same action allowlisted passes', () => {
    const root = tree({ [ACTIONS]: OPEN });
    expect(scan(root, { roots: ['apps'], allowlist: [] }).violations).toHaveLength(1);
    expect(scan(root, { roots: ['apps'], allowlist: [entry()] }).violations).toEqual([]);
  });

  it('an entry that matches nothing is stale and fails', () => {
    const root = tree({ [ACTIONS]: SHUT, 'apps/demo/other.ts': 'export const x = 1;' });
    const v = scan(root, {
      roots: ['apps'],
      allowlist: [entry(), { ...entry(), name: 'gone' }],
    }).violations;
    expect(v.join('\n')).toContain('is on the allowlist but IS gated');
    expect(v.join('\n')).toContain('matches no surface (stale)');
  });

  it('an entry with no real reason fails', () => {
    const root = tree({ [ACTIONS]: OPEN });
    const v = scan(root, { roots: ['apps'], allowlist: [entry('todo')] }).violations;
    expect(v.join('\n')).toContain('no real reason');
  });

  it('a stale sensitive-read entry fails', () => {
    const root = tree({ [ACTIONS]: SHUT });
    const v = scan(root, {
      roots: ['apps'],
      allowlist: [],
      sensitiveReads: [{ file: ROUTE, name: 'GET', reason: 'x' }],
    }).violations;
    expect(v.join('\n')).toContain('sensitive read');
  });

  it('skips test files and node_modules', () => {
    const root = tree({
      'apps/demo/a.test.ts': OPEN,
      'apps/demo/node_modules/x/actions.ts': OPEN,
      [ACTIONS]: SHUT,
    });
    const r = scan(root, { roots: ['apps'], allowlist: [] });
    expect(r.violations).toEqual([]);
    expect(r.scannedFiles).toBe(1);
  });
});

describe('the real tree', () => {
  const result = scanTree(REPO_ROOT);

  it('has no unauthenticated Server Action or mutating route', () => {
    expect(result.violations).toEqual([]);
  });

  it('scans the apps and the app scaffold templates', () => {
    expect(SCAN_ROOTS).toEqual(['apps', 'packages/kn-next/templates/app']);
    expect(result.scannedFiles).toBeGreaterThan(50);
  });

  it('sees exactly the surfaces the audit lists (a scan that reads nothing is green too)', () => {
    const ids = result.surfaces.map((s) => s.id).sort();
    expect(ids).toEqual([
      'apps/db-demo/src/app/actions.ts::postMessage',
      'apps/file-manager/src/app/actions.ts::uploadFile',
      'apps/file-manager/src/app/api/audit/route.ts::GET',
      'apps/file-manager/src/app/api/cache/events/route.ts::DELETE',
      'apps/file-manager/src/app/api/cache/invalidate/route.ts::POST',
      'apps/file-manager/src/app/api/rum/route.ts::POST',
      'apps/file-manager/src/app/cache-tests/on-demand/page.tsx::invalidateAll',
      'apps/file-manager/src/app/cache-tests/on-demand/page.tsx::invalidateOrders',
      'apps/file-manager/src/app/cache-tests/on-demand/page.tsx::invalidatePath',
      'apps/file-manager/src/app/cache-tests/on-demand/page.tsx::invalidateProducts',
      'apps/file-manager/src/app/knext-smoke/stream/page.tsx::echoAction',
      'apps/file-manager/src/app/users/page.tsx::addUser',
    ]);
  });

  it('the allowlist is exactly three entries, each with a reason', () => {
    expect(ALLOWLIST.map((a) => `${a.file}::${a.name}`).sort()).toEqual([
      'apps/db-demo/src/app/actions.ts::postMessage',
      'apps/file-manager/src/app/api/rum/route.ts::POST',
      'apps/file-manager/src/app/knext-smoke/stream/page.tsx::echoAction',
    ]);
    for (const a of ALLOWLIST) expect(a.reason.length).toBeGreaterThan(40);
  });

  it('gates the audit read as well as the mutations', () => {
    expect(SENSITIVE_READS.map((r) => `${r.file}::${r.name}`)).toEqual([
      'apps/file-manager/src/app/api/audit/route.ts::GET',
    ]);
    const audit = result.surfaces.find((s) => s.id.endsWith('api/audit/route.ts::GET'));
    expect(audit?.gated).toBe(true);
  });

  it('accepts exactly the two auth calls', () => {
    expect([...AUTH_CALLS].sort()).toEqual(['authorizeMutation', 'isAuthorized']);
  });

  it('every surface is inventoried in docs/security/mutating-endpoints.md', () => {
    const doc = readFileSync(resolve(REPO_ROOT, 'docs/security/mutating-endpoints.md'), 'utf8');
    const missing = result.surfaces
      .filter((s) => s.kind === 'action')
      .map((s) => `${s.file}::${s.name}`)
      .filter((id) => !doc.includes(`\`${id}\``));
    expect(missing).toEqual([]);
  });
});
