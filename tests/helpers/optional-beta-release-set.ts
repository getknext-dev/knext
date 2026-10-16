/**
 * PACKAGE-SCOPE half of the R8 publish-lane supply-chain guard (#2389).
 *
 * `publish-lane-supply-chain.ts` proves every publish JOB needs the audit job.
 * That covers a package only if `scripts/audit-published.mjs` audits it, and
 * only if the package is published the way its release set says. This engine
 * checks the packages:
 *
 *   1. every publishable workspace package belongs to a release set — the
 *      changesets `fixed` group containing `@getknext/core`, or the optional
 *      Beta set — and is in the audit's scope (or a reasoned exemption that
 *      cannot go stale);
 *   2. every optional Beta package follows the release-set rule (ADR-0020
 *      amendment, 2026-10-16): outside every changesets `fixed`/`linked`
 *      group, never listed by a fixed-group manifest, and an OPTIONAL peer on
 *      `@getknext/core` over a bounded major (`>=A <B`), never a dependency;
 *   3. an optional Beta package that is publishable (not `private`) is wired:
 *      in the changesets `ignore` list (the shared `changeset publish` always
 *      passes `--tag latest|<pre tag>`, which overrides `publishConfig.tag`),
 *      built by every audit job, published by a job running
 *      `npm publish … --tag beta` that transitively needs the audit job, and,
 *      when it records a knext-ffi crate revision, that also needs an
 *      unconditional `cargo deny check` over `crates/`;
 *   4. the crates lane that gates every merged crate revision runs
 *      `cargo deny check` and the crate-rev drift guard unconditionally, on
 *      pull requests and on pushes to the release branches, path-filtered to
 *      include `crates/**` and the manifest that records the revision.
 *
 * Fails closed on anything it cannot read.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

export interface AuditExemption {
  name: string;
  reason: string;
}

export interface ReleaseSetOptions {
  repoRoot: string;
  workflowDir: string;
  /** Names of the optional Beta packages (`OPTIONAL_BETA` in audit-published.mjs). */
  optionalBeta: readonly string[];
  /** Names `auditScope()` returns for this tree. */
  auditScope: readonly string[];
  auditExempt: readonly AuditExemption[];
  /** The workflow file that gates the knext-ffi crates. */
  crateWorkflow: string;
  /** name → manifest fields applied over the files (a simulated flip). */
  overrides?: Record<string, Record<string, unknown>>;
}

export interface ReleaseSetAudit {
  problems: string[];
  publishable: string[];
  fixedGroup: string[];
  optionalSeen: string[];
  crateLaneChecked: boolean;
}

/** The branches whose pushes must run the crates lane. */
export const CRATE_LANE_BRANCHES = ['main', 'integration/v2'] as const;

const CORE = '@getknext/core';
const BOUNDED_MAJOR = /^>=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? <\d+\.\d+\.\d+$/;
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

type Obj = Record<string, unknown>;

interface Pkg {
  name: string;
  /** Repo-relative directory, POSIX. */
  dir: string;
  manifest: Obj;
}

interface Step {
  run: string;
  if: unknown;
  continueOnError: unknown;
  workingDirectory: unknown;
}

interface Job {
  id: string;
  file: string;
  needs: string[];
  if: unknown;
  continueOnError: unknown;
  defaultWorkingDirectory: unknown;
  steps: Step[];
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/**
 * A job or step gates only if it always runs and its failure fails the run: no
 * `if:` at all (even `if: true` is a condition someone can flip), and no
 * `continue-on-error:` other than a literal `false`.
 */
const ungated = (unit: { if: unknown; continueOnError: unknown }) =>
  unit.if !== undefined || (unit.continueOnError !== undefined && unit.continueOnError !== false);

function readWorkspace(repoRoot: string, problems: string[]): Pkg[] {
  let globs: unknown;
  try {
    globs = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Obj).workspaces;
  } catch (err) {
    problems.push(`package.json: cannot read the workspace declaration (${String(err)})`);
    return [];
  }
  if (!Array.isArray(globs) || globs.length === 0) {
    problems.push('package.json: declares no `workspaces` array');
    return [];
  }
  const pkgs: Pkg[] = [];
  for (const glob of globs) {
    const m = typeof glob === 'string' ? /^([A-Za-z0-9._-]+)\/\*$/.exec(glob) : null;
    if (!m) {
      problems.push(`package.json: workspace glob ${JSON.stringify(glob)} is not <dir>/* (unread)`);
      continue;
    }
    const base = join(repoRoot, m[1]);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base).sort()) {
      const file = join(base, entry, 'package.json');
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      try {
        const manifest = JSON.parse(readFileSync(file, 'utf8')) as Obj;
        pkgs.push({ name: String(manifest.name), dir: `${m[1]}/${entry}`, manifest });
      } catch (err) {
        problems.push(`${m[1]}/${entry}/package.json: unparseable (${String(err)})`);
      }
    }
  }
  return pkgs;
}

function readWorkflows(workflowDir: string, problems: string[]): Map<string, Obj> {
  const docs = new Map<string, Obj>();
  let names: string[];
  try {
    names = readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  } catch (err) {
    problems.push(`${workflowDir}: cannot list workflows (${String(err)})`);
    return docs;
  }
  for (const name of names.sort()) {
    try {
      const doc = parse(readFileSync(join(workflowDir, name), 'utf8'));
      if (!isObj(doc)) throw new Error('not a mapping');
      docs.set(name, doc);
    } catch (err) {
      problems.push(`${name}: unreadable or unparseable workflow (${String(err)})`);
    }
  }
  return docs;
}

function jobsOf(file: string, doc: Obj): Job[] {
  const jobs = isObj(doc.jobs) ? doc.jobs : {};
  const wfDefault = isObj(doc.defaults) && isObj(doc.defaults.run) ? doc.defaults.run : {};
  return Object.entries(jobs).flatMap(([id, raw]) => {
    if (!isObj(raw)) return [];
    const jobDefault = isObj(raw.defaults) && isObj(raw.defaults.run) ? raw.defaults.run : {};
    return [
      {
        id,
        file,
        needs: asArray(raw.needs).map(String),
        if: raw.if,
        continueOnError: raw['continue-on-error'],
        defaultWorkingDirectory: jobDefault['working-directory'] ?? wfDefault['working-directory'],
        steps: asArray(raw.steps)
          .filter(isObj)
          .map((s) => ({
            run: typeof s.run === 'string' ? s.run : '',
            if: s.if,
            continueOnError: s['continue-on-error'],
            workingDirectory: s['working-directory'],
          })),
      },
    ];
  });
}

/** `job` plus every job it transitively needs, within its workflow. */
function needsClosure(job: Job, jobs: Job[]): Job[] {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const seen = new Map<string, Job>();
  const stack = [job];
  while (stack.length > 0) {
    const j = stack.pop() as Job;
    if (seen.has(j.id)) continue;
    seen.set(j.id, j);
    for (const n of j.needs) {
      const next = byId.get(n);
      if (next) stack.push(next);
    }
  }
  return [...seen.values()];
}

const runsAudit = (job: Job) =>
  job.steps.some((s) => s.run.includes('scripts/audit-published.mjs'));

/** A job with an unconditional `cargo deny check` step that runs against `crates/`. */
function hasCrateDenyGate(job: Job): boolean {
  if (ungated(job)) return false;
  return job.steps.some((s) => {
    if (ungated(s)) return false;
    if (!/\bcargo\s+deny\b[^\n]*\bcheck\b/.test(s.run)) return false;
    const wd = String(s.workingDirectory ?? job.defaultWorkingDirectory ?? '').replace(/\/$/, '');
    return (
      wd === 'crates' ||
      wd === './crates' ||
      /--manifest-path[ =]\.?\/?crates\//.test(s.run) ||
      /\bcd\s+\.?\/?crates\b/.test(s.run)
    );
  });
}

const crateRevOf = (manifest: Obj): unknown =>
  isObj(manifest.knextFfi) ? manifest.knextFfi.crateRev : undefined;

function checkCrateLane(
  file: string,
  doc: Obj | undefined,
  revManifestPaths: string[],
  problems: string[],
): void {
  if (!doc) {
    problems.push(`${file}: the knext-ffi crates lane is missing or unreadable`);
    return;
  }
  const on = (doc.on ?? (doc as Record<string, unknown>).true) as unknown;
  const triggers = isObj(on) ? on : {};
  const needPaths = ['crates/**', ...revManifestPaths];
  for (const event of ['pull_request', 'push']) {
    if (!(event in triggers)) {
      problems.push(`${file}: no ${event} trigger — a crate change could merge ungated`);
      continue;
    }
    const cfg = isObj(triggers[event]) ? (triggers[event] as Obj) : {};
    if ('paths-ignore' in cfg) {
      problems.push(`${file}: ${event} uses paths-ignore, which this guard cannot vouch for`);
    }
    if ('paths' in cfg) {
      const paths = asArray(cfg.paths).map(String);
      for (const p of needPaths) {
        if (!paths.includes(p)) problems.push(`${file}: ${event} paths miss ${p}`);
      }
    }
    if (event === 'push') {
      const branches = asArray(cfg.branches).map(String);
      for (const b of CRATE_LANE_BRANCHES) {
        if (!branches.includes(b)) {
          problems.push(`${file}: the push trigger does not cover branch ${b}`);
        }
      }
    }
  }
  const jobs = jobsOf(file, doc);
  if (!jobs.some(hasCrateDenyGate)) {
    problems.push(
      `${file}: no unconditional cargo deny check over crates/ (a step with no if:, no continue-on-error, in a job with neither)`,
    );
  }
  const driftGuard = jobs.some(
    (j) =>
      !ungated(j) &&
      j.steps.some(
        (s) => !ungated(s) && /\bnode\s+scripts\/check-ffi-crate-rev\.mjs\b/.test(s.run),
      ),
  );
  if (!driftGuard) {
    problems.push(
      `${file}: the crate-rev drift guard (scripts/check-ffi-crate-rev.mjs) does not run unconditionally`,
    );
  }
}

export function auditReleaseSets(options: ReleaseSetOptions): ReleaseSetAudit {
  const problems: string[] = [];
  const optional = new Set(options.optionalBeta);
  const scope = new Set(options.auditScope);

  const pkgs = readWorkspace(options.repoRoot, problems).map((p) => ({
    ...p,
    manifest: { ...p.manifest, ...(options.overrides?.[p.name] ?? {}) },
  }));
  const byName = new Map(pkgs.map((p) => [p.name, p]));

  let changeset: Obj = {};
  try {
    const parsed = JSON.parse(
      readFileSync(join(options.repoRoot, '.changeset', 'config.json'), 'utf8'),
    );
    if (!isObj(parsed)) throw new Error('not an object');
    changeset = parsed;
  } catch (err) {
    problems.push(`.changeset/config.json: unreadable or unparseable (${String(err)})`);
  }
  const groups = (key: string) => asArray(changeset[key]).map((g) => asArray(g).map(String));
  const fixedGroups = groups('fixed');
  const linkedGroups = groups('linked');
  const ignore = asArray(changeset.ignore).map(String);
  const fixedGroup = fixedGroups.find((g) => g.includes(CORE)) ?? [];
  if (fixedGroup.length === 0) {
    problems.push(`.changeset/config.json: no fixed group contains ${CORE}`);
  }

  const publishable = pkgs.filter((p) => p.manifest.private !== true).map((p) => p.name);

  // 1. release-set membership and audit scope.
  for (const name of publishable) {
    if (!fixedGroup.includes(name) && !optional.has(name)) {
      problems.push(
        `${name} is publishable but belongs to no release set (neither the changesets fixed group nor the optional Beta set)`,
      );
    }
    if (!scope.has(name) && !options.auditExempt.some((e) => e.name === name)) {
      problems.push(
        `${name} is publishable but not in the audit scope (scripts/audit-published.mjs auditScope()) — it would publish with no npm audit and no SBOM`,
      );
    }
  }
  for (const e of options.auditExempt) {
    if (!publishable.includes(e.name)) {
      problems.push(
        `audit exemption for ${e.name} is stale: ${e.name} is not a publishable package`,
      );
    }
    if (!e.reason.trim()) problems.push(`audit exemption for ${e.name} carries no reason`);
  }

  // 2. the release-set rule for optional Beta packages.
  const optionalSeen: string[] = [];
  for (const name of optional) {
    const pkg = byName.get(name);
    if (!pkg) {
      problems.push(`${name} is declared an optional Beta package but is not a workspace package`);
      continue;
    }
    optionalSeen.push(name);
    if (fixedGroups.some((g) => g.includes(name))) {
      problems.push(`${name} is an optional Beta package but sits in a changesets fixed group`);
    }
    if (linkedGroups.some((g) => g.includes(name))) {
      problems.push(`${name} is an optional Beta package but sits in a changesets linked group`);
    }
    const m = pkg.manifest;
    for (const field of ['dependencies', 'optionalDependencies'] as const) {
      if (isObj(m[field]) && CORE in (m[field] as Obj)) {
        problems.push(`${name} depends on ${CORE} (${field}); it must be an optional peer instead`);
      }
    }
    const peer = isObj(m.peerDependencies) ? (m.peerDependencies as Obj)[CORE] : undefined;
    if (peer === undefined) {
      problems.push(`${name} declares no peer range on ${CORE}`);
    } else if (!BOUNDED_MAJOR.test(String(peer))) {
      problems.push(
        `${name} peers on ${CORE}@'${String(peer)}', which is not a bounded major (>=A <B)`,
      );
    }
    const meta = isObj(m.peerDependenciesMeta) ? (m.peerDependenciesMeta as Obj)[CORE] : undefined;
    if (peer !== undefined && !(isObj(meta) && meta.optional === true)) {
      problems.push(`${name}'s ${CORE} peer is not marked optional in peerDependenciesMeta`);
    }
  }
  for (const name of fixedGroup) {
    const pkg = byName.get(name);
    if (!pkg) continue;
    for (const field of DEP_FIELDS) {
      const deps = isObj(pkg.manifest[field]) ? (pkg.manifest[field] as Obj) : {};
      for (const opt of optional) {
        if (opt in deps) {
          problems.push(
            `${name} lists optional Beta package ${opt} in ${field} — the fixed group must never require it`,
          );
        }
      }
    }
  }

  // 3. a publishable optional Beta package must be wired.
  const workflows = readWorkflows(options.workflowDir, problems);
  const allJobs = [...workflows].flatMap(([file, doc]) => jobsOf(file, doc));
  const auditJobs = allJobs.filter(runsAudit);
  for (const name of optionalSeen) {
    const pkg = byName.get(name) as Pkg;
    if (pkg.manifest.private === true) continue;
    if (!ignore.includes(name)) {
      problems.push(
        `${name} is publishable but not in .changeset/config.json ignore — the shared changeset publish passes --tag latest/<pre tag> and would put a Beta package there`,
      );
    }
    if (auditJobs.length === 0) {
      problems.push(`${name} is publishable but no audit job (scripts/audit-published.mjs) exists`);
    }
    const builds = new RegExp(`--filter(?:=|\\s+)${escapeRe(name)}\\s+build\\b`);
    for (const job of auditJobs) {
      if (!job.steps.some((s) => builds.test(s.run))) {
        problems.push(
          `${name} is publishable but the audit job ${job.file}#${job.id} does not build it (bun run --filter ${name} build), so the audit would pack an empty dist/`,
        );
      }
    }
    const names = new RegExp(`(?:${escapeRe(name)}|${escapeRe(pkg.dir)})(?![\\w-])`);
    const betaJobs = allJobs.filter((j) =>
      j.steps.some(
        (s) =>
          /\bnpm\s+publish\b/.test(s.run) &&
          /--tag(?:=|\s+)beta\b/.test(s.run) &&
          names.test(s.run),
      ),
    );
    const rev = crateRevOf(pkg.manifest);
    if (betaJobs.length === 0) {
      problems.push(
        `${name} is publishable but no workflow job publishes it with npm publish --tag beta`,
      );
      if (rev !== undefined) {
        problems.push(
          `${name} records a knext-ffi crate revision: its beta publish job must need an unconditional cargo deny check over crates/ (none found)`,
        );
      }
    }
    for (const job of betaJobs) {
      const closure = needsClosure(
        job,
        allJobs.filter((j) => j.file === job.file),
      );
      if (!closure.some(runsAudit)) {
        problems.push(
          `${name}: the beta publish job ${job.file}#${job.id} needs no audit job, directly or transitively`,
        );
      }
      if (rev !== undefined && !closure.some(hasCrateDenyGate)) {
        problems.push(
          `${name} records a knext-ffi crate revision but its beta publish job ${job.file}#${job.id} does not need an unconditional cargo deny check over crates/`,
        );
      }
    }
  }

  // 4. the crates lane behind every recorded crate revision.
  const revManifests = optionalSeen
    .map((n) => byName.get(n) as Pkg)
    .filter((p) => crateRevOf(p.manifest) !== undefined)
    .map((p) => `${p.dir}/package.json`);
  let crateLaneChecked = false;
  if (revManifests.length > 0) {
    crateLaneChecked = true;
    const lanePath = resolve(options.workflowDir, options.crateWorkflow);
    checkCrateLane(
      options.crateWorkflow,
      existsSync(lanePath) ? workflows.get(options.crateWorkflow) : undefined,
      revManifests,
      problems,
    );
  }

  return { problems, publishable, fixedGroup, optionalSeen, crateLaneChecked };
}
