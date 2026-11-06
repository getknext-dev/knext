import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * GUARD for tolerated (`continue-on-error`) workflow steps whose failure nobody reads (#2663).
 *
 * THE DEFECT CLASS: `continue-on-error` makes the step's `.conclusion` report `success`
 * even when it failed. A report-only scan that starts failing is therefore invisible
 * except in a step log nobody opens (the shape #2648 found in the nightly e2e).
 *
 * THE RULE, scanned over EVERY workflow (a scan, not an enumeration, so a new tolerated
 * step cannot slip in): each step with a `continue-on-error` that is not literally
 * `false` has an `id`, and `steps.<id>.outcome` is read by another step in the SAME job.
 * `.conclusion` is never read (it is masked). The only way out is the allowlist below,
 * which is deliberately tiny and every entry must (a) carry a reason, (b) tolerate
 * ONLY off the protected branches (so an always-tolerated step can never hide there),
 * and (c) still match a real, still-unread step (a stale entry reds).
 */

const WORKFLOWS_DIR = resolve(import.meta.dirname, '../.github/workflows');

// biome-ignore lint/suspicious/noExplicitAny: workflow YAML has no schema type here.
type Any = any;

/** The one expression under which a Trivy gate is advisory: PRs only, blocking on main + integration/*. */
const PROTECTED_BRANCH_ONLY_COE = `\${{ github.ref != 'refs/heads/main' && !startsWith(github.ref, 'refs/heads/integration/') }}`;

interface AllowEntry {
  workflow: string;
  job: string;
  step: RegExp;
  reason: string;
}

const ALLOWLIST: AllowEntry[] = [
  {
    workflow: 'ci.yml',
    job: 'docs-site',
    step: /^Trivy scan — docs dependency closure \(FAIL on HIGH\/CRITICAL\)$/,
    reason:
      'blocking gate on main and integration/*; advisory only on PRs (phased rollout), where the PR annotation is the signal',
  },
  {
    workflow: 'supply-chain.yml',
    job: 'image-supply-chain',
    step: /^Trivy scan — FAIL on HIGH\/CRITICAL$/,
    reason: 'blocking gate on main and integration/*; advisory only on PRs (phased rollout)',
  },
  {
    workflow: 'supply-chain.yml',
    job: 'built-image-trivy',
    step: /^Trivy scan BUILT image — FAIL on HIGH\/CRITICAL$/,
    reason: 'blocking gate on main and integration/*; advisory only on PRs (phased rollout)',
  },
];

interface Tolerated {
  workflow: string;
  job: string;
  name: string;
  step: Any;
  jobDef: Any;
  text: string;
}

function tolerates(v: unknown): boolean {
  return v !== undefined && v !== false && !(typeof v === 'string' && v.trim() === 'false');
}

function loadWorkflows(): Array<{ file: string; text: string; wf: Any }> {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((file) => {
      const text = readFileSync(resolve(WORKFLOWS_DIR, file), 'utf8');
      return { file, text, wf: parseYaml(text) as Any };
    });
}

function scanTolerated(workflows = loadWorkflows()): Tolerated[] {
  const out: Tolerated[] = [];
  for (const { file, text, wf } of workflows) {
    for (const [job, jobDef] of Object.entries<Any>(wf.jobs ?? {})) {
      for (const step of jobDef.steps ?? []) {
        if (tolerates(step['continue-on-error'])) {
          out.push({ workflow: file, job, name: String(step.name ?? ''), step, jobDef, text });
        }
      }
    }
  }
  return out;
}

/** Steps in the same job, other than `self`, whose if/env/run reference `steps.<id>.<field>`. */
function readers(t: Tolerated, field: 'outcome' | 'conclusion'): Any[] {
  const needle = new RegExp(`steps\\.${t.step.id}\\.${field}\\b`);
  return (t.jobDef.steps ?? []).filter(
    (s: Any) =>
      s !== t.step &&
      needle.test(JSON.stringify({ if: s.if, env: s.env, run: s.run, with: s.with })),
  );
}

function allowed(t: Tolerated): AllowEntry | undefined {
  return ALLOWLIST.find((a) => a.workflow === t.workflow && a.job === t.job && a.step.test(t.name));
}

describe('every tolerated step has its OUTCOME read in its own job (#2663)', () => {
  const tolerated = scanTolerated();

  it('finds tolerated steps (the scan is not vacuous)', () => {
    expect(tolerated.length).toBeGreaterThanOrEqual(8);
  });

  it('each is read via steps.<id>.outcome, or is a reasoned allowlist entry', () => {
    const offenders = tolerated
      .filter((t) => !allowed(t))
      .filter((t) => !t.step.id || readers(t, 'outcome').length === 0)
      .map((t) => `${t.workflow} / ${t.job} / "${t.name}" (id=${t.step.id ?? 'none'})`);
    expect(offenders).toEqual([]);
  });

  it('no tolerated step is ever read through the masked .conclusion', () => {
    const offenders = tolerated
      .filter((t) => t.step.id && readers(t, 'conclusion').length > 0)
      .map((t) => `${t.workflow} / ${t.job} / ${t.step.id}`);
    expect(offenders).toEqual([]);
  });
});

describe('the allowlist cannot decay into a hiding place', () => {
  const tolerated = scanTolerated();

  it('every entry has a reason', () => {
    for (const a of ALLOWLIST) expect(a.reason.trim().length).toBeGreaterThan(20);
  });

  it('every entry still matches exactly one real step (no stale entries)', () => {
    for (const a of ALLOWLIST) {
      const hits = tolerated.filter(
        (t) => t.workflow === a.workflow && t.job === a.job && a.step.test(t.name),
      );
      expect(hits, `${a.workflow} / ${a.job} / ${a.step}`).toHaveLength(1);
    }
  });

  it('every allowlisted step tolerates ONLY off the protected branches', () => {
    for (const t of tolerated.filter((x) => allowed(x))) {
      expect(String(t.step['continue-on-error']).trim(), `${t.workflow} / ${t.name}`).toBe(
        PROTECTED_BRANCH_ONLY_COE,
      );
    }
  });

  it('an allowlisted step that gained an outcome reader leaves the allowlist', () => {
    for (const t of tolerated.filter((x) => allowed(x))) {
      const read = t.step.id ? readers(t, 'outcome').length > 0 : false;
      expect(read, `${t.workflow} / ${t.name} is read now — drop it from ALLOWLIST`).toBe(false);
    }
  });
});

describe('the always-tolerated report-only steps SURFACE a failure, still non-blocking', () => {
  const always = scanTolerated().filter(
    (t) => t.step['continue-on-error'] === true && !allowed(t) && t.workflow === 'supply-chain.yml',
  );
  const docs = scanTolerated().filter(
    (t) => t.workflow === 'docs-deploy-oke.yml' && t.step['continue-on-error'] === true,
  );

  it('covers the three rows of the issue', () => {
    expect(always.map((t) => t.job).sort()).toEqual(['base-image-trivy', 'js-closure-fs-trivy']);
    expect(docs.map((t) => t.job)).toEqual(['deploy']);
  });

  for (const t of [...always, ...docs]) {
    describe(`${t.workflow} / ${t.job}`, () => {
      const rs = readers(t, 'outcome');

      it('the tolerance is kept (the job is not made blocking by this)', () => {
        expect(t.step['continue-on-error']).toBe(true);
        expect(tolerates(t.jobDef['continue-on-error'])).toBe(false);
      });

      it('a reader runs always(), carries the outcome in env, and writes the job summary', () => {
        const rec = rs.find((s: Any) => String(s.if ?? '').includes('always()'));
        expect(rec, 'an always() step reading the outcome').toBeTruthy();
        expect(JSON.stringify(rec.env ?? {})).toContain(`steps.${t.step.id}.outcome`);
        expect(String(rec.run)).toContain('GITHUB_STEP_SUMMARY');
      });

      it('the reader warns on a failed outcome and does NOT fail the job', () => {
        const rec = rs.find((s: Any) => String(s.if ?? '').includes('always()'));
        expect(String(rec.run)).toContain('::warning');
        expect(String(rec.run)).toMatch(/=\s*"?failure"?|== "failure"/);
        expect(String(rec.run)).not.toMatch(/\bexit\s+[1-9]/);
        expect(tolerates(rec['continue-on-error'])).toBe(false);
      });

      it('the outcome is read from env, not interpolated into the script', () => {
        const rec = rs.find((s: Any) => String(s.if ?? '').includes('always()'));
        expect(String(rec.run)).not.toContain('${{');
      });
    });
  }
});
