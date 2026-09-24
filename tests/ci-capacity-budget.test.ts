import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { deriveSmokeManifest } from '../scripts/lib/smoke-manifest.mjs';

/**
 * GUARD TESTS for #1301 — CI capacity for the 6 credential cells.
 *
 * Four independent decisions, each with its own describe block so a failure
 * names exactly which half of the budget broke:
 *   1. no two scheduled crons across ALL workflows share a UTC minute
 *      (mechanical — the literal collision measured in docs/ci/capacity-budget.md);
 *   2. `max-parallel: 8` on both credential shard matrices;
 *   3. the branch smoke manifest is DERIVED from (never drifts from) the real
 *      credential manifest, and the dispatch-only `smoke` input wires it in;
 *   4. workflow-level concurrency groups branch dispatches by ref (cancelling
 *      a superseded one) while giving every scheduled run a run-id-unique
 *      group — so no credential/early-warning cron can ever share a group
 *      with anything, following tests/ci-concurrency-group.test.ts's pattern.
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

describe('cron staggering — no exact UTC-minute collision across any workflow (#1301)', () => {
  it('every scheduled cron literal maps to a UNIQUE (file, cron) — collisions are grouped by minute', () => {
    const byMinute = new Map<string, string[]>();
    for (const file of workflowFiles()) {
      for (const cron of crons(readWorkflowText(file))) {
        const list = byMinute.get(cron) ?? [];
        list.push(file);
        byMinute.set(cron, list);
      }
    }
    const collisions = [...byMinute.entries()].filter(([, files]) => new Set(files).size > 1);
    expect(
      collisions,
      `these cron literals are shared by more than one workflow file: ${collisions
        .map(([cron, files]) => `${cron} -> ${files.join(', ')}`)
        .join('; ')}`,
    ).toEqual([]);
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

  for (const file of CREDENTIAL_WORKFLOWS) {
    it(`${file} carries a workflow-level concurrency group`, () => {
      const doc = readWorkflowDoc(file);
      const concurrency = doc.concurrency as Concurrency;
      expect(concurrency, `${file} has no workflow-level concurrency block`).toBeDefined();
      const group =
        typeof concurrency === 'string' ? concurrency : (concurrency as { group?: unknown })?.group;
      expect(group, `${file}'s concurrency block has no group`).toBeTypeOf('string');
    });

    it(`${file}'s concurrency group scopes cancellation to workflow_dispatch only`, () => {
      const doc = readWorkflowDoc(file);
      const concurrency = doc.concurrency as { group?: unknown; 'cancel-in-progress'?: unknown };
      const group = String(concurrency.group ?? '');

      // The group must branch on event_name so a workflow_dispatch run's group
      // key differs in SHAPE from a scheduled run's (ref-scoped vs run_id-scoped).
      expect(group, `${file} concurrency group does not branch on github.event_name`).toMatch(
        /github\.event_name\s*==\s*'workflow_dispatch'/,
      );
      // The dispatch branch must be scoped to the ref (so only the SAME branch's
      // dispatches collide).
      expect(group, `${file} concurrency group's dispatch branch is not ref-scoped`).toMatch(
        /github\.ref/,
      );
      // The non-dispatch (schedule) branch must be scoped to run_id, which no
      // other run can ever share — this is what makes "never share a group"
      // true for credential crons rather than merely low-probability.
      expect(
        group,
        `${file} concurrency group's non-dispatch branch is not run_id-scoped — a scheduled run could collide with another run`,
      ).toMatch(/github\.run_id/);

      const cancelExpr =
        typeof concurrency['cancel-in-progress'] === 'string'
          ? (concurrency['cancel-in-progress'] as string).replace(/\s+/g, ' ').trim()
          : concurrency['cancel-in-progress'];
      expect(
        cancelExpr,
        `${file}'s cancel-in-progress must be gated on workflow_dispatch, not unconditional — an unconditional cancel could cancel a credential night`,
      ).toBe("${{ github.event_name == 'workflow_dispatch' }}");
    });
  }

  it('MUTATION-PROOF: a run_id-unscoped fallback would let two scheduled runs collide (documents the property, not just asserts the text)', () => {
    // If the non-dispatch branch of the group expression were a FIXED string
    // (e.g. just github.workflow) instead of run_id-scoped, two scheduled runs
    // of the SAME workflow (e.g. the node and bun credential crons both firing
    // in test-e2e-deploy.yml) would share one group and one would cancel the
    // other — exactly the failure mode #1301 forbids ("Do NOT put credential
    // crons in a shared concurrency group"). Asserted here as a positive
    // control so the regex above is proven to discriminate the two shapes.
    const safe =
      "${{ github.event_name == 'workflow_dispatch' && format('x-{0}', github.ref) || format('x-{0}', github.run_id) }}";
    const unsafe =
      "${{ github.event_name == 'workflow_dispatch' && format('x-{0}', github.ref) || 'x-schedule' }}";
    expect(safe).toMatch(/github\.run_id/);
    expect(unsafe).not.toMatch(/github\.run_id/);
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
