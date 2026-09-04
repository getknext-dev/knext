import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * "Does every job that builds a vinext artifact run the pre-compile closure
 * audit first?" — asked of PARSED workflows, and SCANNED rather than enumerated
 * (ADR-0042 C6 / #764).
 *
 * The rule has to hold for jobs that do not exist yet, so an enumerated list of
 * image jobs is exactly how the second one gets missed. (An earlier revision of
 * this comment said "there is no vinext PUBLISH lane in CI today". There is —
 * `supply-chain.yml`'s `image-supply-chain` pushes one to GHCR on main. The
 * publish lane has its own, stricter scan at the bottom of this file.)
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

/**
 * ── C1 / #785: the PUBLISH half ──────────────────────────────────────────────
 *
 * Everything above answers "did a closure audit run before this vinext artifact
 * was built?", keyed on the ONE in-repo example. That question has a stricter
 * sibling for the lane that pushes, signs and ATTESTS an image: "did a closure
 * audit of THE APP THIS LANE PUBLISHES run before the build?" — because the
 * failure there is not merely an unscanned binary, it is a signed attestation
 * whose predicate cannot see the binary's contents.
 *
 * Both halves are scanned rather than enumerated, and the app set below is
 * discovered from manifests so a second vinext app is covered on the day it
 * lands rather than when someone remembers a list.
 */

/** Directories to look for vinext apps in. Their CONTENTS are discovered. */
const APP_PARENTS = ['apps', 'examples'];

/**
 * Every in-repo app that builds on vinext, by reading package.json — an app is
 * a vinext app when it declares `vinext` as a dependency of any kind.
 */
export function vinextAppDirs(repoRoot: string): string[] {
  const dirs: string[] = [];
  for (const parent of APP_PARENTS) {
    let children: string[];
    try {
      children = readdirSync(resolve(repoRoot, parent));
    } catch {
      continue;
    }
    for (const child of children) {
      const rel = `${parent}/${child}`;
      let manifest: Record<string, Record<string, string> | undefined>;
      try {
        manifest = JSON.parse(readFileSync(resolve(repoRoot, rel, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      const declares = ['dependencies', 'devDependencies', 'optionalDependencies'].some(
        (field) => manifest[field]?.vinext !== undefined,
      );
      if (declares) dirs.push(rel);
    }
  }
  return dirs.sort();
}

/**
 * A step that PUBLISHES an image. `push: true` is matched on the
 * build-push-action input as well as the bare `crane`/`docker` commands — the
 * three ways an image leaves this repo today.
 */
const PUBLISHES_IMAGE = /crane push|docker push|push:\s*true/;

/** App dirs the given text runs the closure audit AGAINST. */
export function auditedAppDirs(text: string): string[] {
  const dirs: string[] = [];
  const pattern = new RegExp(
    `${AUDIT_SCRIPT.replace(/[.]/g, '\\.')}[^\\n]*?--(?:app|closure)\\s+(\\S+)`,
    'g',
  );
  for (const match of text.matchAll(pattern)) {
    const dir = match[1];
    if (dir !== undefined) dirs.push(dir.replace(/\/+$/, ''));
  }
  return dirs;
}

export interface PublishingVinextJob {
  workflow: string;
  job: string;
  /** vinext app dirs this job builds an image from. */
  appDirs: string[];
  /** app dirs audited in this job's own steps or in its `needs` closure. */
  auditedAppDirs: string[];
  /** did every in-job audit step precede every in-job image build step? */
  auditBeforeBuild: boolean;
}

/** One step's `run` + `with` + `uses` + `working-directory`, as text. */
function stepText(step: Record<string, unknown>): string {
  const withBlock = step.with as Record<string, unknown> | undefined;
  const withText = withBlock
    ? Object.entries(withBlock)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join('\n')
    : '';
  return `${step.run ?? ''}\n${step['working-directory'] ?? ''}\n${step.uses ?? ''}\n${withText}`;
}

/**
 * Every job, in every workflow given, that pushes an image built from a vinext
 * app — with the app dirs it builds and the app dirs it audits.
 *
 * A job is credited ONLY for an audit of the same app it publishes: a lane that
 * audits `examples/bun-exec` while shipping `apps/file-manager` is exactly the
 * defect C1 closes, and it must not read as covered.
 */
export function publishingVinextJobs(
  docs: WorkflowDoc[],
  appDirs: string[],
): PublishingVinextJob[] {
  const hits: PublishingVinextJob[] = [];
  for (const doc of docs) {
    for (const [id, job] of Object.entries(doc.jobs)) {
      // Deliberately NOT `jobText`: that helper omits `with:` inputs, and the
      // publish lane names its app only there (`file: apps/file-manager/Dockerfile`,
      // `push: true`). Widening `jobText` itself would also widen the C6 scan
      // above onto ci.yml's local-only image probe, which is a different risk.
      const text = (job.steps ?? []).map(stepText).join('\n');
      if (!PUBLISHES_IMAGE.test(text)) continue;
      const built = appDirs.filter((dir) => text.includes(dir));
      if (built.length === 0) continue;

      const steps = job.steps ?? [];
      const audited = new Set(auditedAppDirs(text));
      for (const parent of needsClosure(doc.jobs, id)) {
        const parentText = (doc.jobs[parent]?.steps ?? []).map(stepText).join('\n');
        for (const dir of auditedAppDirs(parentText)) audited.add(dir);
      }

      // In-job ordering: the LAST audit step must precede the FIRST build step.
      // (An audit in a `needs` job is trivially earlier, hence the -1 default.)
      const indexes = steps.map((step, index) => ({ index, text: stepText(step) }));
      const lastAudit = indexes.filter((s) => auditedAppDirs(s.text).length > 0).pop()?.index ?? -1;
      const firstBuild =
        indexes.find(
          (s) => BUILDS_VINEXT_ARTIFACT.test(s.text) || /docker\/build-push-action/.test(s.text),
        )?.index ?? Number.POSITIVE_INFINITY;

      hits.push({
        workflow: doc.path,
        job: id,
        appDirs: built,
        auditedAppDirs: [...audited].sort(),
        auditBeforeBuild: lastAudit < firstBuild,
      });
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
