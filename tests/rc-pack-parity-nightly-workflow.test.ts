import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * WIRING GUARD for the G3 nightly pack-parity check (#1734, residual of
 * #1614). This workflow is scheduled, non-required, and OFF the compat
 * credential crons by construction — these tests lock that in.
 */

const ROOT = resolve(import.meta.dirname, '..');
const WF_PATH = resolve(ROOT, '.github/workflows/rc-pack-parity-nightly.yml');
const text = readFileSync(WF_PATH, 'utf8');

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { steps?: Step[]; 'runs-on'?: string; [k: string]: unknown };
const wf = parse(text) as {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

// The compat credential lanes' cron literals + their ~1h runtime tail
// (test-e2e-deploy.yml), as documented in the standing rules for any new
// scheduled lane in this repo.
const CREDENTIAL_CRON_MINUTES_BY_HOUR: Record<number, number[]> = {
  22: [17],
  23: [47],
  1: [17],
  3: [17],
  4: [47],
  5: [47],
};

function parseCron(cron: string): { minute: number; hour: number } {
  const [minute, hour] = cron.trim().split(/\s+/).slice(0, 2).map(Number);
  return { minute, hour };
}

describe('rc-pack-parity-nightly - triggers', () => {
  it('runs on a schedule AND workflow_dispatch (for the one-time proof run)', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  it('the scheduled cron is OUTSIDE every compat-credential cron window (plus ~1h runtime tail)', () => {
    const schedule = wf.on.schedule as Array<{ cron: string }>;
    expect(schedule.length).toBeGreaterThan(0);
    for (const { cron } of schedule) {
      const { minute, hour } = parseCron(cron);
      // Must not land in [credentialHour:credentialMinute, +1h] for any
      // credential cron. Build the simple table of "busy" hour:minute->hour:minute
      // windows and assert this cron's hour:minute falls outside all of them.
      for (const [credHourStr, minutes] of Object.entries(CREDENTIAL_CRON_MINUTES_BY_HOUR)) {
        const credHour = Number(credHourStr);
        for (const credMinute of minutes) {
          const startTotal = credHour * 60 + credMinute;
          const endTotal = startTotal + 60; // ~1h runtime tail
          const thisTotal = hour * 60 + minute;
          const inWindow =
            thisTotal >= startTotal &&
            thisTotal <= (endTotal % (24 * 60) === 0 ? 24 * 60 : endTotal);
          expect(inWindow).toBe(false);
        }
      }
    }
  });

  it('is NON-REQUIRED: this file never appears in a branch-protection / required-status-check list', () => {
    // Mechanical proxy: this workflow's own job name must not be referenced
    // by name from ci.yml's required-check aggregation (if one exists) or
    // from any branch-protection config checked into the repo.
    const ciText = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ciText).not.toContain('pack-parity');
  });
});

describe('rc-pack-parity-nightly - permissions and job wiring', () => {
  it('requests only contents: read', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  it('fetches full history and tags (the rcTag worktree checkout needs it reachable)', () => {
    const job = wf.jobs['pack-parity'];
    const checkout = job.steps?.find((s) => (s.uses ?? '').includes('actions/checkout'));
    expect(checkout?.with).toMatchObject({ 'fetch-depth': 0, 'fetch-tags': true });
  });

  it('invokes scripts/verify-rc-pack-parity.mjs, never the credential harness scripts', () => {
    const job = wf.jobs['pack-parity'];
    const run = job.steps?.map((s) => s.run ?? '').join('\n') ?? '';
    expect(run).toContain('node scripts/verify-rc-pack-parity.mjs');
    expect(run).not.toMatch(/scripts\/e2e-/);
    expect(run).not.toMatch(/test-e2e-deploy\.yml/);
  });

  it('never writes to the credential pin file or the harness manifest (read-only usage)', () => {
    expect(text).not.toMatch(/>\s*\.github\/compat-credential-ref\.json/);
    expect(text).not.toMatch(/deploy-tests-manifest/);
  });

  it('fails closed: no continue-on-error anywhere in this file', () => {
    expect(text).not.toMatch(/continue-on-error/);
  });
});
