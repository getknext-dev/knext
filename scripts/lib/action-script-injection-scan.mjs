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
 * @param {string} text the action file
 * @param {string} file used in messages
 * @returns {Array<{file: string, step: string, key: string, expression: string}>}
 */
export function scanActionText(text, file) {
  let doc;
  try {
    doc = parse(text);
  } catch (e) {
    throw new Error(`${file}: not parseable YAML, so it cannot be scanned: ${e.message}`);
  }
  const runs = doc?.runs;
  if (!runs || runs.using !== 'composite') return [];
  if (!Array.isArray(runs.steps)) {
    throw new Error(`${file}: composite action whose runs.steps is not a list; cannot be scanned`);
  }
  const findings = [];
  runs.steps.forEach((step, i) => {
    const name = String(step?.name ?? step?.id ?? `#${i + 1}`);
    const bodies = [];
    if (typeof step?.run === 'string') bodies.push(['run', step.run]);
    if (typeof step?.with?.script === 'string') bodies.push(['with.script', step.with.script]);
    for (const [key, body] of bodies) {
      for (const expression of expressionsIn(body)) {
        if (isRunnerControlled(expression)) continue;
        findings.push({ file, step: name, key, expression });
      }
    }
  });
  return findings;
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
