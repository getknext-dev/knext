#!/usr/bin/env node
/**
 * workflow-script-install-guard.mjs — #1639(a).
 *
 * A publish-blocking job in release.yml once ran `node scripts/ga-tarball-diff-gate.mjs`
 * with no `bun install` step first, crashed on a missing `tar` import, and
 * silently SKIPPED the rc.1 publish (fixed for that one job by #1621, root
 * caused as #1622). Nothing generalized the fix: any OTHER workflow job that
 * runs a `scripts/*.mjs` file whose import closure reaches a real npm package,
 * with no install step earlier in the same job, is the same failure waiting
 * to happen.
 *
 * This scans every tracked `.github/workflows/*.yml` for a `run:` step
 * invoking `node scripts/<x>.mjs` / `bun scripts/<x>.mjs` / `bun run
 * scripts/<x>.mjs`, computes that script's import closure with
 * `scripts/adapter-import-closure.mjs`'s `computeAdapterClosure` (the same
 * relative-import walker ADR-0039's CLI-execution guard uses — reused here
 * rather than re-implemented), and reports a violation for any such step
 * whose closure reaches a non-`node:` bare specifier with no
 * `bun install|npm ci|npm install|pnpm install` step earlier in the SAME job.
 *
 * FAILS CLOSED, inherited from `computeAdapterClosure`: an unresolvable
 * relative import throws rather than being silently dropped from the
 * closure — a walker that swallows what it cannot resolve is how this class
 * of guard goes permanently green. A script whose closure cannot be computed
 * at all is therefore a hard error, not a skip.
 *
 * Deliberately does NOT see through a `spawnSync`/`execFileSync`-spawned
 * child process into another script's own closure (e.g.
 * `ga-tarball-diff-gate.mjs` spawning `ga-tarball-diff.mjs`, which is what
 * reaches `tar` — see that file's own header comment for why it is written
 * that way on purpose). A script that only ever reaches a dependency by
 * spawning another script as a child process is exactly the case that
 * doesn't need this guard: the spawned script isn't imported into THIS
 * process, so THIS step's own failure mode isn't "missing node_modules" —
 * scripts/ga-tarball-diff-gate.test.ts` and
 * `tests/workflow-script-install-guard.test.ts` both exercise this
 * distinction against the real files, not a fixture, so the claim is
 * checked rather than assumed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { computeAdapterClosure } from './adapter-import-closure.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');
export const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

// `bun run scripts/x.mjs` before `bun scripts/x.mjs` in the alternation so the
// longer form isn't left partially matched by the shorter one first.
const SCRIPT_RUN_RE = /\b(?:node|bun run|bun)\s+(scripts\/[\w./-]+\.mjs)\b/;
const INSTALL_RE = /\b(?:bun\s+install|npm\s+ci|npm\s+install|pnpm\s+install)\b/;

/** @returns {string[]} tracked workflow filenames, sorted. */
export function trackedWorkflowFiles(workflowsDir = WORKFLOWS_DIR) {
  return readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
}

const closureCache = new Map();

/**
 * The non-`node:` bare specifiers `scriptRelPath`'s import closure reaches,
 * from repo root (never CWD — a relative path resolved against the wrong
 * root is how this class of check silently checks nothing).
 *
 * @param {string} scriptRelPath e.g. `scripts/audit-published.mjs`
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function nonBuiltinPackagesFor(scriptRelPath, repoRoot = REPO_ROOT) {
  const cacheKey = `${repoRoot}::${scriptRelPath}`;
  if (closureCache.has(cacheKey)) return closureCache.get(cacheKey);
  const entry = join(repoRoot, scriptRelPath);
  const { externals } = computeAdapterClosure(entry, { packageRoot: repoRoot });
  const packages = externals.filter((specifier) => !specifier.startsWith('node:'));
  closureCache.set(cacheKey, packages);
  return packages;
}

/**
 * @typedef {{ workflow: string, jobId: string, script: string, packages: string[] }} Violation
 */

/**
 * The step's effective `scripts/<x>.mjs` path RELATIVE TO REPO ROOT, honoring
 * `working-directory:` — a step-level `working-directory:` (falling back to
 * the job's `defaults.run.working-directory`, falling back to the workflow's
 * own top-level `defaults.run.working-directory`) changes where a bare
 * `scripts/x.mjs` in `run:` actually resolves from. Missing this produced a
 * false "file does not exist" on a real workflow during development (ci.yml's
 * `compat-smoke` job runs `node scripts/compat-smoke.mjs` with
 * `working-directory: apps/file-manager`, which is a DIFFERENT file from repo
 * root's `scripts/compat-smoke.mjs`) — this is checked against that real case
 * in the test file, not assumed.
 *
 * @param {string} scriptRelPathInStep the raw `scripts/<x>.mjs` text matched in `run:`
 * @param {{ workingDirectory?: string }} step
 * @param {{ workingDirectory?: string }} job
 * @param {{ workingDirectory?: string }} workflow
 * @param {string} repoRoot
 * @returns {string} path relative to repoRoot, forward-slash separated
 */
export function resolveScriptPath(scriptRelPathInStep, step, job, workflow, repoRoot) {
  const cwd = step.workingDirectory ?? job.workingDirectory ?? workflow.workingDirectory ?? '.';
  const absolute = resolve(repoRoot, cwd, scriptRelPathInStep);
  return relative(repoRoot, absolute).split('\\').join('/');
}

/**
 * @param {{ workflowsDir?: string, files?: string[], repoRoot?: string }} [opts]
 * @returns {Violation[]}
 */
export function findViolations({
  workflowsDir = WORKFLOWS_DIR,
  files = trackedWorkflowFiles(workflowsDir),
  repoRoot = REPO_ROOT,
} = {}) {
  /** @type {Violation[]} */
  const violations = [];
  for (const file of files) {
    const text = readFileSync(join(workflowsDir, file), 'utf8');
    const doc = parse(text);
    const workflowCwd = { workingDirectory: doc?.defaults?.run?.['working-directory'] };
    const jobs = doc?.jobs && typeof doc.jobs === 'object' ? doc.jobs : {};
    for (const [jobId, job] of Object.entries(jobs)) {
      const jobCwd = { workingDirectory: job?.defaults?.run?.['working-directory'] };
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      let installSeen = false;
      for (const step of steps) {
        const run = typeof step?.run === 'string' ? step.run : '';
        if (run === '') continue;
        if (INSTALL_RE.test(run)) {
          installSeen = true;
          continue;
        }
        if (installSeen) continue; // already compliant for this job — no need to walk the closure
        const match = SCRIPT_RUN_RE.exec(run);
        if (!match) continue;
        const stepCwd = { workingDirectory: step['working-directory'] };
        const scriptRelPath = resolveScriptPath(match[1], stepCwd, jobCwd, workflowCwd, repoRoot);
        const packages = nonBuiltinPackagesFor(scriptRelPath, repoRoot);
        if (packages.length > 0) {
          violations.push({ workflow: file, jobId, script: scriptRelPath, packages });
        }
      }
    }
  }
  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const violations = findViolations();
    if (violations.length > 0) {
      for (const v of violations) {
        console.error(
          `::error::${v.workflow} [job ${v.jobId}] runs \`${v.script}\` (reaches ${v.packages.join(', ')}) with no dependency-install step earlier in the job`,
        );
      }
      process.exit(1);
    }
    console.log(
      `workflow-script-install-guard: ${trackedWorkflowFiles().length} workflow(s) scanned, no violations`,
    );
  } catch (err) {
    console.error(`::error::workflow-script-install-guard failed closed: ${err.message}`);
    process.exit(1);
  }
}
