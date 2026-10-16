// @vitest-environment node
//
// Builds a REAL Next.js app (next@16.4, Cache Components on, the knext adapter
// and its shared Redis `'use cache'` backend) around the glue `knext generate`
// writes for the fixture zone, and serves it as separate processes ("pods")
// sharing one Redis, against a real Connect function.

import { afterAll, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttp2, type Http2Server } from 'node:http2';
import { type AddressInfo, createServer as createNet } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { Code, ConnectError } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { type FakeRedis, startFakeRedis } from '../../../kn-next/src/__tests__/helpers/fake-redis';
import { OrdersService } from '../../fixtures/zone/src/generated/grpc/orders/v1/orders_pb';
import { generateFiles } from '../generate';
import { FIXTURE_ZONE, PKG_DIR } from './helpers';

/**
 * Two users' reads of the same RPC never share a cache entry.
 *
 * The generated query keys its `'use cache'` function on the verified user's
 * `sub` (from authorize()), the served contract version and the request, and
 * mints the call's token INSIDE the cached function. This proves it against the
 * real pieces, across pods, with positive controls so the test cannot pass on a
 * cache that caches nothing:
 *
 *   1. user A's second read on pod 1 is a HIT (the function is called once);
 *   2. user A's read on pod 2 is a hit on pod 1's entry (the cache is shared);
 *   3. user B's read of the same RPC and request, on either pod, is never A's
 *      entry: the function is called for B, and B sees B;
 *   4. a write (the generated Server Action) on pod 1 refreshes the cached
 *      reads on pod 2, for both users (`updateTag` crosses pods);
 *   5. a pod serving a newer function contract version misses (the served
 *      version is part of the key);
 *   6. no cache key contains a token, and a call with no user is refused before
 *      the function is reached.
 *   7. a write that fails AFTER it was sent (it may have committed) still
 *      refreshes the reads on every pod; one refused before it was sent does not.
 *
 * The minter mints a fresh token per call, as a real one does (it carries an
 * expiry), so keying on the token would make (1) miss. Dropping the subject
 * from the key would make (3) serve A's entry to B. NOTHING here skips: a
 * missing precondition is a FAILURE.
 */

const CORE = resolve(PKG_DIR, '..', 'kn-next');
const CORE_MODULES = join(CORE, 'node_modules');
const NEXT_BIN = join(CORE_MODULES, 'next', 'dist', 'bin', 'next');
const ADAPTER_SRC = join(CORE, 'src', 'adapters', 'next-adapter.ts');
const PREFIX = 'zone-glue';
const OUT = 'src/generated/grpc';

const tempRoots: string[] = [];
const pods: ChildProcess[] = [];
let fake: FakeRedis | undefined;
let fn: Http2Server | undefined;

afterAll(async () => {
  for (const p of pods.splice(0)) {
    if (!p.pid) continue;
    try {
      process.kill(-p.pid, 'SIGKILL');
    } catch {
      p.kill('SIGKILL');
    }
  }
  fn?.close();
  await fake?.close();
  for (const d of tempRoots) rmSync(d, { recursive: true, force: true });
});

const tail = (s: string, n = 40) => s.split('\n').filter(Boolean).slice(-n).join('\n');

async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const srv = createNet();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => res(port));
    });
  });
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    let out = '';
    const child = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: '1',
        NODE_ENV: 'production',
        CI: '1',
        ...env,
      },
    });
    child.stdout?.on('data', (b) => {
      out += String(b);
    });
    child.stderr?.on('data', (b) => {
      out += String(b);
    });
    child.on('error', (err) => {
      out += `\nspawn error: ${err.message}`;
      res({ code: -1, out });
    });
    child.on('close', (code) => res({ code, out }));
  });
}

/** The function: answers with who the TOKEN says is calling, and a call counter. */
interface FunctionLog {
  calls: Record<string, number>;
  tokens: string[];
}

async function startFunction(): Promise<{ url: string; log: FunctionLog }> {
  const log: FunctionLog = { calls: {}, tokens: [] };
  let n = 0;
  const who = (auth: string | null) => {
    const token = (auth ?? '').replace(/^Bearer /, '');
    log.tokens.push(token);
    // tok.<sub>.<rpc>.<nonce>
    return token.split('.')[1] ?? 'none';
  };
  fn = createHttp2(
    connectNodeAdapter({
      routes: (router) =>
        router.service(OrdersService, {
          getOrder(req, ctx) {
            const sub = who(ctx.requestHeader.get('authorization'));
            log.calls[`get:${sub}`] = (log.calls[`get:${sub}`] ?? 0) + 1;
            n += 1;
            return { id: req.id, status: `sub=${sub};n=${n}` };
          },
          placeOrder(_req, ctx) {
            const sub = who(ctx.requestHeader.get('authorization'));
            log.calls[`place:${sub}`] = (log.calls[`place:${sub}`] ?? 0) + 1;
            return { id: `placed-by-${sub}` };
          },
          cancelOrder(_req, ctx) {
            // The write commits, then the call fails: what a lost response looks like.
            const sub = who(ctx.requestHeader.get('authorization'));
            log.calls[`cancel:${sub}`] = (log.calls[`cancel:${sub}`] ?? 0) + 1;
            throw new ConnectError('committed, then the response was lost', Code.Unavailable);
          },
          async *watchOrders() {},
        }),
    }),
  );
  await new Promise<void>((r) => fn?.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(fn.address() as AddressInfo).port}`, log };
}

const APP_FILES: Record<string, string> = {
  'src/knext/authorize.js': `import { headers } from 'next/headers';

// The test's authorize(): the "session" is a header. A real app verifies a cookie.
export async function authorize() {
  const user = (await headers()).get('x-test-user');
  if (!user) throw new Error('no signed-in user');
  return { sub: user };
}
`,
  'src/instrumentation.js': `export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { registerTokenMinter } = await import('@getknext/grpc/runtime');
  // A fresh token per call, as a real one (it carries an expiry) is.
  registerTokenMinter(({ sub, method }) =>
    ['tok', sub ?? 'anon', method.split('/').pop(), crypto.randomUUID()].join('.'),
  );
}
`,
  'src/app/layout.js': `export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}
`,
  'src/app/page.js': `export default function Home() {
  return <main id="home">zone glue fixture</main>;
}
`,
  'src/app/api/order/route.js': `import { connection } from 'next/server';
import { getOrder } from '../../../generated/grpc/orders/v1/orders_knext_server';

export async function GET() {
  await connection();
  try {
    const order = await getOrder({ id: 'o-1' });
    return Response.json({ status: order.status });
  } catch (err) {
    return Response.json({ error: String(err?.message ?? err) }, { status: 401 });
  }
}
`,
  'src/app/write/page.js': `import { placeOrder } from '../../generated/grpc/orders/v1/orders_knext_actions';

export default function Write() {
  return <form action={placeOrder}><button type="submit">place</button></form>;
}
`,
};

interface Pod {
  port: number;
  log: () => string;
}

async function startPod(
  serverJs: string,
  serverDir: string,
  env: Record<string, string>,
): Promise<Pod> {
  const port = await freePort();
  let log = '';
  let exited: string | null = null;
  const child = spawn('node', [serverJs], {
    cwd: serverDir,
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      ...env,
    },
  });
  pods.push(child);
  child.stdout?.on('data', (b) => {
    log += String(b);
  });
  child.stderr?.on('data', (b) => {
    log += String(b);
  });
  child.on('exit', (code, signal) => {
    exited = `code=${code} signal=${signal}`;
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !exited) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5_000) });
      await res.arrayBuffer();
      if (res.status === 200) return { port, log: () => log };
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`pod on :${port} never answered 200 (exited=${exited}):\n${tail(log)}`);
}

async function read(pod: Pod, user?: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${pod.port}/api/order`, {
    headers: user ? { 'x-test-user': user } : {},
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json()) as { status?: string; error?: string };
  return { status: res.status, body: json.status ?? json.error ?? '' };
}

async function ok(pod: Pod, user: string): Promise<string> {
  const r = await read(pod, user);
  expect(r.status, `read as ${user} -> ${r.status} ${r.body}\n${tail(pod.log())}`).toBe(200);
  return r.body;
}

/** Find the Server Action id the build gave an export of the generated actions module. */
function actionId(appDir: string, exportName: string): string {
  const manifest = JSON.parse(
    readFileSync(join(appDir, '.next', 'server', 'server-reference-manifest.json'), 'utf8'),
  ) as { node: Record<string, { exportedName?: string; filename?: string }> };
  const ids = Object.entries(manifest.node)
    .filter(([, v]) => v.exportedName === exportName)
    .map(([id]) => id);
  if (ids.length !== 1) throw new Error(`action ${exportName}: ${JSON.stringify(manifest.node)}`);
  return ids[0] as string;
}

async function act(pod: Pod, id: string, user: string, args: unknown[]): Promise<number> {
  const origin = `http://127.0.0.1:${pod.port}`;
  const res = await fetch(`${origin}/write`, {
    method: 'POST',
    headers: {
      'next-action': id,
      'content-type': 'text/plain;charset=UTF-8',
      accept: 'text/x-component',
      origin,
      'x-test-user': user,
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(30_000),
  });
  await res.arrayBuffer();
  return res.status;
}

describe("generated 'use cache' reads: two users never share an entry (real Next.js, two pods, one Redis)", () => {
  it('per-user hits, cross-pod sharing, cross-pod updateTag, served-version scoping, no token in a key', async () => {
    for (const [what, path] of [
      ['next binary', NEXT_BIN],
      [
        "@getknext/core's built 'use cache' backend (run the core build first)",
        join(CORE, 'dist', 'adapters', 'use-cache-handler-node.js'),
      ],
    ] as const) {
      expect(existsSync(path), `${what} not found at ${path}`).toBe(true);
    }

    const made = mkdtempSync(join(tmpdir(), 'knext-grpc-twouser-'));
    tempRoots.push(made);
    const root = realpathSync(made);
    const appDir = join(root, 'app');
    mkdirSync(appDir, { recursive: true });

    // node_modules: core's (next, react), plus this package's protobuf and
    // Connect, and the runtime the generated code imports.
    const modules = join(root, 'node_modules');
    mkdirSync(modules);
    for (const name of readdirSync(CORE_MODULES)) {
      if (name === '@bufbuild' || name === '@connectrpc' || name === '@getknext' || name === '.bin')
        continue;
      symlinkSync(join(CORE_MODULES, name), join(modules, name));
    }
    for (const scope of ['@bufbuild', '@connectrpc']) {
      symlinkSync(join(PKG_DIR, 'node_modules', scope), join(modules, scope));
    }
    const appModules = join(appDir, 'node_modules', '@getknext');
    mkdirSync(appModules, { recursive: true });
    symlinkSync(CORE, join(appModules, 'core'));
    const grpcPkg = join(appModules, 'grpc');
    mkdirSync(join(grpcPkg, 'dist'), { recursive: true });
    writeFileSync(
      join(grpcPkg, 'package.json'),
      JSON.stringify({
        name: '@getknext/grpc',
        type: 'module',
        exports: { './runtime': './dist/runtime.js' },
      }),
    );
    const runtime = await Bun.build({
      entrypoints: [join(PKG_DIR, 'src', 'runtime.ts')],
      target: 'node',
      format: 'esm',
      outdir: join(grpcPkg, 'dist'),
      packages: 'external',
    });
    expect(runtime.success, runtime.logs.map(String).join('\n')).toBe(true);

    // The glue, generated NOW from the fixture contracts (so a generator change
    // is what this test sees), with only the types stripped for a JS app.
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    for (const [rel, text] of generateFiles(FIXTURE_ZONE)) {
      if (!rel.endsWith('.ts')) continue;
      const target = join(appDir, OUT, rel.replace(/\.ts$/, '.js'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, transpiler.transformSync(text));
    }
    for (const [rel, text] of Object.entries(APP_FILES)) {
      mkdirSync(dirname(join(appDir, rel)), { recursive: true });
      writeFileSync(join(appDir, rel), text);
    }
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: 'zone-glue', private: true }),
    );
    writeFileSync(
      join(appDir, 'cache-handler.js'),
      'export { default } from "@getknext/core/adapters/cache-handler";\n',
    );
    const adapter = await Bun.build({
      entrypoints: [ADAPTER_SRC],
      target: 'node',
      format: 'esm',
      outdir: appDir,
      naming: 'adapter.mjs',
      packages: 'external',
    });
    expect(adapter.success, adapter.logs.map(String).join('\n')).toBe(true);
    writeFileSync(
      join(appDir, 'next.config.mjs'),
      `export default {
  adapterPath: ${JSON.stringify(join(appDir, 'adapter.mjs'))},
  outputFileTracingRoot: "/",
  generateBuildId: () => process.env.KNEXT_BUILD_ID || null,
  cacheComponents: true,
  partialPrefetching: false,
  cacheHandler: new URL("./cache-handler.js", import.meta.url).pathname,
  cacheMaxMemorySize: 0,
};
`,
    );

    const built = await run('node', [NEXT_BIN, 'build', '--webpack'], appDir, {
      KNEXT_RUNTIME: 'node',
      KNEXT_BUILD_ID: 'zone-glue-build-1',
    });
    expect(built.code, `next build failed (exit ${built.code}):\n${tail(built.out)}`).toBe(0);
    const serverDir = join(appDir, '.next', 'standalone', relative('/', appDir));
    const serverJs = join(serverDir, 'server.js');
    expect(existsSync(serverJs), tail(built.out)).toBe(true);
    // The standalone tree has its own copy of the app's static assets? Not needed: API only.
    cpSync(join(appDir, '.next', 'static'), join(serverDir, '.next', 'static'), {
      recursive: true,
    });

    fake = await startFakeRedis();
    const { url, log } = await startFunction();
    const env = {
      REDIS_URL: fake.url,
      REDIS_KEY_PREFIX: PREFIX,
      ORDERS_SERVICE_URL: url,
      ORDERS_SERVICE_PROTO_VERSION: '1.2.0',
    };
    const pod1 = await startPod(serverJs, serverDir, env);
    const pod2 = await startPod(serverJs, serverDir, env);

    // ── 1. positive control: A's second read on pod 1 is a hit ────────────
    const a1 = await ok(pod1, 'alice');
    expect(a1).toMatch(/^sub=alice;n=\d+$/);
    const a2 = await ok(pod1, 'alice');
    expect(
      a2,
      "user A's second read must be a cache HIT (a cache that caches nothing fails here)",
    ).toBe(a1);
    expect(log.calls['get:alice']).toBe(1);

    // ── 2. shared across pods ─────────────────────────────────────────────
    expect(await ok(pod2, 'alice'), "pod 2 must serve pod 1's entry for A").toBe(a1);
    expect(log.calls['get:alice']).toBe(1);

    // ── 3. B never gets A's entry, on either pod ──────────────────────────
    const b1 = await ok(pod2, 'bob');
    expect(b1, "user B must never be served user A's entry").toMatch(/^sub=bob;n=\d+$/);
    expect(b1).not.toBe(a1);
    expect(log.calls['get:bob']).toBe(1);
    expect(await ok(pod1, 'bob')).toBe(b1);
    expect(await ok(pod1, 'alice')).toBe(a1);
    expect(log.calls['get:bob']).toBe(1);

    // ── 6a. no cache key carries a token ──────────────────────────────────
    const keys = [...fake.strings.keys()];
    expect(
      keys.some((k) => k.startsWith(`${PREFIX}:uc:`)),
      keys.join('\n'),
    ).toBe(true);
    for (const t of log.tokens) {
      expect(
        keys.some((k) => k.includes(t)),
        `a cache key contains the token ${t}`,
      ).toBe(false);
    }
    // ...and every token was minted for the user who made the call.
    expect(log.tokens.every((t) => /^tok\.(alice|bob)\.GetOrder\.[0-9a-f-]{36}$/.test(t))).toBe(
      true,
    );

    // ── 6b. no user: refused before the function is reached ───────────────
    const anon = await read(pod1);
    expect(anon.status).toBe(401);
    expect(Object.keys(log.calls).some((k) => k.includes('none'))).toBe(false);

    // ── 4. a write on pod 1 refreshes both users' reads on pod 2 ──────────
    const placeId = actionId(appDir, 'placeOrder');
    expect(
      await act(pod1, placeId, 'alice', [{ sku: 's-1', quantity: 1 }, { idempotencyKey: 'k-1' }]),
    ).toBe(200);
    expect(log.calls['place:alice']).toBe(1);
    const a3 = await ok(pod2, 'alice');
    expect(a3, "the write's updateTag on pod 1 must refresh A's entry on pod 2").not.toBe(a1);
    expect(a3).toMatch(/^sub=alice;/);
    const b2 = await ok(pod2, 'bob');
    expect(b2, "...and B's, since a write can change what B reads").not.toBe(b1);
    expect(b2).toMatch(/^sub=bob;/);
    expect(await ok(pod1, 'alice')).toBe(a3);

    // ── 5. a newer served contract version is a different entry ───────────
    const pod3 = await startPod(serverJs, serverDir, {
      ...env,
      ORDERS_SERVICE_PROTO_VERSION: '1.3.0',
    });
    const before = log.calls['get:alice'] ?? 0;
    const a4 = await ok(pod3, 'alice');
    expect(a4, 'a pod whose function serves 1.3.0 must not reuse the 1.2.0 entry').not.toBe(a3);
    expect(log.calls['get:alice']).toBe(before + 1);

    // ── 7. a failed write refreshes only if it may have been sent ─────────
    const cancelId = actionId(appDir, 'cancelOrder');
    // 7a. no idempotency key: refused before the request left pod 1.
    expect(await act(pod1, cancelId, 'alice', [{ id: 'o-1' }])).toBe(500);
    expect(log.calls['cancel:alice']).toBeUndefined();
    expect(await ok(pod2, 'alice'), 'a write refused before sending refreshes nothing').toBe(a3);
    // 7b. the function commits, then the call fails: the action throws, and
    // Next.js still applies its updateTag, on every pod.
    expect(await act(pod1, cancelId, 'alice', [{ id: 'o-1' }, { idempotencyKey: 'k-2' }])).toBe(
      500,
    );
    expect(log.calls['cancel:alice']).toBe(1);
    const a5 = await ok(pod2, 'alice');
    expect(a5, 'a write that failed after it was sent must still refresh the reads').not.toBe(a3);
    expect(a5).toMatch(/^sub=alice;/);
  }, 600_000);
});
