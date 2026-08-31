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
//   2b. THE SCAN'S SCOPE DRIFTS AS THE CODE MOVES UNDER IT (#686). This is the
//      same class as limit 1, but it bites without anyone touching the guard:
//      when the e2e specs were refactored to delegate port allocation to
//      `apps/file-manager/e2e-support/child-ports.ts` (#683), the repo's now
//      CENTRAL port allocator matched none of the three name patterns — the
//      highest-leverage place for a literal to hide became the one place not
//      scanned. The guard had not changed; the codebase reorganised beneath it.
//      `e2e-support/` is in the selected set below for exactly that reason, and
//      the non-vacuity case names it. The general lesson does not go away: when
//      port plumbing moves to a new home, MOVE THE PATTERN WITH IT.
//   3. THE EXEMPTION'S HONESTY CHECK IS SYNTACTIC TOO. `BINDING_CONSTRUCT` asks
//      "could this file open a listening socket at all?" by looking for
//      `.listen(`, `createServer(` or a literal `from 'node:net|http|https'`. An
//      INDIRECT bind evades it: a helper imported from another module, or a
//      dynamic `await import('node:net')` (the regex requires the static `from`
//      syntax). So a whole-file exemption can, in principle, outlive the reason
//      that justified it — the check narrows the hole, it does not seal it.
//   4. THE SEQUENTIAL-RESERVATION RULE IS A SHAPE-MATCHER, NOT A RULE (#686).
//      "No scanned file may reserve ports one `freePort()` at a time" is how the
//      failure message reads; what `SINGLE_PORT_RESERVATION` actually matches is
//      the LITERAL zero-argument call `freePort()`, counted per file. Measured
//      against the regex, every one of these reserves N ports sequentially and
//      still passes: a loop (`for (…) ports.push(await freePort())`) counts 1;
//      a rename (`getFreePort()`) counts 0; any argument (`freePort(1)`) counts
//      0; and a local helper that calls it twice makes the CALLER count 0. Nor
//      is the count cross-file — two modules calling it once each are both fine.
//      And the shape most likely to arise by ACCIDENT rather than evasion is
//      the one the pattern misses outright: `freePorts(1)` called twice counts 0,
//      as does one `freePort()` plus one `freePorts(1)` (the threshold is `<= 1`)
//      — the same sequential-reservation bug, written in the very API this file
//      promotes.
//      So a green run means "no file repeats the exact shape that bit us twice"
//      (#683's drain e2e, #686's docker e2e), NOT "sequential reservation is
//      gone repo-wide". Same posture as limits 1-3: it stops the accident, not
//      the author who routes around it. Widen the pattern when a real case
//      escapes.
//
// That is deliberate: this is a guard against the ACCIDENT that already bit us
// (#676, `EADDRINUSE :::39188` from a hardcoded fixture port), not a barrier
// against someone determined to route around it. Extend the patterns when a real
// case escapes; do not read a green run as "no fixed port can exist anywhere".

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** This scanner's own repo-relative path — see the sequential-reservation case. */
const SELF = 'tests/e2e-ephemeral-ports.test.ts';

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
      // #686: the port ALLOCATORS themselves. `e2e-support/` is where the e2e
      // port plumbing lives now, and the file every other spec delegates to is
      // the last place a literal should be able to reappear unguarded.
      /(^|\/)e2e-support\/[^/]*\.(mjs|cjs|js|ts)$/.test(f) ||
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

/**
 * A file we own end-to-end — a fixture, a harness, or an `e2e-support/` port
 * allocator — as opposed to a spec. These get the extra `ENV_PORT_FALLBACK`
 * check, so widening this predicate is strictly STRICTER, never a hole.
 */
function isFixtureOrHarness(file: string): boolean {
  return /__fixtures__\//.test(file) || /harness/.test(file) || /(^|\/)e2e-support\//.test(file);
}

/**
 * A SINGLE-port reservation call, `freePort()`. Two of them in one file is the
 * collision class #683 removed from the drain e2e and #686 found still alive in
 * `examples/bun-exec/test/alpine-image.docker-e2e.test.ts`: the first socket is
 * closed before the second is allocated, so nothing forbids the OS handing back
 * the same port twice and one of the two binds dying with EADDRINUSE.
 *
 * The fix is always the same — reserve every port a spawn needs in ONE
 * `freePorts(n)` call, which holds them all in LISTEN simultaneously and makes
 * a repeat impossible rather than merely improbable.
 *
 * Counted on comment-stripped source, so PROSE about `freePort()` (this comment
 * included) never trips it. A DECLARATION (`function freePort()`) is not a
 * reservation and is excluded — otherwise a module that defines the single-port
 * helper and calls it once would read as two calls.
 */
const SINGLE_PORT_RESERVATION = /(function\s+)?\bfreePort\s*\(\s*\)/g;

function sequentialReservationCount(src: string): number {
  return [...stripComments(src).matchAll(SINGLE_PORT_RESERVATION)].filter((m) => m[1] === undefined)
    .length;
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
    // #686: the port ALLOCATORS. These are named explicitly because they are the
    // files every other spec now delegates to — if a rename drops them out of
    // `scannedFiles()` again, this reds rather than silently narrowing the scan.
    expect(files).toContain('apps/file-manager/e2e-support/child-ports.ts');
    expect(files).toContain('examples/bun-exec/test/e2e-support/ports.ts');
    // The self-exclusion below is keyed on this path; a rename must red here
    // rather than silently exclude nothing (or, worse, exclude a real spec).
    expect(files).toContain(SELF);
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

  // #686 — the SECOND half of "no hardcoded port": a port that is OS-assigned but
  // reserved one call at a time can still repeat. Scanned as a rule rather than
  // fixed in the one file that had it, because an enumerated list of call sites
  // is how the next one gets missed.
  //
  // This FILE is excluded from that loop and only that loop: it is the scanner,
  // so its detector samples and failure messages contain literal `freePort()`
  // text by construction, and it binds no socket at all. The non-vacuity case
  // above still asserts it is in the scanned set, so it remains covered by the
  // hardcoded-literal scan.
  it.each(
    files.filter((f) => f !== SELF),
  )('%s reserves multi-port spawns in ONE held call', (file) => {
    const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    expect(
      sequentialReservationCount(src),
      `${file} calls freePort() more than once. Each call closes its socket before ` +
        `the next is allocated, so the OS may return the SAME port twice and one bind ` +
        `dies with EADDRINUSE (#683/#686). Reserve them together: freePorts(n).`,
    ).toBeLessThanOrEqual(1);
  });

  // The other half of that scan: prove the detector FIRES. A scan asserted only
  // against a clean tree is green whether or not it can see anything at all.
  it('the sequential-reservation detector actually detects', () => {
    expect(
      sequentialReservationCount('const a = await freePort();\nconst b = await freePort();'),
    ).toBe(2);
    // ...and does not fire on the fix, nor on prose about it.
    expect(sequentialReservationCount('const [a, b] = await freePorts(2);')).toBe(0);
    expect(sequentialReservationCount('// two freePort() calls used to live here\n')).toBe(0);
    // ...and the DECLARATION exclusion is a real branch, not decoration. Without
    // it the module that DEFINES the single-port helper and calls it once reads
    // as two reservations and reds for no reason — but every other assertion in
    // this case passes with the exclusion deleted, so this is the only one that
    // holds it up. It must count 1 (the call), never 2 (call + declaration).
    expect(
      sequentialReservationCount(
        'export async function freePort() { return 1; }\nconst p = await freePort();',
      ),
    ).toBe(1);
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
