/**
 * Shared test harness for the baked-compile-cache warm-up script
 * (`scripts/warm-compile-cache.sh`, #437/#439/#440).
 *
 * WHY THIS EXISTS (the CI flake it fixes)
 * ---------------------------------------
 * Both bake tests (apps/file-manager + apps/docs) drive the REAL script with a
 * stub server, which must bind a TCP port so the script's health probe can reach
 * it. They used to hardcode ports in the 343xx/344xx band. That is safe on macOS,
 * where the ephemeral (auto-assigned source) port range starts at 49152 — a 34xxx
 * port is never handed out to anything else, so the tests always passed locally.
 *
 * On Linux (every GitHub Actions runner) the default ephemeral range is
 * 32768–60999, which CONTAINS 34xxx. Any outbound socket opened anywhere on the
 * runner — vitest workers, package fetches, the runner agent itself — can
 * transiently occupy exactly the port a bake test is about to bind. The stub then
 * dies with EADDRINUSE, the script finds no cache entries, and the run exits 1:
 *
 *     AssertionError: expected 1 to be +0   // "SUCCEEDS and reports the entry count"
 *
 * That is a harness bug, not a script bug — hence the fix lives here.
 *
 * THE FIX
 * -------
 *   1. Ask the KERNEL for a free loopback port (bind :0, read it, close) instead
 *      of hardcoding one — the same pattern used elsewhere in the repo.
 *   2. Because :0 discovery still leaves a (tiny) close→bind race, retry the run
 *      on a FRESH port when — and ONLY when — the output shows a bind collision.
 *      Any other failure is returned as-is, so every assertion keeps its full
 *      strength; a real regression can never be retried into a pass.
 *   3. Surface the script's own stdout+stderr in assertion messages, so the next
 *      CI failure is diagnosable from the log instead of needing a repro.
 */

import { execFileSync } from 'node:child_process';
import { type AddressInfo, createServer } from 'node:net';
import { resolve } from 'node:path';

/**
 * The SHARED, promoted warm-up script (ADR-0035 action item 2) — one copy, both
 * consumers, so the second consumer inherits the #440 safety guards.
 */
export const WARMUP_SCRIPT = resolve(import.meta.dirname, '../../scripts/warm-compile-cache.sh');

/** A floor of 1/1 — for stubs whose "cache" is a single 8-byte file. */
export const STUB_FLOOR = { KNEXT_WARMUP_MIN_FILES: '1', KNEXT_WARMUP_MIN_BYTES: '1' };

/**
 * Node prints this to stderr when the stub cannot bind the port it was given.
 * It is the ONLY condition that earns a retry — see the module comment.
 */
const BIND_COLLISION = /EADDRINUSE|address already in use/i;

/** How many fresh ports to try before declaring the environment unusable. */
const MAX_BIND_ATTEMPTS = 5;

export interface WarmupResult {
  status: number;
  output: string;
  /** The port the (final) attempt actually used — useful in failure messages. */
  port: number;
  /** How many ports were tried (>1 means a bind collision was retried away). */
  attempts: number;
  /**
   * Ready-made assertion message: exit status, port, and the script's OWN
   * stdout+stderr. Pass it as `expect(status, diagnostic)` so a CI failure names
   * which guard fired instead of only reporting `expected 1 to be +0`.
   */
  diagnostic: string;
}

/**
 * A port the kernel says is free RIGHT NOW on loopback. Binding :0 and closing
 * is the standard discovery trick; the residual close→bind race is covered by
 * the retry in {@link runWarmup}.
 */
export async function freeLoopbackPort(): Promise<number> {
  return await new Promise<number>((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close((err) => (err ? rej(err) : res(port)));
    });
  });
}

export interface WarmupOptions {
  cacheDir: string;
  bootCmd: string;
  /**
   * Health route the script probes. Omit for the shared default (/api/health,
   * apps/file-manager); apps/docs passes '/' (it has no health route).
   */
  healthPath?: string;
  /** Extra env, e.g. to lower the plausibility floor for a stub-sized cache. */
  env?: Record<string, string>;
}

function runOnce(opts: WarmupOptions, port: number): { status: number; output: string } {
  const env = { ...process.env };
  delete env.NODE_OPTIONS; // harness artifact; keep the child shell clean
  try {
    const output = execFileSync('sh', [WARMUP_SCRIPT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        NODE_COMPILE_CACHE: opts.cacheDir,
        CACHE_PROBE_DIR: opts.cacheDir,
        PORT: String(port),
        KNEXT_WARMUP_BOOT_CMD: opts.bootCmd,
        ...(opts.healthPath ? { KNEXT_WARMUP_HEALTH_PATH: opts.healthPath } : {}),
        KNEXT_WARMUP_TIMEOUT_S: '30',
        ...opts.env,
      },
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * Run the warm-up script with a stubbed boot command on a kernel-allocated port.
 * Retries ONLY a bind collision (see {@link BIND_COLLISION}); every other outcome
 * — including the failures these tests deliberately provoke — is returned as-is.
 */
export async function runWarmup(opts: WarmupOptions): Promise<WarmupResult> {
  let last: { status: number; output: string } = { status: 1, output: '' };
  let port = 0;
  for (let attempt = 1; attempt <= MAX_BIND_ATTEMPTS; attempt++) {
    port = await freeLoopbackPort();
    last = runOnce(opts, port);
    if (last.status === 0 || !BIND_COLLISION.test(last.output)) {
      return {
        ...last,
        port,
        attempts: attempt,
        diagnostic:
          `warm-up exited ${last.status} on port ${port} (attempt ${attempt})\n` +
          `--- script output ---\n${last.output}`,
      };
    }
  }
  throw new Error(
    `warm-up harness: could not obtain a bindable port after ${MAX_BIND_ATTEMPTS} attempts ` +
      `(last port ${port}). This is environment contention, not a script regression.\n` +
      `--- script output ---\n${last.output}`,
  );
}

/**
 * A stub "server": listens on PORT, answers every path (so it satisfies both
 * /api/health and the docs home page '/'), and — when `populate` is true — writes
 * a file into CACHE_PROBE_DIR on SIGTERM, standing in for V8 flushing real cache
 * entries.
 *
 * `env -u NODE_COMPILE_CACHE` is essential: without it the stub's OWN node process
 * writes real compile-cache entries into the dir under test, so the "empty cache"
 * case could never actually be empty and the assertion we are testing would pass
 * vacuously. The stub instead writes to CACHE_PROBE_DIR, giving each case an
 * exactly-known entry count.
 */
export function stubServer(populate: boolean): string {
  return `env -u NODE_COMPILE_CACHE node -e "${[
    'const http=require(\\"http\\");',
    'const fs=require(\\"fs\\");',
    'const path=require(\\"path\\");',
    'const s=http.createServer((q,r)=>r.end(\\"ok\\"));',
    's.listen(Number(process.env.PORT));',
    'process.on(\\"SIGTERM\\",()=>{',
    populate
      ? 'fs.writeFileSync(path.join(process.env.CACHE_PROBE_DIR,\\"entry.bin\\"),\\"bytecode\\");'
      : '',
    's.close();process.exit(0);});',
  ].join('')}"`;
}
