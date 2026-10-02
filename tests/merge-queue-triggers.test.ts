import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * GUARD TESTS for the GitHub merge queue (`merge_group`).
 *
 * ## Why this exists
 *
 * GitHub's merge queue enqueues a PR onto a temporary
 * `refs/heads/gh-readonly-queue/main/...` ref and runs the branch's REQUIRED
 * status checks there via the **`merge_group`** event. If no workflow triggers on
 * `merge_group`, the required checks never report on that ref and every PR hangs
 * in `AWAITING_CHECKS` forever — nothing can merge to `main`.
 *
 * So every workflow that OWNS a required status context must trigger on
 * `merge_group`, and the jobs that post those contexts must actually EXECUTE
 * there (not be skipped by an `if:`/`paths:` guard that excludes the event).
 *
 * ## The other half — push-only side effects must NOT fire on the queue ref
 *
 * The merge_group ref is `refs/heads/gh-readonly-queue/main/...`, which is NOT
 * `refs/heads/main`. Any step gated on `github.ref == 'refs/heads/main'` is
 * therefore SAFE — it does not run on the queue. The danger is a step gated on
 * `github.event_name != 'pull_request'`, which WOULD include `merge_group`: that
 * would run cosign signing / registry push / release publishing on the queue ref.
 * This file asserts the signing/publish steps stay ref-gated to `main`.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github/workflows');

function readWorkflow(file: string): { doc: Record<string, unknown>; raw: string } {
  const raw = readFileSync(resolve(WORKFLOW_DIR, file), 'utf8');
  // YAML 1.1 parses the unquoted `on` key as boolean `true`; accept both.
  return { doc: parse(raw) as Record<string, unknown>, raw };
}

function triggerBlock(file: string): Record<string, unknown> {
  const { doc } = readWorkflow(file);
  const on = doc.on ?? (doc as Record<string, unknown>)[true as unknown as string];
  return on && typeof on === 'object' ? (on as Record<string, unknown>) : {};
}

/**
 * The 12 REQUIRED status contexts on `main` (from
 * `gh api repos/getknext-dev/knext/branches/main/protection/required_status_checks`),
 * each mapped to the workflow file whose job `name:` posts it. A required context
 * whose owning workflow does not run on `merge_group` hangs the queue.
 */
const REQUIRED_CONTEXT_OWNERS: Record<string, string> = {
  'Lint & Test': 'ci.yml',
  'Typecheck (root tests/)': 'ci.yml',
  'Operator Go tests (envtest + install bundle)': 'ci.yml',
  'Operator codegen is up-to-date (make generate + make manifests)': 'ci.yml',
  'No :latest images in operator manifests': 'ci.yml',
  'Docs site build (apps/docs → knext-platform.dev)': 'ci.yml',
  'Prod image next/image optimization (strict,': 'ci.yml',
  'SIGTERM drain (legacy standalone supervisor)': 'ci.yml',
  'bun-exec runs from a clean alpine (ADR-0042 A9)': 'ci.yml',
  'Pack + clean-install + CLI + app-import (plain npm/Node, no Bun)': 'install-smoke.yml',
  'SBOM + Trivy (+ cosign sign on main)': 'supply-chain.yml',
  'Escalation triggers acknowledged': 'escalation-triggers.yml',
};

/** Every workflow that must trigger on merge_group so its required check reports. */
const REQUIRED_OWNING_WORKFLOWS = [...new Set(Object.values(REQUIRED_CONTEXT_OWNERS))].sort();

describe('merge queue — required-check workflows trigger on merge_group', () => {
  for (const file of REQUIRED_OWNING_WORKFLOWS) {
    it(`${file} carries a \`merge_group\` trigger`, () => {
      const on = triggerBlock(file);
      expect(
        'merge_group' in on,
        `${file} owns a required status context but does not trigger on \`merge_group\` — its check never reports on the queue ref and every PR hangs in AWAITING_CHECKS.`,
      ).toBe(true);
    });
  }

  it('every required context maps to a workflow that runs on merge_group', () => {
    const unhandled: string[] = [];
    for (const [context, file] of Object.entries(REQUIRED_CONTEXT_OWNERS)) {
      const on = triggerBlock(file);
      if (!('merge_group' in on)) unhandled.push(`${context} (${file})`);
    }
    expect(
      unhandled,
      'required contexts whose owning workflow does not run on merge_group:\n' +
        unhandled.join('\n'),
    ).toEqual([]);
  });

  it('the job posting each required context is NOT skipped off merge_group by a job-level if:', () => {
    // A job-level `if:` that names only pull_request/push would skip on
    // merge_group, so the required context would never post — the exact hang this
    // fixes. Scan every job whose `name:` is a required context and require its
    // `if:` (if any) to permit merge_group.
    const contexts = new Set(Object.keys(REQUIRED_CONTEXT_OWNERS));
    const offenders: string[] = [];
    for (const file of REQUIRED_OWNING_WORKFLOWS) {
      const { doc } = readWorkflow(file);
      const jobs = (doc.jobs ?? {}) as Record<string, Record<string, unknown>>;
      for (const [jobId, job] of Object.entries(jobs)) {
        const name = typeof job.name === 'string' ? job.name : jobId;
        // Required contexts can be a prefix (branch protection truncates long
        // names), so match by startsWith against the truncated required strings.
        const isRequired = [...contexts].some(
          (c) => name === c || name.startsWith(c) || c.startsWith(name),
        );
        if (!isRequired) continue;
        if (!('if' in job)) continue;
        const cond = String(job.if);
        // The only acceptable job-level condition is one that still lets the job
        // run on merge_group.
        if (!/merge_group/.test(cond)) {
          offenders.push(`${file} job \`${jobId}\` (${name}) if: ${cond}`);
        }
      }
    }
    expect(
      offenders,
      'required-context jobs gated off merge_group:\n' + offenders.join('\n'),
    ).toEqual([]);
  });
});

describe('merge queue — signing/publish side effects stay ref-gated to main', () => {
  // These steps must never run on the queue's gh-readonly-queue ref. Gating on
  // `github.ref == 'refs/heads/main'` is safe; gating on
  // `github.event_name != 'pull_request'` is NOT (it includes merge_group).
  const SIDE_EFFECT_WORKFLOWS = ['supply-chain.yml', 'operator-supply-chain.yml'];
  const DANGEROUS_STEP =
    /(cosign\s+sign|cosign\s+attest|crane\s+push|docker\/login-action|gh-release|softprops\/action-gh-release)/;

  /**
   * The two workflows gate their side-effect steps DIFFERENTLY, and both are
   * legitimate — this checks that each stays SAFE, not that they use the same
   * literal.
   *
   * `supply-chain.yml` (the app image) gates directly on
   * `github.ref == 'refs/heads/main'` — the merge_group ref
   * (`refs/heads/gh-readonly-queue/main/...`) never equals that literal, so
   * this is safe by construction.
   *
   * `operator-supply-chain.yml` (#1667) gates on
   * `steps.channel.outputs.publish`/`is_stable` — booleans DERIVED from the
   * ref by `hack/release-channel.sh` (only `refs/heads/main` or
   * `refs/tags/operator-v*` ever produce `publish=true`; see the dedicated
   * "publish is never true for pull_request/merge_group refs" test below,
   * which proves that derivation directly against the real script rather
   * than re-deriving it here as a second copy of the regex). It ALSO
   * requires `steps.trivy.outcome == 'success'` (#1667 round 4) —
   * `continue-on-error` on the Trivy step masks `conclusion`, so `outcome`
   * is the only field that still tells the truth about a failed scan.
   */
  function mainGated(file: string, cond: string): boolean {
    if (file === 'operator-supply-chain.yml') {
      return (
        /steps\.channel\.outputs\.(publish|is_stable)\s*==\s*'true'/.test(cond) &&
        /steps\.trivy\.outcome\s*==\s*'success'/.test(cond)
      );
    }
    return /github\.ref\s*==\s*'refs\/heads\/main'/.test(cond);
  }

  for (const file of SIDE_EFFECT_WORKFLOWS) {
    it(`${file}: every signing/publish step is gated safely against the merge-queue ref, not on event_name`, () => {
      const { doc } = readWorkflow(file);
      const jobs = (doc.jobs ?? {}) as Record<string, Record<string, unknown>>;
      const offenders: string[] = [];
      for (const [jobId, job] of Object.entries(jobs)) {
        const steps = Array.isArray(job.steps) ? (job.steps as Record<string, unknown>[]) : [];
        for (const step of steps) {
          const body = `${step.run ?? ''}\n${step.uses ?? ''}`;
          if (!DANGEROUS_STEP.test(body)) continue;
          const cond = 'if' in step ? String(step.if) : '';
          if (!mainGated(file, cond)) {
            const label = typeof step.name === 'string' ? step.name : (step.uses ?? step.run);
            offenders.push(`${file} job \`${jobId}\` step \`${label}\` if: ${cond || '(none)'}`);
          }
          // A step must never gate a side effect on event_name alone — that
          // includes merge_group.
          if (/event_name\s*!=\s*'pull_request'/.test(cond)) {
            offenders.push(
              `${file} job \`${jobId}\` gates a side effect on \`event_name != 'pull_request'\` — that INCLUDES merge_group`,
            );
          }
        }
      }
      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  }

  it('operator-supply-chain.yml: steps.channel.outputs.publish is never true for pull_request or merge_group refs', () => {
    // Runs the REAL script (hack/release-channel.sh), not a re-derived
    // regex, against refs representative of the two events this describe
    // block cares about: a pull_request ref and a merge_group queue ref.
    const script = resolve(REPO_ROOT, 'packages/kn-next-operator/hack/release-channel.sh');
    const representativeRefs: Array<[ref: string, refName: string]> = [
      ['refs/pull/1694/merge', '1694/merge'],
      [
        'refs/heads/gh-readonly-queue/main/pr-1694-abcdef1234567890',
        'gh-readonly-queue/main/pr-1694-abcdef1234567890',
      ],
    ];
    for (const [ref, refName] of representativeRefs) {
      const result = spawnSync('bash', [script, ref, refName], { encoding: 'utf8' });
      expect(result.status, `release-channel.sh must exit 0 for ref ${ref}`).toBe(0);
      const publishLine = result.stdout.split('\n').find((l) => l.startsWith('publish='));
      expect(
        publishLine,
        `expected a publish= line in the output for ref ${ref}: ${result.stdout}`,
      ).toBe('publish=false');
    }
  });
});
