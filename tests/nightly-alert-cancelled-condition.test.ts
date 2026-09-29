import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { frozenFileSet } from '../scripts/compat-credential-freeze-guard.mjs';

/**
 * #1645 — a nightly's `nightly-red-alert`-shaped job fired its
 * `needs.<job>.result == 'failure'` condition ONLY on failure, never on
 * CANCELLED — the conclusion GitHub Actions gives a job that hits its own
 * `timeout-minutes` or loses its runner. The mutation-prover nightly timed
 * out on 2026-09-28 and again on 2026-09-29 and its alert never fired,
 * silently, exactly because of this gap.
 *
 * This is a SCAN, not an enumerated list of the offenders found on
 * 2026-09-29: for every SCHEDULED (`on.schedule`) workflow, for every job
 * whose `if:` checks `needs.<X>.result == 'failure'`, the SAME condition
 * must also check `needs.<X>.result == 'cancelled'` for that same upstream
 * job — otherwise a cancelled/timed-out run silently never files the alert.
 * A future alert job with this same bug, under any name, trips it
 * immediately; nothing here needs updating to catch it.
 *
 * ALLOWLIST — frozen credential-harness files only, deferred to #1643, not
 * this PR's scope. `test-e2e-deploy.yml`'s `nightly-red-alert` and
 * `compat-vinext.yml`'s `vinext-red-alert` both have this exact gap on
 * their `build-next` leg (checked only for 'failure', never 'cancelled') as
 * of 2026-09-29. The allowlist is DERIVED from the same `frozenFileSet()`
 * `docs/ci/credential-freeze-guard.md` documents (never hand-duplicated),
 * so a workflow entering or leaving the frozen set moves this scan's
 * allowlist with it. The "genuinely still broken" test below keeps the
 * exemption honest: it goes RED the moment #1643 fixes either file and
 * nobody has removed it from the allowlist yet, rather than staying a
 * silent, permanent pass.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOWS_DIR = resolve(REPO_ROOT, '.github/workflows');
const WORKFLOWS_PREFIX = '.github/workflows/';

type YamlJob = { if?: unknown } & Record<string, unknown>;
type YamlDoc = { on?: { schedule?: unknown }; jobs?: Record<string, YamlJob> };

const ALLOWLIST: ReadonlySet<string> = new Set(
  [...(frozenFileSet(REPO_ROOT) as Set<string>)]
    .filter((p) => p.startsWith(WORKFLOWS_PREFIX))
    .map((p) => p.slice(WORKFLOWS_PREFIX.length)),
);

function listWorkflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
}

function loadDoc(file: string): YamlDoc {
  return (parse(readFileSync(resolve(WORKFLOWS_DIR, file), 'utf8')) as YamlDoc | null) ?? {};
}

/** True only for a REAL, non-empty `on.schedule` cron trigger — dispatch-only workflows are out of scope. */
function isScheduled(doc: YamlDoc): boolean {
  const schedule = doc.on?.schedule;
  return Array.isArray(schedule) && schedule.length > 0;
}

interface Finding {
  file: string;
  job: string;
  needsJob: string;
}

const FAILURE_RESULT_RE = /needs\.([\w-]+)\.result\s*==\s*'failure'/g;

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True if `ifStr` also checks `needs.<needsJob>.result == 'cancelled'` for that SAME upstream job. */
function checksCancelledFor(ifStr: string, needsJob: string): boolean {
  const re = new RegExp(`needs\\.${escapeForRegExp(needsJob)}\\.result\\s*==\\s*'cancelled'`);
  return re.test(ifStr);
}

/** Every `needs.<X>.result == 'failure'` check in `ifStr` with no matching `'cancelled'` check for the same `X`. */
function findingsForCondition(file: string, jobName: string, ifStr: string): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const m of ifStr.matchAll(FAILURE_RESULT_RE)) {
    const needsJob = m[1];
    if (seen.has(needsJob)) continue;
    seen.add(needsJob);
    if (!checksCancelledFor(ifStr, needsJob)) {
      findings.push({ file, job: jobName, needsJob });
    }
  }
  return findings;
}

/** Every finding in one already-parsed workflow doc — the unit the non-vacuity tests exercise directly. */
function findingsForDoc(file: string, doc: YamlDoc): Finding[] {
  if (!isScheduled(doc)) return [];
  const jobs = doc.jobs ?? {};
  const findings: Finding[] = [];
  for (const [jobName, job] of Object.entries(jobs)) {
    const ifStr = typeof job?.if === 'string' ? job.if : undefined;
    if (!ifStr) continue;
    findings.push(...findingsForCondition(file, jobName, ifStr));
  }
  return findings;
}

function findingsForFile(file: string): Finding[] {
  return findingsForDoc(file, loadDoc(file));
}

/** Every non-allowlisted scheduled workflow, scanned. */
function scanNonFrozen(): Finding[] {
  return listWorkflowFiles()
    .filter((file) => !ALLOWLIST.has(file))
    .flatMap(findingsForFile);
}

function summarize(findings: Finding[]): string {
  return findings
    .map(
      (f) =>
        `${f.file}: job "${f.job}" checks needs.${f.needsJob}.result == 'failure' but never 'cancelled'`,
    )
    .join('\n');
}

describe("#1645 — every scheduled workflow's alert job fires on a cancelled upstream job, not just a failed one", () => {
  it('non-vacuity: a synthetic job missing the cancelled check IS flagged', () => {
    const doc: YamlDoc = {
      on: { schedule: [{ cron: '0 0 * * *' }] },
      jobs: {
        'nightly-red-alert': {
          if: "always() && github.event_name == 'schedule' && needs.check.result == 'failure'",
        },
      },
    };
    expect(findingsForDoc('synthetic.yml', doc)).toEqual([
      { file: 'synthetic.yml', job: 'nightly-red-alert', needsJob: 'check' },
    ]);
  });

  it("non-vacuity: the SAME job, fixed with the '(failure || cancelled)' shape, is NOT flagged", () => {
    const doc: YamlDoc = {
      on: { schedule: [{ cron: '0 0 * * *' }] },
      jobs: {
        'nightly-red-alert': {
          if: "always() && github.event_name == 'schedule' && (needs.check.result == 'failure' || needs.check.result == 'cancelled')",
        },
      },
    };
    expect(findingsForDoc('synthetic.yml', doc)).toEqual([]);
  });

  it('a workflow with no `on.schedule` trigger is out of scope, even with the same bug', () => {
    const doc: YamlDoc = {
      on: { workflow_dispatch: {} } as YamlDoc['on'],
      jobs: { alert: { if: "needs.check.result == 'failure'" } },
    };
    expect(findingsForDoc('dispatch-only.yml', doc)).toEqual([]);
  });

  it('a job with no `if:` at all, or one that never references `.result`, is not flagged', () => {
    const doc: YamlDoc = {
      on: { schedule: [{ cron: '0 0 * * *' }] },
      jobs: {
        build: {},
        cleanup: { if: 'always()' },
      },
    };
    expect(findingsForDoc('synthetic.yml', doc)).toEqual([]);
  });

  it('two distinct upstream jobs in one condition are checked independently', () => {
    const doc: YamlDoc = {
      on: { schedule: [{ cron: '0 0 * * *' }] },
      jobs: {
        alert: {
          // `a` is fixed, `b` is not — exactly the shape test-e2e-deploy.yml
          // and compat-vinext.yml have today on build-next vs shard-ledger.
          if: "(needs.a.result == 'failure' || needs.a.result == 'cancelled' || needs.b.result == 'failure')",
        },
      },
    };
    expect(findingsForDoc('synthetic.yml', doc)).toEqual([
      { file: 'synthetic.yml', job: 'alert', needsJob: 'b' },
    ]);
  });

  it('the allowlist is derived from frozenFileSet(), and contains exactly the credential-harness workflow files', () => {
    expect([...ALLOWLIST].sort()).toEqual(
      ['compat-credential-freeze-guard.yml', 'compat-vinext.yml', 'test-e2e-deploy.yml'].sort(),
    );
  });

  it('the allowlisted frozen files genuinely still have the gap today — remove the entry (do not widen it) once #1643 fixes them', () => {
    const stillBroken: string[] = [];
    for (const file of ALLOWLIST) {
      if (!isScheduled(loadDoc(file))) continue; // e.g. compat-credential-freeze-guard.yml (PR gate, not a nightly)
      if (findingsForFile(file).length > 0) stillBroken.push(file);
    }
    expect(
      stillBroken.sort(),
      'an allowlisted file no longer has the gap — remove it from the allowlist rather than leaving a stale exemption',
    ).toEqual(['compat-vinext.yml', 'test-e2e-deploy.yml']);
  });

  it('every non-allowlisted scheduled workflow checks cancelled alongside failure in every alert-shaped condition', () => {
    const findings = scanNonFrozen();
    expect(findings, `finding(s):\n${summarize(findings)}`).toEqual([]);
  });

  it('covers the 9 known alert jobs fixed by #1645 (documented floor, not the whole proof)', () => {
    const expected: Array<{ file: string; job: string; needsJob: string }> = [
      {
        file: 'action-pin-resolution-nightly.yml',
        job: 'nightly-red-alert',
        needsJob: 'resolve-action-pins',
      },
      {
        file: 'action-pin-resolution-nightly.yml',
        job: 'crane-pin-red-alert',
        needsJob: 'verify-crane-pin',
      },
      {
        file: 'anonymous-install-nightly.yml',
        job: 'nightly-red-alert',
        needsJob: 'anonymous-install',
      },
      { file: 'compat-shipped-pin-early-warning.yml', job: 'alert', needsJob: 'dispatch-and-wait' },
      { file: 'docs-closure-nightly.yml', job: 'nightly-red-alert', needsJob: 'docs-closure-scan' },
      {
        file: 'image-pin-resolution-nightly.yml',
        job: 'nightly-red-alert',
        needsJob: 'resolve-image-pins',
      },
      {
        file: 'mutation-prover-nightly.yml',
        job: 'nightly-red-alert',
        needsJob: 'run-mutation-provers',
      },
      {
        file: 'retracted-figure-resolution-nightly.yml',
        job: 'nightly-red-alert',
        needsJob: 'resolve-retracted-figures',
      },
      {
        file: 'scaffold-install-nightly.yml',
        job: 'nightly-red-alert',
        needsJob: 'scaffold-install',
      },
    ];
    for (const { file, job, needsJob } of expected) {
      const doc = loadDoc(file);
      const jobDef = doc.jobs?.[job];
      expect(jobDef, `${file}: no longer has a job named "${job}"`).toBeTruthy();
      const ifStr = typeof jobDef?.if === 'string' ? jobDef.if : '';
      expect(
        ifStr.includes(`needs.${needsJob}.result == 'failure'`),
        `${file}/${job}: no longer checks needs.${needsJob}.result == 'failure'`,
      ).toBe(true);
      expect(
        checksCancelledFor(ifStr, needsJob),
        `${file}/${job}: does not check needs.${needsJob}.result == 'cancelled'`,
      ).toBe(true);
    }
  });
});
