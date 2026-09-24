import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  COMPAT_MODES,
  isRcRef,
  isRcTag,
  PIN_FILE,
  resolveCredentialRef,
} from '../scripts/compat-credential-ref.mjs';
import { buildLedger } from '../scripts/compat-run-ledger.mjs';
import {
  auditCredentialMatrix,
  auditWindow,
  CREDENTIAL_CELLS,
  formatReport,
  gradeNight,
  MODE_MARKER_PREFIX,
  modeFromArtifacts,
  selectLaneNights,
  unresolvedNight,
} from '../scripts/compat-window-audit.mjs';
import { computeFingerprint } from '../scripts/compat-window-fingerprint.mjs';
import { evaluate, exprBody } from './helpers/gha-expr';

/**
 * #850 / ADR-0056 — credential v1.0 against a FROZEN release-candidate tag, one
 * window per runtime×builder cell.
 *
 * The three guards the ADR names, each mutation-proved by exit code in
 * `scripts/mutation-prove-compat-credential-ref.mjs`:
 *
 *   1. a `main`-ref night NEVER increments a credential window;
 *   2. a fingerprint change for cell X restarts X's window and not cell Y's;
 *   3. the credential lane REFUSES to run with no RC ref resolvable — it never
 *      silently falls back to `main`.
 *
 * Every guard is asserted in BOTH directions: the thing it forbids is red, and
 * the thing it permits is green. A guard that only checks one half passes an
 * implementation that does nothing at all.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESOLVER = join(REPO_ROOT, 'scripts/compat-credential-ref.mjs');
const WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const MAIN_SHA = 'c'.repeat(40);

type ShardRow = Record<string, unknown> & { shard: string };

let seq = 40_000_000_000;
/** A green 16-shard scheduled night. Defaults to an RC credential night. */
function night(over: Record<string, unknown> = {}) {
  seq += 1;
  const lane = (over.lane as string) ?? 'node';
  // Every shard proves bytecode caching LIVE for the cell's runtime — the
  // shape a credential night must carry (tests/bytecode-liveness.test.ts).
  const runtime = lane.startsWith('bun') ? 'bun' : 'node';
  const shards: ShardRow[] = Array.from({ length: 16 }, (_, i) => ({
    shard: `${i + 1}/16`,
    passed: 49,
    failed: 0,
    notRun: 0,
    runtime: lane,
    bytecode: { runtime, deploys: 3, live: 3, notLive: 0, reasons: [] },
  }));
  return {
    runId: String(seq),
    runAttempt: '1',
    event: 'schedule',
    lane,
    ref: 'v16.2.0',
    compatMode: 'credential',
    credential: true,
    knextRef: 'refs/tags/v1.0.0-rc.1',
    knextSha: SHA_A,
    workflowSha: MAIN_SHA,
    complete: true,
    shardsExpected: 16,
    shardsSeen: 16,
    missingShards: [],
    windowFingerprint: 'sha256:aaaa',
    shards,
    ...over,
  };
}

/** A scheduled run whose ledger was lost, IN SEQUENCE with `night()`. */
function lost(lane: string | null, mode: string | null) {
  seq += 1;
  return unresolvedNight(String(seq), 'no-ledger', lane, mode);
}

/** A `main` early-warning night: the shape the two pre-existing crons produce. */
function mainNight(over: Record<string, unknown> = {}) {
  return night({
    compatMode: 'early-warning',
    credential: false,
    knextRef: 'refs/heads/main',
    knextSha: MAIN_SHA,
    ...over,
  });
}

function hasReason(graded: { disqualifiers: string[] }, token: string) {
  return graded.disqualifiers.some((d) => d === token || d.startsWith(`${token}:`));
}

// ── Guard 3: resolution refuses rather than falling back to main ─────────────

describe('guard 3 — the credential ref resolves to an RC tag or refuses (never main)', () => {
  const lsRemoteOk = (tag: string) => ({ sha: tag === 'v1.0.0-rc.1' ? SHA_A : null });
  const pin = (rcTag: unknown) => JSON.stringify({ rcTag });

  it('resolves a pinned, existing RC tag to its peeled commit — and to nothing else', () => {
    const r = resolveCredentialRef({
      mode: 'credential',
      pinText: pin('v1.0.0-rc.1'),
      lsRemote: lsRemoteOk,
      githubSha: MAIN_SHA,
      githubRef: 'refs/heads/main',
    });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('resolved');
    expect(r.checkoutRef).toBe('refs/tags/v1.0.0-rc.1');
    expect(r.checkoutSha).toBe(SHA_A);
    expect(r.checkoutSha).not.toBe(MAIN_SHA);
  });

  const refusals: Array<[string, Record<string, unknown>, string]> = [
    ['no pin file at all', { pinText: null }, 'pin-missing'],
    ['a pin that is not JSON', { pinText: '{not json' }, 'pin-unreadable'],
    ['the declared not-cut-yet state (rcTag: null)', { pinText: pin(null) }, 'not-cut'],
    ['a pin naming a branch', { pinText: pin('main') }, 'pin-malformed'],
    ['a pin naming a final release, not an RC', { pinText: pin('v1.0.0') }, 'pin-malformed'],
    ['a pin whose tag does not exist', { pinText: pin('v1.0.0-rc.9') }, 'tag-missing'],
    [
      'a pin whose tag cannot be resolved (ls-remote failed)',
      {
        pinText: pin('v1.0.0-rc.1'),
        lsRemote: () => {
          throw new Error('network down');
        },
      },
      'tag-unresolvable',
    ],
  ];
  for (const [label, over, state] of refusals) {
    it(`REFUSES on ${label} — and does not hand back main's sha`, () => {
      const r = resolveCredentialRef({
        mode: 'credential',
        pinText: null,
        lsRemote: lsRemoteOk,
        githubSha: MAIN_SHA,
        githubRef: 'refs/heads/main',
        ...over,
      });
      expect(r.ok).toBe(false);
      expect(r.state).toBe(state);
      // The fail-closed property itself: a refusal carries NO checkout target,
      // so no downstream step can quietly check out main in its place.
      expect(r.checkoutSha ?? null).toBeNull();
      expect(r.checkoutRef ?? null).toBeNull();
    });
  }

  it('an unknown mode is refused, not treated as early-warning', () => {
    const r = resolveCredentialRef({
      mode: 'credentail',
      pinText: pin('v1.0.0-rc.1'),
      lsRemote: lsRemoteOk,
      githubSha: MAIN_SHA,
      githubRef: 'refs/heads/main',
    });
    expect(r.ok).toBe(false);
    expect(r.checkoutSha ?? null).toBeNull();
  });

  it('early-warning mode runs the executing main commit and never reads the pin', () => {
    const r = resolveCredentialRef({
      mode: 'early-warning',
      pinText: null,
      lsRemote: () => {
        throw new Error('must not be called');
      },
      githubSha: MAIN_SHA,
      githubRef: 'refs/heads/main',
    });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('early-warning');
    expect(r.checkoutSha).toBe(MAIN_SHA);
    expect(r.checkoutRef).toBe('refs/heads/main');
  });

  it('the RC shape is exact: vX.Y.Z-rc.N, and only as a tag ref', () => {
    expect(isRcTag('v1.0.0-rc.1')).toBe(true);
    expect(isRcTag('v1.2.10-rc.12')).toBe(true);
    for (const bad of [
      'v1.0.0',
      'main',
      '1.0.0-rc.1',
      'v1.0.0-rc',
      'v1.0.0-rc.1x',
      'v1.0.0-beta.1',
      '',
    ]) {
      expect(isRcTag(bad)).toBe(false);
    }
    expect(isRcRef('refs/tags/v1.0.0-rc.1')).toBe(true);
    for (const bad of [
      'refs/heads/main',
      'refs/heads/v1.0.0-rc.1',
      'v1.0.0-rc.1',
      null,
      undefined,
    ]) {
      expect(isRcRef(bad as string)).toBe(false);
    }
  });

  it('the checked-in pin is valid JSON and declares the not-cut-yet state (no RC is cut by this change)', () => {
    const text = readFileSync(join(REPO_ROOT, PIN_FILE), 'utf8');
    const parsed = JSON.parse(text);
    expect('rcTag' in parsed).toBe(true);
    expect(parsed.rcTag === null || isRcTag(parsed.rcTag)).toBe(true);
  });

  describe('the CLI exits non-zero on refusal and writes no checkout target', () => {
    function runCli(pinBody: string | null, mode = 'credential') {
      const dir = mkdtempSync(join(tmpdir(), 'cred-ref-'));
      try {
        const pinPath = join(dir, 'pin.json');
        if (pinBody !== null) writeFileSync(pinPath, pinBody);
        const out = join(dir, 'gh-output');
        writeFileSync(out, '');
        const r = spawnSync(
          process.execPath,
          [RESOLVER, '--mode', mode, '--pin', pinPath, '--remote-dir', dir],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              GITHUB_OUTPUT: out,
              GITHUB_SHA: MAIN_SHA,
              GITHUB_REF: 'refs/heads/main',
            },
          },
        );
        return { status: r.status, output: readFileSync(out, 'utf8'), stderr: r.stderr };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('refuses (exit != 0) with the not-cut pin, and records the state for the alert', () => {
      const r = runCli(JSON.stringify({ rcTag: null }));
      expect(r.status).not.toBe(0);
      expect(r.output).toMatch(/^state=not-cut$/m);
      expect(r.output).not.toMatch(/^checkout_sha=\S/m);
    });

    it('refuses (exit != 0) with no pin file', () => {
      const r = runCli(null);
      expect(r.status).not.toBe(0);
      expect(r.output).toMatch(/^state=pin-missing$/m);
      expect(r.output).not.toMatch(/^checkout_sha=\S/m);
    });

    it('early-warning exits 0 and checks out the executing sha', () => {
      const r = runCli(null, 'early-warning');
      expect(r.status).toBe(0);
      expect(r.output).toMatch(new RegExp(`^checkout_sha=${MAIN_SHA}$`, 'm'));
      expect(r.output).toMatch(/^credential=false$/m);
    });
  });
});

// ── Guard 1: a main-ref night never increments a credential window ───────────

describe('guard 1 — a main-ref night never advances a credential count', () => {
  it('fourteen green main nights bank ZERO credential nights', () => {
    const ledgers = Array.from({ length: 14 }, () => mainNight());
    const a = auditWindow(ledgers, { lane: 'node' });
    expect(a.scope).toBe('credential');
    expect(a.nights).toHaveLength(0);
    expect(a.current.nights).toBe(0);
    expect(a.met).toBe(false);
  });

  it('the other half: fourteen green RC nights DO meet the gate', () => {
    const a = auditWindow(
      Array.from({ length: 14 }, () => night()),
      { lane: 'node' },
    );
    expect(a.current.nights).toBe(14);
    expect(a.met).toBe(true);
  });

  it('main nights interleaved with RC nights neither extend nor break the RC streak', () => {
    const ledgers = [];
    for (let i = 0; i < 5; i += 1) {
      ledgers.push(night());
      // A red main night in between: it must not restart the credential count…
      ledgers.push(mainNight({ windowFingerprint: `sha256:main-${i}`, shards: [] }));
    }
    const a = auditWindow(ledgers, { lane: 'node' });
    // …and a green one must not add to it.
    expect(a.current.nights).toBe(5);
    expect(a.nights.every((n: { runId: string }) => n.runId !== '')).toBe(true);
  });

  it('a night that CLAIMS credential on a main ref is disqualified (and restarts), not counted', () => {
    const forged = night({ knextRef: 'refs/heads/main', knextSha: MAIN_SHA });
    const g = gradeNight(forged, { lane: 'node' });
    expect(g.eligible).toBe(false);
    expect(hasReason(g, 'non-credential-ref')).toBe(true);
    // Built IN ORDER (runIds are sequential): two good nights, the forged one,
    // one more. The forged night must restart the count, so the streak is 1.
    const before = [night(), night()];
    const forgedInOrder = night({ knextRef: 'refs/heads/main', knextSha: MAIN_SHA });
    const after = night();
    const a = auditWindow([...before, forgedInOrder, after], { lane: 'node' });
    expect(a.current.nights).toBe(1);
    expect(a.nights).toHaveLength(4);
  });

  it('an RC-shaped ref alone is a claim too — it cannot count without the credential flag', () => {
    const halfClaim = night({ credential: false, compatMode: 'early-warning' });
    expect(selectLaneNights([halfClaim], 'node')).toHaveLength(1);
    expect(gradeNight(halfClaim, { lane: 'node' }).eligible).toBe(false);
  });

  it('a night with no knext sha cannot count', () => {
    expect(
      hasReason(gradeNight(night({ knextSha: undefined }), { lane: 'node' }), 'no-knext-sha'),
    ).toBe(true);
  });

  it('a pre-#850 ledger (no mode, no ref) is not a credential night', () => {
    const legacy = night({
      compatMode: undefined,
      credential: undefined,
      knextRef: undefined,
      knextSha: undefined,
    });
    expect(selectLaneNights([legacy], 'node')).toHaveLength(0);
  });

  it('the early-warning scope reports main, and its report never says GATE MET', () => {
    const ledgers = Array.from({ length: 14 }, () => mainNight());
    const a = auditWindow(ledgers, { lane: 'node', scope: 'early-warning' });
    expect(a.current.nights).toBe(14);
    expect(a.met).toBe(false);
    const report = formatReport(a);
    expect(report).not.toMatch(/GATE MET/);
    expect(report).toMatch(/EARLY WARNING/);
  });

  it('an unresolved night whose MODE marker says early-warning cannot restart a credential window', () => {
    const ledgers = [night(), night(), lost('node', 'early-warning'), night()];
    const a = auditWindow(ledgers, { lane: 'node' });
    expect(a.nights).toHaveLength(3);
    expect(a.current.nights).toBe(3);
  });

  it('…while one with an UNKNOWN mode is admitted and fails closed', () => {
    const ledgers = [night(), night(), lost('node', null), night()];
    const a = auditWindow(ledgers, { lane: 'node' });
    expect(a.nights).toHaveLength(4);
    expect(a.current.nights).toBe(1);
  });

  it('reads the mode from the marker artifact NAME, null when absent or conflicting', () => {
    expect(MODE_MARKER_PREFIX).toBe('compat-mode-');
    expect(modeFromArtifacts([{ name: 'compat-mode-credential' }])).toBe('credential');
    expect(modeFromArtifacts([{ name: 'compat-run-ledger' }])).toBeNull();
    expect(
      modeFromArtifacts([
        { name: 'compat-mode-credential' },
        { name: 'compat-mode-early-warning' },
      ]),
    ).toBeNull();
    expect(COMPAT_MODES).toEqual(['credential', 'early-warning']);
  });
});

// ── Guard 2: per-cell windows keyed on each cell's own fingerprint ───────────

describe('guard 2 — a fingerprint change for cell X restarts X and not Y', () => {
  function interleaved(bunFingerprintAt: (i: number) => string) {
    const ledgers = [];
    for (let i = 0; i < 14; i += 1) {
      ledgers.push(night({ lane: 'node', windowFingerprint: 'sha256:node-1' }));
      ledgers.push(night({ lane: 'bun', windowFingerprint: bunFingerprintAt(i) }));
    }
    return ledgers;
  }

  it('bun moves at night 10: bun restarts, node banks 14', () => {
    const m = auditCredentialMatrix(
      interleaved((i) => (i < 10 ? 'sha256:bun-1' : 'sha256:bun-2')),
      { cells: ['node', 'bun'] },
    );
    expect(m.cells.node.current.nights).toBe(14);
    expect(m.cells.node.met).toBe(true);
    expect(m.cells.bun.current.nights).toBe(4);
    expect(m.cells.bun.streaks.at(-1)?.restartCause).toBe('fingerprint-changed');
    expect(m.allMet).toBe(false);
  });

  it('the other half: both stable → both met, allMet', () => {
    const m = auditCredentialMatrix(
      interleaved(() => 'sha256:bun-1'),
      { cells: ['node', 'bun'] },
    );
    expect(m.cells.bun.current.nights).toBe(14);
    expect(m.allMet).toBe(true);
  });

  it('cutting rc.2 with an UNCHANGED cell fingerprint does not restart that cell', () => {
    const ledgers = [
      ...Array.from({ length: 7 }, () =>
        night({ knextRef: 'refs/tags/v1.0.0-rc.1', knextSha: SHA_A }),
      ),
      ...Array.from({ length: 7 }, () =>
        night({ knextRef: 'refs/tags/v1.0.0-rc.2', knextSha: SHA_B }),
      ),
    ];
    expect(auditWindow(ledgers, { lane: 'node' }).current.nights).toBe(14);
  });

  it('…and cutting rc.2 that MOVES the fingerprint restarts it', () => {
    const ledgers = [
      ...Array.from({ length: 7 }, () => night({ knextRef: 'refs/tags/v1.0.0-rc.1' })),
      ...Array.from({ length: 7 }, () =>
        night({
          knextRef: 'refs/tags/v1.0.0-rc.2',
          knextSha: SHA_B,
          windowFingerprint: 'sha256:bbbb',
        }),
      ),
    ];
    expect(auditWindow(ledgers, { lane: 'node' }).current.nights).toBe(7);
  });

  it('a cell with no credential lane wired is NOT met — never vacuously passing', () => {
    const m = auditCredentialMatrix(
      interleaved(() => 'sha256:bun-1'),
      { cells: ['node', 'bun', 'bun-vinext'] },
    );
    expect(m.cells['bun-vinext'].current.nights).toBe(0);
    expect(m.cells['bun-vinext'].met).toBe(false);
    expect(m.allMet).toBe(false);
  });

  it('CREDENTIAL_CELLS names all six supported runtime×builder cells', () => {
    const pairs = CREDENTIAL_CELLS.map(
      (c: { runtime: string; builder: string }) => `${c.runtime}×${c.builder}`,
    ).sort();
    expect(pairs).toEqual(
      [
        'bun×turbopack',
        'bun×vinext',
        'bun×webpack',
        'node×turbopack',
        'node×vinext',
        'node×webpack',
      ].sort(),
    );
    const lanes = CREDENTIAL_CELLS.map((c: { lane: string }) => c.lane);
    expect(new Set(lanes).size).toBe(lanes.length);
    // The two lanes that exist today keep their ids, so their history stays attributable.
    const byPair = Object.fromEntries(
      CREDENTIAL_CELLS.map((c: { runtime: string; builder: string; lane: string }) => [
        `${c.runtime}×${c.builder}`,
        c.lane,
      ]),
    );
    expect(byPair['node×turbopack']).toBe('node');
    expect(byPair['bun×turbopack']).toBe('bun');
  });

  it('auditCredentialMatrix defaults to EVERY supported cell, so unwired cells hold allMet false', () => {
    const m = auditCredentialMatrix(interleaved(() => 'sha256:bun-1'));
    expect(Object.keys(m.cells)).toHaveLength(CREDENTIAL_CELLS.length);
    expect(m.allMet).toBe(false);
  });
});

// ── The ledger records which ref each night ran against ──────────────────────

describe('the run ledger records the ref, and refuses a credential claim on a non-RC ref', () => {
  const shards = Array.from({ length: 2 }, (_, i) => ({
    shard: `${i + 1}/2`,
    passed: 3,
    failed: 0,
    notRun: 0,
    runtime: 'node',
    ref: 'v16.2.0',
  }));
  const fingerprint = { fingerprint: 'sha256:ffff', components: {} };

  it('records mode, credential, knextRef, knextSha, workflowSha', () => {
    const { ledger, errors } = buildLedger({
      shards,
      shardTotal: '2',
      fingerprint,
      runId: '1',
      runAttempt: '1',
      event: 'schedule',
      compatMode: 'credential',
      knextRef: 'refs/tags/v1.0.0-rc.1',
      knextSha: SHA_A,
      workflowSha: MAIN_SHA,
    });
    expect(errors).toEqual([]);
    expect(ledger.compatMode).toBe('credential');
    expect(ledger.credential).toBe(true);
    expect(ledger.knextRef).toBe('refs/tags/v1.0.0-rc.1');
    expect(ledger.knextSha).toBe(SHA_A);
    expect(ledger.workflowSha).toBe(MAIN_SHA);
  });

  it('a credential-mode night on refs/heads/main fails the ledger job', () => {
    const { ledger, errors } = buildLedger({
      shards,
      shardTotal: '2',
      fingerprint,
      runId: '1',
      runAttempt: '1',
      event: 'schedule',
      compatMode: 'credential',
      knextRef: 'refs/heads/main',
      knextSha: MAIN_SHA,
      workflowSha: MAIN_SHA,
    });
    expect(errors.some((e) => /credential/.test(e) && /RC/.test(e))).toBe(true);
    // Recorded as what it was, not upgraded or erased.
    expect(ledger.knextRef).toBe('refs/heads/main');
  });

  it('an early-warning night on main is fine, and is recorded as non-credential', () => {
    const { ledger, errors } = buildLedger({
      shards,
      shardTotal: '2',
      fingerprint,
      runId: '1',
      runAttempt: '1',
      event: 'schedule',
      compatMode: 'early-warning',
      knextRef: 'refs/heads/main',
      knextSha: MAIN_SHA,
      workflowSha: MAIN_SHA,
    });
    expect(errors).toEqual([]);
    expect(ledger.credential).toBe(false);
  });

  it('a ledger that records no mode (another workflow) is non-credential, not an error', () => {
    const { ledger, errors } = buildLedger({
      shards,
      shardTotal: '2',
      fingerprint,
      runId: '1',
      runAttempt: '1',
      event: 'schedule',
    });
    expect(errors).toEqual([]);
    expect(ledger.credential).toBe(false);
    expect(ledger.compatMode).toBeNull();
  });
});

// ── ADR-0039 Amendment 1: the workflow entry is the workflow that ran ────────

describe('the fingerprint hashes the EXECUTING workflow file (ADR-0039 Amendment 1)', () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
  });
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'fp-exec-'));
    temps.push(root);
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, '.github/workflows/test-e2e-deploy.yml'), 'name: rc copy\n');
    writeFileSync(join(root, 'scripts/e2e-deploy.sh'), '#!/bin/sh\n');
    chmodSync(join(root, 'scripts/e2e-deploy.sh'), 0o755);
    writeFileSync(join(root, 'test/deploy-tests-manifest.knext.json'), '{}\n');
    // #1294 round 3: the default lane ('node') declares these in
    // CREDENTIAL_CELLS.extraFiles.
    writeFileSync(join(root, 'scripts/compat-credential-ref.mjs'), 'export const noop = 1;\n');
    writeFileSync(join(root, 'scripts/compat-run-ledger.mjs'), 'export const noop = 1;\n');
    writeFileSync(join(root, '.github/compat-credential-ref.json'), '{"rcTag":null}\n');
    const tarballs = join(root, 'tarballs');
    mkdirSync(tarballs);
    const pkg = join(root, 'pkgsrc/package');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@getknext/lib', version: '0.0.0' }),
    );
    spawnSync('tar', [
      '-czf',
      join(tarballs, 'getknext-lib-0.0.0.tgz'),
      '-C',
      join(root, 'pkgsrc'),
      'package',
    ]);
    const exec = join(root, 'executing.yml');
    return { root, tarballs, exec };
  }

  it('a different executing workflow moves the harness digest', () => {
    const f = fixture();
    try {
      writeFileSync(f.exec, 'name: main copy\n');
      const base = computeFingerprint({ repoRoot: f.root, tarballsDir: f.tarballs });
      const exec = computeFingerprint({
        repoRoot: f.root,
        tarballsDir: f.tarballs,
        workflowFile: f.exec,
      });
      expect(exec.components.harness).not.toBe(base.components.harness);
      expect(exec.fingerprint).not.toBe(base.fingerprint);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('the other half: an identical executing workflow leaves the digest byte-identical', () => {
    const f = fixture();
    try {
      writeFileSync(f.exec, 'name: rc copy\n');
      const base = computeFingerprint({ repoRoot: f.root, tarballsDir: f.tarballs });
      const exec = computeFingerprint({
        repoRoot: f.root,
        tarballsDir: f.tarballs,
        workflowFile: f.exec,
      });
      expect(exec.fingerprint).toBe(base.fingerprint);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('a missing executing workflow file is a hard error, not a silent fallback to the checkout copy', () => {
    const f = fixture();
    try {
      expect(() =>
        computeFingerprint({
          repoRoot: f.root,
          tarballsDir: f.tarballs,
          workflowFile: join(f.root, 'nope.yml'),
        }),
      ).toThrow();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

// ── The workflow wiring ──────────────────────────────────────────────────────

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};
type Job = {
  needs?: string | string[];
  if?: string;
  steps?: Step[];
  outputs?: Record<string, string>;
  'continue-on-error'?: unknown;
};

describe('test-e2e-deploy.yml wires the RC ref into the credential lanes', () => {
  const text = readFileSync(WORKFLOW_PATH, 'utf8');
  const wf = parse(text) as {
    env: Record<string, string>;
    on: { schedule: { cron: string }[] };
    jobs: Record<string, Job>;
  };
  const needsOf = (j: Job) => (Array.isArray(j.needs) ? j.needs : j.needs ? [j.needs] : []);

  /** Evaluate the KNEXT_COMPAT_MODE expression: first truthy `||` operand wins. */
  function resolveMode(ctx: { schedule?: string; inputs?: Record<string, string> }): string {
    const m = String(wf.env.KNEXT_COMPAT_MODE).match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
    expect(m, 'KNEXT_COMPAT_MODE must be a ${{ }} expression').not.toBeNull();
    const ops = (m as RegExpMatchArray)[1].split(/\s*\|\|\s*(?![^()]*\))/);
    for (const raw of ops) {
      const op = raw.trim();
      const lit = op.match(/^'([^']*)'$/);
      if (lit) return lit[1];
      const cmp = op.match(/^\(github\.event\.schedule\s*==\s*'([^']*)'\s*&&\s*'([^']*)'\)$/);
      if (!cmp) throw new Error(`unrecognised KNEXT_COMPAT_MODE operand: ${op}`);
      if (ctx.schedule === cmp[1]) return cmp[2];
    }
    return '';
  }

  const crons = wf.on.schedule.map((s) => s.cron);

  it('exactly four credential crons exist (one per wired cell, #1245), and each maps to credential; every other trigger is early-warning', () => {
    const credentialCrons = crons.filter((c) => resolveMode({ schedule: c }) === 'credential');
    expect(credentialCrons).toHaveLength(4);
    for (const c of crons.filter((x) => !credentialCrons.includes(x))) {
      expect(resolveMode({ schedule: c })).toBe('early-warning');
    }
    // A dispatch can never produce a credential night, whatever its inputs.
    expect(resolveMode({ inputs: { runtime: 'bun' } })).toBe('early-warning');
    expect(resolveMode({})).toBe('early-warning');
  });

  it('one credential cron per wired lane (node, bun, node-webpack, bun-webpack — #1245)', () => {
    const lane = (schedule: string) =>
      String(
        evaluate(exprBody(wf.env.KNEXT_LANE), {
          github: { event: { schedule, inputs: null } },
        }),
      );
    const credentialCrons = crons.filter((c) => resolveMode({ schedule: c }) === 'credential');
    expect(credentialCrons.map(lane).sort()).toEqual([
      'bun',
      'bun-webpack',
      'node',
      'node-webpack',
    ]);
  });

  it('a credential-ref job resolves the ref, and it is the ROOT every other job waits on', () => {
    const job = wf.jobs['credential-ref'];
    expect(job, 'a credential-ref job must exist').toBeTruthy();
    expect(needsOf(job)).toEqual([]);
    const resolve = (job.steps ?? []).find((s) => s.id === 'resolve');
    expect(resolve?.run ?? '').toMatch(/scripts\/compat-credential-ref\.mjs/);
    expect(resolve?.run ?? '').toMatch(/--mode\s+"\$\{KNEXT_COMPAT_MODE\}"/);
    expect(resolve?.if ?? null).toBeNull();
    expect(job['continue-on-error'] ?? null).toBeNull();
    expect(needsOf(wf.jobs['build-next'])).toContain('credential-ref');
    expect(needsOf(wf.jobs['shard-ledger'])).toContain('credential-ref');
    expect(job.outputs?.checkout_sha).toMatch(/steps\.resolve\.outputs\.checkout_sha/);
  });

  it('build-next and shard-ledger check out the RESOLVED sha — never the default ref', () => {
    for (const name of ['build-next', 'shard-ledger']) {
      const co = (wf.jobs[name].steps ?? []).find(
        (s) => /actions\/checkout@/.test(s.uses ?? '') && s.with?.path === 'knext',
      );
      expect(co, `${name} must check out knext`).toBeTruthy();
      expect(String(co?.with?.ref ?? '')).toBe('${{ needs.credential-ref.outputs.checkout_sha }}');
    }
  });

  it('the fingerprint hashes the executing workflow (github.workflow_sha), not the checkout copy', () => {
    const steps = wf.jobs['build-next'].steps ?? [];
    const exec = steps.find(
      (s) =>
        /actions\/checkout@/.test(s.uses ?? '') &&
        String(s.with?.ref ?? '').includes('github.workflow_sha'),
    );
    expect(exec, 'a checkout of github.workflow_sha must exist in build-next').toBeTruthy();
    const fp = steps.find((s) => /compat-window-fingerprint\.mjs/.test(s.run ?? ''));
    expect(fp?.run ?? '').toMatch(
      /--workflow-file\s+"?\$\{GITHUB_WORKSPACE\}\/knext-executing\/\.github\/workflows\/test-e2e-deploy\.yml"?/,
    );
  });

  it('the ledger step is handed the mode, the resolved ref/sha and the executing workflow sha', () => {
    const step = (wf.jobs['shard-ledger'].steps ?? []).find((s) => s.id === 'ledger');
    const env = step?.env ?? {};
    expect(env.KNEXT_COMPAT_MODE).toBe('${{ env.KNEXT_COMPAT_MODE }}');
    expect(env.KNEXT_CHECKOUT_REF).toBe('${{ needs.credential-ref.outputs.checkout_ref }}');
    expect(env.KNEXT_CHECKOUT_SHA).toBe('${{ needs.credential-ref.outputs.checkout_sha }}');
    expect(env.WORKFLOW_SHA).toBe('${{ github.workflow_sha }}');
  });

  it('the mode marker is published before the resolve step, so a refused night is still attributable', () => {
    const steps = wf.jobs['credential-ref'].steps ?? [];
    const marker = steps.findIndex(
      (s) => String(s.with?.name ?? '') === `${MODE_MARKER_PREFIX}\${{ env.KNEXT_COMPAT_MODE }}`,
    );
    const resolveIdx = steps.findIndex((s) => s.id === 'resolve');
    expect(marker).toBeGreaterThanOrEqual(0);
    expect(marker).toBeLessThan(resolveIdx);
    expect(steps[marker].if ?? null).toBeNull();
  });

  it('the alert fires on a refused credential night — except the declared not-cut state', () => {
    const alert = wf.jobs['nightly-red-alert'];
    expect(needsOf(alert)).toContain('credential-ref');
    expect(alert.if ?? '').toMatch(/needs\.credential-ref\.result == 'failure'/);
    expect(alert.if ?? '').toMatch(/needs\.credential-ref\.outputs\.state != 'not-cut'/);
  });
});

// ── Review round 1 (PR #1222): lost credential nights, and each guard proven alone ──

describe('a credential night that RAN but left no ledger restarts its own window', () => {
  // The realistic false credential: a crashed runner / expired artifact /
  // refused night carries the `compat-mode-credential` marker but no ledger. If
  // it were DROPPED instead of graded, the streak would join the nights either
  // side of it — reporting a longer streak than reality.
  for (const lane of ['node', 'bun']) {
    it(`${lane}: [green, green, LOST credential night, green] → current streak 1`, () => {
      const ledgers = [night({ lane }), night({ lane }), lost(lane, 'credential'), night({ lane })];
      const a = auditWindow(ledgers, { lane });
      expect(a.nights).toHaveLength(4);
      expect(a.current.nights).toBe(1);
      expect(a.unresolvedNights).toHaveLength(1);
    });
  }

  it("…and it does not touch the OTHER cell's window", () => {
    const ledgers = [
      night({ lane: 'node' }),
      night({ lane: 'bun' }),
      lost('bun', 'credential'),
      night({ lane: 'node' }),
      night({ lane: 'bun' }),
    ];
    const m = auditCredentialMatrix(ledgers, { cells: ['node', 'bun'] });
    expect(m.cells.node.current.nights).toBe(2);
    expect(m.cells.bun.current.nights).toBe(1);
  });
});

describe('the ledger refuses a credential night that recorded no knext sha (alone)', () => {
  const shards = [
    { shard: '1/1', passed: 3, failed: 0, notRun: 0, runtime: 'node', ref: 'v16.2.0' },
  ];
  const base = {
    shards,
    shardTotal: '1',
    fingerprint: { fingerprint: 'sha256:ffff', components: {} },
    runId: '1',
    runAttempt: '1',
    event: 'schedule',
    compatMode: 'credential',
    knextRef: 'refs/tags/v1.0.0-rc.1',
    workflowSha: MAIN_SHA,
  };

  it('RC ref but no sha → the ledger job fails, naming the missing sha', () => {
    const { errors } = buildLedger({ ...base, knextSha: undefined });
    expect(errors.some((e) => /no knext commit sha/.test(e))).toBe(true);
  });

  it('RC ref but a malformed sha → fails too', () => {
    const { errors } = buildLedger({ ...base, knextSha: 'main' });
    expect(errors.some((e) => /no knext commit sha/.test(e))).toBe(true);
  });

  it('the other half: RC ref + a real sha → no error', () => {
    expect(buildLedger({ ...base, knextSha: SHA_A }).errors).toEqual([]);
  });
});

describe('shard-ledger refuses an unresolved knext ref BEFORE it checks anything out (alone)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: parsed workflow YAML
  const wf = parse(readFileSync(WORKFLOW_PATH, 'utf8')) as any;
  // biome-ignore lint/suspicious/noExplicitAny: parsed workflow YAML
  const steps: any[] = wf.jobs['shard-ledger'].steps ?? [];
  const idx = steps.findIndex((s) => /CHECKOUT_SHA/.test(String(s.run ?? '')));
  const step = steps[idx] ?? {};

  /** Execute the step's own `run:` under bash, exactly as the runner would. */
  function runStep(sha: string) {
    return spawnSync('bash', ['-euo', 'pipefail', '-c', String(step.run ?? '')], {
      env: { PATH: process.env.PATH ?? '', CHECKOUT_SHA: sha },
      encoding: 'utf8',
    });
  }

  it('the precondition exists, reads the resolved sha, and precedes the knext checkout', () => {
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(step.env?.CHECKOUT_SHA).toBe('${{ needs.credential-ref.outputs.checkout_sha }}');
    const checkout = steps.findIndex(
      (s) => /actions\/checkout@/.test(String(s.uses ?? '')) && s.with?.path === 'knext',
    );
    expect(idx).toBeLessThan(checkout);
    expect(step.if ?? null).toBeNull();
  });

  it('EXECUTED with an empty sha it fails (exit != 0) — the default branch is never checked out', () => {
    expect(runStep('').status).not.toBe(0);
  });

  it('the other half: EXECUTED with a resolved sha it passes', () => {
    expect(runStep(SHA_A).status).toBe(0);
  });
});

describe('early-warning alerts say they are non-credentialing', () => {
  // biome-ignore lint/suspicious/noExplicitAny: parsed workflow YAML
  const wf = parse(readFileSync(WORKFLOW_PATH, 'utf8')) as any;
  const alertRun = String(
    // biome-ignore lint/suspicious/noExplicitAny: parsed workflow YAML
    (wf.jobs['nightly-red-alert'].steps ?? []).find((s: any) => /lane_note=/.test(String(s.run)))
      ?.run ?? '',
  );

  /** Run the alert's own title/lane-note logic under bash and read the result. */
  function noteFor(runtime: string, mode: string, lane: string = runtime) {
    const head = alertRun.slice(0, alertRun.indexOf('body="'));
    expect(head.length).toBeGreaterThan(0);
    const r = spawnSync('bash', ['-c', `${head}\nprintf '%s\\n%s' "$title" "$lane_note"`], {
      env: {
        PATH: process.env.PATH ?? '',
        KNEXT_RUNTIME: runtime,
        KNEXT_LANE: lane,
        KNEXT_COMPAT_MODE: mode,
        CHECKOUT_REF: 'refs/tags/v1.0.0-rc.1',
        REF_STATE: 'resolved',
      },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    const [title, ...rest] = r.stdout.split('\n');
    return { title, note: rest.join('\n') };
  }

  // #1245: a webpack credential red is titled by its CELL lane, so it can never
  // be filed on (or comment into) the turbopack cell's issue for the same runtime.
  for (const runtime of ['node', 'bun']) {
    it(`${runtime}-webpack credential: titled by its own lane, distinct from the ${runtime} turbopack issue`, () => {
      const { title, note } = noteFor(runtime, 'credential', `${runtime}-webpack`);
      expect(title).toBe(`Compat CREDENTIAL RED (${runtime}-webpack, RC tag)`);
      expect(title).not.toBe(noteFor(runtime, 'credential').title);
      expect(note).toMatch(new RegExp(`${runtime}-webpack CREDENTIAL night`));
    });
  }

  for (const runtime of ['node', 'bun']) {
    it(`${runtime} early-warning: non-credentialing, affects no streak, claims no credential`, () => {
      const { note } = noteFor(runtime, 'early-warning');
      expect(note).toMatch(/NON-credentialing/);
      expect(note).toMatch(/does not affect any v1\.0 credential streak/);
      expect(note).not.toMatch(
        /credential lane|credentialing lane|backing the compat-matrix|RESTARTS/i,
      );
    });

    it(`${runtime} credential: names the RC night and the restart, under its own title`, () => {
      const { title, note } = noteFor(runtime, 'credential');
      expect(title).toBe(`Compat CREDENTIAL RED (${runtime}, RC tag)`);
      expect(note).toMatch(/CREDENTIAL night/);
      expect(note).toMatch(/RESTARTS this cell's v1\.0 14-night window/);
    });
  }
});
