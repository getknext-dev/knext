import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * #1225 shipped `turbopack × bun` as a `bun build --compile --bytecode`
 * executable of the standalone server (adapters/standalone-compile.mjs) — that
 * is what the image actually boots (Dockerfile.standalone.hbs COPYs
 * `knext-standalone-exec-linux-x64`), not `bun server.js`. Before this change
 * `scripts/e2e-deploy.sh`'s bun lane still boot-tested the UNCOMPILED script,
 * so the official 778-test suite had never run against the artifact that
 * ships.
 *
 * `bun-linux-x64-musl` is dynamically linked against musl — it CANNOT execute
 * on the bare glibc `ubuntu-latest` runner at all (see
 * `packages/kn-next/src/cli/vinext-build.ts`'s `LinuxLibc` note, and #894's
 * post-compile smoke, which compiles a SEPARATE glibc twin for exactly this
 * reason). So the exec must be booted inside the SAME musl base image the
 * product ships (`Dockerfile.standalone.hbs`'s `standalone-bun` stage), never
 * bare on the runner and never against a glibc-target twin (that would
 * certify a binary nothing ships).
 *
 * Source-contract test (same style as `compat-bun-lane-lockstep.test.ts`):
 * asserts the deploy script's bun-lane boot path compiles the standalone
 * executable via the shipped compile script and boots it inside the pinned
 * alpine image, with no fallback path silently wired to a boot that would
 * either crash (bare exec on the runner) or certify the wrong artifact (a
 * glibc twin). Mutation-proved on the REAL `scripts/e2e-deploy.sh` (not a
 * scratch copy): each assertion below was verified to fail after reverting
 * its anchor and to pass again after restoring the file.
 */

const REPO_ROOT = resolve(import.meta.dir, '..');
const DEPLOY_SH_PATH = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');
const DOCKERFILE_PATH = resolve(
  REPO_ROOT,
  'packages/kn-next/templates/runtime-standalone/Dockerfile.standalone.hbs',
);
const NATIVE_REBUILD_SH_PATH = resolve(REPO_ROOT, 'scripts/e2e-native-rebuild-musl.sh');
const src = readFileSync(DEPLOY_SH_PATH, 'utf8');

const SECTION_START = '# ── 3b. compile the standalone-on-Bun bytecode executable';
const SECTION_END = '# ── 3d. bake the V8 compile cache';

/**
 * BEHAVIOUR, not text. Rounds 1–10 tried to prove "the rebuild `docker run`
 * mounts STANDALONE_ROOT before the image" by tokenising the script like bash,
 * and every round lost to a shell semantic the tokenizer did not model (a
 * `: \` line turning the whole command into arguments of `:`, a trailing `&`
 * backgrounding it, `${X:+…}`, `$(…)`, `<(…)`, …). This runs the REAL section
 * of `scripts/e2e-deploy.sh` (from the 3b marker to the 3d marker) under
 * `bash -e` with stub `docker`/`bun` first on PATH, and asserts what the stub
 * OBSERVED: however the text is spelled, bash either executed a docker with
 * these argv, synchronously, or it did not.
 */
function runCompileSection(
  script: string,
  dockerStub: 'ok' | 'fail',
): {
  status: number | null;
  out: string;
  dockerCalls: string[][];
  finishedBeforeExit: boolean;
  reachedEnd: boolean;
  root: string;
  scriptDir: string;
} {
  const start = script.indexOf(SECTION_START);
  const end = script.indexOf(SECTION_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error('the 3b/3d section markers are missing from scripts/e2e-deploy.sh');
  }
  const section = script.slice(start, end);
  const tmp = mkdtempSync(join(tmpdir(), 'bun-lane-'));
  try {
    const bin = join(tmp, 'bin');
    const rec = join(tmp, 'rec');
    const adapter = join(tmp, 'adapter');
    const app = join(tmp, 'app');
    const scriptDir = join(tmp, 'scripts');
    const standaloneApp = join(app, '.next', 'standalone', 'pkg');
    for (const d of [bin, rec, adapter, standaloneApp, scriptDir]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(adapter, 'standalone-compile.js'), '');
    // #1620: the section sources the REAL lockfile-lookup lib to derive its
    // lockfile mounts; this tree has no *.node files, so it derives none.
    mkdirSync(join(scriptDir, 'lib'), { recursive: true });
    writeFileSync(
      join(scriptDir, 'lib', 'musl-lockfile-lookup.sh'),
      readFileSync(join(REPO_ROOT, 'scripts/lib/musl-lockfile-lookup.sh'), 'utf8'),
    );
    const stub = (name: string, body: string) => {
      const p = join(bin, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
    };
    stub('bun', 'exit 0');
    stub(
      'docker',
      [
        'echo x >> "$REC/calls"',
        `printf '%s\\n' "$@" > "$REC/argv.$$"`,
        'sleep 0.4', // a backgrounded docker would still be running when the script exits
        dockerStub === 'ok' ? 'touch "$REC/finished"; exit 0' : 'exit 1',
      ].join('\n'),
    );
    const root = join(app, '.next', 'standalone');
    const wrapper = [
      'set -euo pipefail',
      'log() { echo "[t] $*" >&2; }',
      'RUNTIME=bun',
      `APP_DIR='${app}'`,
      `SERVER_JS='${join(standaloneApp, 'server.js')}'`,
      `STANDALONE_APP_DIR='${standaloneApp}'`,
      `SCRIPT_DIR='${scriptDir}'`,
      `NEXT_ADAPTER_PATH='${join(adapter, 'index.js')}'`,
      'KNEXT_COMPAT_MODE=credential',
      section,
      'echo BLOCK_DONE',
    ].join('\n');
    const wrapperPath = join(tmp, 'wrapper.sh');
    writeFileSync(wrapperPath, wrapper);
    const r = spawnSync('bash', [wrapperPath], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REC: rec },
      encoding: 'utf8',
    });
    const dockerCalls = readdirSync(rec)
      .filter((n) => n.startsWith('argv.'))
      .map((n) => readFileSync(join(rec, n), 'utf8').split('\n').slice(0, -1));
    return {
      status: r.status,
      out: `${r.stdout}\n${r.stderr}`,
      dockerCalls,
      finishedBeforeExit: existsSync(join(rec, 'finished')),
      reachedEnd: r.stdout.includes('BLOCK_DONE'),
      root,
      scriptDir,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('scripts/e2e-deploy.sh — bun lane boots the compiled standalone exec (#1166/#1225)', () => {
  it('compiles the standalone server via the shipped standalone-compile script', () => {
    expect(
      /bun run "\$\{STANDALONE_COMPILE_JS\}"/.test(src),
      'the bun lane must invoke standalone-compile.js (the SAME script kn-next build uses), not reimplement the compile',
    ).toBe(true);
    expect(
      src.includes('standalone-compile.js'),
      'the compile script must be resolved from the installed adapter package (dist/adapters/standalone-compile.js)',
    ).toBe(true);
  });

  it('passes --target bun-linux-x64-musl (the shipped image target, not the runner-native glibc build)', () => {
    expect(/--target bun-linux-x64-musl/.test(src)).toBe(true);
  });

  it('generates a fresh per-build marker so the bytecode proof cannot pass against a stale/foreign binary', () => {
    expect(/MARKER="knext-standalone-exec:/.test(src)).toBe(true);
    expect(/--marker "\$\{MARKER\}"/.test(src)).toBe(true);
  });

  it('records STANDALONE_EXEC', () => {
    expect(
      src.includes('STANDALONE_EXEC="${STANDALONE_APP_DIR}/knext-standalone-exec-linux-x64"'),
    ).toBe(true);
  });

  it('requires docker on PATH before compiling — a musl exec with no runnable base FAILS LOUD, never falls back to server.js', () => {
    const compileBlock = src.slice(
      src.indexOf('# ── 3b. compile the standalone-on-Bun bytecode executable'),
      src.indexOf('# ── 4. boot the standalone server on a free port'),
    );
    expect(
      /command -v docker >\/dev\/null 2>&1/.test(compileBlock),
      'the compile step must check for docker (the musl exec cannot boot bare on this glibc runner)',
    ).toBe(true);
    // The docker-missing AND compile-script-missing branches must each `exit
    // 1` — no path through this block may leave STANDALONE_EXEC empty while
    // RUNTIME=bun and the debug lane is off (that would silently boot
    // server.js instead of failing loud).
    const dockerMissingBranch = compileBlock.slice(compileBlock.indexOf('if ! command -v docker'));
    expect(/exit 1/.test(dockerMissingBranch.split('\n').slice(0, 4).join('\n'))).toBe(true);
    expect(
      /standalone-compile script not found[\s\S]{0,300}exit 1/.test(compileBlock),
      'a missing compile script must exit 1, not warn-and-fallback',
    ).toBe(true);
  });

  it('boots the exec INSIDE the pinned musl image via docker run --network host, not bare on the runner', () => {
    const bootBlock = src.slice(src.indexOf('if [ -n "${STANDALONE_EXEC}" ]; then'));
    expect(/exec docker run --rm --name "\$\{CONTAINER_NAME\}"/.test(bootBlock)).toBe(true);
    expect(/--network host/.test(bootBlock)).toBe(true);
    expect(
      /"\$\{STANDALONE_BUN_IMAGE\}"/.test(bootBlock),
      'must boot inside STANDALONE_BUN_IMAGE, the pinned alpine base — not the bare runner',
    ).toBe(true);
    // No `-r` preload flags, no SERVER_CMD interpreter prefix — baked into
    // the compiled entry (unlike the uncompiled server.js boot below it).
    expect(
      /-r "\$\{KNEXT_CC_PRELOAD\}"[\s\S]{0,400}"\$\{STANDALONE_BUN_IMAGE\}"/.test(bootBlock),
    ).toBe(false);
  });

  it("the image pin is BYTE-IDENTICAL to Dockerfile.standalone.hbs's standalone-bun FROM line (lockstep)", () => {
    const pinMatch = src.match(/STANDALONE_BUN_IMAGE="([^"]+)"/);
    expect(pinMatch, 'scripts/e2e-deploy.sh must define STANDALONE_BUN_IMAGE').not.toBeNull();
    const pin = (pinMatch as RegExpMatchArray)[1];
    const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8');
    expect(
      dockerfile.includes(`FROM ${pin} AS standalone-bun`),
      `Dockerfile.standalone.hbs's standalone-bun stage must FROM the exact same pin (${pin}) — a bump to either alone silently diverges what CI credentials from what ships`,
    ).toBe(true);
  });

  it('skips the compile (boots the uncompiled server.js on purpose) under the sandbox-fetch-debug instrumentation lane', () => {
    const compileBlock = src.slice(
      src.indexOf('# ── 3b. compile the standalone-on-Bun bytecode executable'),
      src.indexOf('# ── 4. boot the standalone server on a free port'),
    );
    expect(
      /\[ "\$\{RUNTIME\}" = "bun" \] && \[ "\$\{KNEXT_SANDBOX_FETCH_DEBUG:-0\}" != "1" \]/.test(
        compileBlock,
      ),
      'the compile step must be gated OFF when KNEXT_SANDBOX_FETCH_DEBUG=1 (that path chain-requires server.js as text, incompatible with a compiled binary)',
    ).toBe(true);
  });

  it('the node lane never sets STANDALONE_EXEC (metadata + boot command stay byte-identical)', () => {
    const compileGuardLine = src
      .split('\n')
      .find((l) =>
        l.includes('if [ "${RUNTIME}" = "bun" ] && [ "${KNEXT_SANDBOX_FETCH_DEBUG:-0}" != "1" ]'),
      );
    expect(compileGuardLine).toBeDefined();
  });

  it('the port-ownership check uses OWNER_PID (resolved via docker inspect for the compiled exec), not the docker CLIENT pid', () => {
    // `--network host` means the docker CLIENT process (SERVER_PID) never
    // itself holds the listening socket — the containerized process does,
    // under a DIFFERENT host pid. Without this the #171 TOCTOU guard would
    // refuse every healthy bun-lane deployment (SERVER_PID would never match
    // the real listener).
    expect(src.includes('docker inspect -f \'{{.State.Pid}}\' "${CONTAINER_NAME}"')).toBe(true);
    expect(/pid=\$\{OWNER_PID\},/.test(src)).toBe(true);
    expect(/-a -p "\$\{OWNER_PID\}"/.test(src)).toBe(true);
  });

  describe('the musl native-addon rebuild `docker run` — observed by running the real section (#1257)', () => {
    const IMAGE_PIN = (src.match(/STANDALONE_BUN_IMAGE="([^"]+)"/) as RegExpMatchArray)[1];

    it('invokes docker exactly once, synchronously, with STANDALONE_ROOT mounted BEFORE the pinned image and the rebuild script after it', () => {
      const r = runCompileSection(src, 'ok');
      expect(r.status, r.out).toBe(0);
      expect(r.reachedEnd, r.out).toBe(true);
      expect(r.dockerCalls.length, 'docker must be invoked exactly once').toBe(1);
      expect(r.finishedBeforeExit, 'docker must have COMPLETED before the script exited').toBe(
        true,
      );
      const argv = r.dockerCalls[0];
      expect(argv.slice(0, 2)).toEqual(['run', '--rm']);
      const imageIdx = argv.indexOf(IMAGE_PIN);
      expect(imageIdx, 'the pinned image ref must be an argument').toBeGreaterThan(-1);
      const before = argv.slice(0, imageIdx);
      const mounts = before.flatMap((w, i) => (w === '-v' ? [before[i + 1]] : []));
      expect(
        mounts.filter((m) => m === `${r.root}:${r.root}`).length,
        'STANDALONE_ROOT mounted once',
      ).toBe(1);
      expect(
        mounts.filter((m) =>
          m.startsWith(`${r.scriptDir}/e2e-native-rebuild-musl.sh:/e2e-native-rebuild-musl.sh`),
        ).length,
        'the rebuild script mounted once',
      ).toBe(1);
      expect(before).toContain('KNEXT_COMPAT_MODE=credential');
      expect(argv.slice(imageIdx + 1)).toEqual([
        'sh',
        '/e2e-native-rebuild-musl.sh',
        r.root,
        '/musl-native-lockfiles',
      ]);
    });

    it('a failing docker fails the section (set -e propagates; nothing after it runs)', () => {
      const r = runCompileSection(src, 'fail');
      expect(r.dockerCalls.length).toBe(1);
      expect(r.status).not.toBe(0);
      expect(r.reachedEnd).toBe(false);
    });
  });

  it('e2e-native-rebuild-musl.sh is a fast no-op when the standalone tree has no native addons', () => {
    const rebuildSrc = readFileSync(NATIVE_REBUILD_SH_PATH, 'utf8');
    expect(/find "\$\{ROOT\}" -name '\*\.node' -type f/.test(rebuildSrc)).toBe(true);
    expect(
      /if \[ -z "\$\{HITS\}" \]; then\s*\n\s*echo[\s\S]{0,80}nothing to rebuild[\s\S]{0,20}exit 0/.test(
        rebuildSrc,
      ),
      'an empty scan must exit 0 immediately, before apk add (the fast path for the overwhelming majority of fixtures)',
    ).toBe(true);
  });

  it('e2e-native-rebuild-musl.sh is best-effort per package (a rebuild failure warns, never aborts the whole script)', () => {
    const rebuildSrc = readFileSync(NATIVE_REBUILD_SH_PATH, 'utf8');
    expect(/^set -eu$/m.test(rebuildSrc)).toBe(true);
    // #1257 round 7 — the fresh-install branch now lives inside an `else`
    // (the pinned-lockfile `npm ci` branch runs first when a committed
    // lockfile matches), and the install itself runs via `run_as_builder`
    // (su-exec'd to the unprivileged `builder` user) rather than directly
    // as root.
    expect(
      /if ! \(cd "\$\{PKG_SCRATCH\}" && run_as_builder env npm_config_build_from_source=true npm install --no-save --no-audit --no-fund "\$\{NAME\}@\$\{VERSION\}"/.test(
        rebuildSrc,
      ),
      'a per-package fresh-install failure must be caught (the `if !` guard), not let a failing `npm install` kill the whole script under set -e',
    ).toBe(true);
  });

  it('e2e-native-rebuild-musl.sh forces build-from-source (round-4 review finding, live CI evidence run 35862123588 — an unforced install can silently fetch a GLIBC prebuilt and reproduce the exact dlopen error)', () => {
    const rebuildSrc = readFileSync(NATIVE_REBUILD_SH_PATH, 'utf8');
    expect(
      /npm_config_build_from_source=true npm install/.test(rebuildSrc),
      'the fresh install must force build-from-source — sqlite3\'s node-pre-gyp does not check libc when picking a prebuilt, so an unforced install can "succeed" with a glibc binary on a well-connected runner even though it fails-over to source on a network-restricted one',
    ).toBe(true);
  });

  it('e2e-native-rebuild-musl.sh fresh-installs the package (not an in-place rebuild) — the traced tree lacks install-time tooling like node-pre-gyp (round-2 regression, #1230)', () => {
    const rebuildSrc = readFileSync(NATIVE_REBUILD_SH_PATH, 'utf8');
    // The round-1 shape (`npm run install --if-present` INSIDE the traced
    // package dir) must be gone — that is exactly what died with
    // `sh: node-pre-gyp: not found` on a real traced tree.
    expect(rebuildSrc.includes('npm run install --if-present')).toBe(false);
    expect(
      /NAME="\$\(node -e/.test(rebuildSrc) && /VERSION="\$\(node -e/.test(rebuildSrc),
      'must read {name, version} from the TRACED package.json to resolve the exact fresh-install spec',
    ).toBe(true);
  });

  it("e2e-native-rebuild-musl.sh carries along the fresh install's OTHER node_modules entries, not just the named package (sqlite3 requires node-pre-gyp at RUNTIME, traced but without its .bin shim)", () => {
    const rebuildSrc = readFileSync(NATIVE_REBUILD_SH_PATH, 'utf8');
    expect(
      /for sibling in "\$\{PKG_SCRATCH\}\/node_modules"\/\*; do/.test(rebuildSrc),
      'must iterate every sibling the fresh install produced (e.g. node-pre-gyp), not copy only ${NAME}',
    ).toBe(true);
    expect(
      /cp -a "\$\{sibling\}" "\$\{ROOT\}\/node_modules\/\$\{sibling_name\}"/.test(rebuildSrc),
      'siblings must land at ROOT/node_modules (where node module resolution walks up to from inside the package dir), not be silently dropped',
    ).toBe(true);
  });

  it("e2e-native-rebuild-musl.sh does NOT overwrite a sibling already present in the traced tree (round-3 review finding — the app's own resolved version, e.g. semver/tar/rc/minimist, must survive)", () => {
    const rebuildSrc = readFileSync(NATIVE_REBUILD_SH_PATH, 'utf8');
    // The copy must be gated on the sibling being ABSENT from
    // ${ROOT}/node_modules — an unconditional overwrite would silently
    // replace whatever version the app itself built with.
    expect(
      /if \[ -e "\$\{ROOT\}\/node_modules\/\$\{sibling_name\}" \]; then/.test(rebuildSrc),
      "the sibling copy must be guarded by an existence check against ROOT/node_modules — present siblings are the app's own resolved dependency tree and must not be overwritten",
    ).toBe(true);
    // The unconditional `rm -rf ... ; cp -a` shape from round 2 must be
    // gone from this loop — `cp -a` alone (no `rm -rf` immediately before
    // it inside the sibling loop) confirms nothing pre-emptively deletes an
    // existing traced sibling before checking whether to keep it.
    const siblingLoop = rebuildSrc.slice(
      rebuildSrc.indexOf('for sibling in "${PKG_SCRATCH}/node_modules"/*; do'),
    );
    expect(
      /rm -rf "\$\{ROOT\}\/node_modules\/\$\{sibling_name\}"/.test(siblingLoop),
      'the sibling loop must never rm -rf a traced sibling unconditionally — only skip-if-present, never delete-then-maybe-restore',
    ).toBe(false);
  });

  it('boots the exec as the invoking (non-root) user, not root — otherwise the pid-attribution check cannot see the socket owner (round-6 review finding, live CI evidence run 35868561131, shard 7)', () => {
    // `docker run` with no `--user` boots as root; the CI runner user calling
    // `ss -ltnp` then cannot see PID/process detail for a different-uid
    // socket (kernel sock_diag same-uid visibility), so
    // `port_owned_by_server` silently degraded to "cannot verify" on every
    // compiled-exec deploy. `--user "$(id -u):$(id -g)"` also prevents the
    // container from leaving root-owned files on the runner's filesystem.
    const bootBlock = src.slice(src.indexOf('if [ -n "${STANDALONE_EXEC}" ]; then'));
    expect(
      /--network host \\\s*\n\s*--user "\$\(id -u\):\$\(id -g\)" \\/.test(bootBlock),
      'the boot docker run must pass --user "$(id -u):$(id -g)" so the containerized process runs under the invoking uid, not root',
    ).toBe(true);
  });

  it('e2e-native-rebuild-musl.sh sends apk output to stderr, not /dev/null (round-6 review finding — set -eu gave an opaque abort on an apk failure)', () => {
    const rebuildSrc = readFileSync(NATIVE_REBUILD_SH_PATH, 'utf8');
    // #1257 round 7 — `su-exec` joined the apk package list (needed to drop
    // root before any install-time code runs); the stdout-only-silenced
    // shape this test protects is otherwise unchanged.
    expect(
      /apk add --no-cache python3~3\.12 make~4\.4 g\+\+~14\.2 npm~11\.6 nodejs~22\.23 su-exec~0\.2 >\/dev\/null$/m.test(
        rebuildSrc,
      ),
      'apk stdout may still be silenced, but stderr must flow (no trailing 2>&1 redirecting it into /dev/null too) so a failure under set -eu is diagnosable',
    ).toBe(true);
    expect(
      rebuildSrc.includes(
        'apk add --no-cache python3~3.12 make~4.4 g++~14.2 npm~11.6 nodejs~22.23 su-exec~0.2 >/dev/null 2>&1',
      ),
      'the old shape swallowed BOTH streams — must be gone',
    ).toBe(false);
  });

  it('e2e-native-rebuild-musl.sh refuses to treat ROOT (or anything outside node_modules) as an addon package (round-6 review finding — dependency-confusion / destructive rm -rf on a walk-up that lands on the standalone root)', () => {
    const rebuildSrc = readFileSync(NATIVE_REBUILD_SH_PATH, 'utf8');
    expect(
      rebuildSrc.includes('if [ "${d}" = "${ROOT}" ]; then'),
      "must refuse to walk up past ROOT and treat ROOT's own package.json (Next's tracer emits one) as an addon package",
    ).toBe(true);
    expect(
      /\*\)\s*\n\s*echo "\[native-rebuild\] WARNING: \$\{d\} is not nested under node_modules\/ /.test(
        rebuildSrc,
      ),
      'must also refuse any owning dir NOT nested under node_modules/ — a case-pattern guard, not just the ROOT-equality check',
    ).toBe(true);
    expect(
      /\*\/node_modules\/\*\)\s*:\s*;;/.test(rebuildSrc),
      'the accept branch must explicitly match */node_modules/*',
    ).toBe(true);
  });

  it('e2e-native-rebuild-musl.sh maps the glibc-only @img/sharp-linux-* platform package to its musl counterpart, plus the separately-versioned libvips sibling (round-6 review finding — sharp/next-image fixtures ran with a sharp that could not load under musl)', () => {
    const rebuildSrc = readFileSync(NATIVE_REBUILD_SH_PATH, 'utf8');
    expect(
      rebuildSrc.includes('musl_install_sibling()'),
      'must define a reusable helper to fresh-install a NEW sibling package (sharp has no from-source fallback, unlike sqlite3)',
    ).toBe(true);
    expect(
      /@img\/sharp-linux-\*\)/.test(rebuildSrc),
      'must special-case the @img/sharp-linux-* platform package name',
    ).toBe(true);
    expect(
      rebuildSrc.includes('MUSL_NAME="@img/sharp-linuxmusl-${NAME#@img/sharp-linux-}"'),
      'must derive the musl counterpart name from the glibc name, not hardcode one arch',
    ).toBe(true);
    expect(
      rebuildSrc.includes('@img/sharp-libvips-linuxmusl-'),
      'must also install the libvips shared-library sibling — sharp 0.34.x pins a DIFFERENT version number for libvips than for itself, so it cannot be derived from ${VERSION}',
    ).toBe(true);
  });

  it('appends a boot-mode ledger line per deploy — the positive proof the compiled exec booted (#1230 review finding)', () => {
    expect(src.includes('BOOT_MODE_LEDGER="${RUNNER_TEMP:-/tmp}/knext-e2e-boot-modes.log"')).toBe(
      true,
    );
    expect(
      /echo "mode=compiled-exec runtime=\$\{RUNTIME\} image=\$\{STANDALONE_BUN_IMAGE\} bytecode_verified=true" >>"\$\{BOOT_MODE_LEDGER\}"/.test(
        src,
      ),
      'a compiled-exec deploy must append a compiled-exec line to the ledger',
    ).toBe(true);
    expect(
      /echo "mode=server-js runtime=\$\{RUNTIME\} image=- bytecode_verified=-" >>"\$\{BOOT_MODE_LEDGER\}"/.test(
        src,
      ),
      'an uncompiled (server.js) deploy must append a server-js line to the ledger — so the workflow check can positively tell the two apart',
    ).toBe(true);
  });

  it('mutation proof: reverting the compile/boot/ownership anchors reds the suite above', () => {
    const mutated = src
      .replace('bun run "${STANDALONE_COMPILE_JS}"', 'bun run "${SOMETHING_ELSE}"')
      .replace('--target bun-linux-x64-musl', '--target host')
      .replace(
        'STANDALONE_EXEC="${STANDALONE_APP_DIR}/knext-standalone-exec-linux-x64"',
        'STANDALONE_EXEC=""',
      )
      .replace(
        'exec docker run --rm --name "${CONTAINER_NAME}" \\\n      --network host \\',
        'exec "${SERVER_BOOT_TARGET}" # mutated: bare boot, no container',
      );
    expect(/bun run "\$\{STANDALONE_COMPILE_JS\}"/.test(mutated)).toBe(false);
    expect(/--target bun-linux-x64-musl/.test(mutated)).toBe(false);
    expect(
      mutated.includes('STANDALONE_EXEC="${STANDALONE_APP_DIR}/knext-standalone-exec-linux-x64"'),
    ).toBe(false);
    expect(/exec docker run --rm --name "\$\{CONTAINER_NAME\}"/.test(mutated)).toBe(false);
  });
});
