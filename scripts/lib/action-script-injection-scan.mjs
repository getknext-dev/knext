/**
 * The script-injection scan for composite GitHub Actions.
 *
 * GitHub replaces `${{ … }}` with plain text BEFORE a step's script is parsed,
 * so any expression inside a `run:` body is text the script's author did not
 * write. When that expression carries a value the caller controls — an action
 * input, a PR title, a branch name — the caller writes shell. In a published
 * action that means the CONSUMER's untrusted data runs with the action's
 * credentials in scope (the decoded kubeconfig, the registry token).
 *
 * The rule is an ALLOWLIST, not a deny list: inside a script body the only
 * expressions permitted are ones whose value the runner, not a caller, decides.
 * Everything else — including contexts nobody has thought of yet — is a finding.
 * The right shape is to pass the value through `env:` and read `"$VAR"`.
 *
 * Scope: every `action.yml` / `action.yaml` in the repository (discovered by
 * walking the tree, never enumerated by hand), whatever its directory. The keys
 * scanned are each composite step's `run:` and a `with.script:` (the
 * `actions/github-script` body, which is JavaScript the same expression is pasted
 * into). `env:`, `with:` (other keys), `if:`, `working-directory:` are not script
 * bodies and are not scanned.
 *
 * Workflows under `.github/workflows` are scanned too, by different rules (an
 * allowlist for `github`, `inputs` banned, env taint) and with documented limits:
 * see {@link WORKFLOW_GITHUB_ALLOWED} and `scanWorkflowText`.
 *
 * A file the scan cannot read is an error, not a pass.
 *
 * The test is `tests/action-script-injection.test.ts`; the mutation proof is
 * `scripts/mutation-prove-2531-action-script-injection.mjs`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Expressions whose value is decided by the runner, not by whoever triggers or
 * calls the workflow. Anything not matching one of these in a script body is
 * reported.
 */
export const RUNNER_CONTROLLED = [
  /^github\.action_path$/,
  /^github\.workspace$/,
  /^github\.sha$/,
  /^runner\.(temp|os|arch|tool_cache)$/,
];

/** True when `expression` (trimmed, without the `${{ }}`) is runner-controlled. */
export function isRunnerControlled(expression) {
  return RUNNER_CONTROLLED.some((re) => re.test(expression));
}

/**
 * Every `${{ … }}` in `body`, trimmed. Also matches the `\${{` spelling: a
 * backslash is a shell escape, and the substitution happens before the shell.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function expressionsIn(body) {
  return [...body.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => (m[1] ?? '').trim());
}

/**
 * @param {string} text
 * @param {string} file used in messages
 */
function parseYaml(text, file) {
  try {
    return parse(text);
  } catch (e) {
    throw new Error(`${file}: not parseable YAML, so it cannot be scanned: ${e.message}`);
  }
}

/**
 * The script bodies of one step: its `run:`, and the `script:` of an
 * `actions/github-script` step (JavaScript the same expression is pasted into).
 *
 * @param {any} step
 * @returns {Array<[string, string]>}
 */
function scriptBodies(step) {
  const bodies = [];
  if (typeof step?.run === 'string') bodies.push(['run', step.run]);
  if (typeof step?.with?.script === 'string') bodies.push(['with.script', step.with.script]);
  return bodies;
}

/**
 * @param {string} text the action file
 * @param {string} file used in messages
 * @returns {Array<{file: string, step: string, key: string, expression: string}>}
 */
export function scanActionText(text, file) {
  const doc = parseYaml(text, file);
  const runs = doc?.runs;
  if (!runs || runs.using !== 'composite') return [];
  if (!Array.isArray(runs.steps)) {
    throw new Error(`${file}: composite action whose runs.steps is not a list; cannot be scanned`);
  }
  const findings = [];
  runs.steps.forEach((step, i) => {
    const name = String(step?.name ?? step?.id ?? `#${i + 1}`);
    for (const [key, body] of scriptBodies(step)) {
      for (const expression of expressionsIn(body)) {
        if (isRunnerControlled(expression)) continue;
        findings.push({ file, step: name, key, expression });
      }
    }
  });
  return findings;
}

/**
 * WORKFLOWS. A workflow's own scripts legitimately interpolate `matrix.*`,
 * `steps.*.outcome` and the like, and a workflow is not a published surface a
 * stranger calls with their own values, so this is not the action allowlist. What
 * must never appear inside a `run:` or `github-script` body is text an outside
 * party chooses: event payload fields (PR title, branch, commit message), ref and
 * actor names, and dispatch/call inputs. Rules:
 *
 *   - `inputs` in ANY form is flagged.
 *   - `github` is an ALLOWLIST ({@link WORKFLOW_GITHUB_ALLOWED}). Every other
 *     reference is flagged: `github.event.*`, `head_ref`, `base_ref`, `ref`,
 *     `ref_name`, `actor`, `triggering_actor`, the bare `github` (so
 *     `toJSON(github)` cannot smuggle the lot), `github.*`, and index syntax
 *     (`github['head_ref']`, `github[inputs.k]`).
 *   - `env.X` is flagged when X resolves (step over job over workflow) to a value
 *     built from a flagged expression: moving an untrusted value into `env:` is the
 *     fix ONLY when the script then reads `"$X"`, not `${{ env.X }}`.
 *   - `runner.*` is runner-controlled and always allowed.
 *   - Matching is case-insensitive (contexts are), whitespace around `.`/`[` is
 *     ignored, `['x']` is read as `.x`, and string literals are blanked so a quoted
 *     name is not a reference. An expression with unbalanced quotes, parentheses or
 *     brackets cannot be read and is flagged ("unparseable"), never passed.
 *
 * KNOWN LIMITATION, stated rather than hidden: data flow through `steps.*.outputs`,
 * `needs.*.outputs` and `matrix.*` is NOT tracked. A step that writes an untrusted
 * value to `$GITHUB_OUTPUT` and a later `run:` that interpolates
 * `${{ steps.x.outputs.y }}` is not caught, nor is a matrix built from event data
 * with `fromJSON`. Those need a taint analysis over the whole job graph; this scan
 * stops at the contexts a caller can name directly. `secrets.*` and `vars.*` are
 * also not flagged (a leak, not an injection, and repo-owner controlled).
 *
 * Each `github` property allowed, and why it is not event-derived:
 *   sha                  the commit being built (a hex string, never free text)
 *   workspace            the runner's checkout path
 *   run_id, run_number, run_attempt   counters the platform assigns
 *   repository, repository_owner      the repo this workflow lives in (fixed)
 *   event_name           which trigger fired: one of a closed set of event names
 *   job                  the job id written in the workflow file
 *   action_path          where a composite action was unpacked
 *   server_url, api_url, graphql_url  the GitHub host, fixed per runner
 */
export const WORKFLOW_GITHUB_ALLOWED = new Set([
  'sha',
  'workspace',
  'run_id',
  'run_number',
  'run_attempt',
  'repository',
  'repository_owner',
  'event_name',
  'job',
  'action_path',
  'server_url',
  'api_url',
  'graphql_url',
]);

/**
 * Put an expression into a form the reference scan can read: lower case, `['x']`
 * as `.x`, no whitespace around `.` or before `[`, string literals blanked.
 * Returns null when it cannot be read: a non-ASCII character, or unbalanced quotes,
 * parentheses or brackets.
 *
 * @param {string} expression
 * @returns {string | null}
 */
function normalizeExpression(expression) {
  // Before lower-casing: toLowerCase maps some non-ASCII letters to ASCII ones (the
  // Kelvin sign to k), and the runner folds case differently from this scan. A name
  // spelled with a long s or a fullwidth letter is not one this scan can vouch for.
  if (/[^ -~\t\n\r]/.test(expression)) return null;
  let s = expression.toLowerCase();
  if ((s.match(/'/g) ?? []).length % 2 !== 0) return null;
  if ((s.match(/"/g) ?? []).length % 2 !== 0) return null;
  s = s.replace(/\s*\.\s*/g, '.').replace(/\s+\[/g, '[');
  s = s.replace(/\[\s*(?:'([^']*)'|"([^"]*)")\s*\]/g, (_, a, b) => `.${a ?? b}`);
  s = s.replace(/'(?:[^']|'')*'/g, "''").replace(/"[^"]*"/g, '""');
  const depth = { '(': 0, '[': 0 };
  for (const ch of s) {
    if (ch === '(') depth['(']++;
    if (ch === ')' && --depth['('] < 0) return null;
    if (ch === '[') depth['[']++;
    if (ch === ']' && --depth['['] < 0) return null;
  }
  if (depth['('] !== 0 || depth['['] !== 0) return null;
  return s;
}

/**
 * Why `expression` is not safe inside a workflow script body (empty = safe).
 *
 * @param {string} expression the trimmed text between `${{` and `}}`
 * @param {Map<string, string>} env effective env for this step: lower-cased name to raw value
 * @param {Set<string>} [seen] env names being resolved (cycle guard)
 * @returns {string[]}
 */
export function workflowExpressionProblems(expression, env, seen = new Set()) {
  const s = normalizeExpression(expression);
  if (s === null) {
    return [
      'unparseable expression (non-ASCII character, or unbalanced quotes, parentheses or brackets)',
    ];
  }
  const problems = [];
  const re = /(^|[^\w.-])(github|inputs|env)(?![\w-])/g;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    const root = m[2];
    const rest = s.slice(m.index + m[0].length);
    const prop = /^\.([\w-]+)(?![\w-])(?![.[])/.exec(rest)?.[1];
    if (root === 'inputs') {
      problems.push('inputs are caller-controlled text');
    } else if (root === 'github') {
      if (prop === undefined || !WORKFLOW_GITHUB_ALLOWED.has(prop)) {
        problems.push(
          prop === undefined
            ? 'the github context other than a plain allowed field (bare, indexed or wildcard)'
            : `github.${prop} is not on the allowed list of non-event fields`,
        );
      }
    } else if (prop === undefined) {
      if ([...env.keys()].some((k) => envTainted(k, env, seen))) {
        problems.push('env used whole while some env value is built from untrusted text');
      }
    } else if (envTainted(prop, env, seen)) {
      problems.push(`env.${prop} is built from untrusted text`);
    }
  }
  return problems;
}

/**
 * The env key that stands for "any name": an `env:` written as a string expression
 * (`env: ${{ fromJSON(...) }}`) defines names the scan cannot list. `*` cannot be a
 * real variable name, so it cannot collide with one.
 */
const ENV_WILDCARD = '*';

/** True when env value `name` contains an expression that is not safe in a script body. */
function envTainted(name, env, seen) {
  // A string-valued env at this scope or above defines any name: if it is built from
  // untrusted text, so is every env.X.
  if (name !== ENV_WILDCARD && env.has(ENV_WILDCARD) && envTainted(ENV_WILDCARD, env, seen)) {
    return true;
  }
  const value = env.get(name);
  if (typeof value !== 'string') return false;
  if (seen.has(name)) return true; // a cycle cannot be resolved: fail closed
  const next = new Set(seen).add(name);
  return expressionsIn(value).some((e) => workflowExpressionProblems(e, env, next).length > 0);
}

/**
 * Lower-cased name to value for an `env:` block. A string (an expression standing for
 * the whole mapping) is recorded under {@link ENV_WILDCARD}.
 */
function envEntries(env) {
  const out = new Map();
  if (typeof env === 'string') {
    out.set(ENV_WILDCARD, env);
  } else if (env && typeof env === 'object' && !Array.isArray(env)) {
    for (const [k, v] of Object.entries(env)) out.set(String(k).toLowerCase(), v);
  }
  return out;
}

/**
 * Merge env scopes, later over earlier. The wildcard is the exception: a string env at
 * ANY scope can define any name, and a mapping below it cannot prove otherwise, so
 * the wildcard values accumulate instead of overriding.
 */
function mergeEnvs(...scopes) {
  const out = new Map();
  for (const scope of scopes) {
    for (const [k, v] of scope) {
      if (k === ENV_WILDCARD && out.has(k)) out.set(k, `${out.get(k)} ${v}`);
      else out.set(k, v);
    }
  }
  return out;
}

/**
 * @param {string} text the workflow file
 * @param {string} file used in messages
 * @returns {Array<{file: string, step: string, key: string, expression: string, reason: string}>}
 */
export function scanWorkflowText(text, file) {
  const doc = parseYaml(text, file);
  const jobs = doc?.jobs;
  if (jobs === undefined || jobs === null) return [];
  if (typeof jobs !== 'object' || Array.isArray(jobs)) {
    throw new Error(`${file}: workflow whose jobs is not a map; cannot be scanned`);
  }
  const findings = [];
  for (const [jobId, job] of Object.entries(jobs)) {
    if (job?.steps === undefined) continue; // a reusable-workflow call has no steps
    if (!Array.isArray(job.steps)) {
      throw new Error(`${file}: job ${jobId} has steps that are not a list; cannot be scanned`);
    }
    job.steps.forEach((step, i) => {
      const name = `${jobId}/${String(step?.name ?? step?.id ?? `#${i + 1}`)}`;
      const env = mergeEnvs(envEntries(doc?.env), envEntries(job.env), envEntries(step?.env));
      for (const [key, body] of scriptBodies(step)) {
        for (const expression of expressionsIn(body)) {
          for (const reason of workflowExpressionProblems(expression, env)) {
            findings.push({ file, step: name, key, expression, reason });
          }
        }
      }
    });
  }
  return findings;
}

/** @param {string} repoRoot @param {string} rel */
export function scanWorkflowFile(repoRoot, rel) {
  return scanWorkflowText(readFileSync(resolve(repoRoot, rel), 'utf8'), rel);
}

/**
 * Every `.github/workflows/*.yml` / `*.yaml`, repo-relative.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function discoverWorkflowFiles(repoRoot) {
  return readdirSync(join(repoRoot, '.github', 'workflows'), { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
    .map((e) => `.github/workflows/${e.name}`)
    .sort();
}

/** @param {string} repoRoot @param {string} rel */
export function scanActionFile(repoRoot, rel) {
  return scanActionText(readFileSync(resolve(repoRoot, rel), 'utf8'), rel);
}

/** Directories that hold dependencies, build output or agent scratch, not the repo's own actions. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude',
  'dist',
  '.next',
  '.turbo',
  'target',
  'coverage',
  'graphify-out',
]);

/**
 * Every `action.yml` / `action.yaml` in the repository, as repo-relative paths.
 * A directory walk rather than a process spawn: the shared-helper rule in
 * `tests/mutation-prover-lane.test.ts` keeps spawns out of `scripts/lib`.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function discoverActionFiles(repoRoot) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(repoRoot, rel), { withFileTypes: true })) {
      const next = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(next);
      } else if (e.isFile() && /^action\.ya?ml$/.test(e.name)) {
        out.push(next);
      }
    }
  };
  walk('');
  return out.sort();
}
