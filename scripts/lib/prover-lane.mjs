/**
 * Discovery, source audit and verdict logic for the mutation-prover lane (#685).
 *
 * Split out of `scripts/run-mutation-provers.mjs` for the same reason
 * `ci-blocking-gate-proof.mjs` was split out of its prover: the parts that have
 * been WRONG must be testable without paying for the mutations. Nothing here
 * spawns anything or reads the tree on import.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { blankNonCode } from './blank-non-code.mjs';
import { parseProverSummary } from './prover-report.mjs';

/** Every prover file lives here and matches this shape. Glob, never a list. */
const PROVER_DIR = 'scripts';
const PROVER_RE = /^mutation-prove-.*\.mjs$/;

/**
 * Every mutation prover in the tree, as `{ relPath, absPath }`, sorted.
 *
 * DISCOVERED, because the bug this lane exists for is a fix that was applied to
 * the two provers a PR happened to touch and to no others. An enumerated list
 * would reproduce that failure one level up.
 *
 * @param {string} repoRoot
 */
export function discoverProvers(repoRoot) {
  const dir = resolve(repoRoot, PROVER_DIR);
  return readdirSync(dir)
    .filter((name) => PROVER_RE.test(name))
    .sort()
    .map((name) => ({ relPath: `${PROVER_DIR}/${name}`, absPath: join(dir, name) }));
}

/**
 * The contents of every string literal that is CODE, comments excluded.
 *
 * `blankNonCode` blanks a literal's CONTENTS but keeps its delimiters, and
 * blanks a comment wholesale — delimiters and all. So a quote surviving in the
 * blanked view is a code-position literal, and its contents can be sliced out of
 * the ORIGINAL source between the delimiters. That distinction is the whole
 * point here: several provers DOCUMENT the `pnpm exec vitest` bug in their
 * header comment, and a scan that cannot tell documenting it from doing it would
 * have to be weakened until it found nothing.
 *
 * Template literals are included — a backtick must not be a hiding place — by
 * skipping `${…}` holes, which `blankNonCode` deliberately leaves as code.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function codeStringLiterals(source) {
  const blanked = blankNonCode(source);
  const found = [];
  let i = 0;
  while (i < blanked.length) {
    const c = blanked[i];
    if (c === "'" || c === '"') {
      const end = blanked.indexOf(c, i + 1);
      if (end === -1) break;
      found.push(source.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let depth = 0;
      for (; j < blanked.length; j++) {
        if (blanked[j] === '$' && blanked[j + 1] === '{') {
          depth += 1;
          j += 1;
          continue;
        }
        if (depth > 0) {
          if (blanked[j] === '}') depth -= 1;
          continue;
        }
        if (blanked[j] === '`') break;
      }
      if (j >= blanked.length) break;
      found.push(source.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return found;
}

/** Does `identifier` appear in CODE position (not only in a comment)? */
function usesIdentifier(source, identifier) {
  return new RegExp(`\\b${identifier}\\b`).test(blankNonCode(source));
}

/**
 * Is `identifier` CALLED — not merely imported?
 *
 * MEASURED, not anticipated: the first version of this audit asked
 * `usesIdentifier`, and deleting `declareMutations(5);` from a prover left the
 * guard GREEN, because the `import { declareMutations, … }` line still carried
 * the name. A guard that an unused import satisfies is decoration, which is the
 * exact failure this whole file exists to make loud.
 */
function callsFunction(source, identifier) {
  return new RegExp(`\\b${identifier}\\s*\\(`).test(blankNonCode(source));
}

/** The child-process entry points a prover could start a test runner through. */
const SPAWNERS = ['spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync'];

/**
 * A code string literal that names a PACKAGE MANAGER as a command.
 *
 * Trimmed EQUALITY for the bare name (`spawnSync('pnpm', […])`) plus the
 * `<pm> exec` form for a single-string command line. Not a substring match on
 * "pnpm": every prover's header comment discusses the bug, and blanking already
 * removes comments, but a code literal like `'pnpm-lock.yaml'` is a legitimate
 * path and must not read as a finding.
 *
 * @param {string[]} literals
 */
function packageManagerCommand(literals) {
  return literals.find(
    (s) => ['pnpm', 'npm', 'yarn'].includes(s.trim()) || /\b(pnpm|npm|yarn)\s+exec\b/.test(s),
  );
}

/**
 * Audit one prover's SOURCE. Returns a finding per violation, `[]` if clean.
 *
 * Two invariants, both scanned:
 *
 *   1. The test runner is resolved via `resolveTestRunner`, never spawned as
 *      `pnpm exec`. `pnpm exec vitest` resolves nothing in a tree without its
 *      own `node_modules` — four of the seven prover failures in #685 were this
 *      one bug, and three of those printed a confidently WRONG diagnosis rather
 *      than failing visibly.
 *   2. The prover declares its mutation count and records each one, so the lane
 *      can catch a prover that runs 4 of 13 and exits 0.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function auditProverSource(source) {
  const findings = auditRunnerResolution(source);
  if (!callsFunction(source, 'declareMutations')) {
    findings.push(
      'does not call declareMutations(n) — without a declared count the lane cannot tell 4-of-13 from 13-of-13',
    );
  }
  if (!callsFunction(source, 'recordMutation')) {
    findings.push('does not call recordMutation() — the run count would always be 0');
  }
  return findings;
}

/**
 * The runner half of the audit, applicable to any file in the proof tree.
 *
 * Separated because it also runs over `scripts/lib/*.mjs`: a prover is allowed
 * to delegate its spawning to a shared helper, and that delegation is only safe
 * if the helper is held to the same rule. The definition site of
 * `resolveTestRunner` satisfies it by construction — its documented
 * last-resort fallback IS `pnpm exec vitest`, reached only when no
 * `node_modules/.bin/vitest` exists anywhere up the tree.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function auditRunnerResolution(source) {
  const findings = [];
  const pm = packageManagerCommand(codeStringLiterals(source));
  const spawner = SPAWNERS.find((name) => usesIdentifier(source, name));
  // The ONE legitimate package-manager SPAWN in the tree is the resolver's own
  // last-resort fallback, so the exemption is the DEFINITION SITE — not "a file
  // that mentions the resolver", which every fixed prover does. A file that names
  // a package manager without spawning anything (this module's own allowlist)
  // is data, not a launch.
  const definesResolver = /function\s+resolveTestRunner\b/.test(blankNonCode(source));
  if (pm !== undefined && spawner !== undefined && !definesResolver) {
    findings.push(
      `spawns the package manager (${JSON.stringify(pm)}) — resolve the runner with resolveTestRunner instead; \`pnpm exec\` resolves nothing in a tree without its own node_modules`,
    );
  }
  // Either the prover resolves the runner itself through the shared resolver, or
  // it spawns NOTHING and delegates to a shared proof helper that does (which is
  // what `mutation-prove-ci-blocking-gates.mjs` does via `runGateTest`). What is
  // not allowed is spawning a process without going through the resolver.
  if (spawner !== undefined && !callsFunction(source, 'resolveTestRunner')) {
    findings.push(
      `calls ${spawner}() without resolveTestRunner — a prover that spawns must resolve its runner through the shared resolver`,
    );
  }
  return findings;
}

/**
 * The verdict for ONE prover run. Returns a finding per problem, `[]` if clean.
 *
 * The count comparison is what makes this more than an exit-code check, and it
 * is deliberately symmetric: `run < declared` is the prover that stopped early,
 * `run > declared` is the declaration that was never updated. Both are a lie
 * about what was proved.
 *
 * @param {{ status: number | null, output: string }} run
 */
export function evaluateProverRun(run) {
  const findings = [];
  if (run.status !== 0) findings.push(`non-zero exit (${run.status})`);
  const summary = parseProverSummary(run.output);
  if (summary === null) {
    findings.push(
      'emitted no mutation summary — declareMutations(n) must be called before the first mutation',
    );
    return { summary, findings };
  }
  if (summary.declared === 0) {
    findings.push('declared zero mutations — a vacuous green proves nothing');
  } else if (summary.declared !== summary.run) {
    findings.push(
      `declared ${summary.declared} mutation(s) but ran ${summary.run} — the prover did not do what it claims`,
    );
  }
  return { summary, findings };
}

/** Read a prover's source. Kept here so callers need no fs import. */
export function readProver(absPath) {
  return readFileSync(absPath, 'utf8');
}
