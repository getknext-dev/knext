// @vitest-environment node
//
// ADR-0042 A1 + A9 — the two claims this file exists to make falsifiable.
//
// A9: `FROM alpine` + the single binary DOES NOT RUN. bun's `-musl` targets are
// dynamically linked, so without `libstdc++`/`libgcc` the container dies with
// ~30 relocation errors and **exit 127**. ADR-0036's image row ("`FROM alpine` +
// the single binary") is wrong as written, and it was wrong for months because
// every prior validation ran the binary somewhere those libraries already
// existed — on the host, or in a base image that happened to carry them. This
// test builds the reference `Dockerfile` and runs the container, so deleting its
// `apk add --no-cache libstdc++ libgcc` line turns this suite red.
//
// A1: self-containment on the CURRENT toolchain. The container's `/app` holds
// ONLY the binary and `.output/public`; `.output/server` is asserted absent. If
// the routes were not embedded by `bun build --compile`, every app route would
// 404 — which is exactly the #460 failure the abandoned `vinext@^0.0.19` /
// `nitro@3.0.1-alpha.2` pin was introduced to dodge. Proving it here on the
// current pins is what allows that pin to be dropped.
//
// NO SKIP PATH — DELIBERATELY. This suite never checks whether docker or bun is
// "available" and adjusts: a missing prerequisite is a FAILURE. A test that
// silently passes when its runtime is absent is the anti-pattern #408 and #448
// were closed for, and this suite is the only thing standing behind the two
// findings above. It is therefore kept out of the default `bun run test` (see
// `vitest.config.ts` exclude) and run by `bun run test:image`, which the
// `bun-exec-alpine-image` CI job invokes. That wiring has its own guard:
// `tests/bun-exec-alpine-image-ci.test.ts` (removing the job reddens it).

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const EXAMPLE_DIR = resolve(__dirname, '..');
const TOKEN = 'alpine-e2e-token';
// UNIQUE per run. A fixed name plus the `docker rm --force` below meant two
// concurrent runs — two git worktrees, which this repo's workflow actively
// encourages — killed each other's container mid-probe and reported it as an A9
// failure. The container is removed in afterAll, so unique names do not leak.
const CONTAINER = `knext-bunexec-alpine-e2e-${randomBytes(4).toString('hex')}`;

/** Build for the host's own architecture — emulation is minutes, native is seconds. */
const ARCH = process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
const PLATFORM = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
const BINARY = `knext-bun-exec-${ARCH}`;
const IMAGE = `knext-bunexec-alpine-e2e:${ARCH}`;

function run(cmd: string, args: string[], opts: { timeout?: number } = {}) {
  return spawnSync(cmd, args, {
    cwd: EXAMPLE_DIR,
    encoding: 'utf8',
    timeout: opts.timeout ?? 600_000,
  });
}

/** An OS-assigned free port, so concurrent runs cannot collide. */
async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => res(port));
    });
  });
}

let appPort = 0;
let metricsPort = 0;

beforeAll(async () => {
  // 1. Prerequisites are REQUIRED, never skipped around.
  const docker = run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 60_000 });
  if (docker.status !== 0) {
    throw new Error(
      `docker is required by this suite and is not usable: ${docker.stderr || docker.error?.message}`,
    );
  }

  // 2. The binary under test — built UNCONDITIONALLY, every run.
  //
  //    This used to reuse an existing binary, which quietly contradicted the
  //    claim it exists to support. A1's entire content is "the CURRENT toolchain
  //    is self-contained", and `knext-bun-exec-*` is gitignored, so it survives
  //    branch switches: a reviewer reproducing A1 with a binary left over from
  //    the `vinext@0.0.19` pin would have got a green "beta.4 is self-contained"
  //    run without beta.4 ever being built. `.output/public` is equally stale,
  //    and `build.sh` regenerates both. The reuse saved seconds and could
  //    validate the wrong artifact, so it is gone.
  const build = run('./build.sh', [ARCH]);
  if (build.status !== 0) {
    throw new Error(`./build.sh ${ARCH} failed:\n${build.stdout}\n${build.stderr}`);
  }
  expect(existsSync(resolve(EXAMPLE_DIR, BINARY)), `${BINARY} was not produced`).toBe(true);
  expect(
    existsSync(resolve(EXAMPLE_DIR, '.output/public')),
    '.output/public missing — the binary ships WITH the static-asset dir',
  ).toBe(true);

  // 3. The reference image.
  const image = run('docker', [
    'build',
    '--platform',
    PLATFORM,
    '--build-arg',
    `BINARY=${BINARY}`,
    '--tag',
    IMAGE,
    '.',
  ]);
  if (image.status !== 0) {
    throw new Error(`docker build failed:\n${image.stdout}\n${image.stderr}`);
  }

  // 4. Run it. Any prior container from an aborted run is cleared first.
  run('docker', ['rm', '--force', CONTAINER], { timeout: 60_000 });
  appPort = await freePort();
  metricsPort = await freePort();
  const started = run(
    'docker',
    [
      'run',
      '--detach',
      '--name',
      CONTAINER,
      '--platform',
      PLATFORM,
      '--publish',
      `${appPort}:3000`,
      '--publish',
      `${metricsPort}:9091`,
      '--env',
      `CACHE_INVALIDATE_TOKEN=${TOKEN}`,
      IMAGE,
    ],
    { timeout: 120_000 },
  );
  if (started.status !== 0) {
    throw new Error(`docker run failed:\n${started.stdout}\n${started.stderr}`);
  }

  // 5. Wait for the app to answer. THIS is where the missing-libstdc++ failure
  //    surfaces, so the error carries the container's logs and exit code — the
  //    difference between "test timed out" and "exit 127, relocation errors".
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${appPort}/api/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    // A died container will never start listening, so do not wait out the
    // deadline for it — the A9 failure (exit 127) is exactly this case.
    const running = run('docker', ['inspect', CONTAINER, '--format', '{{.State.Running}}'], {
      timeout: 60_000,
    });
    const died = running.status === 0 && running.stdout.trim() === 'false';
    if (died || Date.now() > deadline) {
      const logs = run('docker', ['logs', CONTAINER], { timeout: 60_000 });
      const code = run('docker', ['inspect', CONTAINER, '--format', '{{.State.ExitCode}}'], {
        timeout: 60_000,
      });
      throw new Error(
        `the container never served /api/health (${died ? 'it exited' : 'timed out'}).\n` +
          `exit code: ${code.stdout.trim()}\n` +
          `logs:\n${logs.stdout}\n${logs.stderr}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}, 900_000);

afterAll(() => {
  run('docker', ['rm', '--force', CONTAINER], { timeout: 60_000 });
});

describe('A9 — the compiled binary runs from a clean alpine image', () => {
  it('is still running, with no dynamic-linker failure in its logs', () => {
    const state = run('docker', ['inspect', CONTAINER, '--format', '{{.State.Running}}'], {
      timeout: 60_000,
    });
    expect(state.stdout.trim(), 'the container is not running').toBe('true');

    const logs = run('docker', ['logs', CONTAINER], { timeout: 60_000 });
    const combined = `${logs.stdout}${logs.stderr}`;
    // The exact A9 failure signature. Present ⇒ the image lacks libstdc++/libgcc.
    expect(combined).not.toMatch(/Error loading shared library/);
    expect(combined).not.toMatch(/Error relocating/);
    expect(combined, 'the entry never reported both listeners bound').toMatch(
      /LISTENING:\d+ METRICS:\d+/,
    );
  });

  it('bakes the C++ runtime libraries into the image', () => {
    // Direct, not inferential: the musl bun binary links these at load time.
    const ldd = run('docker', ['run', '--rm', '--platform', PLATFORM, IMAGE, 'ls', '/usr/lib'], {
      timeout: 120_000,
    });
    expect(ldd.stdout, 'libstdc++.so.6 is not in the image').toMatch(/libstdc\+\+\.so\.6/);
    expect(ldd.stdout, 'libgcc_s.so.1 is not in the image').toMatch(/libgcc_s\.so\.1/);
  });
});

describe('A1 — self-contained on the current vinext/vite pins', () => {
  it('ships ONLY the binary and .output/public — no .output/server', () => {
    const ls = run('docker', ['exec', CONTAINER, 'ls', '-A', '/app', '/app/.output'], {
      timeout: 60_000,
    });
    expect(ls.status, `ls failed: ${ls.stderr}`).toBe(0);
    expect(ls.stdout).toMatch(/\bserver\b/); // /app/server, the binary
    expect(ls.stdout).toMatch(/public/);
    // The #460 regression shape: a runtime-chunked server shipped alongside the
    // binary would make every assertion below pass for the WRONG reason.
    const outputEntries = ls.stdout.split('/app/.output:')[1] ?? '';
    expect(outputEntries.trim(), '.output/server is present — routes are not embedded').toBe(
      'public',
    );
  });

  it('serves an SSR page', async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('knext bun-exec sample');
  });

  it('serves a route handler', async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', target: 'bun-exec' });
  });

  it('SERVES a static asset out of .output/public', async () => {
    // The ship shape is binary + `.output/public`, so "does it serve statics" is
    // half the claim — and nothing tested it. Dropping the `COPY .output/public`
    // line, or a regression where the binary stops serving that directory, left
    // every other assertion green: `GET /` still returns the SSR text, it just
    // arrives with no JS and no hydration.
    //
    // The asset is discovered from the page's own <script src>, not hardcoded:
    // the filenames are content-hashed, and asserting on the URL the page
    // actually asks the browser to load is what makes this a hydration check
    // rather than a file-exists check.
    const html = await (await fetch(`http://127.0.0.1:${appPort}/`)).text();
    const src = html.match(/<script[^>]+src="(\/_next\/static\/[^"]+\.js)"/)?.[1];
    expect(src, 'the SSR page referenced no /_next/static script to load').toBeTruthy();

    const asset = await fetch(`http://127.0.0.1:${appPort}${src}`);
    expect(asset.status, `the page's own module ${src} is not served`).toBe(200);
    expect(asset.headers.get('content-type') ?? '').toMatch(/javascript/);
    // Non-vacuity: a 200 with an empty or error body would satisfy the above.
    expect((await asset.text()).length).toBeGreaterThan(100);
  });

  it('serves a dynamic page and binds its param', async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/item/42`);
    expect(res.status).toBe(200);
    // React splits `item:{id}` across text nodes, hence the comment marker.
    expect(await res.text()).toContain('item:<!-- -->42');
  });

  it('serves a dynamic route handler and binds its param', async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/api/echo/hello`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: 'hello' });
  });

  it('answers 404 for an unknown route', async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/definitely-not-a-route`);
    expect(res.status).toBe(404);
  });

  it('keeps the mutating endpoint fail-closed and the metrics port live', async () => {
    const denied = await fetch(`http://127.0.0.1:${appPort}/api/cache/invalidate`, {
      method: 'POST',
    });
    expect(denied.status, 'POST /api/cache/invalidate is not fail-closed').toBe(401);

    const allowed = await fetch(`http://127.0.0.1:${appPort}/api/cache/invalidate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(allowed.status).toBe(200);

    const metrics = await fetch(`http://127.0.0.1:${metricsPort}/metrics`);
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toMatch(/^# HELP /m);
  });
});
