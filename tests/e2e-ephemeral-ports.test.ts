// @vitest-environment node
//
// #678 — NO HARDCODED BIND PORT in any e2e spec, fixture, or harness.
//
// The `SIGTERM drain (shipped bundle gate)` failed on PR #676 with
// `EADDRINUSE :::39188` and passed unchanged on re-run: a genuine flake, caused by
// `apps/file-manager/__fixtures__/ignore-sigterm-standalone-server.mjs` hardcoding
// its listen port. Any two jobs sharing a runner collide — and #673 turned CI on
// for stacked PRs, so concurrent jobs are now MORE common, not less.
//
// A flaky REQUIRED gate is one people learn to re-run reflexively, and a gate that
// is re-run reflexively stops being read. So this is a scan, not a one-file fix:
// it walks every tracked fixture/harness/e2e spec and fails on any literal port in
// a BINDING context.
//
// The rule: a bind port is either `0` (the OS assigns it, and the process reports
// the port it actually got) or an OS-assigned port reserved at runtime
// (`freePort()`), never a literal.
//
// ── WHAT THIS SCAN ACTUALLY COVERS (it is a lint, not a proof) ───────────────
// Stated precisely, because "a new e2e is covered the moment it is named"
// overstates it in two directions:
//
//   1. FILE SELECTION IS NAMING-KEYED. `scannedFiles()` matches `__fixtures__/`,
//      `*e2e*.test.ts`, `*harness*` (plus one explicit path). A spec or fixture
//      that binds a port under some OTHER name is not scanned at all. So the
//      claim is narrower: a new e2e is covered once it is named to MATCH THOSE
//      PATTERNS.
//   2. LITERAL DETECTION IS SYNTACTIC. `BIND_PORT` catches the shapes we have
//      actually seen — `PORT = 3000`, `.listen(3000`, `port: 3000`, a multiline
//      `.listen(\n 3000)`, `env.PORT ?? 3000`. It MISSES an indirected literal
//      (`const p = 41234; srv.listen(p)`), a stringified one (`listen('41234')`)
//      and a computed one (`BASE + 234`).
//   3. THE EXEMPTION'S HONESTY CHECK IS SYNTACTIC TOO. `BINDING_CONSTRUCT` asks
//      "could this file open a listening socket at all?" by looking for
//      `.listen(`, `createServer(` or a literal `from 'node:net|http|https'`. An
//      INDIRECT bind evades it: a helper imported from another module, or a
//      dynamic `await import('node:net')` (the regex requires the static `from`
//      syntax). So a whole-file exemption can, in principle, outlive the reason
//      that justified it — the check narrows the hole, it does not seal it.
//
// That is deliberate: this is a guard against the ACCIDENT that already bit us
// (#676, `EADDRINUSE :::39188` from a hardcoded fixture port), not a barrier
// against someone determined to route around it. Extend the patterns when a real
// case escapes; do not read a green run as "no fixed port can exist anywhere".

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * Files whose port literal binds NOTHING, with the reason. Each entry is
 * asserted to still exist and to still contain a literal — a stale exemption
 * reds rather than rotting silently.
 */
const EXEMPT: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'tests/e2e-deploy.port-ownership.test.ts',
    reason:
      'no socket is ever bound: the literal is synthetic `ss -ltnp` OUTPUT fed to ' +
      'stub ss/lsof binaries on a controlled PATH, so it is test DATA, not a bind.',
  },
];

/** Every tracked file whose job is to spawn/serve something in a test. */
function scannedFiles(): string[] {
  const tracked = execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((l) => l.length > 0);
  return tracked.filter(
    (f) =>
      /__fixtures__\/.*\.(mjs|cjs|js|ts)$/.test(f) ||
      /(^|\/)[^/]*e2e[^/]*\.test\.ts$/.test(f) ||
      /(^|\/)[^/]*harness[^/]*\.(mjs|ts)$/.test(f) ||
      /examples\/bun-exec\/test\/runtime-contract\.test\.ts$/.test(f),
  );
}

/** Strip comments so PROSE mentioning a port is never mistaken for a bind. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Port literals in a BINDING context only — an assignment to a PORT-ish name, a
 * `.listen(<n>`, or a `port: <n>` option. Anything else (a container-internal
 * `${hostPort}:3000` publish mapping, an HTTP status, a timeout) is not a bind
 * and is not matched.
 */
const BIND_PORT =
  /(?:\b[A-Za-z_]*PORT[A-Za-z_]*\s*[:=]\s*|\.listen\(\s*|\bport\s*:\s*)(\d{1,5})\b/g;

/**
 * `process.env.<X>PORT ?? <n>` — the FALLBACK a fixture/harness binds when the
 * spawning spec forgets to pass a port. Checked only for fixture/harness FILES,
 * which we own end-to-end: their fallback must be 0 (OS-assigned) so a forgotten
 * env var degrades to an ephemeral port rather than to a shared fixed one.
 *
 * Deliberately NOT applied to the `tests/e2e-deploy.*` specs: the inline
 * server.js strings there mirror the REAL generated Next standalone server, whose
 * documented default IS 3000 — that literal is fidelity to the artifact under
 * test, and the harness (`scripts/e2e-deploy.sh` free_port) always supplies a
 * real port, so the fallback is never bound.
 */
const ENV_PORT_FALLBACK = /env\.[A-Za-z_]*PORT[A-Za-z_]*\s*(?:\?\?|\|\|)\s*(\d{1,5})\b/g;

/**
 * Evidence that a file BINDS something, used to keep a whole-file exemption
 * honest (see the exemption case below). Not a bind-port matcher — it asks the
 * coarser question "could this file open a listening socket at all?".
 */
const BINDING_CONSTRUCT = /\.listen\(|createServer\(|from\s+['"]node:(?:net|http|https)['"]/;

/** A file we own end-to-end (fixture or harness), not a spec. */
function isFixtureOrHarness(file: string): boolean {
  return /__fixtures__\//.test(file) || /harness/.test(file);
}

function bindPortLiterals(src: string, file: string): number[] {
  const clean = stripComments(src);
  const found: number[] = [];
  const patterns = isFixtureOrHarness(file) ? [BIND_PORT, ENV_PORT_FALLBACK] : [BIND_PORT];
  for (const re of patterns) {
    for (const m of clean.matchAll(re)) {
      found.push(Number(m[1]));
    }
  }
  return found;
}

describe('#678 e2e ports are OS-assigned, never hardcoded', () => {
  const files = scannedFiles();
  const exemptFiles = new Set(EXEMPT.map((e) => e.file));

  it('scans a non-empty set of fixtures/harnesses/e2e specs (never vacuously green)', () => {
    // An empty scan passes every assertion below, so assert the scan found the
    // known members. If a rename empties this, the guard reds instead of lying.
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain('apps/file-manager/__fixtures__/ignore-sigterm-standalone-server.mjs');
    expect(files).toContain('apps/file-manager/__fixtures__/slow-standalone-server.mjs');
    expect(files).toContain('apps/file-manager/sigterm-hardcap-e2e.test.ts');
    expect(files).toContain('apps/file-manager/sigterm-drain-e2e.test.ts');
    expect(files).toContain('examples/bun-exec/test/sigterm-hardcap-e2e.test.ts');
    expect(files).toContain('examples/bun-exec/test/drain-harness.mjs');
  });

  it.each(files.filter((f) => !exemptFiles.has(f)))('%s binds no hardcoded port', (file) => {
    const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    const literals = bindPortLiterals(src, file).filter((p) => p !== 0);
    expect(
      literals,
      `${file} hardcodes bind port(s) ${literals.join(', ')} — two CI jobs on one ` +
        `runner collide (EADDRINUSE, #678). Bind 0 and report the port actually ` +
        `assigned, or reserve one with freePort().`,
    ).toEqual([]);
  });

  it.each(EXEMPT)('exemption for $file is still real', ({ file }) => {
    // A stale exemption is worse than none: it silently widens the hole. If the
    // file loses its literal (or the file goes away), delete the entry.
    const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    expect(bindPortLiterals(src, file).filter((p) => p !== 0).length).toBeGreaterThan(0);

    // ...AND the exemption's stated REASON still holds. Exempting a whole FILE
    // is the hole: `port-ownership` is exempt because its literals are synthetic
    // `ss -ltnp` OUTPUT, but nothing stopped it later gaining a REAL bind and
    // inheriting the exemption by construction. So assert the property the
    // reason claims — the file binds nothing — instead of trusting the name.
    // A `.listen(`/`createServer(`/socket import appearing here reds this case
    // and forces the entry to be re-justified or narrowed.
    expect(
      BINDING_CONSTRUCT.test(stripComments(src)),
      `${file} is exempt because "${EXEMPT.find((e) => e.file === file)?.reason}", but it now ` +
        `contains a real binding construct. The file-wide exemption no longer holds — narrow it ` +
        `or remove it.`,
    ).toBe(false);
  });
});
