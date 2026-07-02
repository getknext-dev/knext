import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * GUARD TESTS for #147 A3-3 fix round 1 (triage of baseline run 28558576615).
 *
 * That run's 491 "failures" carried ZERO adapter signal: `scripts/e2e-deploy.sh`
 * packed @knext/core with `npm pack`, which ships pnpm's raw `workspace:^` dep on
 * @knext/lib verbatim (npm does NOT rewrite the workspace protocol on pack) → the
 * per-fixture `npm install <tarball>` died with EUNSUPPORTEDPROTOCOL in EVERY
 * fixture, `next build` ran ZERO times, and 472/473 real failing files were this
 * ONE bug. These tests pin the fix:
 *
 *  1. Tarballs are packed with `pnpm pack` (rewrites `workspace:^` → real semver)
 *     for BOTH @knext/lib AND @knext/core, ONCE in the workflow (not per test —
 *     per-test packing also raced at runner concurrency 2), staged at a stable
 *     path the deploy script reuses via KNEXT_E2E_TARBALLS_DIR.
 *  2. Both tarballs are installed in ONE `npm install` so npm satisfies the
 *     rewritten `@knext/lib@^x` dep from the local lib tarball (it is not on npm
 *     yet — #53 is human-blocked).
 *  3. A fail-fast PREFLIGHT gate (scripts/e2e-preflight.mjs: scratch npm install
 *     + adapter resolve smoke) runs in build-next BEFORE the 16 shards spawn and
 *     again in each shard after artifact transport — a packaging regression can
 *     never again burn a full run on an uninstallable tarball.
 *  4. The Playwright chromium cache key is version-shaped (the old extraction
 *     leaked `<ver>/node_modules/playwright-chromium` into the key → permanent
 *     cache miss + 4×10-min timed-out downloads on 9/16 shards) and build-next
 *     warms the cache so shards exact-hit.
 *  5. Timeout headroom: with real `next build`s per fixture the old 60-min shard
 *     limit is a near-certain blowout — 120-min job, a bounded run step, and
 *     `if: always()` on summarize/upload so a timed-out shard still reports
 *     partial results.
 *
 * Same text-scan style as tests/compat-suite-workflow.test.ts (no YAML dep).
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');
const DEPLOY_SH = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');
const PREFLIGHT_MJS = resolve(REPO_ROOT, 'scripts/e2e-preflight.mjs');
const INSTALL_SMOKE_MJS = resolve(REPO_ROOT, 'scripts/install-smoke.mjs');

function workflowText(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

function deployShText(): string {
  return readFileSync(DEPLOY_SH, 'utf8');
}

/** Slice a top-level job block (indent 2) out of the workflow text. */
function jobBlock(jobId: string): string {
  const lines = workflowText().split('\n');
  const start = lines.findIndex((l) => new RegExp(`^ {2}${jobId}:\\s*$`).test(l));
  expect(start, `job "${jobId}" must exist in the workflow`).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  \S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** Split a job block into step blocks at each `- name:` boundary. */
function stepBlocks(job: string): string[] {
  const lines = job.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) blocks.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    if (/^\s*-\s+name:/.test(line)) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

function findStep(job: string, namePattern: RegExp): string {
  const step = stepBlocks(job).find((b) => {
    const nameLine = b.split('\n').find((l) => /^\s*-\s+name:/.test(l));
    return nameLine !== undefined && namePattern.test(nameLine);
  });
  expect(step, `a step matching ${namePattern} must exist`).toBeDefined();
  return step as string;
}

describe('compat-suite installable adapter tarball — pack once with pnpm pack (#147 fix round 1)', () => {
  it('build-next packs BOTH @knext/lib and @knext/core with `pnpm pack` into a stable knext-tarballs dir', () => {
    const job = jobBlock('build-next');
    const pack = findStep(job, /[Pp]ack .*(tarball|adapter)/);
    expect(pack).toMatch(/pnpm pack/);
    expect(pack).toMatch(/--pack-destination/);
    expect(pack).toMatch(/packages\/lib/);
    expect(pack).toMatch(/packages\/kn-next/);
    expect(pack).toMatch(/knext-tarballs/);
  });

  it('nothing in the workflow runs a bare `npm pack` (the workspace:^ regression vector)', () => {
    // `npm pack "next@…"` / `npm pack "${pkg}@…"` (published packages) are fine —
    // only a BARE `npm pack` of a local workspace package ships raw workspace:^.
    const bare = workflowText()
      .split('\n')
      .filter((l) => /(^|[;&|]\s*|\s)npm pack\s*($|\s*\||\s*>)/.test(l));
    expect(bare, `bare npm pack lines found:\n${bare.join('\n')}`).toEqual([]);
  });

  it('the workspace tarball handoff ships the knext-tarballs dir to the shards', () => {
    const job = jobBlock('build-next');
    const tarStep = findStep(job, /Pack workspace tarball/);
    expect(tarStep).toMatch(/\.\/knext-tarballs/);
  });

  it('the shard unpack asserts the tarballs dir survived transport', () => {
    const job = jobBlock('deploy-tests');
    const unpack = findStep(job, /Unpack workspace tarball/);
    expect(unpack).toMatch(/test -d knext-tarballs/);
  });

  it('the run step hands the pre-packed tarballs to e2e-deploy.sh via KNEXT_E2E_TARBALLS_DIR', () => {
    const job = jobBlock('deploy-tests');
    const run = findStep(job, /Run official deploy tests/);
    expect(run).toMatch(
      /KNEXT_E2E_TARBALLS_DIR:\s*\$\{\{\s*github\.workspace\s*\}\}\/knext-tarballs/,
    );
  });
});

describe('compat-suite fail-fast preflight gate (#147 fix round 1)', () => {
  it('scripts/e2e-preflight.mjs exists and is the committed, locally-runnable gate', () => {
    expect(existsSync(PREFLIGHT_MJS)).toBe(true);
    const text = readFileSync(PREFLIGHT_MJS, 'utf8');
    // The gate must do a REAL dependency-resolving npm install + a resolve smoke.
    expect(text).toMatch(/npm/);
    expect(text).toMatch(/@knext\/core\/adapter/);
    expect(text).toMatch(/::error::/);
  });

  it('build-next runs the preflight AFTER packing and BEFORE uploading the workspace (16 shards never spawn on a bad tarball)', () => {
    const job = jobBlock('build-next');
    const steps = stepBlocks(job);
    const idx = (re: RegExp) =>
      steps.findIndex((b) => {
        const nameLine = b.split('\n').find((l) => /^\s*-\s+name:/.test(l));
        return nameLine !== undefined && re.test(nameLine);
      });
    const packIdx = idx(/[Pp]ack .*(tarball|adapter)/);
    const preflightIdx = idx(/[Pp]reflight/);
    const uploadIdx = idx(/Upload workspace/);
    expect(packIdx).toBeGreaterThanOrEqual(0);
    expect(preflightIdx).toBeGreaterThan(packIdx);
    expect(uploadIdx).toBeGreaterThan(preflightIdx);
    expect(steps[preflightIdx]).toMatch(/e2e-preflight\.mjs/);
  });

  it('each shard re-runs the preflight after artifact transport, before run-tests', () => {
    const job = jobBlock('deploy-tests');
    const steps = stepBlocks(job);
    const idx = (re: RegExp) =>
      steps.findIndex((b) => {
        const nameLine = b.split('\n').find((l) => /^\s*-\s+name:/.test(l));
        return nameLine !== undefined && re.test(nameLine);
      });
    const preflightIdx = idx(/[Pp]reflight/);
    const runIdx = idx(/Run official deploy tests/);
    expect(preflightIdx).toBeGreaterThanOrEqual(0);
    expect(runIdx).toBeGreaterThan(preflightIdx);
    expect(steps[preflightIdx]).toMatch(/e2e-preflight\.mjs/);
  });
});

describe('compat-suite Playwright cache-key + warm cache fix (#147 fix round 1)', () => {
  it('no step uses the leaky path-into-version extraction (`s/.*playwright-chromium@//p`)', () => {
    // Run 28558576615: the sed leaked `…@<ver>/node_modules/playwright-chromium`
    // into the cache key (`playwright-chromium-Linux-1.58.2/node_modules/…`) →
    // exact-hit impossible, stale 2MB fallback, 4×10-min timed-out downloads on
    // 9/16 shards (~41 wasted minutes each).
    expect(workflowText()).not.toContain('s/.*playwright-chromium@//p');
  });

  it('resolves the playwright version from the installed package.json and validates its shape', () => {
    for (const jobId of ['build-next', 'deploy-tests']) {
      const step = findStep(jobBlock(jobId), /Resolve Playwright version/);
      expect(step, `${jobId} version resolve must read the package manifest`).toMatch(
        /playwright-chromium\/package\.json/,
      );
      // A version-shape gate so a path/garbage value can never key the cache again.
      expect(step, `${jobId} must validate the version shape`).toMatch(/\[0-9\]\+\\\.\[0-9\]\+/);
      expect(step, `${jobId} must fall back to 'unknown' on a non-version value`).toMatch(
        /unknown/,
      );
    }
  });

  it('build-next WARMS the chromium cache so the 16 shards exact-hit instead of 16 concurrent CDN downloads', () => {
    const job = jobBlock('build-next');
    const cache = findStep(job, /Cache Playwright browsers/);
    expect(cache).toMatch(/~\/\.cache\/ms-playwright/);
    expect(cache).toMatch(/playwright-chromium-\$\{\{\s*runner\.os\s*\}\}/);
    const install = findStep(job, /Install Playwright chromium/);
    expect(install).toMatch(/playwright install chromium/);
  });
});

describe('compat-suite shard timeout headroom + always-report (#147 fix round 1)', () => {
  it('deploy-tests shards get 120 minutes (real next builds per fixture blow out 60)', () => {
    const job = jobBlock('deploy-tests');
    const m = job.match(/^\s{4}timeout-minutes:\s*(\d+)\s*$/m);
    expect(m, 'deploy-tests must declare a job-level timeout-minutes').not.toBeNull();
    expect(Number((m as RegExpMatchArray)[1])).toBeGreaterThanOrEqual(120);
  });

  it('the run step is bounded BELOW the job timeout so the summarize/upload tail always has room', () => {
    const job = jobBlock('deploy-tests');
    const run = findStep(job, /Run official deploy tests/);
    const m = run.match(/timeout-minutes:\s*(\d+)/);
    expect(m, 'the run step must carry its own timeout-minutes').not.toBeNull();
    const jobTimeout = Number(
      (job.match(/^\s{4}timeout-minutes:\s*(\d+)\s*$/m) as RegExpMatchArray)[1],
    );
    expect(Number((m as RegExpMatchArray)[1])).toBeLessThan(jobTimeout);
  });

  it('summarize + upload (and the excluded-count input) run even when the shard failed or timed out', () => {
    const job = jobBlock('deploy-tests');
    for (const name of [
      /Compute excluded count/,
      /Summarize shard result/,
      /Upload summary artifact/,
    ]) {
      const step = findStep(job, name);
      expect(step, `${name} must carry if: always()`).toMatch(/if:\s*always\(\)/);
    }
  });
});

describe('scripts/e2e-deploy.sh installs an npm-installable dual tarball (#147 fix round 1)', () => {
  it('never executes `npm pack` (npm ships raw workspace:^ — the 472-failure bug)', () => {
    const executable = deployShText()
      .split('\n')
      .filter((l) => !/^\s*#/.test(l));
    expect(executable.filter((l) => /\bnpm pack\b/.test(l))).toEqual([]);
  });

  it('packs with `pnpm pack` in the local fallback path', () => {
    expect(deployShText()).toMatch(/pnpm pack/);
  });

  it('installs the lib AND core tarballs in ONE npm install (npm satisfies @knext/lib from the local tarball)', () => {
    const line = deployShText()
      .split('\n')
      .find((l) => /^\s*npm install\b/.test(l));
    expect(line, 'an npm install line must exist').toBeDefined();
    expect(line).toMatch(/LIB_TGZ/);
    expect(line).toMatch(/CORE_TGZ/);
  });

  it('reuses pre-packed tarballs via KNEXT_E2E_TARBALLS_DIR (pack once per shard, not per test)', () => {
    expect(deployShText()).toMatch(/KNEXT_E2E_TARBALLS_DIR/);
  });

  it('invokes the FIXTURE-LOCAL next binary (node_modules/.bin/next), never a bare `next build`', () => {
    // Branch run 28561839378: with the tarball install finally working, EVERY
    // real test then died with `next: command not found` (127) — the fixture's
    // node_modules/.bin is NOT on the deploy script's PATH in the harness env
    // (the harness installs next INTO the fixture dir via NEXT_TEST_PKG_PATHS).
    // The script must resolve the app-local binary explicitly and refuse a
    // global fallback (which would build with the wrong next version).
    const text = deployShText();
    expect(text).toMatch(/NEXT_BIN="\$\{APP_DIR\}\/node_modules\/\.bin\/next"/);
    expect(text).toMatch(/"\$\{NEXT_BIN\}" build/);
    // No executable line may invoke `next build` as a bare command.
    const bareInvocations = text
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .filter((l) => /(?:^|[;&|]\s*)next\s+build\b/.test(l));
    expect(bareInvocations).toEqual([]);
    // And the absence of the binary must fail loud, not fall through.
    expect(text).toMatch(/-x "\$\{NEXT_BIN\}"/);
  });

  it('guards the local pack-once fallback with a lock (per-test packing raced at concurrency 2)', () => {
    // mkdir-based lock — atomic on POSIX; the exact implementation may evolve but
    // some lock must serialize concurrent packs into the shared stable dir.
    expect(deployShText()).toMatch(/\.lock/);
    expect(deployShText()).toMatch(/mkdir "?\$\{?LOCK_DIR\}?"?/);
  });

  it('fails loudly (non-zero, named cause) when KNEXT_E2E_TARBALLS_DIR is set but empty', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'knext-tarballs-empty-'));
    const appDir = mkdtempSync(join(tmpdir(), 'knext-e2e-app-empty-'));
    try {
      const r = spawnSync('bash', [DEPLOY_SH], {
        cwd: appDir,
        env: { ...process.env, KNEXT_E2E_TARBALLS_DIR: emptyDir },
        encoding: 'utf8',
        timeout: 30000,
      });
      expect(r.status).not.toBe(0);
      expect(`${r.stderr}`).toMatch(/tarball/i);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
      rmSync(appDir, { recursive: true, force: true });
    }
  });
});

describe('install-smoke gate hardening — tarball manifests must be workspace:-free (#147 fix round 1)', () => {
  // WHY: the install-smoke job passed on main while the compat run's installs all
  // failed — NOT because its install was weak (it already pnpm-packs + installs
  // both tarballs with full dependency resolution) but because e2e-deploy.sh used
  // a DIFFERENT pack path (`npm pack`) that no gate covered. Defense-in-depth:
  // both the smoke and the preflight now also assert the packed manifests carry
  // NO `workspace:` specifier, so the failure names its cause instead of
  // surfacing as a downstream EUNSUPPORTEDPROTOCOL.
  it('install-smoke.mjs inspects the packed manifests for workspace: protocol leaks', () => {
    const text = readFileSync(INSTALL_SMOKE_MJS, 'utf8');
    expect(text).toMatch(/findWorkspaceProtocolDeps|workspace:/);
    expect(text).toMatch(/workspace-protocol\.mjs|findWorkspaceProtocolDeps/);
  });
});

afterAll(() => {
  // best-effort: nothing persistent to clean beyond the per-test temp dirs above.
});
