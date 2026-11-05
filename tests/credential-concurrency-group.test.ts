import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { CREDENTIAL_LINES } from '../scripts/compat-credential-line.mjs';
import {
  deriveLineWorkflow,
  GROUPED_CONCURRENCY,
  sourceConcurrencyOf,
  underiveLineWorkflow,
} from '../scripts/compat-line-workflow.mjs';
import { CREDENTIAL_CELLS } from '../scripts/compat-window-audit.mjs';
import { CREDENTIAL_CONCURRENCY_GROUP } from '../scripts/lib/credential-slot-watchdog.mjs';
import { evaluate, exprBody } from './helpers/gha-expr';

/**
 * One credential run in flight at a time (v2 R5): every credential-bearing
 * workflow's SCHEDULED runs share one concurrency group, so two credential runs
 * never spoil each other's "cold" and never hold the pool together.
 *
 * The workflow set is SCANNED, not enumerated, so a new credential workflow that
 * forgets the group reds here. Each property is evaluated per trigger against the
 * REAL expression (`tests/helpers/gha-expr`), never grepped.
 *
 * WHY `queue: max` IS LOAD-BEARING, NOT A TUNING KNOB. GitHub's default keeps one
 * pending run per group and cancels the older one. Replaying the last 14 days of
 * real credential arrivals through one group drops 9-19% of runs at a 0.8-1.0 h run
 * length, and a dropped run has no markers, so the audit reads it as an unknown-lane
 * lost run and resets EVERY cell of that line. See docs/ci/capacity-budget.md §4.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github/workflows');

// biome-ignore lint/suspicious/noExplicitAny: parsed workflow YAML
type Doc = any;

const readDoc = (file: string): Doc => parse(readFileSync(resolve(WORKFLOW_DIR, file), 'utf8'));

const allWorkflowFiles = () =>
  readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

/** A workflow that selects a compat mode at the top level grades a credential run. */
const setsCompatMode = (doc: Doc) =>
  typeof doc?.env === 'object' && doc.env !== null && 'KNEXT_COMPAT_MODE' in doc.env;

/**
 * Every credential-bearing workflow: the audit's cells, each release line's derived
 * lane, and anything else that selects a compat mode. A new credential workflow is
 * caught by at least one of the three without an edit here.
 */
function credentialBearingWorkflows(): string[] {
  const out = new Set<string>();
  for (const cell of CREDENTIAL_CELLS) if (cell.workflowFile) out.add(cell.workflowFile);
  for (const spec of Object.values(CREDENTIAL_LINES) as { workflowFile: string }[]) {
    out.add(spec.workflowFile);
  }
  for (const file of allWorkflowFiles()) if (setsCompatMode(readDoc(file))) out.add(file);
  return [...out].sort();
}

const ctx = (event_name: string, inputs: Record<string, string> = {}) => ({
  github: {
    event_name,
    workflow: 'sentinel-workflow',
    ref: 'refs/heads/sentinel-ref',
    run_id: '424242',
    event: { inputs, schedule: '17 1,9,17 * * *' },
  },
});

/** A `${{ … }}` value evaluated in `context`; a plain scalar is itself. */
function value(raw: unknown, context: Record<string, unknown>) {
  return typeof raw === 'string' && raw.includes('${{')
    ? evaluate(exprBody(raw), context)
    : (raw ?? null);
}

/**
 * Everything wrong with `doc` as a member of the credential group. Returned, not
 * asserted, so the same check is proved against the real tree and against
 * synthetic workflows that must go red.
 */
function violations(doc: Doc): string[] {
  const out: string[] = [];
  const c = doc?.concurrency;
  if (!c || typeof c !== 'object') return ['no workflow-level concurrency mapping'];

  const schedule = ctx('schedule');
  if (value(c.group, schedule) !== CREDENTIAL_CONCURRENCY_GROUP) {
    out.push(`a scheduled run is not in the credential group: ${value(c.group, schedule)}`);
  }
  if (value(c.queue, schedule) !== 'max') {
    out.push(`a scheduled run does not queue (a third arrival replaces a pending run)`);
  }
  if (value(c['cancel-in-progress'], schedule) === true) {
    out.push('a scheduled run cancels the credential run in progress');
  }

  for (const dispatch of [
    ctx('workflow_dispatch'),
    ctx('workflow_dispatch', { dispatchId: 'x' }),
  ]) {
    const group = String(value(c.group, dispatch));
    if (group === CREDENTIAL_CONCURRENCY_GROUP) {
      out.push(
        'a dispatch joined the credential group, so it can queue behind or hold credentials',
      );
    }
    if (!group.includes('refs/heads/sentinel-ref')) {
      out.push(`a dispatch group is not ref-scoped: ${group}`);
    }
    if (group.includes('424242')) out.push(`a dispatch group carries a run id: ${group}`);
    if (value(c['cancel-in-progress'], dispatch) !== true) {
      out.push('a superseded dispatch no longer cancels');
    }
    // GitHub rejects `queue: max` with `cancel-in-progress: true` at validation.
    if (value(c.queue, dispatch) === 'max') out.push('a dispatch combines queue max with cancel');
  }

  // A job-level group, or a child workflow, held while its parent waits on the same
  // group is how a fan-out deadlocks against itself.
  for (const [name, job] of Object.entries<Doc>(doc?.jobs ?? {})) {
    if (job?.concurrency) out.push(`job ${name} carries a job-level concurrency group`);
    if (typeof job?.uses === 'string' && job.uses.startsWith('./')) {
      out.push(`job ${name} calls a reusable workflow (${job.uses}) that could share the group`);
    }
    for (const step of job?.steps ?? []) {
      if (typeof step?.run === 'string' && /^\s*gh workflow run\b/m.test(step.run)) {
        out.push(`job ${name} dispatches a child workflow from inside the group`);
      }
    }
  }
  return out;
}

describe('every credential-bearing workflow is in one concurrency group', () => {
  const files = credentialBearingWorkflows();

  it('the scan finds the known lanes, so the guard below cannot pass vacuously', () => {
    for (const known of [
      'test-e2e-deploy.yml',
      'compat-credential-v1.3.yml',
      'compat-vinext.yml',
    ]) {
      expect(files).toContain(known);
    }
  });

  for (const file of files) {
    it(`${file}: scheduled runs queue in the group, dispatches stay out and cancel`, () => {
      expect(violations(readDoc(file))).toEqual([]);
    });
  }

  it('no workflow outside the credential set holds the group', () => {
    const outsiders = allWorkflowFiles().filter(
      (f) =>
        !files.includes(f) &&
        readFileSync(resolve(WORKFLOW_DIR, f), 'utf8').includes(CREDENTIAL_CONCURRENCY_GROUP),
    );
    expect(outsiders).toEqual([]);
  });

  it('only a schedule joins: a push or a merge-queue event never lands in the group', () => {
    for (const file of files) {
      const { group } = readDoc(file).concurrency;
      for (const event of ['push', 'pull_request', 'merge_group', 'workflow_run']) {
        expect(value(group, ctx(event))).not.toBe(CREDENTIAL_CONCURRENCY_GROUP);
      }
    }
  });
});

describe('the v1.3 derivation moves a pre-group tag into the group', () => {
  const V10 = readFileSync(resolve(WORKFLOW_DIR, 'test-e2e-deploy.yml'), 'utf8');
  const committed = readFileSync(resolve(WORKFLOW_DIR, 'compat-credential-v1.3.yml'), 'utf8');
  const { sourceText: tagSource, tag } = underiveLineWorkflow(committed, { line: 'v1.3' });
  const derive = (source: string) => deriveLineWorkflow(source, { line: 'v1.3', tag });

  it('the derivation writes the same block test-e2e-deploy.yml carries, byte for byte', () => {
    expect(V10).toContain(GROUPED_CONCURRENCY);
    expect(committed).toContain(GROUPED_CONCURRENCY);
  });

  it('the pinned tag predates the group, so the substitution is what puts v1.3 in it', () => {
    expect(sourceConcurrencyOf(tagSource)).toBe('legacy');
    expect(tagSource).not.toContain(CREDENTIAL_CONCURRENCY_GROUP);
    expect(derive(tagSource)).toBe(committed);
  });

  it('a tag cut after the group passes through unchanged, and still round-trips', () => {
    const withBlock = (text: string) => {
      const blocks = text.match(/^concurrency:\n(?: +[^\n]*\n)+/gm) ?? [];
      expect(blocks).toHaveLength(1);
      return text.replace(blocks[0], () => GROUPED_CONCURRENCY);
    };
    const future = withBlock(tagSource);
    expect(sourceConcurrencyOf(future)).toBe('grouped');
    const derived = derive(future);
    expect(derived).toContain(GROUPED_CONCURRENCY);
    expect(derived).not.toContain('joins the one group every credential workflow shares');
    expect(underiveLineWorkflow(derived, { line: 'v1.3' }).sourceText).toBe(future);
  });

  it('a source with neither block, or with both, refuses to derive', () => {
    const neither = tagSource.replace(/^concurrency:\n(?: +[^\n]*\n)+/m, () => '');
    expect(() => derive(neither)).toThrow(/concurrency block/);
    expect(() => derive(`${tagSource}\n${GROUPED_CONCURRENCY}`)).toThrow(/concurrency block/);
  });
});

describe('the scan goes red on the mistakes it exists to catch', () => {
  const good = readDoc('test-e2e-deploy.yml').concurrency;
  const lane = (concurrency: unknown, jobs: unknown = {}) => ({
    env: { KNEXT_COMPAT_MODE: 'credential' },
    concurrency,
    jobs,
  });

  it('accepts the real block (the other half of every case below)', () => {
    expect(violations(lane(good))).toEqual([]);
  });

  it('a credential workflow with no concurrency block', () => {
    expect(violations(lane(undefined))).not.toEqual([]);
  });

  it('the old per-run group', () => {
    const group =
      "${{ github.event_name == 'workflow_dispatch' && format('{0}-dispatch-{1}', github.workflow, github.ref) || format('{0}-run-{1}', github.workflow, github.run_id) }}";
    expect(violations(lane({ ...good, group })).join()).toContain('not in the credential group');
  });

  it('the group without a queue, where a third arrival silently replaces a pending run', () => {
    const { queue: _queue, ...noQueue } = good;
    expect(violations(lane(noQueue)).join()).toContain('does not queue');
  });

  it('queue max on a dispatch, which GitHub rejects next to cancel-in-progress', () => {
    expect(violations(lane({ ...good, queue: 'max' })).join()).toContain('queue max with cancel');
  });

  it('a dispatch that joins the group', () => {
    expect(violations(lane({ ...good, group: CREDENTIAL_CONCURRENCY_GROUP })).join()).toContain(
      'a dispatch joined',
    );
  });

  it('cancel-in-progress on a scheduled run', () => {
    expect(violations(lane({ ...good, 'cancel-in-progress': true })).join()).toContain(
      'cancels the credential run in progress',
    );
  });

  it('a job-level group, a reusable child, or a dispatched child', () => {
    const jobs = {
      a: { concurrency: CREDENTIAL_CONCURRENCY_GROUP },
      b: { uses: './.github/workflows/child.yml' },
      c: { steps: [{ run: 'set -e\ngh workflow run test-e2e-deploy.yml' }] },
    };
    const found = violations(lane(good, jobs)).join();
    expect(found).toContain('job a carries');
    expect(found).toContain('job b calls');
    expect(found).toContain('job c dispatches');
  });
});
