import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { CREDENTIAL_CELLS } from '../scripts/compat-window-audit.mjs';
import { activeExemptions } from '../scripts/lib/dated-exemptions.mjs';

/**
 * #1294 rounds 3 & 4 — SCANNING TEST, INDEPENDENTLY REIMPLEMENTED.
 *
 * The import/source closure (`compat-window-fingerprint.mjs`) only follows JS
 * `import`/`require`/`import()` and shell `source`/`.`. Two other execution
 * shapes reach real repo files without going through either:
 *
 *   1. a workflow `run:` step invoking a script by SUBPROCESS
 *      (`node knext/scripts/compat-credential-ref.mjs …`), or reading a JSON
 *      pin file by CLI flag (`--pin knext/.github/compat-credential-ref.json`);
 *   2. a harness script referencing a REPO PATH through `${SCRIPT_DIR}/…` or
 *      `${KNEXT_REPO_ROOT}/…` shell interpolation OUTSIDE a `source`/`.`
 *      statement — e.g. mounting a sibling script into a container, or
 *      resolving a preload file to hand to `node -r`.
 *
 * `CREDENTIAL_CELLS.extraFiles` (scripts/compat-window-audit.mjs) is the
 * DECLARED source of truth for (1). This scan is what keeps it honest: it
 * reads the REAL workflow files and REAL harness files (every `.sh`/`.mjs`/
 * `.cjs`/`.js` the computed harness ACTUALLY includes — round 4 widened this
 * from "just the top-level scripts/e2e-* entry points" to the whole harness,
 * so a reached `scripts/lib/*.sh` and a DECLARED EXTRA's own imports are both
 * covered by the SAME pass) with its OWN parser (deliberately not calling
 * into `compat-window-fingerprint.mjs` — a scan that shares its target's
 * implementation would go green the same way the target is wrong) and fails
 * if it finds a repo-relative reference that is neither in the lane's actual
 * computed harness NOR a documented, reasoned exception below.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/compat-window-fingerprint.mjs');

/**
 * PERMANENT exceptions (#1294 round 3) — structurally dead code, verified by
 * a standing check below (not a clock): re-verified every run, so staying on
 * this list forever is correct as long as the verification keeps passing.
 *
 * #1422 — each exception is scoped to EXACTLY the source file(s) that
 * reference the path (`sources`), never to a lane or the whole repo. The
 * exemption key is the pair (source file, referenced path): a second file
 * (another workflow, another harness script) referencing the same path gets
 * no exemption and must be frozen or named on its own. `isNamedException`
 * below is the only place the pair is consulted.
 */
const NAMED_EXCEPTIONS: { path: string; reason: string; sources: readonly string[] }[] = [
  // scripts/e2e-deploy.sh's contract-test-mode (KNEXT_E2E_SKIP_PACK=1)
  // fallback resolves these FOUR preloads from in-repo SOURCE rather than the
  // installed tarball. VERIFIED DEAD on every CI run: KNEXT_E2E_SKIP_PACK is
  // never set (as an `env:` key OR a shell assignment) in either workflow, so
  // this branch never executes on a scheduled night — the ACTIVE path
  // resolves the same preloads from the INSTALLED @getknext/core tarball via
  // `require.resolve(...)`, which the `packed` component already hashes in
  // full. See the "verified dead" test below, which fails loud if that
  // env var is ever wired into a workflow — at which point these stop being
  // exempt and must be declared for real.
  {
    path: 'packages/kn-next/src/adapters/cache-control-normalize.cjs',
    reason:
      'contract-test-mode-only fallback (KNEXT_E2E_SKIP_PACK=1), verified never set in CI; the active path is covered by the packed tarball hash.',
    sources: ['scripts/e2e-deploy.sh'],
  },
  {
    path: 'packages/kn-next/src/adapters/bun-keepalive-guard.cjs',
    reason:
      'contract-test-mode-only fallback (KNEXT_E2E_SKIP_PACK=1), verified never set in CI; the active path is covered by the packed tarball hash.',
    sources: ['scripts/e2e-deploy.sh'],
  },
  {
    path: 'packages/kn-next/src/adapters/sandbox-fetch-debug.cjs',
    reason:
      'contract-test-mode-only fallback (KNEXT_E2E_SKIP_PACK=1), verified never set in CI; the active path is covered by the packed tarball hash.',
    sources: ['scripts/e2e-deploy.sh'],
  },
  {
    path: 'packages/kn-next/src/adapters/sandbox-fetch-realm-debug.cjs',
    reason:
      'contract-test-mode-only fallback (KNEXT_E2E_SKIP_PACK=1), verified never set in CI; the active path is covered by the packed tarball hash.',
    sources: ['scripts/e2e-deploy.sh'],
  },
  // #1347/#1406 — compat-vinext.yml's `vinext-red-alert` job shells out to
  // scripts/nightly-alert-issue.mjs. VERIFIED structurally outside the
  // fingerprint-relevant harness for the "bun-vinext" lane: that job
  // `needs: [build-next, deploy-tests, shard-ledger]` ONLY for its own `if:`
  // status gating (always() + schedule + a failure result), so it never runs
  // as part of — or before — the credential build/test work the fingerprint
  // exists to freeze; it runs strictly AFTER, and only on a scheduled RED
  // night, to file/update a pinned issue. Its own steps touch no build
  // output, so a change to nightly-alert-issue.mjs cannot move the fingerprint
  // and must not be required to appear in the harness closure. Permanent
  // (not dated): this is what the alert job STRUCTURALLY is, not temporary
  // tech debt with a clock.
  {
    path: 'scripts/nightly-alert-issue.mjs',
    reason:
      "invoked only by compat-vinext.yml's vinext-red-alert job (and the 8 sibling nightly-red-alert jobs, none of which are CREDENTIAL_CELLS lanes), which needs the other jobs only for status gating and runs strictly after the credential build/test work — never part of the fingerprint-relevant harness.",
    sources: ['.github/workflows/compat-vinext.yml'],
  },
];

/** Entries that declare no source file — dead exceptions that exempt nothing. */
function deadExceptions(entries: { path: string; sources: readonly string[] }[]): string[] {
  return entries.filter((e) => e.sources.length === 0).map((e) => e.path);
}

/**
 * True only when `source` (repo-relative file containing the reference) is
 * explicitly listed for `ref` — exact string match on both, no wildcards.
 */
function isNamedException(source: string, ref: string): boolean {
  return NAMED_EXCEPTIONS.some((e) => e.path === ref && e.sources.includes(source));
}

/**
 * The REAL scan code path for the workflow half — the lane tests and the
 * negative fixtures below both go through it, so a call-site exemption that
 * goes global is visible to the fixtures. `source` for the exemption key is
 * the workflow's repo path.
 */
function unresolvedWorkflowRefs(
  workflowFile: string,
  workflowText: string,
  harness: Set<string>,
  datedPaths: Set<string>,
): string[] {
  const unresolved: string[] = [];
  for (const ref of workflowSubprocessRefs(workflowText)) {
    // compat-window-fingerprint.mjs itself is the TOOL computing the digest,
    // never a subject of it — excluded by construction, not by exception.
    if (ref === 'scripts/compat-window-fingerprint.mjs') continue;
    if (
      !(
        harness.has(ref) ||
        isNamedException(`.github/workflows/${workflowFile}`, ref) ||
        datedPaths.has(ref)
      )
    ) {
      unresolved.push(ref);
    }
  }
  return unresolved;
}

/** The REAL scan code path for the harness-file half; key = the file's relPath. */
function unresolvedHarnessRefs(
  files: { relPath: string; text: string }[],
  harness: Set<string>,
  datedPaths: Set<string>,
): string[] {
  const unresolved: string[] = [];
  for (const { relPath, text } of files) {
    const fromDir = dirname(resolve(REPO_ROOT, relPath));
    const refs = [
      ...scriptDirRefs(text, fromDir),
      ...(/\.(mjs|cjs|js)$/.test(relPath) ? jsImportRefs(text, fromDir) : []),
    ];
    for (const ref of refs) {
      if (!(harness.has(ref) || isNamedException(relPath, ref) || datedPaths.has(ref))) {
        unresolved.push(`${relPath} -> ${ref}`);
      }
    }
  }
  return unresolved;
}

/**
 * DATED exceptions (#1294 round 4, jev 0.75) — real, temporary tech debt,
 * each with a clock and a tracking issue, so it CANNOT quietly become
 * permanent the way a plain comment-only exception can. `activeExemptions`
 * (scripts/lib/dated-exemptions.mjs) is the SAME shared reader the
 * prover-lane and coverage exemptions use: an unknown key throws, `expires`
 * is required, and a lapsed entry simply stops appearing in the active set.
 *
 * CURRENTLY EMPTY (#1294 round 6): the one entry this held —
 * `scripts/patch-vinext-3197.mjs`, exempted while PR #1311 (issue #1309,
 * "migrate vinext 1.0.0-beta.8 → 1.0.0-beta.11") was in flight on a sibling
 * branch — was removed once #1311 actually landed on `main` and deleted that
 * file. The removal is itself proof the mechanism works: the red-on-delete
 * guard this file's own tests carried ("once the file is deleted, remove the
 * exception") is exactly what fired in CI and is why this entry is gone
 * rather than quietly stale. Left declared (empty) as the place a FUTURE
 * dated exception belongs — the fixture-based tests below exercise the
 * mechanism directly, so it does not need a live subject to stay tested.
 */
const DATED_EXCEPTIONS: { path: string; justification: string; added: string; expires: string }[] =
  [];

function activeDatedExceptionPaths(now = new Date()): Set<string> {
  return activeExemptions(DATED_EXCEPTIONS, { field: 'path', now });
}

/** Every top-level scripts/e2e-* file — the closure ENTRY set, read the same way collectHarness discovers it. */
function entryScripts(): string[] {
  return readdirSync(resolve(REPO_ROOT, 'scripts')).filter((f) =>
    /^e2e-[^/]*\.(sh|mjs|cjs|js)$/.test(f),
  );
}

/**
 * `node`/`bash` subprocess invocations and `--pin` JSON references in a
 * workflow's text (#1294 round 4: widened past the bare `knext/scripts/…`
 * form to also match `./knext/scripts/…` and `"$GITHUB_WORKSPACE/knext/
 * scripts/…"` / `"${GITHUB_WORKSPACE}/knext/scripts/…"` — none of these
 * appear in either real workflow TODAY, but the scan's job is to survive the
 * next edit, not just describe the current one).
 */
function workflowSubprocessRefs(workflowText: string): string[] {
  const found = new Set<string>();
  // #1294 round 5 (jev 0.87): widened past a bare `node`/`bash` invoker with
  // no flags and only the `${VAR}`/`./`/`knext/` shell-side path forms.
  // Three more shapes now match, none of which appeared in either real
  // workflow at the time this was written — the scan's job is to survive
  // the NEXT edit, not just describe the current one:
  //   - `bun` as the invoker, not just `node` (both run .mjs/.cjs/.js here);
  //   - one or more `--flag`/`--flag=value` tokens between the invoker and
  //     the path (e.g. `node --experimental-foo knext/scripts/x.mjs`);
  //   - the GITHUB ACTIONS EXPRESSION form `${{ github.workspace }}/…`
  //     (double-curly, dotted, optional inner spaces) — distinct from the
  //     shell `${GITHUB_WORKSPACE}`/`$GITHUB_WORKSPACE` forms already
  //     handled, and evaluated by the Actions runner BEFORE the shell ever
  //     sees the `run:` step, so it is a real, different-looking way to
  //     reference the same path.
  const invoker = '(?:node|bun)';
  const flags = '(?:--?[\\w.:=-]+\\s+)*';
  const workspacePrefix =
    '(?:\\$\\{?GITHUB_WORKSPACE\\}?\\/|\\$\\{\\{\\s*github\\.workspace\\s*\\}\\}\\/)?';
  const nodeRe = new RegExp(
    `\\b${invoker}\\s+${flags}"?${workspacePrefix}(?:\\.\\/)?(?:knext\\/)?(scripts\\/[\\w./-]+\\.(?:mjs|cjs|js))"?\\b`,
    'g',
  );
  for (const m of workflowText.matchAll(nodeRe)) found.add(m[1]);
  const bashRe = new RegExp(
    `\\bbash\\s+${flags}"?${workspacePrefix}(?:\\.\\/)?(?:knext\\/)?(scripts\\/[\\w./-]+\\.sh)"?\\b`,
    'g',
  );
  for (const m of workflowText.matchAll(bashRe)) found.add(m[1]);
  for (const m of workflowText.matchAll(/--pin\s+(?:knext\/)?(\.github\/[\w./-]+\.json)/g)) {
    found.add(m[1]);
  }
  return [...found];
}

/**
 * `${SCRIPT_DIR}/X` and `${KNEXT_REPO_ROOT[:-…]}/X` references in a harness
 * FILE's OWN text (JS or shell) — resolved to repo-relative paths.
 * `SCRIPT_DIR` is always the referencing file's own directory by this repo's
 * convention (`SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`),
 * so it is resolved relative to `fromDir`, not hardcoded to `scripts/` —
 * round 4 widened this scan past the top-level entry scripts to every
 * harness file, including `scripts/lib/*.sh`, whose own `SCRIPT_DIR` is
 * ALSO `scripts/` (the sourcing script's directory, by the same convention —
 * a sourced file never redefines `SCRIPT_DIR`), so the resolution rule does
 * not change, only which files get scanned.
 */
function scriptDirRefs(fileText: string, fromDir: string): string[] {
  const found = new Set<string>();
  // Path chars only: no `"`, `'`, whitespace, `)`, or `:` — the last excludes
  // docker `-v SRC:DST:MODE` mount syntax, where a bare path-char class would
  // swallow the container-side path and mode flag as if they were part of
  // the repo-relative reference.
  for (const m of fileText.matchAll(/\$\{SCRIPT_DIR\}\/([^"'\s):]+)/g)) {
    found.add(relative(REPO_ROOT, resolve(fromDir, m[1])));
  }
  for (const m of fileText.matchAll(/\$\{KNEXT_REPO_ROOT(?::-[^}]*)?\}\/([^"'\s):]+)/g)) {
    found.add(posix.normalize(m[1]));
  }
  return [...found];
}

/**
 * Local (`./…`/`../…`) JS import/require/import() specifiers in a harness
 * file's OWN text, resolved to repo-relative paths — a DELIBERATELY simpler,
 * independent reimplementation than `compat-window-fingerprint.mjs`'s
 * tokenizer (round 3's fix for THAT file's false-hard-error risk is a
 * separate concern from THIS scan, which only needs to work against the
 * real files it actually reads, not adversarial input). Strips `//` and
 * `/* *\/` comments first so an obvious decoy does not manufacture a false
 * scan failure.
 */
function jsImportRefs(fileText: string, fromDir: string): string[] {
  const stripped = fileText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const specs = new Set<string>();
  for (const re of [
    /\bfrom\s+['"](\.\.?\/[^'"]+)['"]/g,
    /\brequire\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g,
  ]) {
    for (const m of stripped.matchAll(re)) specs.add(m[1]);
  }
  return [...specs].map((spec) => relative(REPO_ROOT, resolve(fromDir, spec)));
}

/** The real, computed harness set for a lane. */
function harnessFor(lane: string): Set<string> {
  const tarballsDir = mkdtempSync(join(tmpdir(), 'knext-fp-execscan-tb-'));
  const stage = mkdtempSync(join(tmpdir(), 'knext-fp-execscan-pkg-'));
  try {
    const pkgDir = join(stage, 'package');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@getknext/core', version: '0.0.0' }),
    );
    execFileSync('tar', [
      'czf',
      join(tarballsDir, 'getknext-core-0.0.0.tgz'),
      '-C',
      stage,
      'package',
    ]);

    const out = execFileSync(
      process.execPath,
      [
        SCRIPT,
        '--repo-root',
        REPO_ROOT,
        '--tarballs-dir',
        tarballsDir,
        '--lane',
        lane,
        '--json',
        '--files',
      ],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out) as { files: { component: string; path: string }[] };
    return new Set(parsed.files.filter((f) => f.component === 'harness').map((f) => f.path));
  } finally {
    rmSync(tarballsDir, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Every `.sh`/`.mjs`/`.cjs`/`.js` file the computed harness for `lane` actually includes, with its text. */
function harnessCodeFiles(lane: string): { relPath: string; text: string }[] {
  const harness = harnessFor(lane);
  const out: { relPath: string; text: string }[] = [];
  for (const relPath of harness) {
    if (!/\.(sh|mjs|cjs|js)$/.test(relPath)) continue;
    const abs = resolve(REPO_ROOT, relPath);
    if (existsSync(abs)) out.push({ relPath, text: readFileSync(abs, 'utf8') });
  }
  return out;
}

/**
 * Every credential-lane (`lane`, `workflowFile`) pair, read from
 * `CREDENTIAL_CELLS` — round 4: was a hardcoded `['node', ...], ['bun', ...]`
 * array here, which could drift from the ONE declared table the production
 * code itself reads the moment a new cell's workflow lands and this file is
 * not updated to match.
 */
function credentialLanes(): { lane: string; workflowFile: string }[] {
  return CREDENTIAL_CELLS.filter(
    (c): c is typeof c & { workflowFile: string } => typeof c.workflowFile === 'string',
  ).map((c) => ({ lane: c.lane, workflowFile: c.workflowFile }));
}

describe('compat-window fingerprint — execution scan: every node/bash/import/${SCRIPT_DIR}/${KNEXT_REPO_ROOT} reference is frozen or named (#1294 rounds 3–4)', () => {
  it('KNEXT_E2E_SKIP_PACK is never set (env key OR shell assignment) in a workflow — the contract-test-mode preload exceptions stay honestly dead', () => {
    // #1294 round 4: widened past the YAML `env:`-key form to also catch a
    // shell assignment INSIDE a `run:` step body (`export KNEXT_E2E_SKIP_PACK=1`
    // or a bare `KNEXT_E2E_SKIP_PACK=1`) — a `run:` block is plain text to
    // this scan and to the YAML parser alike, so the env-key-only check could
    // not see a run-step assignment that activates the exact same fallback.
    const setterRe = /(?:^|\s)(?:export\s+)?KNEXT_E2E_SKIP_PACK\s*=/m;
    const envKeyRe = /^\s*KNEXT_E2E_SKIP_PACK\s*:/m;
    for (const wf of ['test-e2e-deploy.yml', 'compat-vinext.yml']) {
      const text = readFileSync(resolve(REPO_ROOT, '.github/workflows', wf), 'utf8');
      expect(
        envKeyRe.test(text),
        `${wf} sets KNEXT_E2E_SKIP_PACK as an env: key — the contract-test-mode preload exceptions are no longer honest and must be re-evaluated`,
      ).toBe(false);
      expect(
        setterRe.test(text),
        `${wf} assigns KNEXT_E2E_SKIP_PACK inside a run: step — the contract-test-mode preload exceptions are no longer honest and must be re-evaluated`,
      ).toBe(false);
    }
  });

  it('every PERMANENT named exception resolves to a real file, so the exception list cannot rot into pointing at nothing', () => {
    for (const { path } of NAMED_EXCEPTIONS) {
      expect(existsSync(resolve(REPO_ROOT, path)), `named exception ${path} does not exist`).toBe(
        true,
      );
    }
  });

  // #1422 — NAMED_EXCEPTIONS is scoped per SOURCE FILE. Direct unit coverage
  // of `isNamedException`, independent of what the repo references today.
  it('isNamedException: exempts exactly the (source, path) pairs declared', () => {
    for (const { path, sources } of NAMED_EXCEPTIONS) {
      for (const source of sources) {
        expect(isNamedException(source, path), `${source} -> ${path}`).toBe(true);
      }
    }
  });

  it('isNamedException: a different source file referencing the same path is NOT exempt (#1422)', () => {
    for (const { path, sources } of NAMED_EXCEPTIONS) {
      for (const other of [
        '.github/workflows/compat-window-other.yml',
        'scripts/some-other-harness.sh',
        `${sources[0]}.bak`,
      ]) {
        expect(isNamedException(other, path), `${other} must not inherit ${path}`).toBe(false);
      }
    }
  });

  it('isNamedException: a declared source is not exempt for a path it was not declared for (#1422)', () => {
    expect(isNamedException('scripts/e2e-deploy.sh', 'scripts/anything-else.sh')).toBe(false);
  });

  it('deadExceptions: flags an entry with sources: [] and passes the real list (#1422)', () => {
    expect(deadExceptions([{ path: 'x/y.mjs', sources: [] }])).toEqual(['x/y.mjs']);
    expect(deadExceptions(NAMED_EXCEPTIONS)).toEqual([]);
  });

  it('every named-exception source exists and references its FULL path (no stale exemption); sources is never empty', () => {
    for (const { path, sources } of NAMED_EXCEPTIONS) {
      for (const source of sources) {
        const abs = resolve(REPO_ROOT, source);
        expect(existsSync(abs), `${source} is gone — remove the exception`).toBe(true);
        expect(
          readFileSync(abs, 'utf8').includes(path),
          `${source} no longer references ${path} — remove the exception`,
        ).toBe(true);
      }
    }
  });

  // #1422 — NEGATIVE SCAN FIXTURES through the real call-site code paths. An
  // undeclared source referencing an exempt path must be REPORTED; declared
  // sources must not be. Workflow key and harness key are proved separately,
  // so reverting either call site to a global exemption goes red.
  it('workflow scan: an undeclared workflow referencing an exempt path is reported; the declared one is not (#1422)', () => {
    const { path, sources } = NAMED_EXCEPTIONS.find((e) =>
      e.sources.some((s) => s.startsWith('.github/workflows/')),
    ) as (typeof NAMED_EXCEPTIONS)[number];
    const declared = (sources.find((s) => s.startsWith('.github/workflows/')) as string).replace(
      '.github/workflows/',
      '',
    );
    const text = `jobs:\n  j:\n    steps:\n      - run: node ${path}\n`;
    expect(workflowSubprocessRefs(text)).toContain(path);
    expect(unresolvedWorkflowRefs('undeclared-fixture.yml', text, new Set(), new Set())).toEqual([
      path,
    ]);
    expect(unresolvedWorkflowRefs(declared, text, new Set(), new Set())).toEqual([]);
  });

  it('harness scan: an undeclared harness file referencing an exempt path is reported; the declared one is not (#1422)', () => {
    const { path, sources } = NAMED_EXCEPTIONS.find((e) =>
      e.sources.includes('scripts/e2e-deploy.sh'),
    ) as (typeof NAMED_EXCEPTIONS)[number];
    expect(sources).toContain('scripts/e2e-deploy.sh');
    // Real, existing directory so `${SCRIPT_DIR}/../<path>` resolves the same
    // way for the declared and the undeclared source.
    const text = `KNEXT_PRELOAD="\${SCRIPT_DIR}/../${path}"\n`;
    const undeclared = [{ relPath: 'scripts/undeclared-fixture.sh', text }];
    const declared = [{ relPath: 'scripts/e2e-deploy.sh', text }];
    expect(scriptDirRefs(text, resolve(REPO_ROOT, 'scripts'))).toContain(path);
    expect(unresolvedHarnessRefs(undeclared, new Set(), new Set())).toEqual([
      `scripts/undeclared-fixture.sh -> ${path}`,
    ]);
    expect(unresolvedHarnessRefs(declared, new Set(), new Set())).toEqual([]);
  });

  // #1294 round 6 — DATED_EXCEPTIONS is empty right now (its one real
  // subject was removed once #1311 landed and deleted the file it excused),
  // so these exercise `activeExemptions`'s lifecycle directly against a
  // SYNTHETIC fixture entry rather than a real, time-bound repo file: a
  // fixture cannot go stale the way a real subject can, and the mechanism
  // needs no live subject to stay tested.
  it('activeExemptions: a well-formed dated exception (fixture) is active before its expiry and points at a real file', () => {
    const fixture = [
      {
        path: 'scripts/compat-window-fingerprint.mjs',
        justification:
          'fixture entry for the dated-exemption mechanism test — not a real exception.',
        added: '2026-01-01',
        expires: '2099-01-01',
      },
    ];
    const active = activeExemptions(fixture, { field: 'path', now: new Date('2026-06-01') });
    expect(active.has('scripts/compat-window-fingerprint.mjs')).toBe(true);
    for (const path of active) {
      expect(existsSync(resolve(REPO_ROOT, path)), `fixture exception ${path} does not exist`).toBe(
        true,
      );
    }
  });

  it('activeExemptions: the SAME fixture entry goes INACTIVE once its expiry has passed — the clock actually fires', () => {
    const fixture = [
      {
        path: 'scripts/compat-window-fingerprint.mjs',
        justification:
          'fixture entry for the dated-exemption mechanism test — not a real exception.',
        added: '2026-01-01',
        expires: '2026-06-01',
      },
    ];
    const active = activeExemptions(fixture, { field: 'path', now: new Date('2026-06-02') });
    expect(active.has('scripts/compat-window-fingerprint.mjs')).toBe(false);
  });

  // The "or when the file is deleted and the exception still exists" half of
  // round 4's ask, kept GENERAL (over whatever DATED_EXCEPTIONS holds at any
  // given time) rather than tied to one now-gone subject: this is exactly
  // the guard that fired in CI once PR #1311 deleted
  // scripts/patch-vinext-3197.mjs while its exception was still declared —
  // proof the check works, not dead weight now that the array is empty. A
  // future dated exception added here is covered automatically.
  it('every currently-declared dated exception (if any) still points at a real file', () => {
    for (const { path } of DATED_EXCEPTIONS) {
      expect(
        existsSync(resolve(REPO_ROOT, path)),
        `${path}'s dated exception is still declared, but the file is gone — remove the exception`,
      ).toBe(true);
    }
  });

  for (const { lane, workflowFile } of credentialLanes()) {
    it(`lane "${lane}" (${workflowFile}): every node/bash/pin subprocess reference in the workflow is frozen or named`, () => {
      const workflowText = readFileSync(
        resolve(REPO_ROOT, '.github/workflows', workflowFile),
        'utf8',
      );
      const unresolved = unresolvedWorkflowRefs(
        workflowFile,
        workflowText,
        harnessFor(lane),
        activeDatedExceptionPaths(),
      );
      expect(
        unresolved,
        `${workflowFile} invokes these by subprocess; missing from lane "${lane}"'s harness and not a named exception`,
      ).toEqual([]);
    });

    it(`lane "${lane}": every ${'${SCRIPT_DIR}'}/${'${KNEXT_REPO_ROOT}'} reference AND every local import, in every harness file this lane actually includes, is frozen or named`, () => {
      const unresolved = unresolvedHarnessRefs(
        harnessCodeFiles(lane),
        harnessFor(lane),
        activeDatedExceptionPaths(),
      );
      expect(
        unresolved,
        `these harness references are missing from lane "${lane}"'s harness and not a named exception`,
      ).toEqual([]);
    });
  }

  // #1294 round 4, bullet 1: the declared extras' OWN imports, checked
  // EXPLICITLY (the pass above already covers this as a side effect of
  // scanning every harness file, but this test names the exact regression
  // round 4 found — compat-run-ledger.mjs importing ./compat-credential-
  // ref.mjs — so a future reader does not have to infer it from the general
  // pass).
  it("every declared CREDENTIAL_CELLS.extraFiles entry's own local imports are in that lane's harness", () => {
    for (const cell of CREDENTIAL_CELLS) {
      if (!cell.workflowFile) continue;
      const harness = harnessFor(cell.lane);
      for (const relPath of cell.extraFiles ?? []) {
        const abs = resolve(REPO_ROOT, relPath);
        if (!/\.(mjs|cjs|js)$/.test(relPath) || !existsSync(abs)) continue;
        const text = readFileSync(abs, 'utf8');
        for (const ref of jsImportRefs(text, dirname(abs))) {
          expect(
            harness.has(ref),
            `declared extra ${relPath} (lane "${cell.lane}") imports ${ref}, which is missing from the harness`,
          ).toBe(true);
        }
      }
    }
  });

  it('this scan is not vacuous: it finds real subprocess, ${SCRIPT_DIR}, and import references', () => {
    const workflowText = readFileSync(
      resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml'),
      'utf8',
    );
    expect(workflowSubprocessRefs(workflowText).length).toBeGreaterThan(0);

    let scriptDirHits = 0;
    let importHits = 0;
    for (const { relPath, text } of harnessCodeFiles('node')) {
      const fromDir = dirname(resolve(REPO_ROOT, relPath));
      scriptDirHits += scriptDirRefs(text, fromDir).length;
      if (/\.(mjs|cjs|js)$/.test(relPath)) importHits += jsImportRefs(text, fromDir).length;
    }
    expect(scriptDirHits).toBeGreaterThan(0);
    expect(importHits).toBeGreaterThan(0);
  });

  it('entryScripts() is non-vacuous (sanity for the helper other tests build on)', () => {
    expect(entryScripts().length).toBeGreaterThan(0);
  });

  // #1294 round 5 (jev 0.87) — the workflow subprocess regex previously
  // missed three real shapes: none appeared in either real workflow when
  // this was written, so these are direct unit tests of the scanner
  // function rather than assertions against the current tree (which the
  // "not vacuous" test above already covers for the shapes that DO occur
  // today).
  it('workflowSubprocessRefs matches node/bun with flags, and the ${{ github.workspace }} Actions-expression form', () => {
    expect(
      workflowSubprocessRefs('run: node "${{ github.workspace }}/knext/scripts/x.mjs"'),
    ).toEqual(['scripts/x.mjs']);
    expect(workflowSubprocessRefs('run: node --experimental-foo knext/scripts/x.mjs')).toEqual([
      'scripts/x.mjs',
    ]);
    expect(workflowSubprocessRefs('run: bun knext/scripts/x.mjs')).toEqual(['scripts/x.mjs']);
    expect(
      workflowSubprocessRefs('run: bash --posix "${{ github.workspace }}/knext/scripts/x.sh"'),
    ).toEqual(['scripts/x.sh']);
  });
});
