import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { cronsOverlap, findOverlappingPairs, parseCron } from '../scripts/lib/cron-overlap.mjs';
import { deriveSmokeManifest } from '../scripts/lib/smoke-manifest.mjs';
import { evaluate, exprBody } from './helpers/gha-expr';

/**
 * GUARD TESTS for #1301 — CI capacity for the 6 credential cells.
 *
 * Four independent decisions, each with its own describe block so a failure
 * names exactly which half of the budget broke:
 *   1. no two (file, cron) entries — including two in the SAME file —
 *      overlap on the real UTC minute-of-day + day-of-week they fire on
 *      (scripts/lib/cron-overlap.mjs NORMALISES rather than string-compares:
 *      a plain `crons.includes(x)` check misses a Sunday-only cron
 *      overlapping a daily one, a leading-zero hour literal, and a duplicate
 *      declared twice in one file — all three are mutation-proved below);
 *   2. `max-parallel: 8` on both credential shard matrices;
 *   3. the branch smoke manifest is DERIVED from (never drifts from) the real
 *      credential manifest, and the dispatch-only `smoke` input wires it in;
 *   4. workflow-level concurrency groups EVALUATE ref-scoped on dispatch and
 *      run_id-scoped on schedule (tests/helpers/gha-expr's real evaluator,
 *      not a text-presence check — a text check stays green if `github.ref`
 *      and `github.run_id` are swapped between branches; mutation-proved
 *      below by performing exactly that swap on the real expression and
 *      confirming the property reds), so no credential/early-warning cron
 *      can ever share a group with anything, following
 *      tests/ci-concurrency-group.test.ts's pattern.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github/workflows');
const CREDENTIAL_WORKFLOWS = ['test-e2e-deploy.yml', 'compat-vinext.yml'];

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
}

function readWorkflowText(file: string): string {
  return readFileSync(resolve(WORKFLOW_DIR, file), 'utf8');
}

function readWorkflowDoc(file: string): Record<string, unknown> {
  return parse(readWorkflowText(file)) as Record<string, unknown>;
}

/** All `cron: '...'` literals in a workflow file's `schedule:` trigger. */
function crons(text: string): string[] {
  return [...text.matchAll(/cron:\s*'([^']+)'/g)].map((m) => m[1] as string);
}

describe('cron staggering — no overlapping UTC minute-of-day across any workflow (#1301)', () => {
  /** Every (file, cron) entry across the whole workflow directory. */
  function allCronEntries(): { file: string; cron: string }[] {
    const out: { file: string; cron: string }[] = [];
    for (const file of workflowFiles()) {
      for (const cron of crons(readWorkflowText(file))) out.push({ file, cron });
    }
    return out;
  }

  it('no two (file, cron) entries — including two in the SAME file — overlap on minute+hour+day-of-week', () => {
    // findOverlappingPairs compares EVERY pair, so two identical crons
    // declared twice in one file collide with each other too, not just
    // across files.
    const overlaps = findOverlappingPairs(allCronEntries());
    expect(
      overlaps,
      `these cron entries overlap on UTC minute-of-day: ${overlaps
        .map((o) => `${o.a.file}:${o.a.cron} <-> ${o.b.file}:${o.b.cron}`)
        .join('; ')}`,
    ).toEqual([]);
  });

  it('parseCron normalises minute/hour as integers and day-of-week "*" to all 7 days', () => {
    expect(parseCron('17 3 * * *')).toEqual({
      minute: 17,
      hour: 3,
      daysOfWeek: new Set([0, 1, 2, 3, 4, 5, 6]),
    });
    // Leading zero on the hour is the SAME integer hour.
    expect(parseCron('17 03 * * *').hour).toBe(3);
    expect(parseCron('17 3 * * 0').daysOfWeek).toEqual(new Set([0]));
  });

  it('parseCron fails closed on a shape this repo never uses (day-of-month/month set)', () => {
    expect(() => parseCron('17 3 1 * *')).toThrow(/day-of-month/);
    expect(() => parseCron('17 3 * 6 *')).toThrow(/day-of-month/);
    expect(() => parseCron('not a cron')).toThrow();
  });

  // ── MUTATION-PROOF: cronsOverlap discriminates every shape a string
  // comparison misses. Each case is a real gap a `crons.includes(x)` check
  // has — Sunday-overlap, a leading-zero literal, and same-file duplicates —
  // asserted directly against the pure function, not against the real
  // workflow directory (which, having been fixed, has none of these left to
  // exercise).
  describe('cronsOverlap catches what exact-string comparison misses', () => {
    it('a Sunday-only cron OVERLAPS a daily cron at the same minute+hour ("*" includes Sunday)', () => {
      expect(cronsOverlap('17 3 * * 0', '17 3 * * *')).toBe(true);
    });

    it('a leading-zero hour literal is the SAME hour, not a different one', () => {
      expect(cronsOverlap('17 03 * * *', '17 3 * * *')).toBe(true);
    });

    it('two IDENTICAL crons overlap (catches a duplicate within one file)', () => {
      expect(cronsOverlap('41 5 * * *', '41 5 * * *')).toBe(true);
    });

    it('NEGATIVE CONTROL: different minute or hour never overlaps', () => {
      expect(cronsOverlap('17 3 * * *', '18 3 * * *')).toBe(false);
      expect(cronsOverlap('17 3 * * *', '17 4 * * *')).toBe(false);
    });

    it('NEGATIVE CONTROL: same minute+hour but disjoint days-of-week does not overlap', () => {
      expect(cronsOverlap('17 3 * * 0', '17 3 * * 1')).toBe(false);
    });

    it('a string-identity check would have missed the Sunday case — proven directly', () => {
      // The exact defect the review named: `['17 3 * * 0'].includes('17 3 * * *')`
      // is false even though the two crons DO fire in the same window. This
      // pins the gap so nobody re-introduces a plain string-Set collision
      // check believing it is equivalent to cronsOverlap.
      const stringCollision = ['17 3 * * 0'].includes('17 3 * * *');
      expect(stringCollision, 'string comparison must NOT see this as a collision').toBe(false);
      expect(cronsOverlap('17 3 * * 0', '17 3 * * *'), 'cronsOverlap MUST see it').toBe(true);
    });
  });

  it('the two historically-colliding literals now resolve to their documented new times', () => {
    // The two REAL collisions docs/ci/capacity-budget.md records, pinned so a
    // regression is a named diff rather than a silent re-collision.
    const operatorE2e = crons(readWorkflowText('operator-e2e-nightly.yml'));
    const secretScan = crons(readWorkflowText('secret-scan-nightly.yml'));
    const retractedFigure = crons(readWorkflowText('retracted-figure-resolution-nightly.yml'));
    const imagePin = crons(readWorkflowText('image-pin-resolution-nightly.yml'));
    const testE2eDeploy = crons(readWorkflowText('test-e2e-deploy.yml'));

    expect(operatorE2e, 'operator-e2e-nightly.yml must move off 17 3 * * *').not.toContain(
      '17 3 * * *',
    );
    expect(secretScan, 'secret-scan-nightly.yml must move off 17 3 * * *').not.toContain(
      '17 3 * * *',
    );
    // The node credential lane's own anchor stays untouched — it is
    // cross-referenced by docs/compat/window-node-lane.md and several tests.
    expect(
      testE2eDeploy,
      'test-e2e-deploy.yml must keep its node credential anchor at 17 3 * * *',
    ).toContain('17 3 * * *');

    expect(
      retractedFigure,
      'retracted-figure-resolution-nightly.yml must move off 41 5 * * *',
    ).not.toContain('41 5 * * *');
    expect(imagePin, 'image-pin-resolution-nightly.yml keeps its existing 41 5 * * *').toContain(
      '41 5 * * *',
    );
  });
});

describe('max-parallel: 8 on every credential shard matrix (#1301)', () => {
  for (const file of CREDENTIAL_WORKFLOWS) {
    it(`${file}'s deploy-tests job caps concurrency at 8`, () => {
      const doc = readWorkflowDoc(file);
      const jobs = doc.jobs as Record<string, { strategy?: { 'max-parallel'?: unknown } }>;
      const deployTests = jobs['deploy-tests'];
      expect(deployTests, `${file} has no deploy-tests job`).toBeDefined();
      expect(
        deployTests?.strategy?.['max-parallel'],
        `${file}'s deploy-tests job has no (or a non-8) max-parallel — a full credential run can consume the whole 20-job cap alone`,
      ).toBe(8);
    });
  }
});

describe('the branch smoke manifest never drifts from the credential manifest (#1301)', () => {
  const MAIN_PATH = resolve(REPO_ROOT, 'test/deploy-tests-manifest.knext.json');
  const SMOKE_PATH = resolve(REPO_ROOT, 'test/deploy-tests-manifest.smoke.knext.json');

  it('the committed smoke manifest equals deriveSmokeManifest(mainManifest) exactly', () => {
    const main = JSON.parse(readFileSync(MAIN_PATH, 'utf8'));
    const committedSmoke = JSON.parse(readFileSync(SMOKE_PATH, 'utf8'));
    const expectedSmoke = deriveSmokeManifest(main);
    expect(
      committedSmoke,
      'test/deploy-tests-manifest.smoke.knext.json is stale — run `node scripts/generate-smoke-manifest.mjs`',
    ).toEqual(expectedSmoke);
  });

  it('the smoke manifest narrows rules.include and copies exclude/suites/quarantines verbatim', () => {
    const main = JSON.parse(readFileSync(MAIN_PATH, 'utf8'));
    const smoke = JSON.parse(readFileSync(SMOKE_PATH, 'utf8'));
    expect(
      smoke.rules.include,
      'smoke include must be narrower than the main manifest',
    ).not.toEqual(main.rules.include);
    expect(smoke.rules.include.length).toBeGreaterThan(0);
    expect(smoke.rules.exclude, 'smoke exclude must mirror the credential manifest').toEqual(
      main.rules.exclude,
    );
    expect(smoke.suites, 'smoke suites must mirror the credential manifest').toEqual(main.suites);
  });

  it('test-e2e-deploy.yml wires a dispatch-only `smoke` input to select the smoke manifest', () => {
    const raw = readWorkflowText('test-e2e-deploy.yml');
    const doc = readWorkflowDoc('test-e2e-deploy.yml');
    const inputs = (doc.on as { workflow_dispatch?: { inputs?: Record<string, unknown> } })
      .workflow_dispatch?.inputs;
    expect(
      inputs?.smoke,
      'test-e2e-deploy.yml has no `smoke` workflow_dispatch input',
    ).toBeDefined();
    expect((inputs?.smoke as { default?: unknown })?.default).toBe(false);

    // Dispatch-only, same pattern as sandboxFetchDebug: the manifest-select
    // expression must read github.event.inputs.smoke, never github.event.schedule.
    expect(raw, 'KNEXT_DEPLOY_MANIFEST must be defined and read the smoke dispatch input').toMatch(
      /KNEXT_DEPLOY_MANIFEST:.*github\.event\.inputs\.smoke/,
    );
    expect(raw).toMatch(/deploy-tests-manifest\.smoke\.knext\.json/);

    // Every NON-COMMENT use of the manifest filename in the shard job must go
    // through the single env decision, not a second hardcoded literal —
    // otherwise smoke mode silently fails to affect the "Compute excluded
    // count" step. Comment mentions (e.g. the header's prose) are not a
    // wiring hazard and are excluded, mirroring the effective-text approach
    // tests/ci-concurrency-group.test.ts's classifier uses.
    const codeLines = raw.split('\n').filter((line) => !line.trim().startsWith('#'));
    const literalManifestUses = codeLines.filter((line) =>
      line.includes('deploy-tests-manifest.knext.json'),
    ).length;
    // Exactly one hardcoded occurrence is expected: inside the KNEXT_DEPLOY_MANIFEST
    // decision expression itself (the non-smoke branch's literal filename).
    expect(
      literalManifestUses,
      'the real manifest filename must be hardcoded in exactly one place (the KNEXT_DEPLOY_MANIFEST decision) — a second hardcoded use would bypass smoke mode',
    ).toBe(1);
  });

  it('never selects the smoke manifest on a schedule (credential/early-warning) trigger', () => {
    // github.event.inputs is empty on every `schedule` event, so an expression
    // of the form `inputs.smoke == 'true' && smokeFile || mainFile` always
    // falls through to mainFile on a cron — mirrored from the sandboxFetchDebug
    // guard already proven for this exact GitHub Actions property.
    const raw = readWorkflowText('test-e2e-deploy.yml');
    const match = raw.match(/KNEXT_DEPLOY_MANIFEST:\s*(.+)/);
    expect(match, 'KNEXT_DEPLOY_MANIFEST expression not found').toBeTruthy();
    const expr = match?.[1] ?? '';
    expect(expr, 'the manifest decision must never branch on github.event.schedule').not.toMatch(
      /github\.event\.schedule/,
    );
  });
});

describe('per-branch concurrency: dispatches cancel each other, credential crons never share a group (#1301)', () => {
  type Concurrency = { group?: unknown; 'cancel-in-progress'?: unknown } | string | undefined;

  // Distinct, unmistakable sentinel values per trigger context, so a
  // substring match can only succeed for the RIGHT reason.
  const DISPATCH_REF = 'refs/heads/sentinel-dispatch-ref';
  const DISPATCH_RUN_ID = 111111;
  const SCHEDULE_REF = 'refs/heads/sentinel-schedule-ref';
  const SCHEDULE_RUN_ID = 222222;

  function dispatchCtx(workflow: string) {
    return {
      github: {
        event_name: 'workflow_dispatch',
        workflow,
        ref: DISPATCH_REF,
        run_id: DISPATCH_RUN_ID,
      },
    };
  }
  function scheduleCtx(workflow: string) {
    return {
      github: {
        event_name: 'schedule',
        workflow,
        ref: SCHEDULE_REF,
        run_id: SCHEDULE_RUN_ID,
      },
    };
  }

  /**
   * The #1301 review round-1 mutation: swap every `github.ref` <-> every
   * `github.run_id` in the REAL extracted expression — the exact "schedules
   * keyed on ref, sharing one group on main" defect named in review. Fails
   * closed (throws) unless BOTH identifiers appear at least once, so a
   * future rewrite of the expression that drops one of them cannot make
   * this swap silently a no-op.
   */
  function swapRefAndRunId(expr: string): string {
    const refCount = (expr.match(/github\.ref\b/g) ?? []).length;
    const runIdCount = (expr.match(/github\.run_id\b/g) ?? []).length;
    if (refCount === 0 || runIdCount === 0) {
      throw new Error(
        `swapRefAndRunId: expected both github.ref and github.run_id in the expression, found ref=${refCount} run_id=${runIdCount} in: ${expr}`,
      );
    }
    const PLACEHOLDER = '\u0000SWAP_RUN_ID\u0000';
    return expr
      .replace(/github\.run_id\b/g, PLACEHOLDER)
      .replace(/github\.ref\b/g, 'github.run_id')
      .split(PLACEHOLDER)
      .join('github.ref');
  }

  for (const file of CREDENTIAL_WORKFLOWS) {
    it(`${file} carries a workflow-level concurrency group`, () => {
      const doc = readWorkflowDoc(file);
      const concurrency = doc.concurrency as Concurrency;
      expect(concurrency, `${file} has no workflow-level concurrency block`).toBeDefined();
      const group =
        typeof concurrency === 'string' ? concurrency : (concurrency as { group?: unknown })?.group;
      expect(group, `${file}'s concurrency block has no group`).toBeTypeOf('string');
    });

    // #1301 review round 1: EVALUATE the group expression per trigger (the
    // real gha-expr evaluator, the same one tests/compat-webpack-credential-lanes.test.ts
    // uses) instead of checking that `github.ref` and `github.run_id` merely
    // APPEAR somewhere in the text. A text-presence check stays green if the
    // two identifiers are swapped between branches; evaluating the real
    // expression under a dispatch context and a schedule context cannot.
    it(`${file}'s concurrency group EVALUATES ref-scoped on dispatch, run_id-scoped on schedule`, () => {
      const doc = readWorkflowDoc(file);
      const concurrency = doc.concurrency as { group?: unknown; 'cancel-in-progress'?: unknown };
      const groupExpr = exprBody(concurrency.group);

      const dispatchResult = String(evaluate(groupExpr, dispatchCtx(file)) ?? '');
      const scheduleResult = String(evaluate(groupExpr, scheduleCtx(file)) ?? '');

      expect(dispatchResult, `${file}: dispatch trigger must produce a ref-scoped group`).toContain(
        DISPATCH_REF,
      );
      expect(
        dispatchResult,
        `${file}: dispatch trigger's group must not carry a run_id`,
      ).not.toContain(String(DISPATCH_RUN_ID));

      expect(
        scheduleResult,
        `${file}: schedule (credential/early-warning) trigger must produce a run_id-scoped group — a ref-scoped schedule group means every scheduled run on the same ref (e.g. every credential cron on main) shares ONE group`,
      ).toContain(String(SCHEDULE_RUN_ID));
      expect(
        scheduleResult,
        `${file}: schedule trigger's group must not carry the ref — that is the exact "schedules keyed on ref, sharing one group on main" defect`,
      ).not.toContain(SCHEDULE_REF);

      const cancelExpr =
        typeof concurrency['cancel-in-progress'] === 'string'
          ? (concurrency['cancel-in-progress'] as string).replace(/\s+/g, ' ').trim()
          : concurrency['cancel-in-progress'];
      expect(
        cancelExpr,
        `${file}'s cancel-in-progress must be gated on workflow_dispatch, not unconditional — an unconditional cancel could cancel a credential night`,
      ).toBe("${{ github.event_name == 'workflow_dispatch' }}");
    });

    // ── MUTATION-PROOF, against the REAL extracted expression ──────────────
    // Swap github.ref <-> github.run_id in the ACTUAL workflow's group
    // expression and re-evaluate. If the assertions above only checked that
    // both identifiers appear somewhere in the text, this swap would leave
    // them green — proving that would be decoration. Evaluating per trigger
    // catches it: the swapped expression must now FAIL the schedule
    // assertion (its schedule branch is ref-scoped) and FAIL the dispatch
    // assertion (its dispatch branch is run_id-scoped).
    it(`MUTATION-PROOF (${file}): swapping github.ref <-> github.run_id reds the property above`, () => {
      const doc = readWorkflowDoc(file);
      const concurrency = doc.concurrency as { group?: unknown };
      const realExpr = exprBody(concurrency.group);
      const swapped = swapRefAndRunId(realExpr);
      // The swap must actually change something, or it isn't exercising the
      // mutation at all.
      expect(swapped, 'swapRefAndRunId produced no change — nothing was proven').not.toBe(realExpr);

      const scheduleResultSwapped = String(evaluate(swapped, scheduleCtx(file)) ?? '');
      const dispatchResultSwapped = String(evaluate(swapped, dispatchCtx(file)) ?? '');

      // Under the swap, the schedule branch is now ref-scoped — the exact
      // "schedules keyed on ref, sharing one group on main" defect.
      expect(
        scheduleResultSwapped,
        'the swap must make the schedule branch ref-scoped (proving the un-swapped assertion actually discriminates this)',
      ).toContain(SCHEDULE_REF);
      expect(scheduleResultSwapped).not.toContain(String(SCHEDULE_RUN_ID));

      // And the dispatch branch is now run_id-scoped instead of ref-scoped.
      expect(dispatchResultSwapped).toContain(String(DISPATCH_RUN_ID));
      expect(dispatchResultSwapped).not.toContain(DISPATCH_REF);
    });
  }

  it('swapRefAndRunId fails closed when the expression carries only one of the two identifiers', () => {
    expect(() => swapRefAndRunId("${{ format('x-{0}', github.ref) }}")).toThrow(/expected both/);
    expect(() => swapRefAndRunId("${{ format('x-{0}', github.run_id) }}")).toThrow(/expected both/);
  });

  it('swapRefAndRunId is its own inverse (sanity: the swap is a true swap, not a one-way collapse)', () => {
    const expr = "github.event_name == 'workflow_dispatch' && github.ref || github.run_id";
    expect(swapRefAndRunId(swapRefAndRunId(expr))).toBe(expr);
  });
});

describe('the capacity budget is documented (#1301)', () => {
  it('docs/ci/capacity-budget.md exists and covers every decision this issue requires', () => {
    const doc = readFileSync(resolve(REPO_ROOT, 'docs/ci/capacity-budget.md'), 'utf8');
    for (const marker of ['max-parallel: 8', 'smoke', 'concurrency', '20', 'stagger']) {
      expect(
        doc.toLowerCase(),
        `docs/ci/capacity-budget.md does not mention "${marker}"`,
      ).toContain(marker.toLowerCase());
    }
  });
});
