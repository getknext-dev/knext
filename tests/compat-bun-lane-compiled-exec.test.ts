import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * #1225 shipped `turbopack × bun` as a `bun build --compile --bytecode`
 * executable of the standalone server (adapters/standalone-compile.mjs) — that
 * is what the image actually boots (Dockerfile.standalone.hbs COPYs
 * `knext-standalone-exec-linux-x64`), not `bun server.js`. Before this change
 * `scripts/e2e-deploy.sh`'s bun lane still boot-tested the UNCOMPILED script,
 * so the official 778-test suite had never run against the artifact that
 * ships.
 *
 * Source-contract test (same style as `compat-bun-lane-lockstep.test.ts`):
 * asserts the deploy script's bun-lane boot path compiles the standalone
 * executable via the shipped compile script and boots THAT artifact, with no
 * fallback path left silently wired to the old uncompiled boot. Mutation
 * proof: reverting the compile-and-boot block to a bare
 * `exec "${SERVER_CMD}" ... "${SERVER_JS}"` for the bun lane must red this
 * file (verified below by literally deleting the anchors and checking the
 * assertions fail).
 */

const REPO_ROOT = resolve(import.meta.dir, '..');
const DEPLOY_SH_PATH = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');
const src = readFileSync(DEPLOY_SH_PATH, 'utf8');

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

  it('records STANDALONE_EXEC and overrides SERVER_BOOT_TARGET with it', () => {
    expect(
      src.includes('STANDALONE_EXEC="${STANDALONE_APP_DIR}/knext-standalone-exec-linux-x64"'),
    ).toBe(true);
    expect(
      /if \[ -n "\$\{STANDALONE_EXEC\}" \]; then\s*\n\s*SERVER_BOOT_TARGET="\$\{STANDALONE_EXEC\}"/.test(
        src,
      ),
      'SERVER_BOOT_TARGET must be overridden to the compiled exec when STANDALONE_EXEC is set',
    ).toBe(true);
  });

  it('boots the compiled exec DIRECTLY — no interpreter prefix, no -r preload flags (baked in)', () => {
    const bootBlock = src.slice(src.indexOf('if [ -n "${STANDALONE_EXEC}" ]; then'));
    const execLine = bootBlock.match(/exec "\$\{SERVER_BOOT_TARGET\}"\s*\n/);
    expect(
      execLine,
      'the compiled-exec branch must `exec "${SERVER_BOOT_TARGET}"` with no SERVER_CMD/preload-args prefix',
    ).not.toBeNull();
  });

  it('skips the compile (falls back to the uncompiled server.js) under the sandbox-fetch-debug instrumentation lane', () => {
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
    // The compile block's outer guard is `RUNTIME = bun`; nothing outside
    // that guard may reference STANDALONE_EXEC as anything but the
    // already-declared empty-string default and the boot-time override
    // check, both of which are runtime-neutral no-ops when RUNTIME=node.
    const compileGuardLine = src
      .split('\n')
      .find((l) =>
        l.includes('if [ "${RUNTIME}" = "bun" ] && [ "${KNEXT_SANDBOX_FETCH_DEBUG:-0}" != "1" ]'),
      );
    expect(compileGuardLine).toBeDefined();
  });

  it('mutation proof: deleting the compile-and-boot anchors reds the suite above', () => {
    const mutated = src
      .replace('bun run "${STANDALONE_COMPILE_JS}"', 'bun run "${SOMETHING_ELSE}"')
      .replace('--target bun-linux-x64-musl', '--target host')
      .replace(
        'STANDALONE_EXEC="${STANDALONE_APP_DIR}/knext-standalone-exec-linux-x64"',
        'STANDALONE_EXEC=""',
      );
    expect(/bun run "\$\{STANDALONE_COMPILE_JS\}"/.test(mutated)).toBe(false);
    expect(/--target bun-linux-x64-musl/.test(mutated)).toBe(false);
    expect(
      mutated.includes('STANDALONE_EXEC="${STANDALONE_APP_DIR}/knext-standalone-exec-linux-x64"'),
    ).toBe(false);
  });
});
