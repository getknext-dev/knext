/**
 * The vinext compat lane must hand the harness vinext's REAL build id.
 *
 * The harness builds Pages Router data URLs as `/_next/data/<BUILD_ID>/<page>.json`
 * from the `BUILD_ID:` line `scripts/e2e-logs.sh` prints out of
 * `.adapter-build.log`. `next build` writes that id to `.next/BUILD_ID`; vinext
 * never does. It writes it to `<vite outDir>/server/BUILD_ID`
 * (`dist/server/BUILD_ID`), the same id that names
 * `.output/public/_next/static/<buildId>/`, and it is what vinext's own
 * prerender reads back (`build/run-prerender.js`).
 *
 * The lane used to read `.next/BUILD_ID` and silently fall back to the
 * deployment id. Every data request then went to a build id the server never
 * had, so every `/_next/data` fixture was a 404, and the lane reported that as a
 * vinext incompatibility. Measured locally: with the real id,
 * `/_next/data/<id>/index.json` answers 200.
 *
 * So the lane reads `dist/server/BUILD_ID` first and FAILS CLOSED when no build
 * id file exists. A fallback to the deployment id is exactly the silent wrong
 * answer this guard exists to prevent.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = 'scripts/e2e-deploy-vinext.sh';
const raw = readFileSync(resolve(repoRoot, SCRIPT), 'utf8');

/** Script body with full-line comments removed: prose must not satisfy a code assertion. */
const code = raw
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

/** The `vinext_build_id() { … }` definition, which must occur exactly once. */
function buildIdFunction(): string {
  const hits = [...code.matchAll(/^vinext_build_id\(\) \{[\s\S]*?^\}$/gm)];
  expect(hits.length, `${SCRIPT} must define vinext_build_id() exactly once`).toBe(1);
  return hits[0][0];
}

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'knext-vinext-buildid-'));
  temps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

/** Run the script's own function (not a copy of it) against an app dir. */
function resolveId(dir: string): { status: number | null; out: string } {
  const r = spawnSync(
    'bash',
    ['-c', `set -euo pipefail\n${buildIdFunction()}\nvinext_build_id "$1"`, 'x', dir],
    {
      encoding: 'utf8',
    },
  );
  return { status: r.status, out: r.stdout };
}

describe('vinext_build_id: the build id vinext actually baked in', () => {
  it('reads dist/server/BUILD_ID, where vinext writes it', () => {
    expect(resolveId(app({ 'dist/server/BUILD_ID': 'abc-123' }))).toEqual({
      status: 0,
      out: 'abc-123',
    });
  });

  it('prefers dist/server/BUILD_ID over a stray .next/BUILD_ID', () => {
    const dir = app({ 'dist/server/BUILD_ID': 'vinext-id', '.next/BUILD_ID': 'stale-next-id' });
    expect(resolveId(dir).out).toBe('vinext-id');
  });

  it('accepts .next/BUILD_ID when it is the only build id file', () => {
    expect(resolveId(app({ '.next/BUILD_ID': 'next-id' })).out).toBe('next-id');
  });

  it('trims the trailing newline and surrounding whitespace', () => {
    expect(resolveId(app({ 'dist/server/BUILD_ID': '  f9640b18-9477\n' })).out).toBe(
      'f9640b18-9477',
    );
  });

  it('fails (non-zero, no output) when no build id file exists', () => {
    const r = resolveId(app({ 'package.json': '{}' }));
    expect(r.status).not.toBe(0);
    expect(r.out).toBe('');
  });

  it('treats an empty BUILD_ID file as absent', () => {
    const r = resolveId(app({ 'dist/server/BUILD_ID': '' }));
    expect(r.status).not.toBe(0);
    expect(r.out).toBe('');
  });
});

describe('the lane uses it, and fails closed', () => {
  it('assigns BUILD_ID exactly once, from vinext_build_id, and never from the deployment id', () => {
    // Any assignment form: quoted or not, `export`/`readonly`/`local`, or inside `if !`.
    const assigns = [
      ...code.matchAll(/^\s*(?:if\s+!\s+|export\s+|readonly\s+|local\s+)?BUILD_ID=[^\n]*$/gm),
    ].map((m) => m[0].trim());
    expect(assigns.length, `BUILD_ID assignments in ${SCRIPT}: ${JSON.stringify(assigns)}`).toBe(1);
    // The value is the function's output and nothing else: no default, no fallback.
    expect(assigns[0]).toContain(`BUILD_ID="$(vinext_build_id "\${APP_DIR}")"`);
    expect(assigns[0]).not.toContain('DEPLOYMENT_ID');
    expect(assigns[0]).not.toMatch(/\|\|\s*echo|:-/);
  });

  it('exits non-zero when the build id cannot be resolved', () => {
    const block = code.match(
      /^if ! BUILD_ID="\$\(vinext_build_id "\$\{APP_DIR\}"\)"[^\n]*\n([\s\S]*?)^fi$/m,
    );
    expect(
      block,
      'the BUILD_ID resolution must be an if-block that handles failure',
    ).not.toBeNull();
    expect(block?.[1]).toMatch(/^\s*exit 1$/m);
  });

  it('resolves the build id BEFORE compiling and booting (fail before any server starts)', () => {
    const at = code.indexOf('if ! BUILD_ID="$(vinext_build_id');
    expect(at).toBeGreaterThan(code.indexOf('npx --no-install vite build'));
    expect(at).toBeLessThan(code.indexOf('COMPILE_SCRIPT='));
    expect(at).toBeLessThan(code.indexOf('SERVER_PID=$!'));
  });

  it('still records the resolved id in the metadata e2e-logs.sh reads', () => {
    expect(code).toMatch(/^\s*echo "BUILD_ID=\$\{BUILD_ID\}"$/m);
  });

  it('the function text is valid bash (syntax check)', () => {
    expect(() => execFileSync('bash', ['-n', '-c', buildIdFunction()])).not.toThrow();
  });
});
