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
 * EVERY initializer text assigned to `name` in this file.
 *
 * All of them, not the first: `image-prewarm-harness.test.ts` assigns `dir` in
 * four separate tests and also has a `dir: string = HARNESS` DEFAULT PARAMETER
 * sixty lines earlier, and `create-scaffold.test.ts` declares `(root: string) =>`
 * in a type before ever assigning `root`. First-match resolution classified both
 * on the wrong binding and reported 41 findings, none real. The caller reads the
 * list optimistically — one tmp-rooted assignment is enough — which is the
 * fail-open direction this scan takes everywhere it cannot be certain.
 *
 * @param {string} blanked
 * @param {string} raw
 * @param {string} name
 * @returns {string[]}
 */
function initializersOf(blanked, raw, name) {
  // `(?![=>])` excludes `==` AND `=>`: an arrow in a type position
  // (`(root: string) => string[]`) otherwise reads as an assignment to `root`.
  const decl = new RegExp(
    `(?:\\b(?:const|let|var)\\s+)?\\b${name}\\b\\s*(?::[^=;\\n]*)?=\\s*(?![=>])`,
    'g',
  );
  /** @type {string[]} */
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
    if (text) found.push(text);
  }
  return found;
}

/**
 * Where does this path expression root itself?
 *
 * @param {string} expr the RAW expression text
 * @param {string} blanked the whole file, blanked
 * @param {string} raw the whole file
 * @param {number} [depth] recursion budget for identifier resolution
 * @returns {'tmp'|'repo'|'unknown'}
 */
export function classifyPathExpr(expr, blanked, raw, depth = 0) {
  if (!expr || !expr.trim()) return 'unknown';
  if (TMP_ROOTED.test(expr)) return 'tmp';
  if (REPO_ROOTED.test(expr)) return 'repo';

  // An ABSOLUTE literal is somewhere deliberate; only a RELATIVE one is a
  // finding, because a relative path resolves against the process CWD, which
  // for this suite is the repo root.
  const literals = [...expr.matchAll(/['"]([^'"]*)['"]/g)].map((m) => m[1]);
  if (literals.some((l) => l.startsWith('/'))) return 'tmp';

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
      for (const init of initializersOf(blanked, raw, id)) {
        verdicts.add(classifyPathExpr(init, blanked, raw, depth + 1));
      }
    }
    // OPTIMISTIC: one tmp-rooted assignment acquits the name. A name assigned
    // both ways in one file is not evidence of a repo write.
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

  const record = (call, target, embedded) => {
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
    if (classifyPathExpr(expr, blanked, source) !== 'repo') return;
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
    if (target !== undefined) record(m[1], target, false);
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
      if (target !== undefined) record(m[1], target, true);
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
 * PAIRING IS FILE-LOCAL AND NAME-BASED. A directory removed by a helper in
 * another module reads as unpaired here — the safe direction, and the one that
 * keeps this readable. Anything the scan cannot bind to a name is reported as
 * `(unbound)` rather than dropped, because a dropped site is a leak the guard
 * promised to see.
 *
 * @param {string} source
 * @returns {{ binding: string }[]}
 */
export function unpairedTempDirs(source) {
  const blanked = blankNonCode(source);
  /** @type {{ binding: string }[]} */
  const found = [];
  for (const m of blanked.matchAll(/\bmkdtemp(?:Sync)?\s*\(/g)) {
    const binding = bindingBefore(blanked, m.index);
    if (binding === null) {
      found.push({ binding: '(unbound)' });
      continue;
    }
    const cleanup = new RegExp(`\\b(?:rmSync|rm|rmdirSync|rmdir)\\s*\\([^)]*\\b${binding}\\b`);
    if (!cleanup.test(blanked)) found.push({ binding });
  }
  return found;
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
