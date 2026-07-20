import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #437 — the V8 compile cache must be BAKED INTO THE IMAGE at build time.
 *
 * The bug this covers: the Dockerfile did
 *   `RUN mkdir -p apps/file-manager/.next/compile-cache`
 * and nothing ever populated it. The CMD then pointed NODE_COMPILE_CACHE at that
 * EMPTY directory, so every cold pod compiled the whole standalone server from
 * scratch (~2s of a measured 3.81s median cold start on OKE), wrote the cache to
 * the ephemeral container layer, and discarded it on scale-to-zero. Nothing ever
 * survived a cold start, so the "faster subsequent cold starts" comment was false
 * as shipped.
 *
 * These tests pin the three things that make the fix real and self-verifying:
 *   1. the image build actually RUNS a warm-up that populates the cache;
 *   2. the warm-up uses the SAME NODE_COMPILE_CACHE / STANDALONE_SERVER_PATH
 *      values the runtime CMD uses (a cache baked at a different path is dead
 *      weight — and V8 keys entries by filename);
 *   3. the warm-up FAILS THE BUILD when the cache ends up empty — which is
 *      exactly the silent regression that shipped.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = resolve(__dirname, 'Dockerfile');
const WARMUP_SCRIPT = resolve(__dirname, 'scripts/warm-compile-cache.sh');

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

/** Run the warm-up script with a stubbed boot command, return {status, output}. */
function runWarmup(opts: { cacheDir: string; bootCmd: string; port: number }): {
  status: number;
  output: string;
} {
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
        KNEXT_WARMUP_TIMEOUT_S: '30',
      },
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * A stub "server": listens on PORT, answers /api/health, and — when
 * `populate` is true — writes a file into NODE_COMPILE_CACHE before exiting on
 * SIGTERM (standing in for V8 flushing real cache entries).
 */
function stubServer(populate: boolean): string {
  // `env -u NODE_COMPILE_CACHE` is essential: without it the stub's OWN node
  // process writes real compile-cache entries into the dir under test, so the
  // "empty cache" case could never actually be empty and the assertion we are
  // testing would pass vacuously. The stub instead writes to CACHE_PROBE_DIR,
  // giving each case an exactly-known entry count.
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

describe('#437 — the compile cache is baked into the image at build time', () => {
  it('the image build runs a warm-up that populates the compile cache (not a bare mkdir)', () => {
    const df = dockerfile();

    // The warm-up script must exist and be COPY'd + executed in the runner stage.
    expect(statSync(WARMUP_SCRIPT).isFile()).toBe(true);
    expect(df).toMatch(/warm-compile-cache\.sh/);
    // …and actually invoked by a RUN, not merely copied in.
    expect(df).toMatch(/RUN[\s\S]{0,600}?warm-compile-cache\.sh/);

    // The old bug: a `mkdir -p …compile-cache` that nothing populates. Any
    // mkdir of the cache dir must now live inside the warm-up, not the Dockerfile.
    expect(df).not.toMatch(/RUN\s+mkdir\s+-p\s+apps\/file-manager\/\.next\/compile-cache/);
  });

  it('the warm-up targets the SAME cache dir and server path as the runtime CMD', () => {
    const df = dockerfile();
    const cacheDir = cmdDefault('NODE_COMPILE_CACHE');
    const serverPath = cmdDefault('STANDALONE_SERVER_PATH');

    // The build-time RUN block must set both to the CMD's values, otherwise the
    // baked entries are keyed to paths the runtime never loads.
    const runBlock = df.slice(0, df.indexOf('CMD ['));
    expect(runBlock).toContain(`NODE_COMPILE_CACHE=${cacheDir}`);
    expect(runBlock).toContain(`STANDALONE_SERVER_PATH=${serverPath}`);
  });

  it('keeps the NODE_COMPILE_CACHE default-substitution so an injected value still wins', () => {
    expect(dockerfileRuntimeCmd()).toContain('${NODE_COMPILE_CACHE:-');
  });

  it('makes the baked cache readable by the runtime `node` user', () => {
    expect(dockerfile()).toMatch(/chown\s+-R\s+node:node\s+apps\/file-manager\/\.next/);
  });

  it('no longer claims a benefit it does not deliver ("subsequent cold starts")', () => {
    // The pre-fix comment promised a cross-cold-start benefit that an empty,
    // ephemeral cache can never provide.
    expect(dockerfile()).not.toContain('V8 bytecode cache for faster subsequent cold starts');
    expect(dockerfile()).toMatch(/baked|pre-populated|populated at (image )?build/i);
  });

  it('FAILS the build when the warm-up leaves the cache empty (the shipped bug)', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'knext-cc-empty-'));
    const { status, output } = runWarmup({
      cacheDir,
      bootCmd: stubServer(false),
      port: 34371,
    });

    expect(status).not.toBe(0);
    expect(output).toMatch(/empty|no .*entries/i);
  });

  it('SUCCEEDS and reports the entry count when the warm-up populates the cache', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'knext-cc-full-'));
    const { status, output } = runWarmup({
      cacheDir,
      bootCmd: stubServer(true),
      port: 34372,
    });

    expect(status).toBe(0);
    expect(output).toMatch(/baked 1 entries, 8 bytes/);
  });

  it('FAILS the build when the warm-up server never becomes ready', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'knext-cc-dead-'));
    // A "server" that exits immediately without ever listening.
    const { status, output } = runWarmup({
      cacheDir,
      bootCmd: 'node -e "process.exit(0)"',
      port: 34373,
    });

    expect(status).not.toBe(0);
    expect(output).toMatch(/ready/i);
  });

  it('does not depend on Postgres/Redis: it probes the shallow health route', () => {
    // /api/health is documented as dependency-free (ADR-0026) — a deep probe
    // would make the image build require a live database.
    const script = readFileSync(WARMUP_SCRIPT, 'utf8');
    expect(script).toContain('/api/health');
    expect(script).not.toContain('/api/health/deep');

    const health = readFileSync(resolve(__dirname, 'src/app/api/health/route.ts'), 'utf8');
    expect(health).toContain('checkShallowHealth');

    // Guard the write we rely on: a temp file placed by the stub must be seen.
    const probe = join(mkdtempSync(join(tmpdir(), 'knext-cc-probe-')), 'x');
    writeFileSync(probe, 'x');
    expect(readFileSync(probe, 'utf8')).toBe('x');
  });
});
