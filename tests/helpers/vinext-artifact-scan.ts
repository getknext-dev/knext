import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * "Does every job that builds a vinext artifact run the pre-compile closure
 * audit first?" — asked of PARSED workflows, and SCANNED rather than enumerated
 * (ADR-0042 C6 / #764).
 *
 * The rule has to hold for jobs that do not exist yet: there is no vinext
 * PUBLISH lane in CI today, so an enumerated list of image jobs is exactly how
 * the second one gets missed.
 */

export interface WorkflowJob {
  needs?: string | string[];
  steps?: Array<Record<string, unknown>>;
  defaults?: { run?: Record<string, unknown> };
}

export interface WorkflowDoc {
  /** Repo-relative path, for failure messages. */
  path: string;
  jobs: Record<string, WorkflowJob>;
}

export interface VinextArtifactJob {
  workflow: string;
  job: string;
  /** Jobs in this workflow's transitive `needs` closure that run the audit. */
  gates: string[];
}

/** The closure this gate covers: the in-repo vinext example. */
export const CLOSURE_DIR = 'examples/bun-exec';

/** The script whose presence in a job makes that job the closure gate. */
export const AUDIT_SCRIPT = 'scripts/precompile-closure-audit.mjs';

/**
 * Steps that compile the binary or build/run its image.
 *
 * The last alternative is not decoration: `examples/bun-exec/package.json`
 * defines `"build": "./build.sh"`, so `bun run build` compiles the ~120 MB
 * executable while naming neither `build.sh` nor `docker build`. A scan that
 * matched only the literal script name let that lane through silently.
 *
 * This is a MATCHER, not a proof of coverage — a lane that compiles through a
 * reusable workflow, a composite action or a shell wrapper is still invisible.
 * Adding one of those to a vinext build path means extending this pattern in
 * the same PR; see the header of tests/precompile-closure-gate-ci.test.ts.
 */
export const BUILDS_VINEXT_ARTIFACT =
  /build\.sh|test:image|docker build|\b(?:bun|npm|pnpm|yarn|npx)\s+run\s+build\b/;

/**
 * Every step's `run` + `working-directory` + `uses`, plus the job's default
 * working directory, as one blob.
 */
export function jobText(job: WorkflowJob): string {
  const steps = job.steps ?? [];
  const defaultDir = job.defaults?.run?.['working-directory'] ?? '';
  return [
    String(defaultDir),
    ...steps.map((s) => `${s.run ?? ''} ${s['working-directory'] ?? ''} ${s.uses ?? ''}`),
  ].join('\n');
}

/** Does this job compile the vinext binary or build/run its image? */
export function buildsVinextArtifact(job: WorkflowJob): boolean {
  const text = jobText(job);
  if (!text.includes(CLOSURE_DIR)) return false;
  return BUILDS_VINEXT_ARTIFACT.test(text);
}

/** Does this job run the pre-compile closure audit? */
export function runsClosureAudit(job: WorkflowJob): boolean {
  return jobText(job).includes(AUDIT_SCRIPT);
}

/** Transitive `needs` closure of a job (excluding the job itself). */
export function needsClosure(jobs: Record<string, WorkflowJob>, jobId: string): Set<string> {
  const out = new Set<string>();
  const walk = (id: string) => {
    const raw = jobs[id]?.needs;
    const parents = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    for (const p of parents) {
      if (out.has(p)) continue;
      out.add(p);
      walk(p);
    }
  };
  walk(jobId);
  return out;
}

/**
 * Every job, in every workflow given, that builds a vinext artifact — with the
 * audit-running jobs found in its transitive `needs` closure. `gates` empty
 * means the artifact would be produced with no scannable surface behind it.
 */
export function vinextArtifactJobs(docs: WorkflowDoc[]): VinextArtifactJob[] {
  const hits: VinextArtifactJob[] = [];
  for (const doc of docs) {
    for (const [id, job] of Object.entries(doc.jobs)) {
      if (!buildsVinextArtifact(job)) continue;
      const gates = [...needsClosure(doc.jobs, id)].filter((parent) =>
        runsClosureAudit(doc.jobs[parent] ?? {}),
      );
      hits.push({ workflow: doc.path, job: id, gates });
    }
  }
  return hits;
}

/** Parse one workflow file into a `WorkflowDoc`. */
export function readWorkflow(repoRoot: string, relPath: string): WorkflowDoc {
  const raw = readFileSync(resolve(repoRoot, relPath), 'utf8');
  const doc = parse(raw) as { jobs?: Record<string, WorkflowJob> };
  return { path: relPath, jobs: doc?.jobs ?? {} };
}

/** Parse a workflow from a YAML string — for synthetic, not-yet-real lanes. */
export function parseWorkflow(path: string, yaml: string): WorkflowDoc {
  const doc = parse(yaml) as { jobs?: Record<string, WorkflowJob> };
  return { path, jobs: doc?.jobs ?? {} };
}

/**
 * EVERY workflow in `.github/workflows` — never just ci.yml. A vinext publish
 * lane is at least as likely to land in `release.yml` or a new
 * `publish-vinext.yml`, and a scan that reads one file cannot see it.
 */
export function loadWorkflows(repoRoot: string): WorkflowDoc[] {
  const dir = '.github/workflows';
  return readdirSync(resolve(repoRoot, dir))
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((f) => readWorkflow(repoRoot, `${dir}/${f}`));
}
