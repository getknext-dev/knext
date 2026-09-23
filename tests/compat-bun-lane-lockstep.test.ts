import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { LANE_MARKER_PREFIX } from '../scripts/compat-window-audit.mjs';

/**
 * cr-1179 findings 1 + 2 — the compat-window fingerprint must freeze the Bun
 * the lane ACTUALLY SERVED ON, and must never freeze a constant.
 *
 * `docs/compat/window-bun-lane.md` rule 4 makes the freeze key "the
 * `bun-version` workflow INPUT together with `bun --revision`". The fingerprint
 * step runs in `build-next`, but the Bun the suite runs against is installed in
 * `deploy-tests` from `${{ github.event.inputs.bun-version || '1.4.0' }}`. If
 * those two Bun installs can differ, the fold freezes the WRONG Bun: a
 * `bun-version=canary` dispatch records stable, and the documented bump
 * procedure (edit the deploy-tests pin) moves the tested Bun WITHOUT moving the
 * fingerprint — so the 14-night streak does not restart, which is the entire
 * point of rule 4.
 *
 * These are LOCKSTEP assertions in the sense of `metrics-port-lockstep.test.ts`:
 * they do not restate one literal, they assert that two places which must move
 * together CANNOT diverge. Mutation proof: changing either bun-lane
 * `bun-version:` expression alone must red this file.
 *
 * WHAT THIS DOES NOT GUARANTEE, stated rather than implied. Identical SPECS are
 * identical BUILDS only for a fixed spec. A floating spec — `canary`, `latest` —
 * can resolve to different builds in the two jobs, which start at different
 * times, so the frozen revision could differ from the served one. That is out of
 * scope for the credential rather than unhandled: only SCHEDULED runs are graded
 * nights, and the schedule always takes the pinned fallback (the floating spec is
 * reachable only through `workflow_dispatch`, whose runs are not nights). A
 * future change that lets a schedule carry a floating spec would reopen this,
 * and would have to close it by threading the OBSERVED revision from the shard
 * instead of the install spec.
 */

const REPO_ROOT = resolve(import.meta.dir, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');

type Step = {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type Job = { steps?: Step[]; needs?: string | string[] };

function workflow(): { jobs: Record<string, Job> } {
  return parse(readFileSync(WORKFLOW_PATH, 'utf8'));
}

/** Is this step gated on the Bun credentialing lane? */
function isBunLaneGated(step: Step): boolean {
  return /KNEXT_RUNTIME\s*==\s*'bun'/.test(String(step.if ?? ''));
}

function isSetupBun(step: Step): boolean {
  return String(step.uses ?? '').startsWith('oven-sh/setup-bun@');
}

/** Every setup-bun in the workflow that installs the LANE's Bun. */
function bunLaneSetupSteps(): Array<{ job: string; step: Step }> {
  const out: Array<{ job: string; step: Step }> = [];
  for (const [job, def] of Object.entries(workflow().jobs)) {
    for (const step of def.steps ?? []) {
      if (isSetupBun(step) && isBunLaneGated(step)) out.push({ job, step });
    }
  }
  return out;
}

function fingerprintStep(): { job: string; index: number; steps: Step[] } {
  for (const [job, def] of Object.entries(workflow().jobs)) {
    const steps = def.steps ?? [];
    const index = steps.findIndex((s) =>
      /Fingerprint the frozen compat-window set/.test(s.name ?? ''),
    );
    if (index >= 0) return { job, index, steps };
  }
  throw new Error('no step named "Fingerprint the frozen compat-window set" exists');
}

describe('cr-1179 #1 — the fingerprint freezes the Bun the lane served on', () => {
  it('the bun-lane setup-bun steps all install ONE version expression (they cannot drift apart)', () => {
    const lane = bunLaneSetupSteps();
    // Scanning, not enumerating: a third lane-gated setup-bun added later is
    // covered by construction.
    expect(lane.length).toBeGreaterThanOrEqual(2);
    const expressions = new Set(lane.map(({ step }) => String(step.with?.['bun-version'] ?? '')));
    expect(
      [...expressions],
      `every bun-lane setup-bun must resolve the SAME bun-version; found ${JSON.stringify(
        lane.map(({ job, step }) => [job, step.with?.['bun-version']]),
      )}`,
    ).toHaveLength(1);
    // And that one expression must be the lane's dispatchable input, not a bare
    // literal — otherwise a `bun-version=canary` dispatch is unattributable.
    expect([...expressions][0]).toMatch(/github\.event\.inputs\.bun-version/);
  });

  it('the Bun on PATH at the fingerprint step is the LANE Bun, not the workspace pin', () => {
    const { steps, index, job } = fingerprintStep();
    const priorBunSetups = steps.slice(0, index).filter(isSetupBun);
    const priorSetupBun = priorBunSetups[priorBunSetups.length - 1];
    expect(priorSetupBun, `no setup-bun precedes the fingerprint step in ${job}`).toBeDefined();
    expect(
      isBunLaneGated(priorSetupBun as Step),
      'the LAST setup-bun before the fingerprint step must be the bun-lane one, or the fold ' +
        'observes the hardcoded workspace pin instead of the Bun under test',
    ).toBe(true);
    const laneExpressions = new Set(
      bunLaneSetupSteps().map(({ step }) => String(step.with?.['bun-version'] ?? '')),
    );
    expect(laneExpressions.has(String((priorSetupBun as Step).with?.['bun-version'] ?? ''))).toBe(
      true,
    );
  });

  it('the workspace (ungated) setup-bun is NOT what the fold reads', () => {
    // The knext-workspace Bun is a build-tool pin and is deliberately free to
    // differ from the served Bun; the guard above is what keeps the fold off it.
    const ungated = Object.values(workflow().jobs)
      .flatMap((j) => j.steps ?? [])
      .filter((s) => isSetupBun(s) && !isBunLaneGated(s));
    expect(ungated.length).toBeGreaterThanOrEqual(1);
    const { steps, index } = fingerprintStep();
    const priorBunSetups = steps.slice(0, index).filter(isSetupBun);
    const last = priorBunSetups[priorBunSetups.length - 1];
    expect(ungated.includes(last as Step)).toBe(false);
  });
});

describe('cr-1179 #2 — the fold must not swallow a missing Bun into a constant', () => {
  const foldScript = () => String(fingerprintStep().steps[fingerprintStep().index].run ?? '');

  it('bun --version / --revision are observed without a fallback constant', () => {
    const run = foldScript();
    expect(run).toMatch(/bun --version/);
    expect(run).toMatch(/bun --revision/);
    // A `|| echo unknown` freezes the literal `unknown` on EVERY night: the
    // digest still reads as frozen while the fold has stopped discriminating
    // Bun builds at all — green when its subject is gone.
    const bunObservations = run
      .split('\n')
      .filter((l) => /bun --(version|revision)/.test(l) && !l.trimStart().startsWith('#'));
    expect(bunObservations.length).toBeGreaterThanOrEqual(2);
    for (const line of bunObservations) {
      expect(line, `fail-open fallback in: ${line.trim()}`).not.toMatch(/\|\|/);
      expect(line, `suppressed stderr in: ${line.trim()}`).not.toMatch(/2>\s*\/dev\/null/);
    }
  });

  it('the step is set -e and refuses an EMPTY observation', () => {
    const run = foldScript();
    expect(run).toMatch(/set -euo pipefail/);
    // An empty string is folded as "absent" by computeFingerprint (node-lane
    // shape), so an empty `bun --version` would silently degrade the bun digest
    // to the node formula. It must fail the step instead.
    expect(run, 'the fold must assert both observations are non-empty').toMatch(
      /\[\s*-n\s*"\$\{?BUN_VERSION\}?"\s*\]/,
    );
    expect(run).toMatch(/\[\s*-n\s*"\$\{?BUN_REVISION\}?"\s*\]/);
  });
});

/**
 * cr-1179 #3 — the lane-marker artifact. `compat-window-audit` reads the lane
 * from this artifact's NAME (out of the artifacts listing, never downloaded) so
 * a night whose ledger is lost is still attributed to ONE lane. Without it, a
 * bun night that loses its runner disqualifies a night in the NODE window and
 * restarts the v1.0 credential streak for a failure on the other lane.
 */
describe('cr-1179 #3 — the run publishes its lane independently of the ledger', () => {
  function markerStep(): { job: string; index: number; steps: Step[]; step: Step } {
    for (const [job, def] of Object.entries(workflow().jobs)) {
      const steps = def.steps ?? [];
      const index = steps.findIndex((s) =>
        String(s.with?.name ?? '').startsWith(LANE_MARKER_PREFIX),
      );
      if (index >= 0) return { job, index, steps, step: steps[index] };
    }
    throw new Error(`no step uploads an artifact named ${LANE_MARKER_PREFIX}<lane>`);
  }

  it('an artifact names the lane, locksteped to the prefix the audit reads', () => {
    const { step } = markerStep();
    expect(String(step.uses ?? '')).toMatch(/^actions\/upload-artifact@/);
    // The lane comes from the SAME env the ledger and the alert title read, so
    // the marker cannot disagree with the lane the run actually ran.
    expect(step.with?.name).toBe(`${LANE_MARKER_PREFIX}\${{ env.KNEXT_RUNTIME }}`);
  });

  it('it is published for EVERY lane, not just the bun one', () => {
    // A node-only or bun-only marker would leave the other lane's lost nights
    // unattributed — i.e. back in both windows.
    const { step } = markerStep();
    expect(step.if ?? null, 'the lane marker must be unconditional').toBeNull();
  });

  it('it is published BEFORE any step that can lose the night', () => {
    // Attribution has to outlive the failure it attributes. A marker uploaded
    // after the install/pack/fingerprint work would be missing from exactly the
    // runs that need it.
    //
    // #850 / ADR-0056 moved it into the ROOT job (`credential-ref`), ahead of
    // the RC resolution — a REFUSED credential night must still be attributed
    // to its own lane, or it would restart every lane's credential window. So
    // the property is now asserted structurally: the marker's job needs
    // nothing, every other job waits on it (transitively), and within that job
    // only marker steps precede it.
    const { job, steps, index } = markerStep();
    const jobs = workflow().jobs;
    const needsOf = (name: string) => {
      const n = jobs[name]?.needs;
      return Array.isArray(n) ? n : n ? [n] : [];
    };
    expect(needsOf(job), 'the marker job must be a root job').toEqual([]);
    const reaches = (name: string, seen = new Set<string>()): boolean =>
      needsOf(name).some((n) => {
        if (n === job) return true;
        if (seen.has(n)) return false;
        seen.add(n);
        return reaches(n, seen);
      });
    for (const other of Object.keys(jobs).filter((j) => j !== job)) {
      expect(reaches(other), `job ${other} must wait on the marker job ${job}`).toBe(true);
    }
    const firstWork = steps.findIndex((s) => !/marker/i.test(s.name ?? ''));
    expect(firstWork).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(firstWork);
  });
});
