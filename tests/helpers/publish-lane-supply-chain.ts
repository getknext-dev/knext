import { readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parse } from 'yaml';
import { splitSourceIntoStatements } from './shell-statements';

/**
 * Engine for `tests/publish-lane-supply-chain.test.ts` (#2044, v2 task R8).
 *
 * Question asked of a directory of workflows: does EVERY job that publishes to
 * npm transitively `needs` (a) the npm-audit gate and (b) the SBOM job?
 *
 * ## Scanned, not enumerated
 *
 * Nothing here names a workflow file or a job id. Three things are derived from
 * the PARSED documents (never raw text, so a comment cannot trip or hide
 * anything):
 *
 *   - PUBLISH LANES — a job with a `run` statement that invokes `npm|pnpm|bun|
 *     yarn publish`, `changeset publish`, or `<pm> run <script>` where the root
 *     `package.json` script is itself one of those; or a `changesets/action`
 *     step carrying a `publish`/`publish-script` input (that is how this repo's
 *     `release` job publishes: the command arrives through a step output, so a
 *     text scan for `changeset publish` finds nothing in it at all).
 *   - THE AUDIT GATE — a job running `scripts/audit-published.mjs` (`npm audit
 *     --omit=dev` over the packed production closure) that CANNOT be neutralised:
 *     no job/step `continue-on-error`, no step `if`, no `|| …` on the invocation.
 *   - THE SBOM JOB — a job running that same script and uploading a
 *     `*.cdx.json` artifact. The script is the single source of truth for both
 *     the audit and the CycloneDX SBOM, so today one job is both; the guard
 *     requires the lane to reach at least one of each, not two distinct jobs.
 *
 * ## Fail closed
 *
 * A workflow that cannot be read, cannot be parsed, or parses to something with
 * no `jobs` mapping is a PROBLEM, never "no lanes found". So is a `needs` entry
 * naming a job that does not exist, and a missing workflow directory.
 *
 * ## What the `needs` graph honours
 *
 * An edge `J needs K` is only a gate when J cannot start after K FAILED. A job
 * whose `if` carries `always()`, `failure()` or `cancelled()` does exactly that,
 * so its outgoing edges are dropped from the closure: the lane's own `if`, or an
 * intermediate job's.
 *
 * ## Known blind spots (stated, not dressed up)
 *
 *   - A publish performed inside a script (`node scripts/x.mjs` that shells to
 *     `npm publish`) or a composite/reusable workflow (`jobs.<id>.uses`) is not
 *     seen: the scan is over `run` statements and `changesets/action` inputs.
 *     `release.yml`'s self-heal step is such a script, but it lives inside the
 *     already-gated `release` job.
 *   - `<pm> run <script>` aliases are resolved against the ROOT `package.json`
 *     only.
 *   - Composite actions (`.github/actions/*`) are not scanned for lanes.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const AUDIT_SCRIPT = /(^|\/)audit-published\.mjs$/;
const SBOM_PATH = /\.cdx\.json\b/;
const STATUS_BYPASS = /\b(always|failure|cancelled)\s*\(\s*\)/;

type Job = Record<string, unknown>;
type Step = Record<string, unknown>;

export interface PublishLane {
  file: string;
  jobId: string;
  /** What made this job a publish lane, for the failure message. */
  why: string;
}

export interface PublishLaneAudit {
  problems: string[];
  workflowsSeen: number;
  lanes: PublishLane[];
  /** `file#jobId` of every non-neutralisable job that runs the audit script. */
  auditJobs: string[];
  /** `file#jobId` of every job that runs the audit script and uploads a CycloneDX SBOM. */
  sbomJobs: string[];
}

export interface AuditOptions {
  workflowDir: string;
  /** Root package.json whose `scripts` resolve `<pm> run <script>`. Default: the repo root's. */
  packageJsonPath?: string;
}

// ── shell-statement classification ─────────────────────────────────────────

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that run the NEXT command, with optional flags in between. */
const WRAPPERS = new Set([
  'sudo',
  'env',
  'time',
  'exec',
  'command',
  'nohup',
  'npx',
  'bunx',
  'pnpx',
  'corepack',
]);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const RUNNERS = new Set(['node', 'nodejs', 'bun', 'deno', 'tsx', 'ts-node', 'npx', 'bunx']);

function tokenize(statement: string): string[] {
  const raw = statement.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return raw.map((t) => t.replace(/^(["'])(.*)\1$/s, '$2'));
}

/** Drops leading `VAR=val` assignments and wrapper words (+ their flags). */
function commandTokens(tokens: string[]): string[] {
  let i = 0;
  for (;;) {
    while (i < tokens.length && ASSIGNMENT.test(tokens[i])) i++;
    if (i < tokens.length && WRAPPERS.has(tokens[i])) {
      i++;
      while (i < tokens.length && tokens[i].startsWith('-')) i++;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/** Why `source` publishes to npm, or null. `scripts` resolves `<pm> run <name>`. */
function publishReason(source: string, scripts: Record<string, string>, depth = 0): string | null {
  if (depth > 5) return null;
  for (const { text } of splitSourceIntoStatements(source)) {
    const cmd = commandTokens(tokenize(text));
    const head = cmd[0];
    if (head === undefined) continue;
    const rest = cmd.slice(1);

    if (SHELLS.has(head)) {
      const c = rest.indexOf('-c');
      if (c !== -1 && rest[c + 1] !== undefined) {
        const inner = publishReason(rest[c + 1], scripts, depth + 1);
        if (inner) return inner;
      }
      continue;
    }
    if (head === 'changeset' || head === 'changesets') {
      if (rest.find((t) => !t.startsWith('-')) === 'publish') return `${head} publish`;
      continue;
    }
    if (!PACKAGE_MANAGERS.has(head)) continue;

    const window = rest.slice(0, 4);
    if (window.includes('publish')) return `${head} publish`;
    // `pnpm exec changeset publish`, `bun x changeset publish`, `yarn dlx …`
    const exec = rest.findIndex((t) => t === 'exec' || t === 'x' || t === 'dlx');
    if (exec !== -1 && exec < 3) {
      const inner = publishReason(rest.slice(exec + 1).join(' '), scripts, depth + 1);
      if (inner) return inner;
    }
    // `<pm> run <script>` / `pnpm <script>` / `yarn <script>` → the package.json script body
    const run = rest.findIndex((t) => t === 'run' || t === 'run-script');
    const candidates =
      run !== -1
        ? rest.slice(run + 1).filter((t) => !t.startsWith('-'))
        : head === 'pnpm' || head === 'yarn'
          ? rest.filter((t) => !t.startsWith('-')).slice(0, 1)
          : [];
    for (const name of candidates) {
      const body = scripts[name];
      if (typeof body !== 'string') continue;
      const inner = publishReason(body, scripts, depth + 1);
      if (inner) return `\`${head} run ${name}\` (→ ${inner})`;
    }
  }
  return null;
}

/** Does `source` run `scripts/audit-published.mjs` (as a program argument, not prose)? */
function runsAuditScript(source: string): boolean {
  for (const { text } of splitSourceIntoStatements(source)) {
    const cmd = commandTokens(tokenize(text));
    if (cmd[0] === undefined || !RUNNERS.has(cmd[0])) continue;
    if (cmd.slice(1).some((t) => AUDIT_SCRIPT.test(t))) return true;
  }
  return false;
}

// ── workflow reading ───────────────────────────────────────────────────────

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function needsOf(job: Job): string[] {
  const n = job.needs;
  if (typeof n === 'string') return [n];
  if (Array.isArray(n)) return n.map(String);
  return [];
}

function stepsOf(job: Job): Step[] {
  return Array.isArray(job.steps) ? (job.steps.map(asRecord).filter(Boolean) as Step[]) : [];
}

const runOf = (step: Step): string => (typeof step.run === 'string' ? step.run : '');

/** `continue-on-error` is neutralising unless it is the literal `false`. */
function softensFailure(node: Record<string, unknown>): boolean {
  return 'continue-on-error' in node && node['continue-on-error'] !== false;
}

/** Why this step, which runs the audit script, can NOT be relied on to fail the run (null = it can). */
function stepNeutralisation(step: Step): string | null {
  if (softensFailure(step)) return 'step has continue-on-error';
  if ('if' in step) {
    const cond = String(step.if).replace(/[\s${}]/g, '');
    if (cond !== 'true' && cond !== 'success()') return `step has a conditional \`if: ${step.if}\``;
  }
  if (/audit-published\.mjs[^\n]*\|\|/.test(runOf(step))) return 'invocation is followed by `||`';
  return null;
}

interface JobFacts {
  /** `why` if this job publishes, else null. */
  publishes: string | null;
  runsAudit: boolean;
  /** Reason the audit can't gate, when it runs but is neutralised. */
  neutralised: string | null;
  uploadsSbom: boolean;
}

function analyseJob(job: Job, scripts: Record<string, string>): JobFacts {
  let publishes: string | null = null;
  let runsAudit = false;
  let neutralised: string | null = null;
  let uploadsSbom = false;
  const jobSoftened = softensFailure(job);

  for (const step of stepsOf(job)) {
    const run = runOf(step);
    if (run) {
      publishes ??= publishReason(run, scripts);
      if (runsAuditScript(run)) {
        runsAudit = true;
        neutralised ??= jobSoftened ? 'job has continue-on-error' : stepNeutralisation(step);
      }
    }
    const uses = typeof step.uses === 'string' ? step.uses : '';
    const withs = asRecord(step.with) ?? {};
    if (/^changesets\/action(@|$)/.test(uses)) {
      for (const key of ['publish-script', 'publish']) {
        const v = withs[key];
        if (v !== undefined && v !== null && v !== '' && v !== false) {
          publishes ??= `changesets/action \`${key}\` input`;
        }
      }
    }
    if (/^actions\/upload-artifact(@|$)/.test(uses) && SBOM_PATH.test(String(withs.path ?? ''))) {
      uploadsSbom = true;
    }
  }
  return { publishes, runsAudit, neutralised, uploadsSbom };
}

/** Transitive `needs` closure; edges out of a status-bypassing job are dropped. */
function closure(
  jobs: Record<string, Job>,
  start: string,
  problems: string[],
  where: string,
): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const job = jobs[id];
    if (!job) continue;
    if (STATUS_BYPASS.test(String(job.if ?? ''))) continue; // starts after a FAILED need
    for (const dep of needsOf(job)) {
      if (!(dep in jobs)) {
        problems.push(
          `${where}: job \`${id}\` needs \`${dep}\`, which is not a job in this workflow`,
        );
        continue;
      }
      if (!seen.has(dep)) {
        seen.add(dep);
        stack.push(dep);
      }
    }
  }
  return seen;
}

function readScripts(packageJsonPath: string, problems: string[]): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: unknown };
    const scripts = asRecord(pkg.scripts) ?? {};
    return Object.fromEntries(
      Object.entries(scripts).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  } catch (err) {
    problems.push(`cannot read ${packageJsonPath} to resolve \`<pm> run\` aliases: ${String(err)}`);
    return {};
  }
}

export function auditPublishLanes(options: AuditOptions): PublishLaneAudit {
  const problems: string[] = [];
  const lanes: PublishLane[] = [];
  const auditJobs: string[] = [];
  const sbomJobs: string[] = [];
  const scripts = readScripts(
    options.packageJsonPath ?? resolve(REPO_ROOT, 'package.json'),
    problems,
  );

  let names: string[] = [];
  try {
    names = readdirSync(options.workflowDir)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .sort();
  } catch (err) {
    problems.push(`cannot list workflow directory ${options.workflowDir}: ${String(err)}`);
  }

  // Pass 1: read everything. A file we cannot see could hold an ungated lane.
  const parsed: Array<{ file: string; jobs: Record<string, Job> }> = [];
  for (const file of names) {
    let doc: unknown;
    try {
      doc = parse(readFileSync(resolve(options.workflowDir, file), 'utf8'));
    } catch (err) {
      problems.push(`${file}: cannot be read/parsed (${String(err).split('\n')[0]})`);
      continue;
    }
    const jobs = asRecord(asRecord(doc)?.jobs);
    if (jobs === null || Object.keys(jobs).length === 0) {
      problems.push(
        `${file}: parsed but has no \`jobs\` mapping — refusing to read it as "no lanes"`,
      );
      continue;
    }
    const clean: Record<string, Job> = {};
    for (const [id, job] of Object.entries(jobs)) clean[id] = asRecord(job) ?? {};
    parsed.push({ file: basename(file), jobs: clean });
  }

  // Pass 2: per workflow, find gates and lanes, then walk each lane's `needs`.
  for (const { file, jobs } of parsed) {
    const facts = new Map<string, JobFacts>();
    for (const [id, job] of Object.entries(jobs)) facts.set(id, analyseJob(job, scripts));

    const audits = new Set<string>();
    const sboms = new Set<string>();
    const neutralisedAudits: string[] = [];
    for (const [id, f] of facts) {
      if (!f.runsAudit) continue;
      if (f.neutralised) {
        neutralisedAudits.push(`\`${id}\` (${f.neutralised})`);
        continue;
      }
      audits.add(id);
      auditJobs.push(`${file}#${id}`);
      if (f.uploadsSbom) {
        sboms.add(id);
        sbomJobs.push(`${file}#${id}`);
      }
    }

    for (const [id, f] of facts) {
      if (f.publishes === null) continue;
      lanes.push({ file, jobId: id, why: f.publishes });
      const reach = closure(jobs, id, problems, `${file}#${id}`);
      const label = `${file}#${id} publishes to npm (${f.publishes})`;
      const hint = neutralisedAudits.length
        ? ` Neutralised audit job(s) here do not count: ${neutralisedAudits.join(', ')}.`
        : '';
      if (![...reach].some((j) => audits.has(j))) {
        problems.push(
          `${label} but does not transitively \`needs\` an npm-audit gate (a job running scripts/audit-published.mjs that cannot be skipped or softened).${hint}`,
        );
      }
      if (![...reach].some((j) => sboms.has(j))) {
        problems.push(
          `${label} but does not transitively \`needs\` an SBOM job (a job running scripts/audit-published.mjs and uploading a *.cdx.json artifact).${hint}`,
        );
      }
    }
  }

  return { problems, workflowsSeen: names.length, lanes, auditJobs, sbomJobs };
}
