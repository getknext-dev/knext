import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverCredentialWorkflowFiles,
  evaluateWatchdog,
  runCli,
} from '../scripts/credential-slot-watchdog.mjs';
import {
  anyLaneNeedsAlert,
  CREDENTIAL_CONCURRENCY_GROUP,
  decideCancelledCredentialRuns,
  decideCredentialSlotVerdicts,
} from '../scripts/lib/credential-slot-watchdog.mjs';

/**
 * v2 R5 — a cancelled credential run must alert, never pass silently.
 *
 * With every credential workflow in one concurrency group the failure this guards is
 * a run GitHub cancels while it waits (the queue overflowed, someone cancelled it).
 * Such a run never reached its first job, so it has no markers and no ledger, and the
 * audit grades it as a lost run of unknown lane: it resets every cell of that line.
 * The audit only says so when somebody next reads it. This says so at the next
 * watchdog run.
 */

const WORKFLOW_YAML = readFileSync(
  new URL('../.github/workflows/test-e2e-deploy.yml', import.meta.url),
  'utf8',
);

const WINDOW = {
  start: new Date('2026-11-05T01:00:00Z'),
  end: new Date('2026-11-05T09:00:00Z'),
};

type Run = {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_started_at: string | null;
  updated_at: string;
  html_url?: string;
  earlyWarning?: boolean;
  exactLane?: string | null;
};

const run = (over: Partial<Run> = {}): Run => ({
  id: 1,
  event: 'schedule',
  status: 'completed',
  conclusion: 'cancelled',
  created_at: '2026-11-05T03:00:00Z',
  run_started_at: '2026-11-05T03:00:00Z',
  updated_at: '2026-11-05T05:00:00Z',
  html_url: 'https://x/1',
  ...over,
});

describe('decideCancelledCredentialRuns', () => {
  const decide = (runs: Run[]) =>
    decideCancelledCredentialRuns({ runs, window: WINDOW, workflowFile: 'test-e2e-deploy.yml' });

  it('flags a cancelled scheduled run, and the flag raises the alert', () => {
    const verdicts = decide([run()]);
    expect(verdicts.map((v) => v.verdict)).toEqual(['cancelled']);
    expect(anyLaneNeedsAlert(verdicts)).toBe(true);
    expect(verdicts[0].reason).toContain('test-e2e-deploy.yml');
    expect(verdicts[0].reason).toContain('https://x/1');
  });

  it('flags a run that timed out: it left no result either', () => {
    expect(decide([run({ conclusion: 'timed_out' })]).map((v) => v.verdict)).toEqual(['cancelled']);
  });

  it('names the lane when the run published its marker, and says unattributed when it did not', () => {
    expect(decide([run({ exactLane: 'bun' })])[0].lane).toBe('bun');
    expect(decide([run()])[0].lane).toBe('unattributed');
  });

  it('stays quiet on a run that succeeded or failed: those carry their own verdict', () => {
    expect(decide([run({ conclusion: 'success' })])).toEqual([]);
    expect(decide([run({ conclusion: 'failure' })])).toEqual([]);
  });

  it('stays quiet on a cancelled dispatch: a manual diagnostic is not a credential run', () => {
    expect(decide([run({ event: 'workflow_dispatch' })])).toEqual([]);
  });

  it('stays quiet on a run still waiting or running', () => {
    expect(decide([run({ status: 'pending', conclusion: null })])).toEqual([]);
    expect(decide([run({ status: 'in_progress', conclusion: null })])).toEqual([]);
  });

  it('stays quiet on a run whose own marker says early-warning, and fails closed without one', () => {
    expect(decide([run({ earlyWarning: true })])).toEqual([]);
    expect(decide([run({ earlyWarning: false })]).map((v) => v.verdict)).toEqual(['cancelled']);
  });

  it('flags a run once: consecutive windows tile on the time it was cancelled', () => {
    const atStart = run({ updated_at: WINDOW.start.toISOString() });
    const atEnd = run({ updated_at: WINDOW.end.toISOString() });
    expect(decide([atStart])).toEqual([]);
    expect(decide([atEnd]).map((v) => v.verdict)).toEqual(['cancelled']);
    const next = { start: WINDOW.end, end: new Date('2026-11-05T17:00:00Z') };
    const inNext = decideCancelledCredentialRuns({
      runs: [atEnd],
      window: next,
      workflowFile: 'test-e2e-deploy.yml',
    });
    expect(inNext).toEqual([]);
  });

  it('keys on when it was cancelled, not when it fired: a long wait does not hide it', () => {
    const late = run({
      created_at: '2026-11-03T03:00:00Z',
      updated_at: '2026-11-05T05:00:00Z',
    });
    expect(decide([late]).map((v) => v.verdict)).toEqual(['cancelled']);
  });

  it('falls back to creation when a listing omits updated_at, never to silence', () => {
    const { updated_at: _omit, ...noUpdated } = run();
    expect(decide([noUpdated as Run]).map((v) => v.verdict)).toEqual(['cancelled']);
  });
});

/** A `gh` fake with one run listing per workflow file, plus artifact listings. */
function ghFor(perWorkflow: Record<string, Run[]>, markers: Record<number, string[]> = {}) {
  const calls: string[] = [];
  const gh = (args: string[]) => {
    const url = args[1] ?? '';
    calls.push(url);
    const art = /actions\/runs\/(\d+)\/artifacts/.exec(url);
    if (art) {
      const names = markers[Number(art[1])] ?? [];
      return JSON.stringify({
        total_count: names.length,
        artifacts: names.map((name) => ({ name })),
      });
    }
    const file = /actions\/workflows\/([^/]+)\/runs/.exec(url)?.[1] ?? '';
    const runs = perWorkflow[file] ?? [];
    const scheduleOnly = url.includes('event=schedule');
    const out = scheduleOnly ? runs.filter((r) => r.event === 'schedule') : runs;
    return JSON.stringify({ total_count: out.length, workflow_runs: out });
  };
  return { gh, calls };
}

const FILES = ['test-e2e-deploy.yml', 'compat-credential-v1.3.yml', 'compat-vinext.yml'];
const GRACE = 8;
// (previous check, this check] = (01:00, 09:00].
const checkAt = new Date('2026-11-05T09:00:00Z');
const previousCheckAt = new Date('2026-11-05T01:00:00Z');
const cancelled = (verdicts: { verdict: string }[]) =>
  verdicts.filter((v) => v.verdict === 'cancelled');

const evaluate = (gh: (a: string[]) => string, credentialWorkflowFiles = FILES) =>
  evaluateWatchdog({
    workflowYamlText: WORKFLOW_YAML,
    gh,
    now: checkAt,
    graceHours: GRACE,
    checkAt,
    previousCheckAt,
    credentialWorkflowFiles,
  });

describe('evaluateWatchdog — cancelled runs across every credential workflow', () => {
  it('flags a cancelled scheduled run of each credential workflow, not just the v1.0 one', () => {
    for (const file of FILES) {
      const { gh } = ghFor({ [file]: [run({ id: 7, html_url: `https://x/${file}` })] });
      const found = cancelled(evaluate(gh));
      expect(found).toHaveLength(1);
      expect(found[0].reason).toContain(file);
    }
  });

  it('does not flag a green run or a cancelled dispatch of any of them (the other half)', () => {
    const { gh } = ghFor({
      'test-e2e-deploy.yml': [run({ id: 1, conclusion: 'success' })],
      'compat-credential-v1.3.yml': [run({ id: 2, event: 'workflow_dispatch' })],
      'compat-vinext.yml': [run({ id: 3, conclusion: 'success' })],
    });
    expect(cancelled(evaluate(gh))).toEqual([]);
  });

  it('reads the markers to drop an early-warning run and to name a credential lane', () => {
    const { gh } = ghFor(
      { 'test-e2e-deploy.yml': [run({ id: 11 }), run({ id: 12 })] },
      {
        11: ['compat-lane-node', 'compat-mode-early-warning'],
        12: ['compat-lane-bun', 'compat-mode-credential'],
      },
    );
    const found = cancelled(evaluate(gh));
    expect(found.map((v) => (v as { lane: string }).lane)).toEqual(['bun']);
  });

  it('a run in both listings is flagged once', () => {
    const { gh } = ghFor({ 'test-e2e-deploy.yml': [run({ id: 21 })] });
    expect(cancelled(evaluate(gh, ['test-e2e-deploy.yml']))).toHaveLength(1);
  });

  it('checks a cancellation even when no credential fire came due in the window', () => {
    const { gh } = ghFor({ 'test-e2e-deploy.yml': [run({ id: 31 })] });
    const verdicts = evaluateWatchdog({
      workflowYamlText: WORKFLOW_YAML,
      gh,
      now: checkAt,
      graceHours: GRACE,
      checkAt,
      // A one-minute window: no credential fire falls inside it. The cancel does.
      previousCheckAt: new Date('2026-11-05T04:59:00Z'),
      credentialWorkflowFiles: ['test-e2e-deploy.yml'],
    });
    expect(cancelled(verdicts)).toHaveLength(1);
  });

  it('a listing that fails is a crash, never a silent pass', () => {
    const down = () => {
      throw new Error('api down');
    };
    expect(() => evaluate(down)).toThrow();
  });
});

describe('the CLI turns a cancelled run into the alert output', () => {
  const env = { WATCHDOG_GRACE_HOURS: '8' };
  const cli = (gh: (a: string[]) => string) => {
    const outputs: Record<string, string> = {};
    const code = runCli({
      workflowYamlText: WORKFLOW_YAML,
      gh,
      // A dispatch checks the lookback window, which holds this cancellation.
      now: new Date('2026-11-05T09:00:00Z'),
      env,
      writeOutput: (k: string, v: string) => {
        outputs[k] = v;
        return true;
      },
      log: () => {},
      error: () => {},
      credentialWorkflowFiles: ['compat-credential-v1.3.yml'],
    });
    return { code, outputs };
  };

  it('a cancelled credential run alerts through the output and still exits 0', () => {
    const r = cli(ghFor({ 'compat-credential-v1.3.yml': [run({ id: 41 })] }).gh);
    expect(r.code).toBe(0);
    expect(r.outputs.alert).toBe('true');
  });
});

describe('discoverCredentialWorkflowFiles', () => {
  const block = (group: string) =>
    `name: x\nconcurrency:\n  group: \${{ github.event_name == 'schedule' && '${group}' || 'x' }}\njobs: {}\n`;

  it('finds the three lanes in the real tree', () => {
    expect(discoverCredentialWorkflowFiles().sort()).toEqual([...FILES].sort());
  });

  it('finds a new lane by its group, ignores a mention outside the block, and ignores other groups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r5-discover-'));
    try {
      writeFileSync(join(dir, 'lane.yml'), block(CREDENTIAL_CONCURRENCY_GROUP));
      writeFileSync(join(dir, 'other.yml'), block('another-group'));
      writeFileSync(
        join(dir, 'prose.yml'),
        `name: y\n# mentions ${CREDENTIAL_CONCURRENCY_GROUP} in a comment\njobs: {}\n`,
      );
      expect(discoverCredentialWorkflowFiles({ dir })).toEqual(['lane.yml']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when nothing is in the group: an empty scan must not read as quiet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r5-discover-'));
    try {
      writeFileSync(join(dir, 'other.yml'), block('another-group'));
      expect(() => discoverCredentialWorkflowFiles({ dir })).toThrow(/credential/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a run still waiting in the queue is not a run that started', () => {
  // Measured live: the Actions API sets `run_started_at` on a `queued` run, so that
  // field alone reads a waiting run as started and `queued-too-long` never fires.
  const SLOT = '2026-11-05T01:17:00.000Z';
  const lanes = [{ lane: 'node', expectedSlotTime: SLOT, graceHours: 8 }];
  const verdict = (status: string, now: string) =>
    decideCredentialSlotVerdicts({
      lanes,
      runs: [
        {
          lane: 'node',
          status,
          created_at: '2026-11-05T04:00:00Z',
          run_started_at: '2026-11-05T04:00:00Z',
        },
      ],
      now: new Date(now),
    })[0].verdict;
  const PAST_GRACE = '2026-11-05T10:00:00Z';

  for (const status of ['queued', 'pending', 'waiting']) {
    it(`${status} past its grace alerts queued-too-long, the group's backlog signal`, () => {
      expect(verdict(status, PAST_GRACE)).toBe('queued-too-long');
    });
  }

  it('the same run within its grace stays quiet', () => {
    expect(verdict('pending', '2026-11-05T05:00:00Z')).toBe('quiet');
  });

  for (const status of ['in_progress', 'completed']) {
    it(`${status} past its grace stays quiet (the other half)`, () => {
      expect(verdict(status, PAST_GRACE)).toBe('quiet');
    });
  }
});

describe('the alert text names the cancelled verdict', () => {
  it('the watchdog workflow tells the reader what a cancelled verdict means', () => {
    const wf = readFileSync(
      new URL('../.github/workflows/credential-slot-watchdog.yml', import.meta.url),
      'utf8',
    );
    expect(wf).toContain('CANCELLED');
    expect(wf).toContain('compat-credential-v1.3.yml');
  });
});
