import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';

/**
 * #1294 round 3 (jev 0.84) — SCANNING TEST, INDEPENDENTLY REIMPLEMENTED.
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
 * reads the REAL workflow files and REAL harness scripts with its OWN parser
 * (deliberately not calling into `compat-window-fingerprint.mjs` — a scan
 * that shares its target's implementation would go green the same way the
 * target is wrong) and fails if it finds a repo-relative reference that is
 * neither in the lane's actual computed harness NOR a documented, reasoned
 * exception below.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/compat-window-fingerprint.mjs');

/**
 * NAMED EXCEPTIONS (#1294 round 3) — a repo-relative reference this scan
 * finds that is DELIBERATELY not declared in any lane's frozen closure, with
 * the reason recorded rather than silently allowlisted.
 */
const NAMED_EXCEPTIONS: { path: string; reason: string }[] = [
  // scripts/e2e-deploy.sh's contract-test-mode (KNEXT_E2E_SKIP_PACK=1)
  // fallback resolves these FOUR preloads from in-repo SOURCE rather than the
  // installed tarball. VERIFIED DEAD on every CI run: KNEXT_E2E_SKIP_PACK is
  // never set as an `env:` in either workflow (grep confirms zero hits), so
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
  },
  {
    path: 'packages/kn-next/src/adapters/bun-keepalive-guard.cjs',
    reason:
      'contract-test-mode-only fallback (KNEXT_E2E_SKIP_PACK=1), verified never set in CI; the active path is covered by the packed tarball hash.',
  },
  {
    path: 'packages/kn-next/src/adapters/sandbox-fetch-debug.cjs',
    reason:
      'contract-test-mode-only fallback (KNEXT_E2E_SKIP_PACK=1), verified never set in CI; the active path is covered by the packed tarball hash.',
  },
  {
    path: 'packages/kn-next/src/adapters/sandbox-fetch-realm-debug.cjs',
    reason:
      'contract-test-mode-only fallback (KNEXT_E2E_SKIP_PACK=1), verified never set in CI; the active path is covered by the packed tarball hash.',
  },
  // scripts/e2e-deploy-vinext.sh:342 — being DELETED by PR #1311 (vinext
  // beta.11), concurrent work on a sibling branch. NOT declared in any
  // lane's frozen closure since it is going away regardless. Once #1311
  // lands, re-run this scan: if it stops finding this reference at all, this
  // exception is dead weight and should be deleted; if a replacement script
  // appears in its place, THAT reference must be declared for real (not
  // re-exempted) or this scan will (correctly) go red on it.
  {
    path: 'scripts/patch-vinext-3197.mjs',
    reason:
      'being deleted by PR #1311 (vinext beta.11), concurrent work; not declared since it is going away — remove this exception once #1311 lands.',
  },
];

/** Every top-level scripts/e2e-* file — the closure ENTRY set, read the same way collectHarness discovers it. */
function entryScripts(): string[] {
  return readdirSync(resolve(REPO_ROOT, 'scripts')).filter((f) =>
    /^e2e-[^/]*\.(sh|mjs|cjs|js)$/.test(f),
  );
}

/** `node knext/scripts/X` / `bash knext/scripts/X` / `--pin knext/.github/X.json` references in a workflow's text. */
function workflowSubprocessRefs(workflowText: string): string[] {
  const found = new Set<string>();
  for (const m of workflowText.matchAll(
    /\bnode\s+(?:knext\/)?(scripts\/[\w./-]+\.(?:mjs|cjs|js))\b/g,
  )) {
    found.add(m[1]);
  }
  for (const m of workflowText.matchAll(/\bbash\s+(?:knext\/)?(scripts\/[\w./-]+\.sh)\b/g)) {
    found.add(m[1]);
  }
  for (const m of workflowText.matchAll(/--pin\s+(?:knext\/)?(\.github\/[\w./-]+\.json)/g)) {
    found.add(m[1]);
  }
  return [...found];
}

/**
 * `${SCRIPT_DIR}/X` and `${KNEXT_REPO_ROOT[:-…]}/X` references in a harness
 * script's OWN text — resolved to repo-relative paths. `SCRIPT_DIR` is
 * always the script's own directory (`scripts/`) by this repo's convention
 * (`SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`);
 * `KNEXT_REPO_ROOT` is already repo-root-relative.
 */
function scriptDirRefs(scriptText: string): string[] {
  const found = new Set<string>();
  // Path chars only: no `"`, `'`, whitespace, `)`, or `:` — the last excludes
  // docker `-v SRC:DST:MODE` mount syntax, where a bare path-char class would
  // swallow the container-side path and mode flag as if they were part of
  // the repo-relative reference.
  for (const m of scriptText.matchAll(/\$\{SCRIPT_DIR\}\/([^"'\s):]+)/g)) {
    found.add(posix.normalize(posix.join('scripts', m[1])));
  }
  for (const m of scriptText.matchAll(/\$\{KNEXT_REPO_ROOT(?::-[^}]*)?\}\/([^"'\s):]+)/g)) {
    found.add(posix.normalize(m[1]));
  }
  return [...found];
}

/** The real, computed harness set for a lane. */
function harnessFor(lane: string): Set<string> {
  const tarballsDir = mkdtempSync(join(tmpdir(), 'knext-fp-execscan-tb-'));
  const stage = mkdtempSync(join(tmpdir(), 'knext-fp-execscan-pkg-'));
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
}

describe('compat-window fingerprint — execution scan: every node/bash/${SCRIPT_DIR}/${KNEXT_REPO_ROOT} reference is frozen or named (#1294 round 3)', () => {
  it('KNEXT_E2E_SKIP_PACK is never set in a workflow env — the contract-test-mode preload exceptions stay honestly dead', () => {
    for (const wf of ['test-e2e-deploy.yml', 'compat-vinext.yml']) {
      const text = readFileSync(resolve(REPO_ROOT, '.github/workflows', wf), 'utf8');
      expect(
        text,
        `${wf} sets KNEXT_E2E_SKIP_PACK — the contract-test-mode preload exceptions in this scan are no longer honest and must be re-evaluated`,
      ).not.toMatch(/KNEXT_E2E_SKIP_PACK\s*:/);
    }
  });

  it('every NAMED EXCEPTION resolves to a real file, so the exception list cannot rot into pointing at nothing', () => {
    for (const { path } of NAMED_EXCEPTIONS) {
      expect(existsSync(resolve(REPO_ROOT, path)), `named exception ${path} does not exist`).toBe(
        true,
      );
    }
  });

  for (const [lane, workflowFile] of [
    ['node', 'test-e2e-deploy.yml'],
    ['bun', 'test-e2e-deploy.yml'],
    ['bun-vinext', 'compat-vinext.yml'],
  ] as const) {
    it(`lane "${lane}" (${workflowFile}): every node/bash/pin subprocess reference in the workflow is frozen or named`, () => {
      const workflowText = readFileSync(
        resolve(REPO_ROOT, '.github/workflows', workflowFile),
        'utf8',
      );
      const harness = harnessFor(lane);
      const exceptionPaths = new Set(NAMED_EXCEPTIONS.map((e) => e.path));

      for (const ref of workflowSubprocessRefs(workflowText)) {
        // compat-window-fingerprint.mjs itself is the TOOL computing the
        // digest, never a subject of it — excluded by construction, not by
        // exception.
        if (ref === 'scripts/compat-window-fingerprint.mjs') continue;
        expect(
          harness.has(ref) || exceptionPaths.has(ref),
          `${workflowFile} invokes ${ref} by subprocess; missing from lane "${lane}"'s harness and not a named exception`,
        ).toBe(true);
      }
    });
  }

  it('every ${SCRIPT_DIR}/${KNEXT_REPO_ROOT} reference in every entry script is frozen or named', () => {
    const harness = harnessFor('node'); // the shared half (scripts/) is lane-independent
    const exceptionPaths = new Set(NAMED_EXCEPTIONS.map((e) => e.path));

    for (const entry of entryScripts()) {
      const text = readFileSync(resolve(REPO_ROOT, 'scripts', entry), 'utf8');
      for (const ref of scriptDirRefs(text)) {
        expect(
          harness.has(ref) || exceptionPaths.has(ref),
          `scripts/${entry} references ${ref} via \${SCRIPT_DIR}/\${KNEXT_REPO_ROOT}; missing from the harness and not a named exception`,
        ).toBe(true);
      }
    }
  });

  it('this scan is not vacuous: it finds at least one real subprocess reference and at least one real ${SCRIPT_DIR} reference', () => {
    const workflowText = readFileSync(
      resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml'),
      'utf8',
    );
    expect(workflowSubprocessRefs(workflowText).length).toBeGreaterThan(0);
    let scriptDirHits = 0;
    for (const entry of entryScripts()) {
      scriptDirHits += scriptDirRefs(
        readFileSync(resolve(REPO_ROOT, 'scripts', entry), 'utf8'),
      ).length;
    }
    expect(scriptDirHits).toBeGreaterThan(0);
  });
});
