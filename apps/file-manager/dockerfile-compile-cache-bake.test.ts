import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

/** The warm-up RUN block's `NODE_COMPILE_CACHE=<value>` (build-time bake target). */
function warmupNodeCompileCache(): string {
  const df = dockerfile();
  const runBlock = df.slice(0, df.indexOf('CMD ['));
  const m = runBlock.match(/NODE_COMPILE_CACHE=(\S+)/);
  if (!m) throw new Error('warm-up RUN block must set NODE_COMPILE_CACHE');
  return m[1];
}

/**
 * The WORKDIR in effect for the runtime CMD = the LAST `WORKDIR` directive in the
 * Dockerfile (the runner stage's). The runtime resolves STANDALONE_SERVER_PATH
 * against process.cwd(), which the container starts at this WORKDIR.
 */
function dockerfileRunnerWorkdir(): string {
  const matches = [...dockerfile().matchAll(/^\s*WORKDIR\s+(\S+)\s*$/gm)];
  if (matches.length === 0) throw new Error('Dockerfile has no WORKDIR directive');
  return matches[matches.length - 1][1];
}

/** Run the warm-up script with a stubbed boot command, return {status, output}. */
function runWarmup(opts: {
  cacheDir: string;
  bootCmd: string;
  port: number;
  /** Extra env, e.g. to lower the plausibility floor for a stub-sized cache. */
  env?: Record<string, string>;
}): {
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

/** Write a JS file to a fresh temp dir and return a `node <path>` boot command. */
function nodeScript(name: string, source: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'knext-cc-stub-')), name);
  writeFileSync(path, source);
  // `env -u NODE_COMPILE_CACHE`: see stubServer — keep the stub's own V8 cache
  // out of the directory under test so entry counts are exactly known.
  return `env -u NODE_COMPILE_CACHE node ${path}`;
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

  it('#507 — the THREE compile-cache paths (warm-up RUN, CMD default, runtime-derived) resolve to ONE dir', () => {
    // The baked cold-start win (ADR-0035, ~393ms) only materializes if THREE paths
    // agree on ONE directory. Nothing else in CI asserts this EQUALITY, so a future
    // WORKDIR / STANDALONE_SERVER_PATH / Dockerfile-path change could silently bake
    // the cache where the runtime never reads it — the win vanishes with NO build
    // failure, caught only by the runtime #450 shadow-warning (needs a live pod).
    //
    // All three are DERIVED from the parsed Dockerfile (never hardcoded), so the
    // test tracks a real WORKDIR/STANDALONE_SERVER_PATH edit instead of pinning a
    // literal `/app/apps/file-manager/.next/compile-cache`.

    // 1. Dockerfile warm-up RUN — the build-time bake target (already absolute).
    const warmupDir = resolve(warmupNodeCompileCache());

    // 2. Dockerfile CMD default — where the runtime's NODE_COMPILE_CACHE points
    //    when the operator injects nothing (also absolute in the shipped image).
    const cmdDir = resolve(cmdDefault('NODE_COMPILE_CACHE'));

    // 3. Runtime-derived dir — mirror node-server.ts's `bakedCompileCacheDir`:
    //      serverJs             = resolve(cwd, STANDALONE_SERVER_PATH)
    //      bakedCompileCacheDir = resolve(dirname(serverJs), '.next', 'compile-cache')
    //    cwd is the container WORKDIR and STANDALONE_SERVER_PATH is the CMD default.
    const workdir = dockerfileRunnerWorkdir();
    const serverPath = cmdDefault('STANDALONE_SERVER_PATH');
    const serverJs = resolve(workdir, serverPath);
    const runtimeDir = resolve(dirname(serverJs), '.next', 'compile-cache');

    // The tripwire: any divergence between the three fails the build in unit CI.
    expect(cmdDir).toBe(warmupDir);
    expect(runtimeDir).toBe(warmupDir);
  });

  it('keeps the NODE_COMPILE_CACHE default-substitution so an injected value still wins', () => {
    expect(dockerfileRuntimeCmd()).toContain('${NODE_COMPILE_CACHE:-');
  });

  it("the warm-up's NODE_COMPILE_CACHE is ABSOLUTE, so it PASSES the freshness guard (#440)", () => {
    // The freshness guard clears the cache dir and (correctly) FATALs on a
    // RELATIVE path — clearing a cwd-relative path is unsafe. So the warm-up
    // CALLER must pass an ABSOLUTE path or the guard kills the real image build.
    // Unit CI never runs `docker build`, so this string assertion is the only
    // thing that catches a relative regression before it breaks production.
    const df = dockerfile();
    const runBlock = df.slice(0, df.indexOf('CMD ['));
    const m = runBlock.match(/NODE_COMPILE_CACHE=(\S+)/);
    if (!m) throw new Error('warm-up RUN block must set NODE_COMPILE_CACHE');
    const value = m[1];

    // Absolute, and not a form the guard rejects (`..`, `//`, bare `.`).
    expect(value.startsWith('/')).toBe(true);
    expect(value).not.toMatch(/(^|\/)\.\.(\/|$)/);
    expect(value).not.toMatch(/\/\//);
    expect(value).not.toMatch(/(^|\/)\.(\/|$)/);

    // Prove it end-to-end: the real Dockerfile value must PASS the guard (the
    // script clears it and reaches the boot), not FATAL on the absolute-path
    // check. Point it at a temp dir so we exercise the guard, not a real path.
    const probeDir = mkdtempSync(join(tmpdir(), 'knext-cc-abs-'));
    const { status, output } = runWarmup({
      // Substitute the temp dir but KEEP the leading-slash shape of the real
      // value — we are asserting "absolute ⇒ guard passes", and the shipped
      // value is absolute.
      cacheDir: probeDir,
      bootCmd: stubServer(true),
      port: 34385,
      env: STUB_FLOOR,
    });
    expect(status).toBe(0);
    expect(output).not.toMatch(/not an absolute path/i);
    expect(output).toMatch(/baked/);
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
      env: STUB_FLOOR, // even the most permissive floor must reject zero
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
      env: STUB_FLOOR,
    });

    expect(status).toBe(0);
    expect(output).toMatch(/baked 1 entries, 8 bytes/);
  });

  it('FAILS the build when the warm-up server EXITS EARLY (distinct from a ready timeout)', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'knext-cc-dead-'));
    // A "server" that exits immediately without ever listening.
    const { status, output } = runWarmup({
      cacheDir,
      bootCmd: 'node -e "process.exit(0)"',
      port: 34373,
    });

    expect(status).not.toBe(0);
    // Must name the EXITED path specifically. `/ready/i` would also match the
    // ready-timeout message, so it cannot tell the two failures apart — and a
    // regression collapsing them into one would pass unnoticed.
    expect(output).toMatch(/exited before it was ready/i);
    expect(output).not.toMatch(/not ready within/i);
  });

  it('FAILS the build when the server stays alive but never becomes ready (timeout path)', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'knext-cc-hang-'));
    // Alive for the whole run, but never binds the port — so the health probe
    // never succeeds and the READY_TIMEOUT_S branch is what must fire.
    const { status, output } = runWarmup({
      cacheDir,
      bootCmd: nodeScript('hang.js', 'setTimeout(() => {}, 60_000);\n'),
      port: 34374,
      env: { KNEXT_WARMUP_TIMEOUT_S: '3' },
    });

    expect(status).not.toBe(0);
    expect(output).toMatch(/not ready within 3s/i);
    expect(output).not.toMatch(/exited before it was ready/i);
  });

  it('waits for the standalone-server GRANDCHILD to flush before asserting', () => {
    // The runtime entry (node-server.ts) SPAWNS `server.js` as a child, and it
    // is that grandchild whose modules V8 caches. The parent's graceful shutdown
    // has a hard cap (SHUTDOWN_GRACE_MS) and calls process.exit() even if the
    // child has not finished — so waiting on the parent alone can assert, and
    // COMMIT THE IMAGE LAYER, while the real writer is still flushing.
    const cacheDir = mkdtempSync(join(tmpdir(), 'knext-cc-grandchild-'));
    const child = nodeScript(
      'late-writer.js',
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        '// Ignore SIGTERM: only the parent is signalled, exactly as in the real',
        '// runtime where the supervisor forwards and then gives up at its cap.',
        'setTimeout(() => {',
        "  fs.writeFileSync(path.join(process.env.CACHE_PROBE_DIR, 'entry.bin'), 'bytecode');",
        '  process.exit(0);',
        '}, 3000);',
      ].join('\n'),
    );
    const parent = nodeScript(
      'supervisor.js',
      [
        "const http = require('node:http');",
        "const { spawn } = require('node:child_process');",
        `const kid = spawn('sh', ['-c', ${JSON.stringify(child)}], { stdio: 'inherit' });`,
        "const s = http.createServer((_q, r) => r.end('ok'));",
        's.listen(Number(process.env.PORT));',
        '// Exit IMMEDIATELY on SIGTERM, abandoning the still-writing child.',
        "process.on('SIGTERM', () => { s.close(); process.exit(0); });",
        'kid.unref();',
      ].join('\n'),
    );

    const { status, output } = runWarmup({
      cacheDir,
      bootCmd: parent,
      port: 34375,
      env: STUB_FLOOR,
    });

    // If the script only waited on the parent it would find an EMPTY dir here
    // and fail — the partial-cache race, made deterministic.
    expect(status).toBe(0);
    expect(output).toMatch(/baked 1 entries, 8 bytes/);
  });

  it('rejects a PARTIAL cache, not merely an empty one (plausibility floor)', () => {
    // A truncated flush leaves a handful of entries, which sails past a `>= 1`
    // non-empty check. The real bake produces 1106 entries / ~4.25 MB, so the
    // DEFAULT floor must reject a single 8-byte entry.
    const cacheDir = mkdtempSync(join(tmpdir(), 'knext-cc-partial-'));
    const { status, output } = runWarmup({
      cacheDir,
      bootCmd: stubServer(true),
      port: 34376,
      // NB: no STUB_FLOOR — this exercises the shipped defaults.
    });

    expect(status).not.toBe(0);
    // The message must state expected-vs-actual so a build failure is diagnosable.
    expect(output).toMatch(/1 files/);
    expect(output).toMatch(/8 bytes/);
    expect(output).toMatch(/expected/i);
  });

  it('pins the default floor comfortably below the real bake (1106 entries / 4.25 MB)', () => {
    const script = readFileSync(WARMUP_SCRIPT, 'utf8');
    const files = script.match(/KNEXT_WARMUP_MIN_FILES:-(\d+)/);
    const bytes = script.match(/KNEXT_WARMUP_MIN_BYTES:-(\d+)/);
    if (!files || !bytes) throw new Error('warm-up must expose overridable MIN_FILES/MIN_BYTES');

    // Far above trivial…
    expect(Number(files[1])).toBeGreaterThanOrEqual(100);
    expect(Number(bytes[1])).toBeGreaterThanOrEqual(500_000);
    // …and well under the observed real values, so legitimate app-size
    // variation never fails a build that is in fact fine.
    expect(Number(files[1])).toBeLessThanOrEqual(1106 / 2);
    expect(Number(bytes[1])).toBeLessThanOrEqual(4_246_032 / 2);
  });

  it("CLEARS a pre-existing cache dir before the warm-up (freshness is the script's job, #440 item 2)", () => {
    // The plausibility floor must reflect a REAL flush of THIS build, never
    // leftover entries from a previous run. Today the runner stage happens not
    // to COPY the cache dir, but that is an inference about the Dockerfile a
    // future edit could invalidate — so the script itself must empty the dir.
    const cacheDir = mkdtempSync(join(tmpdir(), 'knext-cc-stale-'));
    // Seed a stale junk "entry" that alone would satisfy a 1-file/1-byte floor.
    const stale = join(cacheDir, 'stale.junk');
    writeFileSync(stale, 'leftover-from-a-previous-build');

    const { status, output } = runWarmup({
      cacheDir,
      bootCmd: stubServer(true), // writes a single fresh entry on SIGTERM
      port: 34377,
      env: STUB_FLOOR,
    });

    expect(status).toBe(0);
    // The stale file must be GONE — the dir was emptied before the warm-up, so
    // leftover entries can never satisfy the floor.
    expect(existsSync(stale)).toBe(false);
    // Only the freshly-flushed entry should remain.
    expect(output).toMatch(/baked 1 entries, 8 bytes/);
  });

  it('FATALs WITHOUT deleting when NODE_COMPILE_CACHE is a catastrophic path (safety guard, #440 item 2)', () => {
    // The clear step is `rm -rf "$CACHE_DIR"`, and $CACHE_DIR is attacker-shaped
    // env input, so the guard must reject `/`, a non-absolute path, and critical
    // system dirs BEFORE removing anything. A short ready-timeout keeps the
    // pre-guard (unimplemented) run fast and safe — the boot never enumerates a
    // real filesystem.
    for (const badPath of ['/', '/etc', '/usr', 'relative/dir']) {
      const { status, output } = runWarmup({
        cacheDir: badPath,
        // Never becomes ready; short timeout so if the guard is ABSENT the run
        // still exits quickly (via the ready-timeout) instead of scanning disk.
        bootCmd: nodeScript('guard-hang.js', 'setTimeout(() => {}, 60_000);\n'),
        port: 34378,
        env: { ...STUB_FLOOR, KNEXT_WARMUP_TIMEOUT_S: '2' },
      });

      expect(status).not.toBe(0);
      // Must name the guard specifically — a generic ready-timeout message means
      // the guard did not fire before the boot/clear.
      expect(output).toMatch(/refus|unsafe|critical|absolute/i);
      expect(output).not.toMatch(/not ready within/i);
    }
  });

  it('rejects a `..`-traversal path WITHOUT deleting (guard normalises segments, #440)', () => {
    // String-equality on the blocklist is defeated by traversal: `/etc/../etc`
    // is absolute, never equals a blocklist entry, yet resolves to `/etc`. The
    // guard must reject any `..` SEGMENT before the rm. Proven safe by pointing
    // at a traversal that resolves back INTO a temp dir we own: if the guard
    // regressed, the WORST it could clear is our own temp dir — never a system
    // path — and the sentinel below makes a stray delete observable.
    const base = mkdtempSync(join(tmpdir(), 'knext-cc-traverse-'));
    const real = join(base, 'real');
    mkdirSync(real);
    const sentinel = join(real, 'sentinel.keep');
    writeFileSync(sentinel, 'must-survive');

    const { status, output } = runWarmup({
      // Raw string concat, NOT path.join — join() would collapse the `..` before
      // it ever reached the script. = <base>/real/../real, resolves to <base>/real.
      cacheDir: `${real}/../real`,
      bootCmd: nodeScript('traverse-hang.js', 'setTimeout(() => {}, 60_000);\n'),
      port: 34379,
      env: { ...STUB_FLOOR, KNEXT_WARMUP_TIMEOUT_S: '2' },
    });

    expect(status).not.toBe(0);
    // Must name the `..`/traversal guard, not a generic ready-timeout.
    expect(output).toMatch(/\.\.|traversal|refus/i);
    expect(output).not.toMatch(/not ready within/i);
    // Nothing was cleared: the sentinel is still there.
    expect(existsSync(sentinel)).toBe(true);
  });

  it('FATALs on a `..`-traversal into a critical dir (defeats the blocklist bypass, #440)', () => {
    // The archetypal bypass: `/etc/../etc` → `/etc`. The guard MUST abort on the
    // `..` segment BEFORE any rm, so this never actually touches /etc. We assert
    // the FATAL message + non-zero exit only — the temp-scoped test above is the
    // one that proves "nothing deleted".
    const { status, output } = runWarmup({
      cacheDir: '/etc/../etc',
      bootCmd: nodeScript('etc-hang.js', 'setTimeout(() => {}, 60_000);\n'),
      port: 34380,
      env: { ...STUB_FLOOR, KNEXT_WARMUP_TIMEOUT_S: '2' },
    });

    expect(status).not.toBe(0);
    expect(output).toMatch(/\.\.|traversal|refus/i);
    expect(output).not.toMatch(/not ready within/i);
  });

  it('rejects a duplicate-slash path WITHOUT deleting (guard squeezes `//`, #440)', () => {
    // `//etc` is the SAME dir as `/etc` on POSIX, but string-equality on the
    // blocklist sees "//etc" != "/etc" and lets it through. The guard must
    // collapse duplicate slashes BEFORE the blocklist. Proven safe by a
    // double-slash path that resolves back into a temp dir we own.
    const base = mkdtempSync(join(tmpdir(), 'knext-cc-dslash-'));
    const sentinel = join(base, 'sentinel.keep');
    writeFileSync(sentinel, 'must-survive');

    const { status, output } = runWarmup({
      // Raw string with a leading `//` — `//<abs-temp>` is the same dir as the
      // temp path, but only the squeeze makes the guard see it that way.
      cacheDir: `/${base}`, // base already starts with '/', so this is '//…'
      bootCmd: stubServer(true), // populates the (cleared) dir on SIGTERM
      port: 34381,
      env: STUB_FLOOR,
    });

    // A '//<temp>' path is NOT a critical dir, so it is legitimately clearable —
    // the point of THIS case is only that the squeeze happens (so the blocklist
    // is applied to the canonical form). The critical-dir proof is the //etc
    // case below; here we assert the dir is cleared normally (sentinel gone) and
    // the run succeeds, proving the squeeze did not break a legit double-slash.
    expect(status).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
    expect(output).toMatch(/baked/);
  });

  it('FATALs on a `//`-duplicate-slash critical dir (defeats the blocklist bypass, #440)', () => {
    // `//etc` == `/etc`. Without the squeeze it dodges the string-equality
    // blocklist and would clear /etc. The guard MUST abort before any rm.
    const { status, output } = runWarmup({
      cacheDir: '//etc',
      bootCmd: nodeScript('dslash-etc-hang.js', 'setTimeout(() => {}, 60_000);\n'),
      port: 34382,
      env: { ...STUB_FLOOR, KNEXT_WARMUP_TIMEOUT_S: '2' },
    });

    expect(status).not.toBe(0);
    expect(output).toMatch(/critical|refus/i);
    expect(output).not.toMatch(/not ready within/i);
  });

  it('rejects a bare `.` path segment WITHOUT deleting (#440)', () => {
    const { status, output } = runWarmup({
      cacheDir: '/etc/.',
      bootCmd: nodeScript('dot-hang.js', 'setTimeout(() => {}, 60_000);\n'),
      port: 34383,
      env: { ...STUB_FLOOR, KNEXT_WARMUP_TIMEOUT_S: '2' },
    });

    expect(status).not.toBe(0);
    expect(output).toMatch(/'\.'|segment|refus/i);
    expect(output).not.toMatch(/not ready within/i);
  });

  it('happy path: a real-shaped `.next/compile-cache` dir still clears normally (#440)', () => {
    // Regression guard for the `.`-segment and squeeze checks: the REAL cache
    // path contains a hidden `.next` dir and dotted filenames, none of which is
    // a bare `.`/`..` segment or a duplicate slash — so it MUST still be cleared
    // and re-baked, not FATAL'd.
    const base = mkdtempSync(join(tmpdir(), 'knext-cc-happy-'));
    const cacheDir = join(base, '.next', 'compile-cache');
    mkdirSync(cacheDir, { recursive: true });
    const stale = join(cacheDir, 'stale.cache');
    writeFileSync(stale, 'leftover');

    const { status, output } = runWarmup({
      cacheDir,
      bootCmd: stubServer(true),
      port: 34384,
      env: STUB_FLOOR,
    });

    expect(status).toBe(0);
    // Cleared then re-baked: the stale file is gone, a fresh entry is present.
    expect(existsSync(stale)).toBe(false);
    expect(output).toMatch(/baked 1 entries, 8 bytes/);
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
