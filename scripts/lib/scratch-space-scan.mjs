/**
 * Scratch-space scanning: WHERE a test writes, and HOW LONG what it made lives.
 *
 * `tests/temp-dirs-outside-the-repo.test.ts` is the guard; this is its eyes. It
 * lives in `scripts/lib/*.mjs` for the same reason `blank-non-code.mjs` does —
 * one of its callers is a plain `node` prover, not a bun:test module.
 *
 * TWO HALVES, BECAUSE THE GUARD HAD ONLY ONE
 * ------------------------------------------
 * The guard shipped asserting LOCATION of `mkdtemp` prefixes and nothing else.
 * Both things it did not asserts have since bitten:
 *
 *  1. LOCATION, beyond mkdtemp (#918). `tests/tomatchobject-mutation-guard.test.ts`
 *     wrote two transient dot-prefixed `.ts` files into the repo's own `tests/`
 *     directory, via `node -e`. The bun suite runs files concurrently and
 *     TypeScript's `**\/*.ts` include never matches a dot-prefixed name, so
 *     `tests/root-typecheck-gate.test.ts` went red whenever its disk walk
 *     overlapped the scratch files' lifetime. The guard was green throughout:
 *     the write was a `writeFileSync`, not a `mkdtemp`, so nothing looked at it.
 *
 *  2. LIFETIME (#880's residual). A `mkdtemp` rooted correctly at `tmpdir()` and
 *     never removed still leaks — one directory per run, forever, on every
 *     machine that runs the suite. That is the same class of defect as the 2877
 *     repo-rooted fixture directories, moved one directory up and out of sight.
 *
 * WHY THE SCAN IS SHAPED THE WAY IT IS
 * ------------------------------------
 * `blankNonCode` blanks comment and literal CONTENTS while keeping quote
 * delimiters, so this module can work in two passes over one tokenization:
 *
 *   - the STRUCTURAL pass reads the blanked source, where a `writeFileSync` in a
 *     comment or in a fixture string cannot be reported;
 *   - the EMBEDDED pass reads the raw text INSIDE string literals, because the
 *     #918 write was `require('fs').writeFileSync(...)` inside a `node -e`
 *     argument, which the structural pass cannot see by construction.
 *
 * The embedded pass demands the `fs` receiver (`require('fs').writeFileSync`,
 * `fs.cpSync`, …) precisely so a regex source or a prose sentence that merely
 * NAMES a write call is not a finding. A guard that reports its own vocabulary
 * is a guard people learn to edit.
 *
 * CLASSIFICATION IS BINDING-AWARE, NOT NAME-AWARE. `join(repoRoot, …)` is an
 * offender in one file and correct in another: `tests/compat-window-fingerprint.test.ts`
 * calls its FIXTURE root `repoRoot`, and it is a `mkdtemp`. Matching the name
 * would report five findings there, none real — five findings of that kind is
 * how a guard teaches people to delete it. So an identifier is resolved to its
 * declaration and the declaration is classified; an identifier that cannot be
 * resolved (a parameter, a destructure, an import) is UNKNOWN and never an
 * offender. Fail-open on unknown is deliberate: this guard's job is to catch the
 * shape that shipped, not to litigate every path expression in the tree.
 */

import { blankNonCode } from './blank-non-code.mjs';

/**
 * Write calls and WHICH argument is the destination. Getting this wrong in the
 * obvious direction (always argument 0) reports `copyFileSync(resolve(REPO_ROOT,
 * 'x'), tmpTarget)` — reading a tracked file INTO scratch, the correct
 * direction — as a repo write. Two live call sites do exactly that.
 *
 * @type {Record<string, number>}
 */
export const WRITE_CALLS = Object.freeze({
  writeFileSync: 0,
  writeFile: 0,
  appendFileSync: 0,
  appendFile: 0,
  mkdirSync: 0,
  mkdir: 0,
  createWriteStream: 0,
  cpSync: 1,
  cp: 1,
  copyFileSync: 1,
  copyFile: 1,
  renameSync: 1,
  rename: 1,
  symlinkSync: 1,
  linkSync: 1,
});

/**
 * A path expression rooted at the temp directory — the ROOT itself, not a name
 * that merely resembles one.
 *
 * Deliberately narrower than the `\bTMP\b`-accepting regex the mkdtemp half of
 * the guard uses on a `mkdtemp` PREFIX. That one is matching an argument; this
 * one is classifying a destination, and a destination is routinely called `tmp`
 * while living wherever its binding says. Measured: the #918 destination is
 * literally `const tmp = resolve(repoRoot, 'tests/…')`, so the loose regex
 * acquitted the exact write this scan exists to catch. Aliases (`TMP`,
 * `loaderTmpRoot`) are handled by resolving the binding instead, which is
 * strictly better — it reads what the name was assigned, not what it is called.
 */
const TMP_ROOTED = /tmpdir|TMPDIR|tmp_?root/i;

/** Expressions that can only be rooted inside the checkout. */
const REPO_ROOTED = /import\.meta\.(url|dirname)|__dirname|process\.cwd\s*\(/;

/** Path-plumbing names that are never the ROOT of a path expression. */
const WRAPPERS = new Set([
  'JSON',
  'stringify',
  'String',
  'resolve',
  'join',
  'normalize',
  'relative',
  'format',
  'posix',
  'win32',
  'require',
  'fs',
  'fsp',
  'fsPromises',
  'promises',
  'await',
  'new',
  'URL',
  'fileURLToPath',
  'toString',
  'replace',
  'concat',
]);

/**
 * Split `text` on top-level commas, using the BLANKED twin for structure so a
 * comma inside a string cannot split an argument.
 *
 * @param {string} blanked
 * @param {string} raw
 * @returns {string[]}
 */
function splitArgs(blanked, raw) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  out.push(raw.slice(start));
  return out;
}

/**
 * The index just past the `)` closing the call whose `(` sits at `open`, or -1.
 *
 * @param {string} blanked
 * @param {number} open
 */
function matchParen(blanked, open) {
  let depth = 0;
  for (let i = open; i < blanked.length; i++) {
    if (blanked[i] === '(') depth++;
    else if (blanked[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * EVERY initializer assigned to `name` in this file, with its offset.
 *
 * All of them, not the first: `image-prewarm-harness.test.ts` assigns `dir` in
 * four separate tests and also has a `dir: string = HARNESS` DEFAULT PARAMETER
 * sixty lines earlier, and `create-scaffold.test.ts` declares `(root: string) =>`
 * in a type before ever assigning `root`. First-match resolution classified both
 * on the wrong binding and reported 41 findings, none real.
 *
 * The caller picks the NEAREST PRECEDING one — see `nearest` — which is the
 * closest a regex gets to scope. Reading them optimistically instead (any
 * tmp-rooted assignment acquits the name) was tried and MEASURED WRONG: it let
 * the reintroduced #918 mutation survive, because the file that carried the bug
 * binds `tmp` twice — once repo-rooted in the offending test and once at
 * `tmpdir()` in the test below it — and the second acquitted the first.
 *
 * @param {string} blanked
 * @param {string} raw
 * @param {string} name
 * @returns {{ at: number, text: string }[]}
 */
function initializersOf(blanked, raw, name) {
  // `(?![=>])` excludes `==` AND `=>`: an arrow in a type position
  // (`(root: string) => string[]`) otherwise reads as an assignment to `root`.
  const decl = new RegExp(
    `(?:\\b(?:const|let|var)\\s+)?${identifierPattern(name)}\\s*(?::[^=;\\n]*)?=\\s*(?![=>])`,
    'g',
  );
  /** @type {{ at: number, text: string }[]} */
  const found = [];
  for (const m of blanked.matchAll(decl)) {
    const from = m.index + m[0].length;
    // Bounded at the statement end. The root of a path expression is at the
    // front of the initializer, so an unbounded read would reach into the next
    // statement and classify on something unrelated.
    let to = from;
    let depth = 0;
    while (to < blanked.length) {
      const c = blanked[to];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth--;
      } else if ((c === ';' || c === '\n') && depth === 0) break;
      to++;
    }
    const text = raw.slice(from, to).trim();
    if (text) found.push({ at: m.index, text });
  }
  return found;
}

/**
 * A binding name, made safe to interpolate into a `RegExp`, with a JS-identifier
 * token boundary.
 *
 * `$` IS A LEGAL IDENTIFIER CHARACTER AND A REGEX ANCHOR, and interpolating a
 * name raw let a binding defeat the scan BY ITS NAME. Measured: `const tmp$ =
 * resolve(repoRoot, 'tests/.x.tmp.ts'); writeFileSync(tmp$, …)` — the literal
 * #918 shape — reported ZERO findings, because `\btmp$\b` anchors at
 * end-of-line and never matched the declaration, leaving the binding
 * unresolvable and therefore acquitted. The same trick defeated removal credit
 * and enrolment on the lifetime half.
 *
 * `\b` cannot express this boundary either way: it is defined over `\w`, which
 * excludes `$`, so `\b` is wrong at BOTH ends of a `$`-bearing identifier.
 * Lookarounds over `[\w$]` are the correct token boundary for JS.
 *
 * @param {string} name
 */
function identifierPattern(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(?<![\\w$])${escaped}(?![\\w$])`;
}

/** The outermost call of a path expression, when it is one of the two joiners. */
const OUTER_RESOLVE = /^\s*(?:path\s*\.\s*)?resolve\s*\(/;
const OUTER_JOIN = /^\s*(?:path\s*\.\s*)?join\s*\(/;

/**
 * The arguments of the outermost call in `expr`, as raw text.
 *
 * @param {string} expr
 * @returns {string[]}
 */
function outerArgs(expr) {
  const blanked = blankNonCode(expr);
  const open = blanked.indexOf('(');
  if (open === -1) return [];
  const close = matchParen(blanked, open);
  if (close === -1) return [];
  return splitArgs(blanked.slice(open + 1, close), expr.slice(open + 1, close)).map((a) =>
    a.trim(),
  );
}

/**
 * Every string literal's CONTENT in `expr`, backticks included.
 *
 * Backticks are not optional. Without them `` writeFileSync(`tests/.x.tmp.ts`, …) ``
 * — and its `${pid}`-suffixed twin, which is the shape a spec reaches for when it
 * needs a unique scratch name — yielded ZERO findings, while the single-quoted
 * spelling of the identical bug was the unit-tested case.
 *
 * @param {string} expr
 * @returns {string[]}
 */
function stringLiterals(expr) {
  return [...expr.matchAll(/(['"`])([\s\S]*?)\1/g)].map((m) => m[2]);
}

/**
 * When `expr` is a single string or template literal, the fixed text before its
 * first `${…}` hole — otherwise `null`.
 *
 * @param {string} expr
 * @returns {string | null}
 */
function staticPrefixOfLiteral(expr) {
  const m = expr.trim().match(/^(['"`])([\s\S]*)\1$/);
  if (!m) return null;
  const prefix = m[2].split('${')[0];
  return prefix.length > 0 ? prefix : null;
}

/**
 * The assignment in scope at `use`: the nearest one BEFORE it, or — when the
 * name is only assigned later, as a `beforeAll` does for a `let` a helper above
 * it reads — the nearest one after.
 *
 * @param {{ at: number, text: string }[]} inits
 * @param {number} use
 */
function nearest(inits, use) {
  const before = inits.filter((i) => i.at < use).sort((a, b) => b.at - a.at)[0];
  return before ?? inits.filter((i) => i.at >= use).sort((a, b) => a.at - b.at)[0] ?? null;
}

/**
 * Where does this path expression root itself?
 *
 * @param {string} expr the RAW expression text
 * @param {string} blanked the whole file, blanked
 * @param {string} raw the whole file
 * @param {{ at?: number, depth?: number }} [where] `at` is the offset the
 *   expression is USED at, which is what makes "the nearest preceding
 *   assignment" meaningful; `depth` is the recursion budget.
 * @returns {'tmp'|'repo'|'unknown'}
 */
export function classifyPathExpr(expr, blanked, raw, where = {}) {
  const { at = blanked.length, depth = 0 } = where;
  if (!expr || !expr.trim()) return 'unknown';
  if (TMP_ROOTED.test(expr)) return 'tmp';
  if (REPO_ROOTED.test(expr)) return 'repo';

  // WHICH ARGUMENT IS THE ROOT. `join(a, b)` roots at `a`; only `resolve(a, b)`
  // lets a LATER argument take over, and it does so only when that argument is
  // absolute. Conflating the two is not academic: `join(root, '/tests/x')` is
  // `root/tests/x`, not `/tests/x`, so treating any absolute-looking literal as
  // "somewhere deliberate" acquits every repo write whose relative segment
  // happens to be spelled with a leading slash.
  const outer = OUTER_RESOLVE.test(expr) ? 'resolve' : OUTER_JOIN.test(expr) ? 'join' : 'none';
  const rootArg = outer === 'none' ? expr : outerArgs(expr)[0];

  // ABSOLUTE. Under `resolve` the LAST absolute argument wins, so any of them
  // acquits; under `join` — and for a bare literal — only the root can be
  // absolute, and a leading slash anywhere else is just a segment separator.
  //
  // TOP-LEVEL ARGUMENTS ONLY, and only where the argument IS a literal. Reading
  // every literal in the expression would let one nested deep inside a subpath
  // (`resolve(root, join(x, '/seg'))`) acquit the whole destination — the same
  // "a slash anywhere means absolute" mistake one level down.
  const absolute = (text) => (staticPrefixOfLiteral(text) ?? '').startsWith('/');
  if (outer === 'resolve' && outerArgs(expr).some(absolute)) return 'tmp';
  if (outer !== 'resolve' && rootArg !== undefined && absolute(rootArg)) return 'tmp';

  // THE ROOT IS A LITERAL, and it is relative — the destination is inside the
  // CWD, which for this suite is the repo root.
  //
  // Reads the STATIC PREFIX so a template literal is judged on the part that is
  // actually fixed: `` `tests/.x-${pid}.tmp.ts` `` roots at `tests/` whatever
  // `pid` turns out to be, and reporting it does not depend on resolving the
  // hole. A literal that STARTS with a hole (`` `${dir}/x.ts` ``) has no static
  // root, so it falls through to the identifier resolution below.
  //
  // DEPTH 0 ONLY. A relative literal reached through an identifier is not a
  // destination, it is a fragment: `asset-upload.test.ts` builds a path from
  // `const staticNs = "_next/static/"`, and applying this rule at depth reported
  // that namespace constant as a repo write in two files.
  if (depth === 0 && rootArg !== undefined) {
    const staticRoot = staticPrefixOfLiteral(rootArg);
    if (staticRoot) return 'repo';
  }

  const literals = stringLiterals(expr);

  // MODULE QUALIFIERS ONLY, stripped as `x.` prefixes rather than listed as
  // wrapper NAMES: `path` was in the wrapper set, and `mkdir(join(path, '..'))`
  // — where `path` is a for-of binding over real destinations — then had no
  // identifiers left and was judged on its `'..'` literal alone. A false
  // positive built out of the guard's own vocabulary.
  // Identifiers come from the BLANKED expression: read raw, `'tests/x.tmp.ts'`
  // yields four "identifiers" out of its own path segments, none of which
  // resolves, and the expression is then judged UNKNOWN — which acquits the
  // plainest form of the bug, a bare relative destination.
  const stripped = blankNonCode(expr).replace(/\b(?:path|fs|fsp|fsPromises|JSON|os)\s*\.\s*/g, '');
  const identifiers = [...stripped.matchAll(/[A-Za-z_$][\w$]*/g)]
    .map((m) => m[0])
    .filter((id) => !WRAPPERS.has(id));
  if (depth < 3) {
    /** @type {Set<'tmp'|'repo'|'unknown'>} */
    const verdicts = new Set();
    for (const id of identifiers) {
      const init = nearest(initializersOf(blanked, raw, id), at);
      if (init) {
        verdicts.add(classifyPathExpr(init.text, blanked, raw, { at: init.at, depth: depth + 1 }));
      }
    }
    // `tmp` wins a TIE between two different identifiers in one expression
    // (`join(scratchRoot, repoRelativeName)`), which is the fail-open direction
    // this scan takes wherever it is not certain. It is not an override of the
    // nearest-assignment rule above: that rule already picked ONE initializer
    // per name.
    if (verdicts.has('tmp')) return 'tmp';
    if (verdicts.has('repo')) return 'repo';
  }
  if (identifiers.length > 0) return 'unknown';

  // No identifier at all: the destination IS the literal, and it is relative —
  // which resolves against the process CWD, the repo root for this suite.
  //
  // DEPTH 0 ONLY. A relative literal reached through an identifier is not a
  // destination, it is a fragment: `asset-upload.test.ts` builds a path from
  // `const staticNs = "_next/static/"`, and applying this rule at depth reported
  // that namespace constant as a repo write in two files.
  if (depth > 0) return 'unknown';
  return literals.some((l) => l.length > 0) ? 'repo' : 'unknown';
}

/**
 * Every write whose destination resolves inside the checkout.
 *
 * @param {string} source
 * @returns {{ call: string, target: string, embedded: boolean }[]}
 */
export function repoRootedWrites(source) {
  const blanked = blankNonCode(source);
  /** @type {{ call: string, target: string, embedded: boolean }[]} */
  const found = [];

  const record = (call, target, embedded, at) => {
    // INSIDE a `node -e` string, `__dirname` and `process.cwd()` belong to the
    // CHILD, not to the spec — `tests/e2e-deploy.contract.test.ts` writes
    // `path.join(__dirname, 'HOSTNAME_AT_BOOT')` from a script that lives in a
    // temp app directory. The only text in an embedded command that refers to
    // the SPEC's scope is a `${…}` hole, so embedded classification reads the
    // holes and nothing else.
    const expr = embedded
      ? [...target.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]).join(' ')
      : target;
    if (!expr.trim()) return;
    if (classifyPathExpr(expr, blanked, source, { at }) !== 'repo') return;
    found.push({ call, target: target.replace(/\s+/g, ' ').trim().slice(0, 80), embedded });
  };

  // PASS 1 — structural, over blanked source.
  const names = Object.keys(WRITE_CALLS).join('|');
  for (const m of blanked.matchAll(new RegExp(`\\b(${names})\\s*\\(`, 'g'))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(blanked, open);
    if (close === -1) continue;
    const args = splitArgs(blanked.slice(open + 1, close), source.slice(open + 1, close));
    const target = args[WRITE_CALLS[m[1]]];
    if (target !== undefined) record(m[1], target, false, m.index);
  }

  // PASS 2 — embedded, over the RAW text inside string literals. `blankNonCode`
  // keeps the delimiters, so a literal is the span between two surviving quote
  // characters of the same kind.
  const receiver = `(?:require\\s*\\(\\s*['"](?:node:)?fs(?:/promises)?['"]\\s*\\)|\\bfsp?|\\bfsPromises)\\s*\\.\\s*`;
  for (const [from, to] of literalSpans(blanked)) {
    const text = source.slice(from, to);
    for (const m of text.matchAll(new RegExp(`${receiver}(${names})\\s*\\(`, 'g'))) {
      const rest = text.slice(m.index + m[0].length);
      const target = splitArgs(blankNonCode(rest), rest)[WRITE_CALLS[m[1]]];
      if (target !== undefined) record(m[1], target, true, from + m.index);
    }
  }

  return found;
}

/**
 * The spans between surviving quote delimiters — i.e. literal CONTENTS in the
 * original source. Comment bodies have no surviving delimiters (their quotes
 * were blanked with everything else), so they cannot appear here.
 *
 * @param {string} blanked
 * @returns {[number, number][]}
 */
function literalSpans(blanked) {
  /** @type {[number, number][]} */
  const spans = [];
  for (let i = 0; i < blanked.length; i++) {
    const c = blanked[i];
    if (c !== "'" && c !== '"' && c !== '`') continue;
    const end = blanked.indexOf(c, i + 1);
    if (end === -1) break;
    spans.push([i + 1, end]);
    i = end;
  }
  return spans;
}

/**
 * Every `mkdtemp` whose directory is never removed in the same file.
 *
 * PAIRING IS COUNTED, NOT EXISTENTIAL. "Is there an `rmSync(dir)` anywhere in
 * this file" is what the first version asked, and it is the same defeat as the
 * write half's optimistic name resolution: `cli-node-runtime.test.ts` creates
 * NINE directories called `dir` and removes ONE, and reported zero leaks —
 * appending a tenth same-named leak kept it green, while a leak under a fresh
 * name reddened. One cleanup cannot discharge nine creations, so n creations
 * bound to a name require n removals naming it.
 *
 * PAIRING IS ALSO FILE-LOCAL. A directory removed by a helper in another module
 * reads as unpaired — the safe direction. Anything the scan cannot bind to a
 * name is reported as `(unbound)` rather than dropped, because a dropped site is
 * a leak the guard promised to see.
 *
 * @param {string} source
 * @returns {{ binding: string }[]}
 */
export function unpairedTempDirs(source) {
  const blanked = blankNonCode(source);
  /** @type {{ binding: string }[]} */
  const found = [];
  /** @type {Map<string, number>} */
  const created = new Map();

  for (const m of blanked.matchAll(/\bmkdtemp(?:Sync)?\s*\(/g)) {
    const binding = bindingBefore(blanked, m.index);
    if (binding === null) found.push({ binding: '(unbound)' });
    else created.set(binding, (created.get(binding) ?? 0) + 1);
  }

  // A REGISTRY discharges the sites that are actually ENROLLED in it — no more.
  // The first version discharged every same-named creation once ONE was pushed,
  // and matched its `rm` leg against any removal anywhere in the file: five
  // unregistered `dir` leaks appended to `e2e-deploy.port-ownership.test.ts`
  // reported ZERO, and a push beside an unrelated `rmSync(someOtherFile)` also
  // reported zero. Credit is now COUNTED like every other removal, and the `rm`
  // has to be over the registry's own elements.
  const drained = drainedRegistries(blanked);

  for (const [name, creations] of created) {
    const credit =
      directRemovals(blanked, name, drained.spans) + enrolments(blanked, name, drained.names);
    for (let i = credit; i < creations; i++) found.push({ binding: name });
  }
  return found;
}

/**
 * Every rm-shaped call's FIRST argument, with the call's offset.
 *
 * The offset is load-bearing: a drained registry's own `rmSync(d)` has to be
 * EXCLUDED from direct credit, and telling it apart from a real direct removal
 * is positional — both spell the same text.
 *
 * @param {string} text
 * @returns {{ at: number, arg: string }[]}
 */
function removalFirstArgs(text) {
  /** @type {{ at: number, arg: string }[]} */
  const args = [];
  for (const m of text.matchAll(/\b(?:rmSync|rm|rmdirSync|rmdir)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(text, open);
    if (close === -1) continue;
    const inner = text.slice(open + 1, close);
    args.push({ at: m.index, arg: splitArgs(inner, inner)[0]?.trim() ?? '' });
  }
  return args;
}

/**
 * Does this removal argument remove `name` ITSELF?
 *
 * `fs.rm(join(root, '.next', 'BUILD_ID'))` removes a FILE INSIDE `root` and
 * leaves the directory exactly where it was — `asset-upload.test.ts:120` does
 * precisely that and never removes `root`, and a substring match credited it as
 * a cleanup. So the binding must BE the path, not a component of one.
 *
 * @param {string} arg
 * @param {string} name
 */
function removesBindingItself(arg, name) {
  return new RegExp(
    `^(?:await\\s+)?(?:(?:path\\s*\\.\\s*)?(?:resolve|join|normalize)\\s*\\(\\s*)?${identifierPattern(
      name,
    )}\\s*\\)?$`,
  ).test(arg.trim());
}

/**
 * How many removals name this binding as the thing being removed.
 *
 * DRAIN BODIES ARE EXCLUDED. `for (const d of tempDirs) rmSync(d)` is credited
 * once per ENROLMENT, via `enrolments`; counting it here as well hands a second,
 * unearned credit to any creation that happens to share the loop element's name.
 * Measured: a leak named `d` in `e2e-deploy.port-ownership.test.ts` — whose drain
 * element IS `d` — SURVIVED, while the identical leak named `dir` reddened.
 *
 * EXCLUSION IS BY ELEMENT NAME, NOT BY NAMED REGISTRY. The two concerns come
 * apart, and conflating them left a residual of this same class: a drain over an
 * ARRAY LITERAL (`for (const d of [appDir]) rmSync(d, …)`, live in
 * `e2e-deploy.contract.test.ts`) has no registry identifier to enrol into, so it
 * was not recognised as a drain at all and its `rmSync(d)` went on crediting any
 * creation named `d`. Enrolment needs the registry's NAME; exclusion needs only
 * the element name and the body span.
 *
 * @param {string} blanked
 * @param {string} name
 * @param {[number, number][]} drainSpans
 */
function directRemovals(blanked, name, drainSpans) {
  return removalFirstArgs(blanked).filter(
    ({ at, arg }) =>
      removesBindingItself(arg, name) && !drainSpans.some(([from, to]) => at >= from && at < to),
  ).length;
}

/**
 * Iterations that `rm` their OWN elements: the spans of their bodies (every such
 * loop, whatever it iterates) and the NAMES of the registries drained (only the
 * ones iterating a plain identifier, which is what `A.push(x)` can enrol into).
 *
 * @param {string} blanked
 * @returns {{ names: Set<string>, spans: [number, number][] }}
 */
function drainedRegistries(blanked) {
  /** @type {Set<string>} */
  const names = new Set();
  /** @type {[number, number][]} */
  const spans = [];

  // `for (const d of tempDirs) rmSync(d, …)` — and equally `of [appDir]`, `of
  // Object.values(x)`, or any other iterable. The header is paren-matched rather
  // than pattern-matched so the iterable's SHAPE cannot decide whether the loop
  // is seen at all.
  for (const m of blanked.matchAll(
    /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+/g,
  )) {
    const element = m[1];
    const headerOpen = blanked.lastIndexOf('(', m.index + 5);
    const headerClose = matchParen(blanked, headerOpen);
    if (headerClose === -1) continue;
    const iterable = blanked.slice(m.index + m[0].length, headerClose).trim();
    const [from, to] = bodySpanAfter(blanked, headerClose + 1);
    if (
      removalFirstArgs(blanked.slice(from, to)).some(({ arg }) =>
        removesBindingItself(arg, element),
      )
    ) {
      // The registry is the iterable's ROOT identifier, so a drain that reads
      // the array through an accessor still enrols: `doctor.test.ts` drains with
      // `for (const d of dirs.splice(0))`, and requiring a BARE identifier here
      // credited nothing while the span suppressed the direct removal — turning
      // a correctly-cleaned directory into a false finding. An array LITERAL
      // (`of [appDir]`) has no root identifier and contributes a span only,
      // which is right: nothing can be pushed onto a literal.
      const registry = iterable.match(/^([A-Za-z_$][\w$]*)\b/)?.[1];
      if (registry) names.add(registry);
      spans.push([from, to]);
    }
  }

  // `tempDirs.forEach((d) => rmSync(d, …))`
  for (const m of blanked.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*\.\s*forEach\s*\(\s*(?:\(\s*([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*=>)/g,
  )) {
    const element = m[2] ?? m[3];
    const open = blanked.indexOf('(', m.index + m[1].length);
    const close = matchParen(blanked, open);
    if (close === -1 || !element) continue;
    if (
      removalFirstArgs(blanked.slice(open, close + 1)).some(({ arg }) =>
        removesBindingItself(arg, element),
      )
    ) {
      names.add(m[1]);
      spans.push([open, close + 1]);
    }
  }
  return { names, spans };
}

/**
 * The ABSOLUTE span of the statement or block that follows `index` — a loop's
 * body. Absolute rather than a slice, because the caller needs to exclude these
 * offsets from direct-removal credit.
 *
 * @param {string} blanked
 * @param {number} index
 * @returns {[number, number]}
 */
function bodySpanAfter(blanked, index) {
  const rest = blanked.slice(index);
  const braceAt = rest.search(/\S/);
  if (rest[braceAt] !== '{') {
    const end = rest.indexOf(';');
    return [index, end === -1 ? blanked.length : index + end + 1];
  }
  let depth = 0;
  for (let i = braceAt; i < rest.length; i++) {
    if (rest[i] === '{') depth++;
    else if (rest[i] === '}') {
      depth--;
      if (depth === 0) return [index + braceAt, index + i + 1];
    }
  }
  return [index, blanked.length];
}

/**
 * How many creations of `name` are ENROLLED in a drained registry — counted, so
 * one `temps.push(dir)` cannot discharge six unregistered `dir` creations.
 *
 * @param {string} blanked
 * @param {string} name
 * @param {Set<string>} drained
 */
function enrolments(blanked, name, drained) {
  let n = 0;
  for (const m of blanked.matchAll(
    new RegExp(
      `([A-Za-z_$][\\w$]*)\\s*\\.\\s*push\\s*\\(\\s*${identifierPattern(name)}\\s*\\)`,
      'g',
    ),
  )) {
    if (drained.has(m[1])) n += 1;
  }
  return n;
}

/**
 * The name the call at `index` is assigned to, or null.
 *
 * @param {string} blanked
 * @param {number} index
 */
function bindingBefore(blanked, index) {
  let k = index - 1;
  while (k >= 0 && !';{}\n'.includes(blanked[k])) k--;
  const stmt = blanked.slice(k + 1, index);
  const m = stmt.match(
    /(?:^|[(,=]|\b(?:const|let|var)\s+)\s*([A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=\s*(?:await\s+)?[^=]*$/,
  );
  return m ? m[1] : null;
}

/** How many `mkdtemp` call sites the scan saw — the non-vacuity half. */
export function countTempDirSites(source) {
  return [...blankNonCode(source).matchAll(/\bmkdtemp(?:Sync)?\s*\(/g)].length;
}
