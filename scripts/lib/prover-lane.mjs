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
export const PROVER_RE = /^mutation-prove-.*\.mjs$/;

/**
 * The ONE file allowed to spawn a package manager, by PATH (#693).
 *
 * Round 1 exempted any source matching `/function\s+resolveTestRunner\b/`, which
 * is shape-based: copying the function name into a new file bought that file a
 * full exemption from the package-manager-spawn rule — the exact
 * copy-instead-of-share failure this lane exists to stop, defeating the guard
 * against it. The exemption is now the definition SITE, and
 * `tests/mutation-prover-lane.test.ts` asserts this path is the only file in the
 * tree that defines the function, which is what keeps the anchor sound.
 */
export const RESOLVER_DEFINITION_FILE = 'scripts/lib/ci-blocking-gate-proof.mjs';

/**
 * Shared DRIVERS that call the harness's mutating verbs on a prover's behalf.
 *
 * The convention scan below asks "does every file that mutates via the harness
 * match `scripts/mutation-prove-*.mjs`", because an off-convention prover is
 * discovered by nothing and runs never. `scripts/lib/guard-prover.mjs` mutates
 * and is deliberately not a prover: it is the ceremony (baseline, canary, clean
 * tree, exit-code bookkeeping) that sprint 1's nine guards went without because
 * writing it nine times cost more than the mutation tables did.
 *
 * PATH-ANCHORED, like `RESOLVER_DEFINITION_FILE` and for the same reason: #693
 * had a SHAPE-based exemption here (`/function\s+resolveTestRunner\b/`), and
 * copying a function name into a new file bought that file a full exemption —
 * the copy-instead-of-share failure this lane exists to catch, defeating the
 * guard against it.
 *
 * The exemption is NOT a hole, and `tests/mutation-prover-lane.test.ts` asserts
 * why rather than asserting the list: an exempt file must live under
 * `scripts/lib/` (so the lane's `scripts/*.mjs` glob can never mistake it for a
 * prover) AND must NOT call `declareMutations`/`recordMutation` (so it cannot BE
 * a prover hiding from the lane, which is the thing being guarded against).
 */
export const SHARED_MUTATION_DRIVERS = Object.freeze(['scripts/lib/guard-prover.mjs']);

/**
 * Is this path a sanctioned shared driver rather than an off-convention prover?
 *
 * @param {string} relPath
 * @param {string} source
 */
export function isSharedMutationDriver(relPath, source) {
  if (!SHARED_MUTATION_DRIVERS.includes(relPath)) return false;
  // Fail closed if the "driver" has grown into a prover: a file that declares
  // and records mutations is a prover, and one the lane cannot discover is
  // exactly the failure the convention scan exists for.
  return !callsFunction(source, 'declareMutations') && !callsFunction(source, 'recordMutation');
}

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
  return literalSpans(source).map(({ start, end }) => source.slice(start, end));
}

/**
 * The `[start, end)` content span of every code-position string literal.
 *
 * Extracted from `codeStringLiterals` (#693) because a second consumer needs the
 * POSITIONS, not the contents: an import-specifier scan has to see
 * `'node:child_process'`, which the blanked view has emptied. One walk, two
 * consumers — two walks of the same grammar could only diverge.
 *
 * @param {string} source
 * @returns {Array<{ start: number, end: number }>}
 */
function literalSpans(source) {
  const blanked = blankNonCode(source);
  const spans = [];
  let i = 0;
  while (i < blanked.length) {
    const c = blanked[i];
    if (c === "'" || c === '"') {
      const end = blanked.indexOf(c, i + 1);
      if (end === -1) break;
      spans.push({ start: i + 1, end });
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
      spans.push({ start: i + 1, end: j });
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return spans;
}

/**
 * The source with COMMENTS removed but string literals INTACT.
 *
 * `blankNonCode` empties literal contents too, which is right for "is this a
 * spawn or a comment about one" but wrong for "which module does this import
 * name": the specifier IS the literal. This view keeps comments unable to
 * satisfy anything while leaving `from 'node:child_process'` readable.
 *
 * EXPORTED (#690) for a third consumer: the `allowPathsFilter` caller scan needs
 * a quoted key (`{ ['allowPathsFilter']: true }`) to be visible — `blankNonCode`
 * empties it, so it escaped both halves of that scan — while still refusing to
 * let a commented-out assertion satisfy anything. A fourth tokenizer view would
 * be the copy-instead-of-share failure this file's own lane exists to catch.
 *
 * @param {string} source
 */
export function codeWithLiterals(source) {
  const blanked = blankNonCode(source);
  const out = [...blanked];
  for (const { start, end } of literalSpans(source)) {
    for (let k = start; k < end; k++) out[k] = source[k];
  }
  return out.join('');
}

/**
 * Is `identifier` CALLED — not merely imported, and not merely DECLARED?
 *
 * MEASURED, not anticipated: the first version of this audit asked whether the
 * identifier appeared anywhere in code, and deleting `declareMutations(5);` from
 * a prover left the guard GREEN, because the `import { declareMutations, … }`
 * line still carried the name. A guard that an unused import satisfies is
 * decoration, which is the exact failure this whole file exists to make loud.
 *
 * The DECLARATION exclusion is the same defect one level down (#693): a
 * declaration is a call-shaped occurrence, so `function resolveTestRunner() {}`
 * satisfied a plain `name\s*\(` scan and a file that merely COPIED the name
 * passed. Declaration forms are blanked before the scan, so only a real call
 * counts.
 */
function callsFunction(source, identifier) {
  const code = blankNonCode(source).replace(
    new RegExp(
      `(?:async\\s+)?function\\s*\\*?\\s*${identifier}\\s*\\(|(?:const|let|var)\\s+${identifier}\\s*=\\s*(?:async\\s+)?(?:function\\s*\\*?\\s*)?\\(`,
      'g',
    ),
    '',
  );
  return new RegExp(`\\b${identifier}\\s*\\(`).test(code);
}

/**
 * The child-process entry points a prover could start a test runner through.
 *
 * A BACKSTOP for the import scan below, not the rule. Kept because a `require`
 * or a re-export shape the scan does not parse still lands here, and these five
 * names are unambiguous — nothing else in this repo is called `spawnSync`.
 * `exec` is deliberately ABSENT: `regex.exec(...)` appears all over the tree, so
 * listing it here would fire on `verify-action-pins.mjs` and a dozen others. It
 * is caught by the import scan instead, precisely.
 */
const SPAWNERS = ['spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync'];

/** `node:child_process` under either specifier, in an import or a require. */
const CHILD_PROCESS_IMPORT =
  /(?:import\s+([^;]*?)\s+from\s*|(?:const|let|var)\s+([^;]*?)\s*=\s*require\s*\(\s*)['"]node:child_process['"]/g;

/**
 * Every local name in this file bound to a `node:child_process` export (#693).
 *
 * DERIVED rather than enumerated, because an enumerated list of call sites is
 * how the second one gets missed — and it was: `exec` was not in `SPAWNERS`, so
 * `exec('pnpm exec vitest run x')` produced ZERO findings from a scan whose whole
 * subject is spawning a package manager. Whatever the module is destructured or
 * aliased into IS a spawner, including an API nobody predicted here.
 *
 * Returns `{ direct, namespaces }` — `namespaces` are `import * as cp` /
 * `require(...)`-whole bindings, whose every member call counts.
 *
 * @param {string} source
 */
function childProcessBindings(source) {
  const code = codeWithLiterals(source);
  const direct = new Set();
  const namespaces = new Set();
  for (const match of code.matchAll(CHILD_PROCESS_IMPORT)) {
    const clause = (match[1] ?? match[2] ?? '').trim();
    const braced = /\{([\s\S]*)\}/.exec(clause);
    if (braced) {
      for (const part of (braced[1] ?? '').split(',')) {
        // `execSync as sh` binds `sh`; `execSync` binds itself.
        const local = part
          .trim()
          .split(/\s+as\s+|\s*:\s*/)
          .pop();
        if (local) direct.add(local.replace(/[^A-Za-z0-9_$]/g, ''));
      }
      // A default/namespace binding can sit alongside the braces.
      const outside = clause.replace(/\{[\s\S]*\}/, '');
      for (const part of outside.split(',')) {
        const local = part.trim().replace(/^\*\s+as\s+/, '');
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(local)) namespaces.add(local);
      }
      continue;
    }
    const local = clause.replace(/^\*\s+as\s+/, '').trim();
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(local)) namespaces.add(local);
  }
  direct.delete('');
  return { direct, namespaces };
}

/**
 * The name this source starts a child process through, or `undefined`.
 *
 * A DIRECT binding must be called as a bare identifier not preceded by a `.`,
 * which is what keeps `regex.exec(…)` — everywhere in this repo — from reading
 * as a spawn while `exec(…)` imported from `node:child_process` does.
 *
 * @param {string} source
 */
function spawnerCalled(source) {
  const code = blankNonCode(source);
  const { direct, namespaces } = childProcessBindings(source);
  for (const name of [...direct, ...SPAWNERS]) {
    if (new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(code)) return name;
  }
  for (const ns of namespaces) {
    const member = new RegExp(`(?<![.\\w$])${ns}\\.([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\(`).exec(code);
    if (member) return `${ns}.${member[1]}`;
  }
  return undefined;
}

/**
 * Does this source MUTATE tracked files through the shared harness? (#693)
 *
 * `PROVER_RE` is one naming convention shared by the discovery glob AND by the
 * test's `git ls-files` cross-check, so a prover named `prove-mutation-*.mjs` is
 * silently not run AND leaves the guard unaffected — a convention cannot audit
 * itself. This is the independent, BEHAVIOURAL signal: importing the harness's
 * mutating verbs makes a file a prover whatever it is called. Reading
 * `MUTATION_MARKER` does not (`scripts/scan-mutation-residue.mjs` does exactly
 * that and is not a prover).
 *
 * @param {string} source
 */
export function mutatesViaHarness(source) {
  const code = codeWithLiterals(source);
  const imports = code.matchAll(/import\s+([^;]*?)\s+from\s*['"][^'"]*mutation-harness\.mjs['"]/g);
  for (const match of imports) {
    const clause = match[1] ?? '';
    const named = /\{([\s\S]*)\}/.exec(clause);
    const bindings = (named ? (named[1] ?? '') : clause).split(',').map((s) =>
      s
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim(),
    );
    if (bindings.some((b) => b === 'mutate' || b === 'withSnapshot')) return true;
  }
  return false;
}

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
 * @param {string} [relPath] repo-relative path, for the definition-site exemption
 * @returns {string[]}
 */
export function auditProverSource(source, relPath) {
  const findings = auditRunnerResolution(source, relPath);
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
 * @param {string} [relPath] repo-relative path; the exemption is PATH-anchored,
 *   so omitting it exempts nothing — the audit fails closed.
 * @returns {string[]}
 */
export function auditRunnerResolution(source, relPath) {
  const findings = [];
  const pm = packageManagerCommand(codeStringLiterals(source));
  const spawner = spawnerCalled(source);
  // The ONE legitimate package-manager SPAWN in the tree is the resolver's own
  // last-resort fallback, so the exemption is the DEFINITION SITE — and #693
  // made that literally true. It used to be `/function\s+resolveTestRunner\b/`
  // against the source, i.e. a SHAPE: copying the function name into a new file
  // exempted it, which is the copy-instead-of-share failure this guard exists to
  // catch. It is now the PATH, cross-checked by a test asserting exactly one file
  // in the tree defines that function.
  const definesResolver = relPath === RESOLVER_DEFINITION_FILE;
  if (pm !== undefined && spawner !== undefined && !definesResolver) {
    findings.push(
      `spawns the package manager (${JSON.stringify(pm)}) — resolve the runner with resolveTestRunner instead; \`pnpm exec\` resolves nothing in a tree without its own node_modules`,
    );
  }
  // Either the prover resolves the runner itself through the shared resolver, or
  // it spawns NOTHING and delegates to a shared proof helper that does (which is
  // what `mutation-prove-ci-blocking-gates.mjs` does via `runGateTest`). What is
  // not allowed is spawning a process without going through the resolver.
  if (
    spawner !== undefined &&
    !definesResolver &&
    !callsFunction(source, 'resolveTestRunner') &&
    // #902: the per-spec dispatcher is the OTHER sanctioned resolver — it
    // wraps resolveTestRunner for vitest specs and routes bun:test specs to
    // scripts/bun-test.mjs, which vitest cannot collect.
    !callsFunction(source, 'resolveSpecRunner')
  ) {
    findings.push(
      `calls ${spawner}() without resolveTestRunner/resolveSpecRunner — a prover that spawns must resolve its runner through a shared resolver`,
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

/** The framework a spec file's SOURCE declares. bun:test files cannot run under vitest. */
export function specFramework(specSource) {
  return /from\s+['"]bun:test['"]/.test(specSource) ? 'bun' : 'vitest';
}

/**
 * Every `*.test.ts(x)` path a prover's source references as a string literal.
 * Scanned, not declared: a prover that renames its SPEC const would otherwise
 * exit the audit while still targeting the wrong framework.
 */
export function referencedSpecs(source) {
  const out = new Set();
  for (const m of source.matchAll(/['"]([^'"\n]+\.test\.tsx?)['"]/g)) out.add(m[1]);
  return [...out];
}

/**
 * #902 — the framework half of the audit. `resolveTestRunner` resolves VITEST;
 * a prover pointing it at a `bun:test` spec collects nothing and can only fail
 * (or, worse, pass a grep on empty output). Such a prover must resolve through
 * `resolveSpecRunner`, which dispatches per spec framework.
 *
 * @param {string} source prover source
 * @param {(spec: string) => string | undefined} readSpec returns a referenced
 *   spec's source, or undefined when the path does not resolve (not a finding
 *   here — dangling paths are another guard's subject).
 * @returns {string[]}
 */
export function auditSpecFrameworkMatch(source, readSpec) {
  const findings = [];
  const usesVitestResolver =
    /\bresolveTestRunner\s*\(/.test(source) && !/\bresolveSpecRunner\s*\(/.test(source);
  if (!usesVitestResolver) return findings;
  for (const spec of referencedSpecs(source)) {
    const specSource = readSpec(spec);
    if (specSource !== undefined && specFramework(specSource) === 'bun') {
      findings.push(
        `targets bun:test spec ${spec} through resolveTestRunner (vitest) — vitest collects nothing there; use resolveSpecRunner`,
      );
    }
  }
  return findings;
}

/* ────────────────────────────────────────────────────────────────────────────
 * #912 — ANCHOR LIVENESS
 *
 * A prover whose anchors no longer occur in their subjects proves nothing while
 * every PR body citing it still says PROVED. Two were in exactly that state on
 * the sprint-2 tip: `mutation-prove-install-smoke-coverage.mjs` aborts on the
 * first of TEN `{{ standalonePrefix }}` anchors ADR-0048 deleted, and
 * `mutation-prove-release-lane.mjs` ENOENTs on `pnpm-lock.yaml`. The nightly
 * reports both — once a night, after the fact. This makes it a PR-time finding.
 *
 * WHY STATIC. The dynamic answer already exists (each prover's own preflight),
 * and it costs a full prover run. The question "does this anchor still occur in
 * that file" is answerable from the source, and answering it in the PR is the
 * whole difference between a finding and a surprise.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It resolves the shapes provers actually use
 * — `join(ROOT, 'a', 'b')`, `resolve(...)`, a name bound to another resolved
 * name, and `snapshot(PATH)` — and it does NOT evaluate arbitrary expressions.
 * An argument it cannot resolve is returned in `unresolved` rather than dropped,
 * because a dropped anchor is indistinguishable from a live one in the summary,
 * which is how a static audit rots into decoration.
 * `tests/mutation-prover-lane.test.ts` asserts the resolved corpus stays large,
 * so an extractor that quietly stops extracting cannot pass as a clean tree.
 *
 * COVERAGE, MEASURED AND STATED RATHER THAN IMPLIED. Two of the eighteen provers
 * write `mutate(PATH, 'literal', …)` inline and are fully covered. The rest are
 * TABLE-DRIVEN — a `MUTATIONS` array of `{ apply: (checkOnly) => mutate(snap,
 * anchor, …) }` closures — so the anchor reaches `mutate` as a parameter and is
 * not statically resolvable without evaluating the table, which is most of
 * running the prover. Those are covered by the SECOND check below (every path a
 * prover resolves must exist, which is the `pnpm-lock.yaml` failure verbatim)
 * and, dynamically, by their own preflights. Claiming the anchor check covers
 * all eighteen would be the decoration this module exists to catch.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The `[start, end)` span of a balanced argument list starting at `open` (the
 * index of the `(`), or `undefined` if it never closes.
 *
 * Walks the BLANKED view so a bracket inside a string or comment cannot
 * unbalance the walk — the reason this is not a regex.
 *
 * @param {string} blanked
 * @param {number} open
 */
function argSpan(blanked, open) {
  let depth = 0;
  for (let i = open; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return { start: open + 1, end: i };
    }
  }
  return undefined;
}

/**
 * Split an argument list into top-level arguments, by comma.
 *
 * @param {string} blanked the blanked view, for finding the commas
 * @param {number} start
 * @param {number} end
 * @returns {Array<{ start: number, end: number }>}
 */
function splitArgs(blanked, start, end) {
  const out = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i++) {
    const c = blanked[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push({ start: from, end: i });
      from = i + 1;
    }
  }
  if (from < end) out.push({ start: from, end });
  return out;
}

/** Decode a single- or double-quoted JS literal's source into its value. */
function decodeLiteral(raw) {
  try {
    return JSON.parse(raw[0] === "'" ? `"${raw.slice(1, -1).replace(/"/g, '\\"')}"` : raw);
  } catch {
    return undefined;
  }
}

/**
 * The VALUE of an expression that is one or more quoted literals joined by `+`.
 *
 * `+`-concatenation is not an edge case: several provers assemble a long anchor
 * that way to stay inside the line length, and an audit that could not read
 * those would silently exempt the longest anchors — the ones most likely to
 * have drifted.
 *
 * @param {string} source
 * @param {string} blanked
 * @param {{ start: number, end: number }} span
 */
function literalValue(source, blanked, span) {
  const view = blanked.slice(span.start, span.end);
  const parts = [];
  let i = 0;
  while (i < view.length) {
    const c = view[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '+') {
      i += 1;
      continue;
    }
    if (c !== "'" && c !== '"') return undefined;
    const close = view.indexOf(c, i + 1);
    if (close === -1) return undefined;
    const value = decodeLiteral(source.slice(span.start + i, span.start + close + 1));
    if (value === undefined) return undefined;
    parts.push(value);
    i = close + 1;
  }
  return parts.length ? parts.join('') : undefined;
}

/** Roots a prover joins from. Their value is the repo root, i.e. the empty prefix. */
const PATH_ROOT_NAMES = new Set(['WT', 'REPO_ROOT', 'ROOT', 'REPO', 'repoRoot']);

/**
 * Every `const NAME = …` in the source that resolves to a repo-relative PATH.
 *
 * Resolved in two passes so a constant built from a LATER constant still lands;
 * a `snapshot(PATH)` binding inherits its target's path, because both prover
 * shapes in the tree must be audited and following only `mutate(PATH, …)` would
 * leave every snapshot-style prover unaudited while reporting clean.
 *
 * @param {string} source
 * @returns {Map<string, string>}
 */
function pathBindings(source) {
  const blanked = blankNonCode(source);
  const known = new Map();
  for (const name of PATH_ROOT_NAMES) known.set(name, '');

  /** Resolve one right-hand side to a path, or undefined. */
  const resolveRhs = (rhs) => {
    const trimmed = rhs.trim();
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed)) return known.get(trimmed);
    if (/^(['"])(?:[^\\]|\\.)*?\1$/.test(trimmed)) return decodeLiteral(trimmed);
    const call = /^(join|resolve|snapshot)\s*\(/.exec(trimmed);
    if (!call) return undefined;
    const blankedRhs = blankNonCode(trimmed);
    const span = argSpan(blankedRhs, blankedRhs.indexOf('('));
    if (!span) return undefined;
    const args = splitArgs(blankedRhs, span.start, span.end);
    const parts = [];
    for (const arg of args) {
      const piece = resolveRhs(trimmed.slice(arg.start, arg.end));
      if (piece === undefined) return undefined;
      parts.push(piece);
    }
    // `snapshot(PATH)` carries its target's path; join/resolve concatenate.
    if (call[1] === 'snapshot') return parts[0];
    return parts.filter((p) => p !== '').join('/');
  };

  for (let pass = 0; pass < 2; pass++) {
    const decl = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*/g;
    for (let m = decl.exec(blanked); m; m = decl.exec(blanked)) {
      const name = m[1];
      if (known.get(name) !== undefined) continue;
      // The RHS runs to the top-level `;`, found on the BLANKED view so a
      // semicolon inside a string cannot truncate it.
      let end = m.index + m[0].length;
      let depth = 0;
      for (; end < blanked.length; end++) {
        const c = blanked[end];
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') depth -= 1;
        else if (c === ';' && depth === 0) break;
      }
      const value = resolveRhs(source.slice(m.index + m[0].length, end));
      if (value !== undefined) known.set(name, value);
    }
  }
  for (const name of PATH_ROOT_NAMES) known.delete(name);
  return known;
}

/**
 * Audit one prover's anchors against the files they claim to anchor in.
 *
 * @param {string} source the prover's source
 * @param {(relPath: string) => string | undefined} readTarget returns the
 *   subject's contents, or `undefined` when the path does not resolve. A
 *   missing subject is a FINDING, not a skip: a prover pointed at a deleted
 *   file is the `pnpm-lock.yaml` case verbatim.
 * @returns {{ findings: string[], resolved: Array<{file: string, anchor: string, count: number}>, unresolved: string[] }}
 */
export function auditAnchorLiveness(source, readTarget) {
  const blanked = blankNonCode(source);
  const bindings = pathBindings(source);
  const findings = [];
  const resolved = [];
  const unresolved = [];

  const call = /(?<![.\w$])mutate\s*\(/g;
  for (let m = call.exec(blanked); m; m = call.exec(blanked)) {
    const span = argSpan(blanked, m.index + m[0].length - 1);
    if (!span) continue;
    const args = splitArgs(blanked, span.start, span.end);
    if (args.length < 2) continue;
    const targetExpr = source.slice(args[0].start, args[0].end).trim();
    const anchor = literalValue(source, blanked, args[1]);
    const file = bindings.get(targetExpr);
    if (anchor === undefined || file === undefined) {
      unresolved.push(
        `mutate(${targetExpr}, …) — ${anchor === undefined ? 'anchor is not a literal' : 'target does not resolve to a path'}`,
      );
      continue;
    }
    const contents = readTarget(file);
    if (contents === undefined) {
      findings.push(`anchors in ${file}, which does not exist: ${JSON.stringify(anchor)}`);
      continue;
    }
    const count = contents.split(anchor).length - 1;
    resolved.push({ file, anchor, count });
    if (count !== 1) {
      findings.push(
        `anchor occurs ${count} time(s) in ${file} (expected exactly 1): ${JSON.stringify(anchor.slice(0, 80))}`,
      );
    }
  }
  return { findings, resolved, unresolved };
}

/**
 * Every repo-relative path a prover binds to a constant, so callers can check
 * the subjects EXIST (#912).
 *
 * This is the half that reaches the table-driven provers the anchor check
 * cannot. `mutation-prove-release-lane.mjs` binds `pnpm-lock.yaml` and ENOENTs
 * on every run since the workspace moved to bun; the anchor never gets far
 * enough to be wrong, because the read fails first. A prover pointed at a
 * deleted file proves nothing regardless of how its anchors are spelled, and
 * that question needs no table evaluation at all.
 *
 * A SUBJECT IS SOMETHING THE PROVER READS. That qualifier is not tidiness, it
 * is what makes the check usable: provers legitimately name files that do not
 * exist yet and never should — `tests/__canary-*.test.ts` is WRITTEN by the
 * prover to prove the harness can see red, and the probe files
 * `mutation-prove-committed-transform-cache.mjs` plants are the mutations
 * themselves. Reporting those would produce eight noisy findings around the one
 * real one, and a check with a 9:1 noise ratio gets an allowlist and then gets
 * ignored. So a binding qualifies only if it reaches `readFileSync` or
 * `snapshot` — the two verbs that REQUIRE the file to be there already.
 *
 * @param {string} source
 * @returns {Array<{ name: string, path: string }>}
 */
export function proverPathBindings(source) {
  const code = blankNonCode(source);
  const isRead = (name) =>
    new RegExp(`(?:readFileSync|snapshot)\\s*\\(\\s*${name}\\s*[,)]`).test(code);
  return [...pathBindings(source)]
    .filter(([name, path]) => path !== '' && !/\s/.test(path) && path.includes('.') && isRead(name))
    .map(([name, path]) => ({ name, path }));
}
