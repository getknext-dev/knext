#!/usr/bin/env node
/**
 * Mutation proof for the Server Action / mutating-route authentication gate
 * (issue #2532).
 *
 * Guards proved, each against its own spec:
 *   - `tests/server-action-auth-scan.test.ts`   the scan: every `'use server'`
 *       function and every POST/PUT/PATCH/DELETE route handler (plus the audit
 *       GET) opens with a refusing auth check, or is on the counted allowlist;
 *       anything it cannot read FAILS.
 *   - `apps/file-manager/src/app/actions.test.ts`   an unauthenticated upload is
 *       refused and nothing is written; two uploads of one filename never
 *       overwrite each other; a traversal filename is refused.
 *   - `apps/file-manager/src/app/_auth/mutation-auth.test.ts`   the check itself.
 *   - `apps/file-manager/src/app/_upload/object-key.test.ts`    filename validation
 *       and the generated key.
 *   - `apps/file-manager/src/app/api/audit/route.test.ts`       the audit read.
 *   - `apps/file-manager/src/app/api/cache/invalidate/auth.test.ts`   the
 *       fail-closed compare the whole gate stands on.
 *   - `apps/file-manager/src/app/setup/setup.test.tsx`   GET /setup writes
 *       nothing; the setup Server Action (a POST) refuses anonymous callers.
 *   - `apps/db-demo/src/app/actions.test.ts`   the db-demo guestbook write is
 *       refused without its own token, fail-closed when unset.
 *
 * Two kinds of row, and both halves matter: the SCANNER weakened (a RED fixture
 * must then go red), and the REAL TREE broken (an unauthenticated action, a write
 * before the check, an unreadable file planted in shipped code must go red). A
 * scan that is green because it reads nothing is decoration.
 *
 * Deliberately NOT a row: removing the `if (!expected) return false` line in
 * `mutation-auth.ts`. `isAuthorized` fails closed on an unset token by itself, so
 * the line is defence in depth and deleting it changes no behaviour (an
 * equivalent mutant, which a prover must not pretend to kill). The compare it
 * leans on is mutated below instead.
 *
 * Discipline (scripts/lib/guard-prover.mjs): every anchor occurs exactly once
 * (else ABORT in the preflight), every verdict is the runner's EXIT CODE, the
 * baseline must be green first, a canary must go red before any green below is
 * trusted, the tree is checked clean between mutations. Run it on a COMMITTED
 * green tree: the restore is content-addressed, but a prover that dies must not
 * be able to take uncommitted work with it.
 *
 * Exit 0 = every row went red; non-zero otherwise.
 *
 * Usage:
 *   node scripts/mutation-prove-2532-server-action-auth.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { jsStillParses } from './lib/parse-validity.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SCAN_SPEC = 'tests/server-action-auth-scan.test.ts';
const ACTIONS_SPEC = 'apps/file-manager/src/app/actions.test.ts';
const MAUTH_SPEC = 'apps/file-manager/src/app/_auth/mutation-auth.test.ts';
const KEY_SPEC = 'apps/file-manager/src/app/_upload/object-key.test.ts';
const AUDIT_SPEC = 'apps/file-manager/src/app/api/audit/route.test.ts';
const AUTH_SPEC = 'apps/file-manager/src/app/api/cache/invalidate/auth.test.ts';
const SETUP_SPEC = 'apps/file-manager/src/app/setup/setup.test.tsx';
const DBDEMO_SPEC = 'apps/db-demo/src/app/actions.test.ts';

const GUARD = 'if (!(await authorizeMutation(formData))) {';
const OFF = 'if (false) {';

// ---------------------------------------------------------------------------
// The scan weakened: a RED fixture must go red
// ---------------------------------------------------------------------------
const SCANNER = [
  {
    id: 'S01',
    subject: 'lib',
    claim: 'a local function with the right name (not imported) satisfies the check',
    anchor: 'if (!AUTH_CALLS.has(name) || !imported.has(name)) return undefined;',
    replacement: 'if (!AUTH_CALLS.has(name)) return undefined;',
  },
  {
    id: 'S02',
    subject: 'lib',
    claim: 'a write before the check is no longer noticed',
    anchor: '    if (!isInert(st)) {',
    replacement: '    if (false) {',
  },
  {
    id: 'S03',
    subject: 'lib',
    claim: 'an expression-bodied action passes (there is no statement to hold a check)',
    anchor:
      "return { ok: false, why: 'expression-bodied: there is no statement to hold the auth check' };",
    replacement: "return { ok: true, call: 'none' };",
  },
  {
    id: 'S04',
    subject: 'lib',
    claim: 'a check that neither returns nor throws passes',
    anchor:
      'return statement.statements.some((s) => ts.isReturnStatement(s) || ts.isThrowStatement(s));',
    replacement: 'return true;',
  },
  {
    id: 'S05',
    subject: 'lib',
    claim: 'a file that does not parse is read as having no actions (passes)',
    anchor: 'if (diags.length > 0) {',
    replacement: 'if (false) {',
  },
  {
    id: 'S06',
    subject: 'lib',
    claim: "a 'use server' module re-exporting from another file passes unseen",
    anchor:
      "        if (st.moduleSpecifier) {\n          problems.push(\n            `${file}:${lineOf(sf, st)}: a 'use server'",
    replacement:
      "        if (false) {\n          problems.push(\n            `${file}:${lineOf(sf, st)}: a 'use server'",
  },
  {
    id: 'S07',
    subject: 'lib',
    claim: "an inline 'use server' function in a page is not found",
    anchor: "      prologue(n.body.statements).includes('use server') &&",
    replacement: '      false &&',
  },
  {
    id: 'S08',
    subject: 'lib',
    claim: "a module-level 'use server' file is not recognised",
    anchor: "if (prologue(sf.statements).includes('use server')) {",
    replacement: 'if (false) {',
  },
  {
    id: 'S09',
    subject: 'lib',
    claim: 'POST/PUT/PATCH/DELETE handlers are no longer collected',
    anchor: 'const wanted = new Set([...MUTATING_METHODS, ...extraGetNames]);',
    replacement: 'const wanted = new Set([...extraGetNames]);',
  },
  {
    id: 'S10',
    subject: 'lib',
    claim: 'a stale allowlist entry is never reported',
    anchor: '    if (!used.has(a)) {',
    replacement: '    if (false) {',
  },
  {
    id: 'S11',
    subject: 'lib',
    claim: 'an allowlist entry for a surface that IS gated is never reported',
    anchor: '      if (s.gated) {',
    replacement: '      if (false) {',
  },
  {
    id: 'S12',
    subject: 'lib',
    claim: 'an allowlist entry needs no reason',
    anchor: 'if (!a.reason || String(a.reason).trim().length < 20) {',
    replacement: 'if (false) {',
  },
  {
    id: 'S13',
    subject: 'lib',
    claim: 'the app scaffold templates fall out of the scanned scope',
    anchor: "export const SCAN_ROOTS = ['apps', 'packages/kn-next/templates/app'];",
    replacement: "export const SCAN_ROOTS = ['apps'];",
  },
  {
    id: 'S14',
    subject: 'lib',
    claim: 'a pages/api route is ignored instead of failing',
    anchor: 'if (isPagesApi) {',
    replacement: 'if (false) {',
  },
  {
    id: 'S15',
    subject: 'lib',
    claim: 'a wrapper holding two functions is graded on the first only',
    anchor: 'const fns = e.arguments.map(unwrap).filter(isFunctionLike);',
    replacement: 'const fns = e.arguments.map(unwrap).filter(isFunctionLike).slice(0, 1);',
  },
  {
    id: 'S16',
    subject: 'lib',
    claim: 'the audit read stops being held to the gate',
    anchor: "file: 'apps/file-manager/src/app/api/audit/route.ts',",
    replacement: "file: 'apps/file-manager/src/app/api/audit/other.ts',",
  },
  {
    id: 'S17',
    subject: 'lib',
    claim: '`export *` in a route module is ignored instead of failing',
    anchor: '} else if (!st.exportClause) {',
    replacement: '} else if (false) {',
  },
  {
    id: 'S18',
    subject: 'lib',
    claim: 'an allowlist entry outlives the code it excused',
    anchor: "file: 'apps/file-manager/src/app/knext-smoke/stream/page.tsx',",
    replacement: "file: 'apps/file-manager/src/app/knext-smoke/stream/gone.tsx',",
  },
  {
    id: 'S19',
    subject: 'lib',
    claim: 'a third function is accepted as an auth check',
    anchor: "export const AUTH_CALLS = new Set(['authorizeMutation', 'isAuthorized']);",
    replacement:
      "export const AUTH_CALLS = new Set(['authorizeMutation', 'isAuthorized', 'getSession']);",
  },
  {
    id: 'S20',
    subject: 'lib',
    claim: 'test files are scanned as if they were app code',
    anchor: '} else if (CODE_FILE.test(name) && !TEST_FILE.test(name)) {',
    replacement: '} else if (CODE_FILE.test(name)) {',
  },
  {
    id: 'S21',
    subject: 'lib',
    claim: 'node_modules is scanned',
    anchor: "const SKIP_DIRS = new Set([\n  'node_modules',",
    replacement: 'const SKIP_DIRS = new Set([',
  },
  {
    id: 'S22',
    subject: 'lib',
    claim: "a wrapper call with no inline function is read as 'nothing to check' (gated)",
    anchor: 'return fns.length > 0 ? fns : undefined;',
    replacement: 'return fns;',
  },
  {
    id: 'S23',
    subject: 'lib',
    claim: "the 'use server' pre-filter stops matching, so no action file is read",
    anchor: 'const wantsAction = /[\'"]use server[\'"]/.test(text);',
    replacement: 'const wantsAction = /[\'"]use serverx[\'"]/.test(text);',
  },
  {
    id: 'S24',
    subject: 'lib',
    claim: 'Handlebars templates are no longer read as source',
    anchor: 'const CODE_FILE = /\\.(?:[cm]?[jt]sx?)(?:\\.hbs)?$/;',
    replacement: 'const CODE_FILE = /\\.(?:[cm]?[jt]sx?)$/;',
  },
];

// ---------------------------------------------------------------------------
// The real tree broken: a violation planted in shipped code must go red
// ---------------------------------------------------------------------------
const TREE = [
  {
    id: 'T01',
    subject: 'actions',
    claim: 'uploadFile loses its auth check',
    anchor: GUARD,
    replacement: OFF,
  },
  {
    id: 'T02',
    subject: 'actions',
    claim: 'a new, ungated Server Action is added next to uploadFile',
    anchor: 'export async function uploadFile(formData: FormData) {',
    replacement:
      "export async function sneaky() {\n  await getDbPool().query('x');\n}\n\nexport async function uploadFile(formData: FormData) {",
  },
  {
    id: 'T03',
    subject: 'actions',
    claim: "a write is moved in front of uploadFile's check",
    anchor: `export async function uploadFile(formData: FormData) {\n  ${GUARD}`,
    replacement: `export async function uploadFile(formData: FormData) {\n  await getDbPool().query('SELECT 1');\n  ${GUARD}`,
  },
  {
    id: 'T04',
    subject: 'actions',
    claim: "uploadFile's check stops refusing",
    anchor: "return { error: 'Unauthorized' };",
    replacement: 'void 0;',
  },
  {
    id: 'T05',
    subject: 'actions',
    claim: 'the auth import is dropped (the call now names nothing imported)',
    anchor: "import { authorizeMutation } from './_auth/mutation-auth';",
    replacement: '',
  },
  {
    id: 'T06',
    subject: 'users',
    claim: 'the inline addUser action loses its check',
    anchor: GUARD,
    replacement: OFF,
  },
  ...['invalidateProducts', 'invalidateOrders', 'invalidatePath', 'invalidateAll'].map((fn, i) => ({
    id: `T${String(7 + i).padStart(2, '0')}`,
    subject: 'ondemand',
    claim: `the inline ${fn} action loses its check`,
    anchor: `async function ${fn}(formData: FormData) {\n  'use server';\n  // Invalidating the cache is a mutation: authenticate first (public POST endpoint).\n  ${GUARD}`,
    replacement: `async function ${fn}(formData: FormData) {\n  'use server';\n  // Invalidating the cache is a mutation: authenticate first (public POST endpoint).\n  ${OFF}`,
  })),
  {
    id: 'T11',
    subject: 'events',
    claim: 'DELETE /api/cache/events loses its check',
    anchor:
      "if (!isAuthorized(request.headers.get('authorization'), process.env.CACHE_INVALIDATE_TOKEN)) {",
    replacement: OFF,
  },
  {
    id: 'T12',
    subject: 'invalidate',
    claim: 'POST /api/cache/invalidate loses its check',
    anchor:
      "if (!isAuthorized(request.headers.get('authorization'), process.env.CACHE_INVALIDATE_TOKEN)) {",
    replacement: OFF,
  },
  {
    id: 'T13',
    subject: 'audit',
    claim: 'GET /api/audit loses its check (the sensitive read is open again)',
    anchor:
      "if (!isAuthorized(request?.headers?.get?.('authorization'), process.env.CACHE_INVALIDATE_TOKEN)) {",
    replacement: OFF,
  },
  {
    id: 'T14',
    subject: 'healthtpl',
    claim: 'the scaffold template grows an unauthenticated POST handler',
    anchor: 'export function GET() {',
    replacement: 'export function POST() {',
    options: { commentPrefix: '//' },
  },
  {
    id: 'T15',
    subject: 'users',
    claim: 'a gated page stops parsing (its actions would vanish from the scan)',
    anchor: "import TokenField from '@/components/TokenField';",
    replacement: "import TokenField from '@/components/TokenField';\nexport async function (",
  },
  {
    id: 'T16',
    subject: 'dbdemo',
    claim: 'a new unauthenticated action is added to db-demo beside the gated one',
    anchor: 'export async function postMessage(formData: FormData): Promise<void> {',
    replacement:
      'export async function postAnother(formData: FormData): Promise<void> {\n  await addMessage({ author: "x", body: String(formData.get("body")) });\n}\n\nexport async function postMessage(formData: FormData): Promise<void> {',
  },
  {
    id: 'T17',
    subject: 'dbdemo',
    claim: 'db-demo postMessage loses its auth check (it is no longer allowlisted)',
    anchor: GUARD,
    replacement: OFF,
  },
  {
    id: 'T18',
    subject: 'setupactions',
    claim: 'the setup Server Action loses its auth check',
    anchor: GUARD,
    replacement: OFF,
  },
];

// ---------------------------------------------------------------------------
// The upload action itself
// ---------------------------------------------------------------------------
const UPLOAD = [
  {
    id: 'U01',
    subject: 'actions',
    claim: 'an unauthenticated upload writes (the auth check is off)',
    anchor: GUARD,
    replacement: OFF,
  },
  {
    id: 'U02',
    subject: 'actions',
    claim: 'the raw client filename is the object key again',
    anchor: 'await minio.putObject(bucketName, key, buffer, buffer.length);',
    replacement: 'await minio.putObject(bucketName, file.name, buffer, buffer.length);',
  },
  {
    id: 'U03',
    subject: 'actions',
    claim: 'the row is an upsert over the same name again',
    anchor: 'VALUES ($1, $2, $3, $4, NOW())`,',
    replacement: 'VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (name) DO UPDATE SET size = $2`,',
  },
  {
    id: 'U04',
    subject: 'actions',
    claim: 'the row is named by the client filename',
    anchor: "[key, file.size, file.type || 'application/octet-stream', storagePath],",
    replacement: "[file.name, file.size, file.type || 'application/octet-stream', storagePath],",
  },
  {
    id: 'U05',
    subject: 'actions',
    claim: 'the filename is no longer validated',
    anchor: 'key = objectKeyFor(validateFileName(file.name));',
    replacement: 'key = objectKeyFor(file.name);',
  },
  {
    id: 'U06',
    subject: 'objkey',
    claim: 'a path separator in the filename is accepted',
    anchor:
      "if (raw.includes('/') || raw.includes('\\\\')) throw new InvalidFileNameError('path separator');",
    replacement: '',
  },
  {
    id: 'U07',
    subject: 'objkey',
    claim: 'the generated id is a constant, so the same name maps to the same key',
    anchor: "return `${randomBytes(8).toString('hex')}-${validatedName}`;",
    replacement: 'return `0000000000000000-${validatedName}`;',
  },
  {
    id: 'U08',
    subject: 'objkey',
    claim: 'a name made only of dots is accepted',
    anchor: "if (/^[.\\s]+$/.test(raw)) throw new InvalidFileNameError('only dots');",
    replacement: '',
  },
];

// ---------------------------------------------------------------------------
// The check, the filename rules and the audit read, each on its own spec
// ---------------------------------------------------------------------------
const MAUTH = [
  {
    id: 'M01',
    subject: 'mauth',
    claim: 'any Authorization header is accepted, right token or not',
    anchor: 'if (isAuthorized(header, expected)) return true;',
    replacement: 'if (header !== null) return true;',
  },
  {
    id: 'M02',
    subject: 'mauth',
    claim: 'any form token is accepted',
    anchor: 'return isAuthorized(`Bearer ${field}`, expected);',
    replacement: 'return true;',
  },
  {
    id: 'M03',
    subject: 'mauth',
    claim: 'the Authorization header is never read',
    anchor: "header = (await headers()).get('authorization');",
    replacement: 'header = null;',
  },
  {
    id: 'M04',
    subject: 'mauth',
    claim: 'the form token field is never read',
    anchor: "const field = formData?.get('token');",
    replacement: 'const field = undefined as FormDataEntryValue | null | undefined;',
  },
];

const AUTH_ROWS = [
  {
    id: 'F01',
    subject: 'authts',
    claim: 'an unset token authorizes everyone (fail-open)',
    anchor: 'return false; // fail closed: unconfigured = deny all',
    replacement: 'return true;',
  },
  {
    id: 'F02',
    subject: 'authts',
    claim: 'the token is compared by length only',
    anchor: 'return timingSafeEqual(provided, expected);',
    replacement: 'return true;',
  },
];

const KEY = [
  {
    id: 'K01',
    subject: 'objkey',
    claim: 'a path separator is accepted',
    anchor:
      "if (raw.includes('/') || raw.includes('\\\\')) throw new InvalidFileNameError('path separator');",
    replacement: '',
  },
  {
    id: 'K02',
    subject: 'objkey',
    claim: 'a name made only of dots is accepted',
    anchor: "if (/^[.\\s]+$/.test(raw)) throw new InvalidFileNameError('only dots');",
    replacement: '',
  },
  {
    id: 'K03',
    subject: 'objkey',
    claim: 'a control character (NUL, newline) is accepted',
    anchor: "if (CONTROL.test(raw)) throw new InvalidFileNameError('control character');",
    replacement: '',
  },
  {
    id: 'K04',
    subject: 'objkey',
    claim: 'an over-long name is accepted',
    anchor: "if (raw.length > MAX_NAME_LENGTH) throw new InvalidFileNameError('too long');",
    replacement: '',
  },
  {
    id: 'K05',
    subject: 'objkey',
    claim: 'an empty / blank name is accepted',
    anchor: "if (raw.trim() === '') throw new InvalidFileNameError('empty');",
    replacement: '',
  },
  {
    id: 'K06',
    subject: 'objkey',
    claim: 'a non-string name is accepted',
    anchor: "if (typeof raw !== 'string') throw new InvalidFileNameError('not a string');",
    replacement: '',
  },
  {
    id: 'K07',
    subject: 'objkey',
    claim: 'the generated id is a constant',
    anchor: "return `${randomBytes(8).toString('hex')}-${validatedName}`;",
    replacement: 'return `0000000000000000-${validatedName}`;',
  },
  {
    id: 'K08',
    subject: 'objkey',
    claim: 'the key drops the generated id (the name alone is the key)',
    anchor: "return `${randomBytes(8).toString('hex')}-${validatedName}`;",
    replacement: 'return validatedName;',
  },
];

const AUDIT = [
  {
    id: 'A01',
    subject: 'audit',
    claim: 'GET /api/audit answers without a token',
    anchor:
      "if (!isAuthorized(request?.headers?.get?.('authorization'), process.env.CACHE_INVALIDATE_TOKEN)) {",
    replacement: OFF,
  },
  {
    id: 'A02',
    subject: 'audit',
    claim: 'the authenticated audit answer is publicly cacheable again',
    anchor: "'Cache-Control': 'private, no-store',",
    replacement: "'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30',",
  },
  {
    id: 'A03',
    subject: 'audit',
    claim: 'the audit rows are read before the caller is checked',
    anchor:
      "export const GET = withRedMetrics('/api/audit', async (request: any, _context: any) => {",
    replacement:
      "export const GET = withRedMetrics('/api/audit', async (request: any, _context: any) => {\n  await getAuditLogsCached(0);",
  },
];

// ---------------------------------------------------------------------------
// /setup: a GET only renders; the work is an authenticated POST
// ---------------------------------------------------------------------------
const SETUP = [
  {
    id: 'P01',
    subject: 'setupactions',
    claim: 'an unauthenticated setup POST creates the tables (the auth check is off)',
    anchor: GUARD,
    replacement: OFF,
  },
  {
    id: 'P02',
    subject: 'setupactions',
    claim: 'the tables are created before the caller is checked',
    anchor: GUARD,
    replacement: `await setupDatabase();\n  ${GUARD}`,
  },
  {
    id: 'P03',
    subject: 'setupactions',
    claim: 'a refused setup POST returns normally instead of throwing',
    anchor: "throw new Error('Unauthorized');",
    replacement: 'return;',
  },
  {
    id: 'P04',
    subject: 'setuppage',
    claim: 'rendering GET /setup creates the tables again',
    anchor: 'const params = await searchParams;',
    replacement:
      "const { setupDatabase } = await import('./setup-database');\n  await setupDatabase();\n  const params = await searchParams;",
  },
];

// ---------------------------------------------------------------------------
// db-demo: its own copy of the check, its own token
// ---------------------------------------------------------------------------
const DBDEMO = [
  {
    id: 'D01',
    subject: 'dbactions',
    claim: 'an unauthenticated post writes (the auth check is off)',
    anchor: GUARD,
    replacement: OFF,
  },
  {
    id: 'D02',
    subject: 'dbactions',
    claim: 'a refused post returns normally instead of throwing',
    anchor: "throw new Error('Unauthorized');",
    replacement: 'return;',
  },
  {
    id: 'D03',
    subject: 'dbauth',
    claim: 'an unset token authorizes everyone (fail-open)',
    anchor: 'if (!expected) return false; // unconfigured = deny all',
    replacement: 'if (!expected) return true;',
  },
  {
    id: 'D04',
    subject: 'dbauth',
    claim: 'any token is accepted',
    anchor: 'return timingSafeEqual(a, b);',
    replacement: 'return true;',
  },
  {
    id: 'D05',
    subject: 'dbauth',
    claim: 'a token of the wrong length reaches timingSafeEqual (which throws)',
    anchor: 'if (a.length !== b.length) return false; // timingSafeEqual needs equal lengths',
    replacement: '',
  },
  {
    id: 'D06',
    subject: 'dbauth',
    claim: 'the form token field is never read',
    anchor: "const field = formData?.get('token');",
    replacement: 'const field = undefined as FormDataEntryValue | null | undefined;',
  },
  {
    id: 'D07',
    subject: 'dbauth',
    claim: 'the Authorization header is never read',
    anchor: "header = (await headers()).get('authorization');",
    replacement: 'header = null;',
  },
];

// One literal `subjects` map per guard, so the PR-time anchor-liveness audit
// (scripts/lib/prover-lane.mjs) can read every subject path and re-check every
// anchor above without running this prover.
const scan = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SCAN_SPEC,
  subjects: {
    lib: 'scripts/lib/server-action-auth-scan.mjs',
    actions: 'apps/file-manager/src/app/actions.ts',
    users: 'apps/file-manager/src/app/users/page.tsx',
    ondemand: 'apps/file-manager/src/app/cache-tests/on-demand/page.tsx',
    events: 'apps/file-manager/src/app/api/cache/events/route.ts',
    invalidate: 'apps/file-manager/src/app/api/cache/invalidate/route.ts',
    audit: 'apps/file-manager/src/app/api/audit/route.ts',
    healthtpl: 'packages/kn-next/templates/app/src/app/api/health/route.ts.hbs',
    dbdemo: 'apps/db-demo/src/app/actions.ts',
    setupactions: 'apps/file-manager/src/app/setup/actions.ts',
  },
});
const upload = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: ACTIONS_SPEC,
  subjects: {
    actions: 'apps/file-manager/src/app/actions.ts',
    objkey: 'apps/file-manager/src/app/_upload/object-key.ts',
  },
});
const mauth = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: MAUTH_SPEC,
  subjects: { mauth: 'apps/file-manager/src/app/_auth/mutation-auth.ts' },
});
const authSpec = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: AUTH_SPEC,
  subjects: { authts: 'apps/file-manager/src/app/api/cache/invalidate/auth.ts' },
});
const key = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: KEY_SPEC,
  subjects: { objkey: 'apps/file-manager/src/app/_upload/object-key.ts' },
});
const setup = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SETUP_SPEC,
  subjects: {
    setupactions: 'apps/file-manager/src/app/setup/actions.ts',
    setuppage: 'apps/file-manager/src/app/setup/page.tsx',
  },
});
const dbdemo = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: DBDEMO_SPEC,
  subjects: {
    dbactions: 'apps/db-demo/src/app/actions.ts',
    dbauth: 'apps/db-demo/src/lib/mutation-auth.ts',
  },
});
const audit = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: AUDIT_SPEC,
  subjects: { audit: 'apps/file-manager/src/app/api/audit/route.ts' },
});

// A mutation must stay valid TypeScript/JavaScript, or its red is for the wrong
// reason. `.tsx` and `.hbs` subjects cannot go through the TS transpile check
// as written, and T15 breaks the grammar on purpose.
const NO_VALIDATE = new Set(['T15', 'T14', 'T06', 'T07', 'T08', 'T09', 'T10', 'P04']);
const withValidate = (rows) =>
  rows.map((m) =>
    NO_VALIDATE.has(m.id) || m.subject === 'healthtpl' ? m : { ...m, validate: jsStillParses },
  );

const SCAN_ROWS = withValidate([...SCANNER, ...TREE]);
const UPLOAD_ROWS = withValidate(UPLOAD);
const MAUTH_ROWS = withValidate(MAUTH);
const AUTH_TS_ROWS = withValidate(AUTH_ROWS);
const KEY_ROWS = withValidate(KEY);
const AUDIT_ROWS = withValidate(AUDIT);
const SETUP_ROWS = withValidate(SETUP);
const DBDEMO_ROWS = withValidate(DBDEMO);

const CANARY = {
  setup: { subject: 'setupactions', anchor: GUARD, replacement: OFF },
  dbdemo: { subject: 'dbactions', anchor: GUARD, replacement: OFF },
  scan: { subject: 'actions', anchor: GUARD, replacement: OFF },
  upload: { subject: 'actions', anchor: GUARD, replacement: OFF },
  mauth: {
    subject: 'mauth',
    anchor: 'if (isAuthorized(header, expected)) return true;',
    replacement: 'if (header !== null) return true;',
  },
  auth: {
    subject: 'authts',
    anchor: 'return false; // fail closed: unconfigured = deny all',
    replacement: 'return true;',
  },
  key: {
    subject: 'objkey',
    anchor: "if (CONTROL.test(raw)) throw new InvalidFileNameError('control character');",
    replacement: '',
  },
  audit: {
    subject: 'audit',
    anchor:
      "if (!isAuthorized(request?.headers?.get?.('authorization'), process.env.CACHE_INVALIDATE_TOKEN)) {",
    replacement: OFF,
  },
};

console.log('=== mutation proof: Server Action / mutating-route auth gate (#2532) ===');
scan.preflight(SCAN_ROWS);
upload.preflight(UPLOAD_ROWS);
mauth.preflight(MAUTH_ROWS);
authSpec.preflight(AUTH_TS_ROWS);
key.preflight(KEY_ROWS);
audit.preflight(AUDIT_ROWS);
setup.preflight(SETUP_ROWS);
dbdemo.preflight(DBDEMO_ROWS);
declareMutations(
  SCAN_ROWS.length +
    UPLOAD_ROWS.length +
    MAUTH_ROWS.length +
    AUTH_TS_ROWS.length +
    KEY_ROWS.length +
    AUDIT_ROWS.length +
    SETUP_ROWS.length +
    DBDEMO_ROWS.length,
);

const sweep = (label, p, spec, rows, canary) => {
  console.log(`\n=== ${label}: ${spec} ===`);
  p.baseline();
  p.proveCanSeeRed(canary);
  for (const m of rows) {
    p.run({ ...m, expect: 'red' });
    recordMutation();
  }
  p.finish(rows.length);
};

sweep('scan + real tree', scan, SCAN_SPEC, SCAN_ROWS, CANARY.scan);
sweep('upload action', upload, ACTIONS_SPEC, UPLOAD_ROWS, CANARY.upload);
sweep('authorizeMutation', mauth, MAUTH_SPEC, MAUTH_ROWS, CANARY.mauth);
sweep('isAuthorized (fail-closed compare)', authSpec, AUTH_SPEC, AUTH_TS_ROWS, CANARY.auth);
sweep('filename validation + key', key, KEY_SPEC, KEY_ROWS, CANARY.key);
sweep('audit read', audit, AUDIT_SPEC, AUDIT_ROWS, CANARY.audit);
sweep('/setup', setup, SETUP_SPEC, SETUP_ROWS, CANARY.setup);
sweep('db-demo', dbdemo, DBDEMO_SPEC, DBDEMO_ROWS, CANARY.dbdemo);

console.log('\nall sweeps behaved as required');
