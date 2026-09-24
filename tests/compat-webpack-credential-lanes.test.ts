/**
 * #1245 — the webpack×node and webpack×bun credential lanes.
 *
 * The v1.0 credential covers four cells: node/bun × turbopack/webpack. The two
 * webpack cells run on the SAME shared credential workflow
 * (`test-e2e-deploy.yml`) as the turbopack cells, selected by their own
 * credential crons. Everything here EVALUATES the workflow's selector
 * expressions (tests/helpers/gha-expr.ts) against real event contexts rather
 * than grepping their text, so a swapped cron literal or a lane that no longer
 * agrees with its runtime×builder reds the suite.
 *
 * The load-bearing property is the lane: a webpack night must be attributed to
 * ITS cell's window (`node-webpack` / `bun-webpack`), never to the turbopack
 * cell that shares its runtime — otherwise a red webpack night would restart
 * the turbopack window (or, worse, a green one would bank there).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { buildLedger } from '../scripts/compat-run-ledger.mjs';
import { CREDENTIAL_CELLS, LANE_MARKER_PREFIX } from '../scripts/compat-window-audit.mjs';
import { summarize } from '../scripts/e2e-summary.mjs';
import { evaluate, exprBody, truthy } from './helpers/gha-expr';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = join(ROOT, '.github/workflows/test-e2e-deploy.yml');
const text = readFileSync(WORKFLOW_PATH, 'utf8');

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};
type Job = { steps?: Step[]; concurrency?: unknown; needs?: unknown };
const wf = parse(text) as {
  on: {
    schedule: { cron: string }[];
    workflow_dispatch: {
      inputs: Record<string, { type?: string; default?: unknown; options?: string[] }>;
    };
  };
  env: Record<string, string>;
  concurrency?: unknown;
  jobs: Record<string, Job>;
};

type Cell = {
  runtime: string;
  builder: string;
  lane: string;
  wired: boolean;
  workflowFile: string | null;
  extraFiles: readonly string[];
};
const cells = CREDENTIAL_CELLS as unknown as Cell[];

const NODE_WEBPACK_CRON = '17 22 * * *';
const BUN_WEBPACK_CRON = '47 23 * * *';
const crons = wf.on.schedule.map((s) => s.cron);

/** The GHA context for a schedule or a dispatch (one type, so both fit `allContexts`). */
type Ctx = {
  github: {
    event_name: string;
    event: { schedule?: string; inputs?: Record<string, string> | null };
  };
};
function scheduleCtx(cron: string): Ctx {
  return { github: { event_name: 'schedule', event: { schedule: cron, inputs: null } } };
}
function dispatchCtx(inputs: Record<string, string>): Ctx {
  return { github: { event_name: 'workflow_dispatch', event: { inputs } } };
}

function resolveAll(ctx: Ctx) {
  const read = (key: string) => String(evaluate(exprBody(wf.env[key]), ctx) ?? '');
  return {
    runtime: read('KNEXT_RUNTIME'),
    builder: read('KNEXT_BUILDER'),
    lane: read('KNEXT_LANE'),
    mode: read('KNEXT_COMPAT_MODE'),
  };
}

/** The ONE rule: turbopack cells keep their historical ids, others are `<runtime>-<builder>`. */
function expectedLane(runtime: string, builder: string) {
  return builder === 'turbopack' ? runtime : `${runtime}-${builder}`;
}

/** Every event context the workflow can see: each cron, plus every dispatch combination. */
function allContexts(): { label: string; ctx: Ctx }[] {
  const out = crons.map((c) => ({ label: `schedule '${c}'`, ctx: scheduleCtx(c) }));
  for (const runtime of ['node', 'bun']) {
    for (const builder of ['turbopack', 'webpack']) {
      out.push({ label: `dispatch ${runtime}×${builder}`, ctx: dispatchCtx({ runtime, builder }) });
    }
  }
  return out;
}

function minuteOfDay(cron: string): number {
  const [min, hour] = cron.split(/\s+/);
  return Number(hour) * 60 + Number(min);
}

function circularGap(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 1440 - d);
}

describe('webpack credential crons (#1245)', () => {
  it('declares one credential cron per webpack cell, each resolving to its OWN lane', () => {
    expect(crons).toContain(NODE_WEBPACK_CRON);
    expect(crons).toContain(BUN_WEBPACK_CRON);
    expect(resolveAll(scheduleCtx(NODE_WEBPACK_CRON))).toEqual({
      runtime: 'node',
      builder: 'webpack',
      lane: 'node-webpack',
      mode: 'credential',
    });
    expect(resolveAll(scheduleCtx(BUN_WEBPACK_CRON))).toEqual({
      runtime: 'bun',
      builder: 'webpack',
      lane: 'bun-webpack',
      mode: 'credential',
    });
  });

  it('the other half: every pre-existing turbopack cron is untouched (turbopack builder, historical lane id)', () => {
    expect(resolveAll(scheduleCtx('17 3 * * *'))).toEqual({
      runtime: 'node',
      builder: 'turbopack',
      lane: 'node',
      mode: 'early-warning',
    });
    expect(resolveAll(scheduleCtx('47 4 * * *'))).toEqual({
      runtime: 'bun',
      builder: 'turbopack',
      lane: 'bun',
      mode: 'early-warning',
    });
    expect(resolveAll(scheduleCtx('17 1 * * *'))).toEqual({
      runtime: 'node',
      builder: 'turbopack',
      lane: 'node',
      mode: 'credential',
    });
    expect(resolveAll(scheduleCtx('47 5 * * *'))).toEqual({
      runtime: 'bun',
      builder: 'turbopack',
      lane: 'bun',
      mode: 'credential',
    });
  });

  it('for EVERY trigger, the lane agrees with runtime×builder and names a real credential cell', () => {
    for (const { label, ctx } of allContexts()) {
      const r = resolveAll(ctx);
      expect(r.lane, `${label}: lane must be derived from runtime×builder`).toBe(
        expectedLane(r.runtime, r.builder),
      );
      const cell = cells.find((c) => c.lane === r.lane);
      expect(cell, `${label}: lane ${r.lane} is not a CREDENTIAL_CELLS lane`).toBeTruthy();
      expect(cell?.runtime, `${label}: cell runtime`).toBe(r.runtime);
      expect(cell?.builder, `${label}: cell builder`).toBe(r.builder);
    }
  });

  it('a dispatch is NEVER a credential night, whatever builder it selects', () => {
    for (const runtime of ['node', 'bun']) {
      for (const builder of ['turbopack', 'webpack']) {
        const r = resolveAll(dispatchCtx({ runtime, builder }));
        expect(r.mode).toBe('early-warning');
        expect(r.lane).toBe(expectedLane(runtime, builder));
      }
    }
  });

  it('`wired: true` on this workflow ⇔ the cell has exactly one credential cron here', () => {
    const credentialLanes = crons
      .map((c) => resolveAll(scheduleCtx(c)))
      .filter((r) => r.mode === 'credential')
      .map((r) => r.lane);
    const wiredHere = cells
      .filter((c) => c.wired && c.workflowFile === 'test-e2e-deploy.yml')
      .map((c) => c.lane);
    expect([...credentialLanes].sort()).toEqual([...wiredHere].sort());
    expect(new Set(credentialLanes).size).toBe(credentialLanes.length);
    expect(wiredHere.sort()).toEqual(['bun', 'bun-webpack', 'node', 'node-webpack']);
  });

  it('staggers the new crons ≥60 min from every other cron in this workflow and clear of the ~08:30 UTC pile-up (#1301)', () => {
    for (const mine of [NODE_WEBPACK_CRON, BUN_WEBPACK_CRON]) {
      for (const other of crons.filter((c) => c !== mine)) {
        expect(
          circularGap(minuteOfDay(mine), minuteOfDay(other)),
          `${mine} vs ${other}: two ~19-job compat runs would contend for the 20-job cap`,
        ).toBeGreaterThanOrEqual(60);
      }
      expect(
        circularGap(minuteOfDay(mine), 8 * 60 + 30),
        `${mine} is inside the 08:30 pile-up`,
      ).toBeGreaterThanOrEqual(120);
    }
  });

  it('no concurrency group anywhere in the credential workflow — a cancelled pending run would reset a window', () => {
    expect(wf.concurrency, 'workflow-level concurrency').toBeUndefined();
    for (const [name, job] of Object.entries(wf.jobs)) {
      expect(job.concurrency, `job ${name} concurrency`).toBeUndefined();
    }
  });
});

describe('the builder dispatch input and the harness bundler flags (#1245)', () => {
  it('declares a `builder` choice input of turbopack|webpack defaulting to turbopack', () => {
    const input = wf.on.workflow_dispatch.inputs.builder;
    expect(input, 'workflow_dispatch must declare a builder input').toBeTruthy();
    expect(input.type).toBe('choice');
    expect(input.default).toBe('turbopack');
    expect([...(input.options ?? [])].sort()).toEqual(['turbopack', 'webpack']);
  });

  function runStepEnv(): Record<string, unknown> {
    const step = (wf.jobs['deploy-tests']?.steps ?? []).find((s) =>
      /Run official deploy tests/.test(s.name ?? ''),
    );
    expect(step, 'the Run official deploy tests step').toBeTruthy();
    return (step as Step).env ?? {};
  }

  for (const builder of ['turbopack', 'webpack']) {
    it(`builder=${builder}: EXACTLY one of IS_TURBOPACK_TEST / IS_WEBPACK_TEST is set, and it is the right one`, () => {
      const env = runStepEnv();
      const ctx = { env: { KNEXT_BUILDER: builder } };
      const turbo = evaluate(exprBody(env.IS_TURBOPACK_TEST), ctx);
      const webpack = evaluate(exprBody(env.IS_WEBPACK_TEST), ctx);
      // bundler.ts exits(1) on "Multiple bundler flags set" — never both.
      expect(truthy(turbo) && truthy(webpack)).toBe(false);
      if (builder === 'turbopack') {
        expect(turbo).toBe('1');
        expect(truthy(webpack)).toBe(false);
      } else {
        expect(webpack).toBe('1');
        expect(truthy(turbo)).toBe(false);
      }
    });
  }
});

describe('the lane is carried everywhere a night is attributed (#1245)', () => {
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps ?? []);

  it('the lane marker artifact and its file carry KNEXT_LANE, not the bare runtime', () => {
    const upload = steps.find((s) => String(s.with?.name ?? '').startsWith(LANE_MARKER_PREFIX));
    expect(upload?.with?.name).toBe(`${LANE_MARKER_PREFIX}\${{ env.KNEXT_LANE }}`);
    const record = steps.find((s) => /Record the lane \+ mode markers/.test(s.name ?? ''));
    expect(record?.run).toMatch(
      /printf '%s\\n' "\$\{KNEXT_LANE\}" > "\$\{RUNNER_TEMP\}\/compat-lane\.txt"/,
    );
  });

  it('the fingerprint is taken for the lane (so webpack cells resolve their declared workflow)', () => {
    const fp = steps.find((s) => /compat-window-fingerprint\.mjs/.test(s.run ?? ''));
    expect(fp?.run).toMatch(/--lane "\$\{KNEXT_LANE\}"/);
    expect(fp?.run).not.toMatch(/--lane "\$\{KNEXT_RUNTIME\}"/);
  });

  it('every shard summary records the builder, so the ledger can attribute the lane', () => {
    const sum = steps.find(
      (s) => /scripts\/e2e-summary\.mjs/.test(s.run ?? '') && /--runner-log/.test(s.run ?? ''),
    );
    expect(sum?.run).toMatch(/--builder "\$\{KNEXT_BUILDER\}"/);
  });

  it('a credential RED alert is titled by LANE, so a webpack red never lands on the turbopack cell’s issue', () => {
    const alert = steps.find((s) => /Compat nightly RED/.test(s.name ?? ''));
    expect(alert?.run).toMatch(/title="Compat CREDENTIAL RED \(\$\{KNEXT_LANE\}, RC tag\)"/);
  });
});

describe('summary + ledger attribute webpack nights to their own lane (#1245)', () => {
  const meta = { ref: 'v16.2.0', shard: '1/2', excluded: 0 };

  it('summarize records builder=webpack, and omits the key for turbopack (byte-stable node/bun artifacts)', () => {
    expect(summarize('', { ...meta, runtime: 'node', builder: 'webpack' }).builder).toBe('webpack');
    expect(summarize('', { ...meta, runtime: 'bun', builder: 'webpack' }).builder).toBe('webpack');
    expect('builder' in summarize('', { ...meta, runtime: 'node', builder: 'turbopack' })).toBe(
      false,
    );
    expect('builder' in summarize('', { ...meta, runtime: 'node' })).toBe(false);
  });

  function ledgerLane(runtime: string, builder?: string) {
    const shards = Array.from({ length: 2 }, (_, i) => ({
      shard: `${i + 1}/2`,
      passed: 3,
      failed: 0,
      notRun: 0,
      runtime,
      ...(builder ? { builder } : {}),
      ref: 'v16.2.0',
    }));
    const { ledger } = buildLedger({
      shards,
      shardTotal: '2',
      fingerprint: { fingerprint: 'sha256:ffff', components: {} },
      runId: '1',
      runAttempt: '1',
      event: 'schedule',
      compatMode: 'early-warning',
      knextRef: 'refs/heads/main',
      knextSha: 'a'.repeat(40),
      workflowSha: 'a'.repeat(40),
    });
    return ledger.lane;
  }

  it('webpack shards land in node-webpack / bun-webpack', () => {
    expect(ledgerLane('node', 'webpack')).toBe('node-webpack');
    expect(ledgerLane('bun', 'webpack')).toBe('bun-webpack');
  });

  it('the other half: builder-less (turbopack) shards keep the historical node / bun lanes', () => {
    expect(ledgerLane('node')).toBe('node');
    expect(ledgerLane('bun')).toBe('bun');
  });
});

describe('CREDENTIAL_CELLS declares the webpack cells wired to the shared workflow (#1245)', () => {
  const turbo = cells.find((c) => c.lane === 'node') as Cell;
  for (const lane of ['node-webpack', 'bun-webpack']) {
    it(`${lane} is wired to test-e2e-deploy.yml with the same executed-script closure as the turbopack cells`, () => {
      const cell = cells.find((c) => c.lane === lane) as Cell;
      expect(cell.wired).toBe(true);
      expect(cell.workflowFile).toBe('test-e2e-deploy.yml');
      expect([...cell.extraFiles].sort()).toEqual([...turbo.extraFiles].sort());
    });
  }
});
