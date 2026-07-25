import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #439 — apps/docs has the IDENTICAL empty-compile-cache bug as apps/file-manager
 * (#437). The docs Dockerfile did `RUN mkdir -p .next/compile-cache` — an EMPTY
 * directory — and pointed the runtime CMD's NODE_COMPILE_CACHE at it, so every
 * cold pod compiled the whole standalone server from scratch, wrote the cache into
 * the ephemeral container layer, and discarded it on scale-to-zero. The fix bakes
 * the V8 compile cache into the image at build time (ADR-0035).
 *
 * Two things differ from file-manager and are pinned here:
 *   1. docs is served by a BARE `node server.js` (not the knext runtime entry),
 *      so there is no STANDALONE_SERVER_PATH — the runtime reads NODE_COMPILE_CACHE
 *      directly, and warm-up + CMD must agree on that ONE absolute dir.
 *   2. docs has no dependency-free `/api/health` route, so readiness is detected on
 *      the static home page `/` via the shared script's KNEXT_WARMUP_HEALTH_PATH seam.
 *
 * The warm-up script is the SHARED, promoted copy (ADR-0035 action item 2): the
 * second consumer inherits the guards instead of copy-pasting them.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = resolve(__dirname, 'Dockerfile');
// Promoted out of apps/file-manager/scripts/ to a shared repo-root location so
// both consumers (file-manager + docs) inherit the same guarded script (#439).
const WARMUP_SCRIPT = resolve(__dirname, '../../scripts/warm-compile-cache.sh');

function dockerfile(): string {
  return readFileSync(DOCKERFILE, 'utf8');
}

/** Extract the runtime `CMD ["sh","-c","…"]` shell string from the Dockerfile. */
function dockerfileRuntimeCmd(): string {
  const m = dockerfile().match(/CMD\s*\[\s*"sh"\s*,\s*"-c"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]/);
  if (!m) throw new Error('Could not find a CMD ["sh","-c", …] runtime command in the Dockerfile');
  return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/** Default value of `${VAR:-default}` as written in the runtime CMD. */
function cmdDefault(varName: string): string {
  const m = dockerfileRuntimeCmd().match(new RegExp(`\\$\\{${varName}:-([^}]+)\\}`));
  if (!m) throw new Error(`CMD does not supply a \${${varName}:-…} fallback`);
  return m[1];
}

/** The warm-up RUN block's `NODE_COMPILE_CACHE=<value>` (build-time bake target). */
function warmupNodeCompileCache(): string {
  const df = dockerfile();
  const runBlock = df.slice(0, df.indexOf('CMD ['));
  const m = runBlock.match(/NODE_COMPILE_CACHE=(\S+)/);
  if (!m) throw new Error('warm-up RUN block must set NODE_COMPILE_CACHE');
  return m[1];
}

/** Run the warm-up script with a stubbed boot command, return {status, output}. */
function runWarmup(opts: {
  cacheDir: string;
  bootCmd: string;
  port: number;
  healthPath: string;
  env?: Record<string, string>;
}): { status: number; output: string } {
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
        PORT: String(opts.port),
        KNEXT_WARMUP_BOOT_CMD: opts.bootCmd,
        KNEXT_WARMUP_HEALTH_PATH: opts.healthPath,
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

/** A floor of 1/1 — for stubs whose "cache" is a single 8-byte file. */
const STUB_FLOOR = { KNEXT_WARMUP_MIN_FILES: '1', KNEXT_WARMUP_MIN_BYTES: '1' };

/**
 * A stub "server": listens on PORT, answers any path (incl. the docs health path
 * `/`), and — when `populate` is true — writes a file into NODE_COMPILE_CACHE on
 * SIGTERM (standing in for V8 flushing real cache entries). `env -u
 * NODE_COMPILE_CACHE` keeps the stub's OWN cache out of the dir under test.
 */
function stubServer(populate: boolean): string {
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

const DOCS_HEALTH = '/';

describe('#439 — the docs compile cache is baked into the image at build time', () => {
  it('the image build runs a warm-up that populates the compile cache (not a bare mkdir)', () => {
    const df = dockerfile();

    // The SHARED warm-up script must exist and be COPY'd + executed in the runner.
    expect(statSync(WARMUP_SCRIPT).isFile()).toBe(true);
    expect(df).toMatch(/warm-compile-cache\.sh/);
    // …and actually invoked by a RUN, not merely copied in.
    expect(df).toMatch(/RUN[\s\S]{0,600}?warm-compile-cache\.sh/);

    // The old bug: a bare `mkdir -p .next/compile-cache` that nothing populates.
    expect(df).not.toMatch(/RUN\s+mkdir\s+-p\s+\.next\/compile-cache/);
  });

  it('the warm-up boots the SAME entry (bare server.js) and cache dir as the runtime CMD', () => {
    const df = dockerfile();
    const cacheDir = cmdDefault('NODE_COMPILE_CACHE');
    const runBlock = df.slice(0, df.indexOf('CMD ['));

    // The build-time RUN must bake at the CMD's cache dir, else the entries are
    // keyed to a path the runtime never loads.
    expect(runBlock).toContain(`NODE_COMPILE_CACHE=${cacheDir}`);
    // docs runs a BARE `node server.js` — so the warm-up must boot that, not the
    // knext runtime entry (which needs @getknext/core, absent in the docs image).
    expect(runBlock).toMatch(/KNEXT_WARMUP_BOOT_CMD=(["']?)node server\.js\1/);
  });

  it('reads readiness from the static home page `/` (docs has no /api/health)', () => {
    const df = dockerfile();
    const runBlock = df.slice(0, df.indexOf('CMD ['));
    // The shared script defaults to /api/health, which docs does not serve, so the
    // warm-up RUN must override the health path to the dependency-free home page.
    expect(runBlock).toMatch(/KNEXT_WARMUP_HEALTH_PATH=(["']?)\/\1/);
  });

  it('#439 — the compile-cache paths (warm-up RUN, CMD default, runtime-derived) resolve to ONE dir', () => {
    // docs is served by a bare `node server.js`, so Node reads NODE_COMPILE_CACHE
    // directly — there is no STANDALONE_SERVER_PATH derivation. The baked win only
    // materialises if the warm-up bakes where the runtime reads.
    const warmupDir = resolve(warmupNodeCompileCache());
    const cmdDir = resolve(cmdDefault('NODE_COMPILE_CACHE'));
    // Node's runtime-derived dir IS the env value it is given (no derivation).
    const runtimeDir = cmdDir;

    expect(cmdDir).toBe(warmupDir);
    expect(runtimeDir).toBe(warmupDir);
  });

  it('keeps the NODE_COMPILE_CACHE default-substitution so an injected value still wins', () => {
    expect(dockerfileRuntimeCmd()).toContain('${NODE_COMPILE_CACHE:-');
  });

  it('the CMD default AND warm-up NODE_COMPILE_CACHE are ABSOLUTE (freshness guard, #440)', () => {
    // The freshness guard clears the cache dir and FATALs on a RELATIVE path, so
    // both the warm-up caller AND the CMD default must be absolute.
    const warmup = warmupNodeCompileCache();
    const cmd = cmdDefault('NODE_COMPILE_CACHE');
    for (const value of [warmup, cmd]) {
      expect(value.startsWith('/')).toBe(true);
      expect(value).not.toMatch(/(^|\/)\.\.(\/|$)/);
      expect(value).not.toMatch(/\/\//);
      expect(value).not.toMatch(/(^|\/)\.(\/|$)/);
    }
  });

  it("the warm-up's absolute path PASSES the freshness guard end-to-end (#440)", () => {
    const probeDir = mkdtempSync(join(tmpdir(), 'knext-docs-cc-abs-'));
    const { status, output } = runWarmup({
      cacheDir: probeDir,
      bootCmd: stubServer(true),
      port: 34485,
      healthPath: DOCS_HEALTH,
      env: STUB_FLOOR,
    });
    expect(status).toBe(0);
    expect(output).not.toMatch(/not an absolute path/i);
    expect(output).toMatch(/baked/);
  });

  it('makes the baked cache readable by the runtime `node` user', () => {
    expect(dockerfile()).toMatch(/chown\s+-R\s+node:node\s+\.next/);
  });

  it('no longer claims a benefit it does not deliver ("subsequent cold starts")', () => {
    expect(dockerfile()).not.toContain('V8 bytecode cache for faster subsequent cold starts');
    expect(dockerfile()).toMatch(/baked|pre-populated|populated at (image )?build/i);
  });

  it('sets a plausibility floor sized for the (smaller) docs app', () => {
    const df = dockerfile();
    const runBlock = df.slice(0, df.indexOf('CMD ['));
    const files = runBlock.match(/KNEXT_WARMUP_MIN_FILES=(\d+)/);
    const bytes = runBlock.match(/KNEXT_WARMUP_MIN_BYTES=(\d+)/);
    if (!files || !bytes) {
      throw new Error('docs warm-up RUN must set KNEXT_WARMUP_MIN_FILES/MIN_BYTES');
    }
    // Above a truncated flush (a Next standalone server compiles hundreds of its
    // own runtime modules even for a small app)…
    expect(Number(files[1])).toBeGreaterThanOrEqual(50);
    expect(Number(bytes[1])).toBeGreaterThanOrEqual(200_000);
    // …and conservatively BELOW the file-manager reference (1106 / 4.25 MB) — the
    // docs site is a smaller static fumadocs app (no sharp, no runtime supervisor).
    expect(Number(files[1])).toBeLessThan(1106);
    expect(Number(bytes[1])).toBeLessThan(4_246_032);
  });

  it('FAILS the build when the warm-up leaves the cache empty (the shipped bug)', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'knext-docs-cc-empty-'));
    const { status, output } = runWarmup({
      cacheDir,
      bootCmd: stubServer(false),
      port: 34471,
      healthPath: DOCS_HEALTH,
      env: STUB_FLOOR,
    });
    expect(status).not.toBe(0);
    expect(output).toMatch(/empty|no .*entries/i);
  });

  it('SUCCEEDS and reports the entry count when the warm-up populates the cache', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'knext-docs-cc-full-'));
    const { status, output } = runWarmup({
      cacheDir,
      bootCmd: stubServer(true),
      port: 34472,
      healthPath: DOCS_HEALTH,
      env: STUB_FLOOR,
    });
    expect(status).toBe(0);
    expect(output).toMatch(/baked 1 entries, 8 bytes/);
  });

  it('reads readiness from the configured health path (the docs home page)', () => {
    // Prove the KNEXT_WARMUP_HEALTH_PATH seam actually drives the probe: a stub
    // that only ever answers is reached on `/`, and the run reaches "ready".
    const cacheDir = mkdtempSync(join(tmpdir(), 'knext-docs-cc-health-'));
    const { status, output } = runWarmup({
      cacheDir,
      bootCmd: stubServer(true),
      port: 34473,
      healthPath: DOCS_HEALTH,
      env: STUB_FLOOR,
    });
    expect(status).toBe(0);
    expect(output).toMatch(/ready/i);
  });
});
