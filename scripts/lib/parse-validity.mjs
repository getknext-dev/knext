/**
 * The ONE parse-validity check for mutated JS/TS subjects (sprint 3, PR #940).
 *
 * WHY IT EXISTS. A mutated subject that stops PARSING reds its guard for the
 * wrong reason — the module fails to import, every test in the spec falls, and
 * that "KILLED" is indistinguishable in the log from the guard doing its job.
 * Found live, then confirmed as a class by a sweep of all provers: a mid-line
 * anchor plus the harness's appended line-comment residue marker comments out
 * the rest of the line (`) {` tails are the usual casualty), and the false kill
 * certifies coverage that does not exist. Three provers had the shape; one had
 * already logged a false kill for exactly this.
 *
 * WHY SHARED. `dated-exemptions.mjs` states the rule this follows: written
 * three times it would drift three ways, and the failure is silent in every
 * direction — a validator that quietly stops seeing parse errors excuses every
 * unparseable mutation from then on.
 *
 * IN-PROCESS by design: the prover-lane audit refuses a prover that spawns
 * outside the shared runner resolvers, so `node --check` is not an option. The
 * TypeScript parser is already a root devDependency and reads both `.mjs`/`.js`
 * (ESM) and `.ts` sources.
 */

import ts from 'typescript';

/**
 * A `validate` hook for `createGuardProver`'s mutations (also callable from
 * bespoke harness loops): returns undefined when `mutated` still parses, or a
 * problem string naming the first syntax error when it does not.
 *
 * `transpileModule` with `reportDiagnostics` surfaces SYNTAX errors only — it
 * never type-checks — which is exactly the boundary wanted here: a mutation is
 * allowed to break semantics (that is its job), never the grammar.
 *
 * @param {string} mutated the mutated subject's full source text
 * @returns {string | undefined}
 */
export function jsStillParses(mutated) {
  const syntaxErrors = ts
    .transpileModule(mutated, {
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
    })
    .diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (syntaxErrors.length === 0) return undefined;
  const first = ts.flattenDiagnosticMessageText(syntaxErrors[0].messageText, ' ');
  return `the mutated subject no longer parses: ${first}`;
}
