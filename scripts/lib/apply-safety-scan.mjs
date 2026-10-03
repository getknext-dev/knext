/**
 * Apply-safety scanner (#1289, #1410 round 4): fail CLOSED on any
 * `kubectl apply|create|replace -f/-k` whose input cannot be proven to be
 * either (a) a local file that was checksum-verified (`sha256sum -c` against
 * a checksum line naming THAT file) on a path that dominates the apply, or
 * (b) content with no network provenance at all (a repo-committed file, a
 * literal heredoc, a local render).
 *
 * WHY A LEXER AND NOT REGEXES
 * ---------------------------
 * Three review rounds each found a spelling the previous regex set missed:
 * a folded `run: >` block collapsing fetch-then-apply onto one line, `-fsSLo`,
 * `--output=`, `> f`, `wget`, a curl-wrapping helper, `URL=…; apply -f "$URL"`,
 * a brand-new `.sh` anywhere in the tree, `-f-`, `create -f -`, `-f <(curl …)`,
 * `|| exit 0`, `set +e`, `if ! fetch …`. Each was an ENUMERATION gap. This
 * module scans structure instead:
 *
 *   - the apply is found by its VERB (`apply|create|replace` followed by a
 *     `-f`/`--filename`/`-k`/`--kustomize` flag), never by the literal word
 *     `kubectl` — so `$K apply`, `K apply`, `kc apply`, `retry 4 K apply` and
 *     `"$KUBECTL" --context x apply` are all the same thing;
 *   - a fetch is found by its command word (curl/wget/aria2c/gh api|release
 *     download/an interpreter with fetch()/urllib/requests) anywhere in a
 *     pipeline, and EVERY file the clause writes (any -o spelling, redirect,
 *     tee, cp/mv destination) becomes network-tainted — over-approximating
 *     written files only ever makes the scan stricter;
 *   - a checksum only counts when it DOMINATES the apply: errexit on, not the
 *     test of an if/while/until, not negated, not `||`-guarded, not
 *     backgrounded, the WHOLE of its `&&` chain (or earlier in the SAME
 *     all-`&&` chain as the apply), and inside a control block that encloses
 *     the apply;
 *   - function calls are INLINED with their arguments substituted, so a
 *     helper that wraps curl — or wraps `kubectl apply -f "$1"` — is judged at
 *     the call site; `bash -c`/`sh -c`/`eval` strings are re-scanned as shell;
 *   - anything the scanner cannot classify (a top-level `-f -` with no
 *     producer, a GitHub `${{ }}` expression as the target, an unterminated
 *     heredoc, a `shift`ing helper that fetches or applies, recursion too
 *     deep) is reported, never passed;
 *   - (round 5) a remote fetch whose writes the walk cannot follow — an
 *     interpreter's in-process fetch, `git clone`, `gh release download`,
 *     helm charts/repos, `curl | sh`, `bash <(curl …)` — is an "unclassified
 *     remote fetch" unless it is on the exactly-once REMOTE_FETCH_ALLOWLIST;
 *     a heredoc fed to a shell (locally, `ssh host`, `docker exec -i c sh`)
 *     is walked as a script; a `source`d file's functions are followed, and
 *     when it cannot be read a URL-taking call fails closed;
 *   - (round 5) a workflow step's errexit comes from its EFFECTIVE shell
 *     (step, job or workflow `defaults.run.shell`), a non-POSIX shell is
 *     unclassifiable, and a checksum in a `continue-on-error` or `if:` step
 *     does not cover later steps.
 *
 * Exports are pure (text in, offender strings out) so the spec can drive them
 * with fixtures and the mutation prover can break each rule independently.
 */

import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { scanFrames } from './shell-lexer.mjs';

/** Commands whose output is network content. */
const FETCH_WORDS = new Set(['curl', 'wget', 'aria2c', 'http', 'https', 'xh', 'httpie']);
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl']);
// #1787: `fetch` has NO trailing `\(` here (unlike every prior revision) —
// a bare reference to the identifier (`const f = fetch;`, `obj.fn = fetch`)
// is just as fetch-capable as a direct call, and the previous `fetch\(`
// spelling only matched the call form, missing the alias. The other API
// names below were never call-shaped in the first place (`https?\.get`,
// `http\.request` already match an alias like `const g = https.get;`
// without any change) — only `fetch` had the asymmetry.
//
// The boundary is `(?<![\w-])fetch(?![\w-])`, NOT plain `\bfetch\b` — a
// bare `\b` word boundary sits on either side of a hyphen too (`-` is a
// non-word character), so it matches the real tree's `--fetch` CLI flag
// (`compat-window-audit.mjs --fetch --matrix`) and kebab-case substrings
// (`bun-sandbox-fetch-ab`, `normal-fetch`) that are not the `fetch` API at
// all. Excluding an adjacent hyphen on EITHER side keeps those out while
// still matching every real shape: a call (`fetch(`), an alias (`= fetch;`,
// `, fetch,`), and a plain identifier use anywhere code, not string, text
// would spell it.
// #1801 round 3 (fix 4): `https?\.request` (was `http\.request` — missing
// `https.request`), `undici.request`/`undici.fetch` (the namespace-import
// shape of the same API `undici` ships, since `import { fetch } from
// 'undici'` already falls through to the bare `fetch` clause above), and
// `require('undici'|'node:https'|'node:http'|'https'|'http').request` (the
// CommonJS form of the same module, where no bare `http`/`https` identifier
// is ever bound to catch via the property-access clauses alone).
// #1801 (final round): `.get` added alongside `.request` — `require('https').get`
// is the CommonJS direct-chain form of the same shape `https?\.get` already
// matches when an identifier is bound (`const h = https; h.get`), but the
// chained call never binds an identifier at all.
const REQUIRE_FETCH_MODULE_RE =
  /require\(\s*['"`](?:undici|node:https|node:http|https|http)['"`]\s*\)\s*\.\s*(?:request|get)\b/;
export const INTERPRETER_FETCH = new RegExp(
  [
    '(?<![\\w-])fetch(?![\\w-])',
    'urllib',
    'requests\\.',
    'https?\\.get',
    'https?\\.request',
    'undici\\s*\\.\\s*(?:request|fetch)\\b',
    REQUIRE_FETCH_MODULE_RE.source,
    'open-uri',
    'Net::HTTP',
    'LWP',
    // #1801 (final round): raw sockets — net.connect/tls.connect open a
    // network connection this scanner otherwise never classifies as a fetch
    // shape at all (neither is HTTP-shaped, so none of the clauses above
    // would ever match).
    'net\\s*\\.\\s*connect\\b',
    'tls\\s*\\.\\s*connect\\b',
    // #1801 (final round): Python's stdlib HTTP client — `http.client.
    // HTTPConnection(...)` — distinct from the `https?\.get`/`.request`
    // clauses above, which only match a `.get`/`.request` call, not `.client`.
    'http\\.client\\b',
  ].join('|'),
);
const APPLY_VERBS = new Set(['apply', 'create', 'replace']);
const EXEC_STRING_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const URL_RE = /\bhttps?:\/\//;
const MANIFEST_RE = /\.(ya?ml|json)$/i;
const MAX_DEPTH = 6;
/** Any remote scheme a fetcher (git/helm/an interpreter) can be handed. */
const REMOTE_ARG_RE = /^(https?|oci|git|ssh|s3|gs):\/\/|^git@/;
/**
 * Commands that never fetch, so a URL argument to one is text, not a
 * download — only consulted for the "call into an unresolved sourced file"
 * rule, which otherwise treats every URL-taking call as a possible fetch.
 */
const NON_FETCHING = new Set([
  'echo',
  'printf',
  'log',
  'info',
  'warn',
  'die',
  'fail',
  'ok',
  'bad',
  'note',
  'step',
  'kubectl',
  'export',
  'local',
  'test',
  '[',
  '[[',
]);

// ---------------------------------------------------------------------------
// Lexing — one frame-stack scanner shared by every splitter
// ---------------------------------------------------------------------------

// #1444 step 1: the core frame-stack walk moved to `shell-lexer.mjs`, the
// shared module both this file and (eventually — see that module's header
// for what remains TODO) `tests/helpers/shell-statements.ts` are meant to
// import instead of each carrying their own. Re-exported here (imported at
// the top of this file) so every existing importer of `scanFrames` from
// THIS file keeps working unchanged.
export { scanFrames };

/**
 * Pre-pass over raw shell text: extracts heredoc bodies (replacing each
 * `<<DELIM` with `<<__HD<n>__`), drops comments, joins `\`-newline
 * continuations, and joins a line ending in `|`, `&&` or `||` with the next.
 * `error` is set on an unterminated heredoc or unbalanced quoting — the
 * caller reports it rather than scanning a mis-parse (fail closed).
 */
export function lex(raw) {
  const text = raw.replace(/\r\n?/g, '\n');
  const heredocs = [];
  const pendingHd = [];
  let out = '';
  let error = null;
  let copyFrom = 0;
  const flush = (to) => {
    out += text.slice(copyFrom, to);
  };
  const frames = scanFrames(text, (i, _depth, frame) => {
    const c = text[i];
    if (c === '\\' && text[i + 1] === '\n' && frame !== 'sq' && frame !== 'sqa') {
      flush(i);
      copyFrom = i + 2;
      return i + 2;
    }
    if (frame !== 'code') return undefined;
    if (c === '#' && (i === 0 || /[\s;|&()]/.test(text[i - 1]))) {
      flush(i);
      let j = i;
      while (j < text.length && text[j] !== '\n') j++;
      copyFrom = j;
      return j;
    }
    if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<' && text[i - 1] !== '<') {
      const m = text.slice(i).match(/^<<(-?)[ \t]*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/);
      if (m) {
        flush(i);
        const id = heredocs.length;
        heredocs.push({ delim: m[3], quoted: m[2] !== '', body: '' });
        pendingHd.push(id);
        out += `<<__HD${id}__`;
        copyFrom = i + m[0].length;
        return copyFrom;
      }
      if (/^<<-?[ \t]*\$?['"]/.test(text.slice(i))) {
        error = error ?? 'unparseable heredoc opener';
      }
    }
    if (c === '\n' && pendingHd.length > 0) {
      flush(i + 1);
      let j = i + 1;
      while (pendingHd.length > 0) {
        const hd = heredocs[pendingHd.shift()];
        const lines = [];
        let found = false;
        while (j < text.length) {
          const nl = text.indexOf('\n', j);
          const line = nl === -1 ? text.slice(j) : text.slice(j, nl);
          j = nl === -1 ? text.length : nl + 1;
          if (line.replace(/^\t+/, '').trim() === hd.delim) {
            found = true;
            break;
          }
          lines.push(line);
        }
        hd.body = lines.join('\n');
        if (!found) error = error ?? `unterminated heredoc <<${hd.delim}`;
      }
      copyFrom = j;
      return j;
    }
    return undefined;
  });
  flush(text.length);
  if (pendingHd.length > 0) error = error ?? 'heredoc with no body';
  if (frames !== 1) error = error ?? 'unbalanced quoting or substitution';
  const code = out.replace(/(\|\||&&|\|)[ \t]*\n/g, '$1 ');
  return { code, heredocs, error };
}

/**
 * Splits code into clauses at top-level `\n`, `;`, `;;`, `&&`, `||`, `&`.
 * `( … )` and `{ …; }` groups stay whole (the walker recurses into them).
 * Each clause records the separator before and after it.
 */
export function splitClauses(code) {
  const clauses = [];
  let start = 0;
  let braces = 0;
  // A compound command (`if…fi`, `while…done`, `case…esac`) that is a
  // STAGE of a pipeline (`sed … | if …; then awk; else cat; fi | apply -f -`)
  // must stay inside its clause, or its `;`s cut the pipeline in two.
  let sawPipe = false;
  let pipeCompound = 0;
  let sepBefore = 'start';
  const push = (end, sepAfter, next) => {
    const t = code.slice(start, end).trim();
    if (t) clauses.push({ text: t, sepBefore, sepAfter });
    if (t || sepAfter === '\n' || sepAfter === ';') sepBefore = sepAfter;
    start = next;
    sawPipe = false;
  };
  scanFrames(code, (i, depth, frame) => {
    if (depth !== 0 || frame !== 'code') return undefined;
    const c = code[i];
    const prev = code[i - 1] ?? '\n';
    const next = code[i + 1] ?? '\n';
    if (c === '|' && next !== '|' && prev !== '|' && prev !== '>') sawPipe = true;
    if (/[\s;|&(]/.test(prev) && /[a-z]/.test(c)) {
      const word = code.slice(i, i + 7).match(/^[a-z]+(?=[\s;]|$)/)?.[0];
      if (word && /^(if|case|while|until|for|select)$/.test(word) && (sawPipe || pipeCompound > 0))
        pipeCompound++;
      else if (word && /^(fi|esac|done)$/.test(word) && pipeCompound > 0) pipeCompound--;
    }
    if (c === '{' && /\s/.test(next) && /[\s;&|(]/.test(prev)) braces++;
    else if (c === '}' && braces > 0 && /[\s;]/.test(prev) && /[\s;)|&]/.test(next)) braces--;
    if (braces > 0 || pipeCompound > 0) return undefined;
    const two = code.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      push(i, two, i + 2);
      return i + 2;
    }
    if (two === ';;') {
      push(i, ';', i + 2);
      return i + 2;
    }
    if (c === '\n' || c === ';') {
      push(i, c, i + 1);
      return i + 1;
    }
    if (c === '&' && prev !== '>' && next !== '>' && prev !== '<') {
      push(i, '&', i + 1);
      return i + 1;
    }
    return undefined;
  });
  push(code.length, 'end', code.length);
  return clauses;
}

/** Splits a clause into pipeline segments at top-level single `|` (and `|&`). */
export function splitPipeline(clause) {
  const segs = [];
  let start = 0;
  scanFrames(clause, (i, depth, frame) => {
    if (depth !== 0 || frame !== 'code' || clause[i] !== '|') return undefined;
    if (clause[i + 1] === '|' || clause[i - 1] === '|' || clause[i - 1] === '>') return undefined;
    segs.push(clause.slice(start, i).trim());
    const skip = clause[i + 1] === '&' ? 2 : 1;
    start = i + skip;
    return i + skip;
  });
  segs.push(clause.slice(start).trim());
  return segs.filter(Boolean);
}

/** Splits a segment into words at top-level whitespace; quotes are kept. */
export function words(seg) {
  const out = [];
  let start = -1;
  scanFrames(seg, (i, depth) => {
    const ws = /\s/.test(seg[i]) && depth === 0;
    if (ws && start !== -1) {
      out.push(seg.slice(start, i));
      start = -1;
    } else if (!ws && start === -1) start = i;
    return undefined;
  });
  if (start !== -1) out.push(seg.slice(start));
  return out;
}

/** Removes the top-level quoting of a word (quotes inside `$(…)` are left alone). */
export function unquote(w) {
  let s = '';
  scanFrames(w, (i, depth, frame) => {
    const c = w[i];
    const next = w[i + 1] ?? '';
    const outer = depth === 0 && frame === 'code';
    const quoted = depth === 1 && (frame === 'dq' || frame === 'sq' || frame === 'sqa');
    if (outer && (c === '"' || c === "'" || (c === '$' && next === "'"))) return undefined;
    if (quoted && frame === 'dq' && c === '"') return undefined;
    if (quoted && frame !== 'dq' && c === "'") return undefined;
    if (c === '\\' && frame !== 'sq') {
      // The scanner skips the escaped char, so emit it here.
      if (outer) s += next;
      else if (quoted && frame === 'dq' && /["\\$`]/.test(next)) s += next;
      else s += c + next;
      return i + 2;
    }
    s += c;
    return undefined;
  });
  return s;
}

// ---------------------------------------------------------------------------
// Function extraction
// ---------------------------------------------------------------------------

/**
 * Extracts `name() { … }` / `function name [()] { … }` definitions (brace-
 * matched with the frame scanner, so bodies containing `${2}`, nested
 * blocks, or quoted braces are found — the round-3 regex `[^{}]*` silently
 * skipped those). Returns the code with each definition replaced by a
 * newline, plus name → body.
 */
export function extractFunctions(code) {
  const functions = new Map();
  let out = '';
  let copyFrom = 0;
  const head = /^(?:function\s+([A-Za-z_][\w-]*)\s*(?:\(\s*\))?|([A-Za-z_][\w-]*)\s*\(\s*\))\s*\{/;
  scanFrames(code, (i, depth, frame) => {
    if (depth !== 0 || frame !== 'code') return undefined;
    if (!/[A-Za-z_]/.test(code[i]) || (i > 0 && /[\w$-]/.test(code[i - 1]))) return undefined;
    const before = code.slice(Math.max(0, i - 200), i).replace(/[ \t]+$/, '');
    if (before !== '' && !/[\n;&|{(]$/.test(before)) return undefined;
    const m = code.slice(i, i + 200).match(head);
    if (!m) return undefined;
    const open = i + m[0].length - 1;
    const close = matchBody(code, open);
    functions.set(m[1] ?? m[2], code.slice(open + 1, close));
    out += `${code.slice(copyFrom, i)}\n`;
    copyFrom = close + 1;
    return close + 1;
  });
  out += code.slice(copyFrom);
  return { code: out, functions };
}

function matchBody(code, openIdx) {
  let n = 0;
  let close = code.length - 1;
  const sub = code.slice(openIdx);
  scanFrames(sub, (i, depth, frame) => {
    if (depth !== 0 || frame !== 'code') return undefined;
    if (sub[i] === '{') n++;
    else if (sub[i] === '}') {
      n--;
      if (n === 0) {
        close = openIdx + i;
        return sub.length;
      }
    }
    return undefined;
  });
  return close;
}

// ---------------------------------------------------------------------------
// The walker
// ---------------------------------------------------------------------------

class State {
  constructor({ errexit, vars }) {
    this.errexit = errexit;
    /** name → { value, url, content } */
    this.vars = new Map(vars ?? []);
    /** canonical path → true: written from network content, not (yet) verified */
    this.tainted = new Set();
    /** canonical path → blockPath string of the dominating verification */
    this.verified = new Map();
    this.functions = new Map();
    this.heredocs = [];
    this.offenders = [];
    this.blockStack = [];
    this.blockSeq = 0;
    this.walkSeq = 0;
    this.persistedEnv = new Map();
    this.curChainTag = null;
    /** (path) => text | null: reads a `source`d file (the caller knows the tree). */
    this.resolveSource = null;
    /** #1512: opt-in — follow a `node <file>.mjs` / `bun <file>.mjs` invocation. */
    this.followScripts = false;
    /**
     * #1715: whether THIS scanned unit (a `.sh`/`.bash` entrypoint, or a
     * workflow job's steps) contains a manifest apply (`kubectl apply|
     * create|replace -f/-k`, see `textHasManifestApply`) ANYWHERE. Gates
     * `unclassifiedFetch`'s fail-closed rules (followed-script / git-clone /
     * gh-download / helm-pull / in-process-interpreter fetches): a fetch
     * inside a unit that never applies anything cannot taint an apply that
     * does not exist. Does NOT gate the curl/wget write-site taint tracking,
     * which already only offends when a tainted path reaches a real apply
     * target.
     */
    this.hasApplyAnywhere = false;
    /** repo-relative path of the source being scanned (keys STATEMENT_ALLOWLIST). */
    this.file = null;
    /** canonical paths already loaded via `source`, to stop cycles. */
    this.sourced = new Set();
    /** the first `source`d path that could not be resolved, if any. */
    this.unresolvedSource = null;
    /**
     * Every piece of code this source can run in ITS OWN shell: the whole
     * lexed file (helpers included) and every `source`d file. Shared (by
     * reference) with the helper sub-walks. Scanned for variable write sites.
     */
    this.corpus = [];
    this.writeSiteCache = new Map();
    /**
     * #1716: the script's own text OUTSIDE any function (function bodies
     * stripped), plus every `source`d file's own top level — the part of
     * `corpus` that is genuinely global. `scopedTexts` unions this with ONE
     * function's own body, never a sibling's, so a `local` variable of the
     * same name validated in one function cannot launder — or be wrongly
     * tainted by — an unrelated write in another.
     */
    this.topLevelText = '';
  }
}

/**
 * Every function CALLED (by literal, static command word — same shape
 * `taintSources`'/`textIsNetwork`'s own call-following use) anywhere in
 * `text`, at any nesting. Used only to build the reachable-call closure
 * below; a dispatcher's or a run-time command word's callee is NOT static
 * here on purpose — the general walk / `dynamicNameWrites` already fail
 * closed on those shapes, so this helper does not need to re-derive them.
 */
function calledFunctionNames(text, st) {
  const names = new Set();
  for (const seg of commandPieces(text)) {
    const w = commandHead(words(seg))[0];
    if (w === undefined) continue;
    const u = unquote(w);
    if (st.functions.has(u)) names.add(u);
  }
  return names;
}

/**
 * Every function TRANSITIVELY reachable by a static call from `scope` (or
 * from the script's own top level when `scope` is `null`). #1716's
 * function-local scoping needs this to stay fail-closed: tracing `$V` at a
 * call site must still see a write a CALLED helper makes (`setv STATIC_LSN
 * "$val"` where `setv() { printf -v "$1" …; }` — round 9/10's fixtures), a
 * REAL execution path from here, while never following into an unrelated
 * SIBLING function nothing in this scope calls (the laundering #1716
 * exists to close). Cached per scope + function-table size.
 */
function reachableFunctionNames(st, scope) {
  const key = `\0reach\0${scope ?? ''}\0${st.functions.size}`;
  let names = st.writeSiteCache.get(key);
  if (names) return names;
  const rootText =
    scope !== null && st.functions.has(scope) ? st.functions.get(scope) : st.topLevelText;
  names = new Set();
  const queue = [...calledFunctionNames(rootText, st)];
  while (queue.length > 0) {
    const name = queue.shift();
    if (names.has(name)) continue;
    names.add(name);
    const body = st.functions.get(name);
    if (body === undefined) continue;
    for (const n of calledFunctionNames(body, st)) if (!names.has(n)) queue.push(n);
  }
  st.writeSiteCache.set(key, names);
  return names;
}

/**
 * Every function with NO static call site anywhere in the corpus — never
 * reached by `calledFunctionNames` from the top level or from any other
 * function's body. Such a function might still run (a run-time/dispatched
 * command word, a caller this scanner cannot see), so, like the top level
 * itself, it stays visible from EVERY scope rather than silently dropping
 * out of the trace: that would turn "no static call site" (a `positionalSources`
 * opaque finding) into "not found at all" (silently clean) the moment
 * function-local scoping shipped. Cached per function-table size.
 */
function orphanFunctionNames(st) {
  const key = `\0orphans\0${st.functions.size}`;
  let names = st.writeSiteCache.get(key);
  if (names) return names;
  const called = new Set(calledFunctionNames(st.topLevelText, st));
  for (const [, body] of st.functions) for (const n of calledFunctionNames(body, st)) called.add(n);
  names = new Set([...st.functions.keys()].filter((n) => !called.has(n)));
  st.writeSiteCache.set(key, names);
  return names;
}

/**
 * The texts visible while tracing a variable reference lexically inside
 * function `scope` (or at the script's own top level when `scope` is
 * `null`): the global text, `scope`'s own body (when `scope` names a known
 * function), every function `scope` transitively calls, and every ORPHAN
 * function (no static call site anywhere — see `orphanFunctionNames`).
 * Never an UNRELATED, REACHABLE sibling function's body: this is what gives
 * `corpusWriteSites`/`corpusDynamicWrites` function-local scoping instead of
 * scanning the whole, flat, multi-function corpus (#1716).
 */
function scopedTexts(st, scope) {
  const key = `\0scopedTexts\0${scope ?? ''}\0${st.functions.size}`;
  let texts = st.writeSiteCache.get(key);
  if (texts) return texts;
  texts = [st.topLevelText];
  if (scope !== null && st.functions.has(scope)) texts.push(st.functions.get(scope));
  for (const n of reachableFunctionNames(st, scope)) texts.push(st.functions.get(n));
  for (const n of orphanFunctionNames(st)) if (n !== scope) texts.push(st.functions.get(n));
  st.writeSiteCache.set(key, texts);
  return texts;
}

const blockKey = (st) => st.blockStack.join('/');

/** Expands `$X`/`${X}`/`${X:-d}` from known assignments (bounded, cycle-safe) and strips quotes. */
export function canonical(token, vars) {
  let s = unquote(token);
  for (let pass = 0; pass < 8; pass++) {
    const next = s.replace(
      /\$\{([A-Za-z_]\w*)(?:[:]?[-=?+][^}]*)?\}|\$([A-Za-z_]\w*)/g,
      (_whole, a, b) => {
        const name = a ?? b;
        const v = vars.get(name);
        if (!v || v.value === undefined) return `$${name}`;
        const inner = unquote(v.value);
        if (new RegExp(`\\$\\{?${name}\\b`).test(inner)) return `$${name}`;
        return inner;
      },
    );
    if (next === s) break;
    s = next;
  }
  // Collapse `a//b` and `a/./b` in PATHS, never the `://` of a URL.
  return s.replace(/([^:/])\/{2,}/g, '$1/').replace(/\/\.\//g, '/');
}

function varRefs(text) {
  const refs = [];
  for (const m of text.matchAll(/\$\{([A-Za-z_]\w*)|\$([A-Za-z_]\w*)/g)) refs.push(m[1] ?? m[2]);
  return refs;
}

/**
 * Variables the shell assigns WITHOUT the name appearing at the write site
 * (`read` with no name → REPLY, `mapfile` → MAPFILE, `coproc` → COPROC,
 * `[[ =~ ]]` → BASH_REMATCH, `getopts` → OPTARG, `$_`). A statement that
 * interpolates one cannot have its producer located by any scan, so it is
 * opaque; the general walk binds them from every network clause.
 */
const IMPLICIT_VARS = new Set([
  'REPLY',
  'MAPFILE',
  'COPROC',
  'COPROC_PID',
  'OPTARG',
  'OPTIND',
  'BASH_REMATCH',
  'READLINE_LINE',
  '_',
]);

// The start of the simple command an occurrence sits in: after the last
// unquoted-looking separator. Imprecise on purpose — a prefix it mis-splits
// fails the shapes below and is therefore classed a write (fail closed).
const COMMAND_START = /[;\n&|()`]|\{\s/g;
/** Whether the `&` / `|` at `text[i]` belongs to a redirection (`>&2`, `2>&1`, `&>f`, `>|f`). */
function isRedirectionChar(text, i) {
  const c = text[i];
  const prev = text[i - 1] ?? '';
  const next = text[i + 1] ?? '';
  if (c === '&') return /[<>]/.test(prev) || next === '>';
  if (c === '|') return prev === '>';
  return false;
}
function commandPrefix(before, frames = null) {
  let at = 0;
  for (const m of before.matchAll(COMMAND_START)) {
    // A separator inside quotes (`read -d ";" V`, `read -p "a|b" V`) is text.
    if (frames && frames[m.index] !== 'code' && frames[m.index] !== 'bq') continue;
    // `>&2 read V`, `2>&1`, `&>f`, `>|f`: part of a redirection, not a separator.
    if (isRedirectionChar(before, m.index)) continue;
    at = m.index + m[0].length;
  }
  return before.slice(at);
}
// `NAME=v` is a write the recognizer MODELS only as recordAssignments reads
// it: leading assignment words, optionally after export/local/declare/
// readonly/typeset and their flags. `let V=`, `env V=`, `cmd V=` and a
// nameref (`-n`) are not modeled.
const ASSIGN_PREFIX =
  /^\s*(?:(?:export|local|declare|readonly|typeset)(?:\s+-[A-Za-z]+)*\s+)?(?:[A-Za-z_]\w*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'])*\s+)*$/;
// A declaration that binds no value: `local V`, `export V`, `unset V`.
const DECLARE_ONLY =
  /^\s*(?:local|export|readonly|declare|typeset|unset)(?:\s+-[A-Za-z]+)*(?:\s+[A-Za-z_]\w*(?:=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'])*)?)*\s+$/;
const NAMEREF_FLAG = /^\s*(?:local|declare|typeset)\s(?:[^=]*\s)?-[A-Za-z]*n/;
const LEADING_KEYWORDS =
  /^\s*(?:(?:if|then|else|elif|do|while|until|!|\{|time(?:\s+(?:-p|--))*)\s+)*/;

/**
 * Only the SHELL can bind one of its variables: a child process (jq, psql,
 * kubectl, curl, sudo …) cannot write the parent's. So a mention in an
 * argument can be a write only when the command running it is a bash builtin
 * or keyword, or is computed at run time (`$cmd V` may be `read V`). This is
 * bash's COMPLETE builtin + keyword set (`compgen -b`, `compgen -k`), not a
 * list of writers: a builtin that never binds a name is still classed a
 * writer here (fail closed). A user function is not a writer AT ITS CALL SITE,
 * and that is sound only together with dynamicNameWrites: a body that binds a
 * LITERAL name is scanned in the corpus like any other text, and a body that
 * binds a name it is GIVEN (`read -r "$1"`, `printf -v "$1"`, `local -n
 * r="$1"`) is a run-time-name write, which makes EVERY followed variable of
 * that source opaque — so `setv STATIC_LSN …` needs no call-site rule.
 */
const SHELL_COMMANDS = new Set(
  (
    '. : [ alias bg bind break builtin caller cd command compgen complete compopt continue ' +
    'declare dirs disown echo enable eval exec exit export false fc fg getopts hash help ' +
    'history jobs kill let local logout mapfile popd printf pushd pwd read readarray ' +
    'readonly return set shift shopt source suspend test times trap true type typeset ' +
    'ulimit umask unalias unset wait ' +
    'case coproc for select function [['
  ).split(' '),
);
/**
 * Normalises a simple command's words to its COMMAND word: bash lets
 * redirections (`2>/dev/null`, `<f`, `>&2`, `0<f`, `{fd}<f`, `< f`),
 * assignment prefixes (`IFS=`, `V[i]=`, `V+=`), reserved words (`if`, `!`,
 * `{`, `(` …) and pass-through wrappers (`time [-p]`, `command [-pVv]`,
 * `builtin`, `exec [-cl] [-a N]`, `nohup`, `env [-i] [-u N] [K=V]`) all
 * precede it, in any order and any number. Every one is stripped, so
 * `2>/dev/null read V` and `time -p read V` are `read V`. `env`/`nohup`/`exec`
 * run an EXTERNAL program that cannot bind the parent's variables, but they
 * are stripped anyway: a false write only makes a variable opaque (fail
 * closed), a false non-write is a bypass. Returns the remaining words; the
 * first is the command (possibly undefined: the occurrence is itself in
 * command position).
 */
const REDIR_BARE = /^(\d+|&|\{[A-Za-z_]\w*\})?(<<<|<<-?|<>|<&|>&|&>>|&>|>>|>\||<|>)$/;
const REDIR_ATTACHED = /^(\d+|&|\{[A-Za-z_]\w*\})?(<<<|<<-?|<>|<&|>&|&>>|&>|>>|>\||<|>)/;
const WRAPPER_OPTS = new Map(
  Object.entries({
    time: /^-p$|^--$/,
    command: /^-[pVv]+$|^--$/,
    builtin: /^--$/,
    exec: /^-[cl]+$|^--$/,
    nohup: /^--$/,
    env: /^-[i0v]+$|^-$|^--$/,
  }),
);
export function commandHead(ws) {
  const out = [...ws];
  for (;;) {
    const w = out[0];
    if (w === undefined) return out;
    const u = unquote(w);
    if (/^(if|then|else|elif|do|while|until|!|\{|\(|\}|\)|;|&&|\|\|)$/.test(w)) out.shift();
    else if (REDIR_BARE.test(w)) out.splice(0, 2);
    else if (REDIR_ATTACHED.test(w) && !/^<\(/.test(w)) out.shift();
    else if (/^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(w)) out.shift();
    else if (WRAPPER_OPTS.has(u)) {
      out.shift();
      while (out.length && WRAPPER_OPTS.get(u).test(out[0])) out.shift();
      // Option values: `exec -a NAME`, `env -u NAME`.
      while (
        out.length > 1 &&
        ((u === 'exec' && out[0] === '-a') || (u === 'env' && /^-[uSC]$/.test(out[0])))
      )
        out.splice(0, 2);
    } else return out;
  }
}
/** A command word that is not a plain literal (`$cmd`, `{read,x}`, `r*d`) may be ANY command. */
const PLAIN_COMMAND = /^[\w./:@%+,-]+$|^\[\[?$/;
/** Whether the simple command whose normalised words are `ws` can bind a name among its arguments. */
function headCanBind(ws, dispatchers) {
  const cmd = unquote(ws[0]);
  // `retry 3 read V` where `retry() { shift; "$@"; }`: the helper RUNS its
  // arguments, so the command is the word at its dispatch index; at index 0
  // (unknown) any word before the name that could bind makes this a write.
  if (dispatchers.has(cmd)) {
    const idx = dispatchers.get(cmd);
    if (idx === 0) return ws.slice(1).some((w) => mayBeBindingCommand(w, dispatchers));
    const rest = commandHead(ws.slice(idx));
    return rest.length > 0 && headCanBind(rest, dispatchers);
  }
  if (!RUNTIME.test(ws[0]) && !PLAIN_COMMAND.test(cmd)) return true;
  return SHELL_COMMANDS.has(cmd) || RUNTIME.test(ws[0]);
}
/** A word that, run as a command, may bind a name: a builtin, a run-time or non-literal word, or a dispatcher. */
function mayBeBindingCommand(w, dispatchers) {
  const u = unquote(w);
  return SHELL_COMMANDS.has(u) || RUNTIME.test(w) || dispatchers.has(u) || /[{}*?[\]]/.test(u);
}
function shellCanBind(stmt, after, dispatchers) {
  const ws = commandHead(words(stmt.replace(LEADING_KEYWORDS, '')));
  // The occurrence IS the command position: `V[i]=…` / `V+=…` bind it.
  if (ws.length === 0) return /^(\[|\+?=)/.test(after);
  return headCanBind(ws, dispatchers);
}

/**
 * Every site in `text` that can WRITE shell variable `name`, found by
 * SCANNING every occurrence of the name, never by listing the builtins that
 * write. An occurrence is a READ only as `$name` / `${name…}` (without
 * `:=` / `=`), and a MODELED write only as a leading `name=value` word (see
 * ASSIGN_PREFIX) — returned as { kind: 'assign', word }. A bare declaration
 * (`local name`) writes nothing foreign. Every OTHER occurrence — `read
 * name`, `for name in`, `printf -v name`, `mapfile name`, `getopts o name`,
 * `coproc name`, `${name:=…}`, `name[i]=`, `name+=`, `declare -n r=name`,
 * `wait -p name`, `{name}>f`, or a mention the scan cannot place — is
 * { kind: 'other', snippet }: the caller treats it as unfollowable.
 */
export function writeSites(text, name, dispatchers = new Map()) {
  const out = [];
  const re = new RegExp(`(?<![\\w$])(?:-[A-Za-z]+)?${name}(?!\\w)`, 'g');
  let frames = null;
  for (const m of text.matchAll(re)) {
    frames ??= frameMap(text);
    const at = m.index + m[0].length - name.length;
    const before = text.slice(0, at);
    const after = text.slice(at + name.length);
    const snippet = text
      .slice(Math.max(0, at - 40), at + name.length + 40)
      .replace(/\s+/g, ' ')
      .trim();
    const flagged = m[0] !== name; // `-vNAME`: an attached option value
    // `-U` / `-n`: an option LETTER. A name can follow a dash only attached to
    // at least one option letter (`-vNAME`), which is `flagged`.
    if (!flagged && before.endsWith('-')) continue;
    if (!flagged && /\$\{[#!]?$/.test(before)) {
      if (/^(\[[^\]]*\])?:?=/.test(after)) out.push({ kind: 'other', snippet });
      continue;
    }
    // Inside a quoted string (or a `${…}` operand) the name is TEXT — unless it
    // is the very first thing the quotes hold, the one spelling in which a
    // quoted word can still name a variable (`read "V"`, `declare "V=…"`).
    const fr = frames[at];
    if (fr === 'dq' || fr === 'sq' || fr === 'sqa' || fr === 'brace') {
      const q = text[at - 1];
      const opensHere =
        frames[at - 1] !== fr && ((fr === 'dq' && q === '"') || (fr !== 'dq' && q === "'"));
      if (!opensHere) continue;
    }
    // Arithmetic (`$(( … ))`, `(( … ))`): a bare name is a READ unless an
    // assignment operator or ++/-- binds it.
    if (!flagged && ARITH_OPEN.test(before)) {
      if (
        /^\s*(\[[^\]]*\])?\s*([-+*/%&|^]|<<|>>)?=(?!=)/.test(after) ||
        /^\s*(\+\+|--)/.test(after) ||
        /(\+\+|--)\s*$/.test(before)
      )
        out.push({ kind: 'other', snippet });
      continue;
    }
    // `{V}>file`: the shell binds V to a file descriptor, whatever the command.
    if (!flagged && /\{$/.test(before) && /^\}\s*[<>]/.test(after)) {
      out.push({ kind: 'other', snippet });
      continue;
    }
    const stmt = commandPrefix(before, frames).replace(LEADING_KEYWORDS, '');
    if (!shellCanBind(stmt, after, dispatchers)) continue;
    if (!flagged && after.startsWith('=') && ASSIGN_PREFIX.test(stmt) && !NAMEREF_FLAG.test(stmt)) {
      out.push({ kind: 'assign', word: words(text.slice(at, at + 4000))[0] ?? '' });
      continue;
    }
    if (!flagged && /^(\s|;|$)/.test(after) && DECLARE_ONLY.test(stmt) && !NAMEREF_FLAG.test(stmt))
      continue;
    out.push({ kind: 'other', snippet });
  }
  return out;
}

// An unclosed `((` before the occurrence (one level of inner parens allowed).
const ARITH_OPEN = /\(\((?:[^()]|\([^()]*\))*$/;

/** The quoting frame (code / dq / sq / sqa / brace / bq) of every index of `text`. */
function frameMap(text) {
  const f = new Array(text.length);
  scanFrames(text, (i, _d, t) => {
    f[i] = t;
    return undefined;
  });
  for (let i = 1; i < f.length; i++) if (f[i] === undefined) f[i] = f[i - 1];
  return f;
}

/**
 * The builtins that bind a variable whose NAME is an argument, and which of
 * their option letters take a value (for read/mapfile the `-a` value, for
 * printf `-v`, for wait `-p`, for compgen `-V` IS the name). A name
 * computed at run time (`read "$n"`, `printf -v "$n"`, `declare "$n=…"`,
 * `(( $n = 1 ))`) can write ANY variable, so no occurrence scan can see it;
 * this is the one list in the rule, and it lists writers that RED.
 */
const NAME_BINDERS = {
  read: { valued: 'adeinNptu', nameOpts: 'a', positional: 'all' },
  mapfile: { valued: 'dnOsuCc', nameOpts: '', positional: 'first' },
  readarray: { valued: 'dnOsuCc', nameOpts: '', positional: 'first' },
  getopts: { valued: '', nameOpts: '', positional: 'second' },
  printf: { valued: 'v', nameOpts: 'v', positional: 'none' },
  wait: { valued: 'p', nameOpts: 'p', positional: 'none' },
  compgen: { valued: 'AaCFGPSWXV', nameOpts: 'V', positional: 'none' },
};
const DECLARERS = new Set(['declare', 'typeset', 'local', 'export', 'readonly', 'let']);
const RUNTIME = /[$`]/;

/**
 * Every simple command in `text`, at ANY nesting: split at each unquoted
 * `;` `\n` `&` `|` `(` `)` `{` `}` — so a function body (`f() {\n read "$1"\n}`,
 * `function f { … }`), a group, a subshell, a `case` arm and a `$( … )` are
 * each seen as the commands they hold, not as one word headed by `f()`.
 * Every real command starts a piece. The text after a CLOSING `)` (of a
 * `$( … )` or subshell — one that ends a nesting level) or `}` continues the
 * enclosing command (`"$(date) $1"`, `( … ) 2>/dev/null`), so it is not a
 * command and is dropped; a `case` pattern's `)` ends no level, so its arm is
 * kept. `>&2`, `2>&1`, `&>f` and `>|f` are redirections, not separators.
 */
function commandPieces(text) {
  const pieces = [];
  let start = 0;
  let continuation = false;
  scanFrames(text, (i, d, frame) => {
    if (frame !== 'code') return undefined;
    const c = text[i];
    if (!/[;\n&|(){}]/.test(c) || isRedirectionChar(text, i)) return undefined;
    if (!continuation) pieces.push(text.slice(start, i));
    continuation = c === '}' || (c === ')' && d > 0);
    start = i + 1;
    return undefined;
  });
  if (!continuation) pieces.push(text.slice(start));
  return pieces.filter((p) => p.trim() !== '');
}

/** `retry 3 read V` → `read V`: a dispatcher call is the command at its dispatch index. */
function dispatchedCommand(ws, dispatchers) {
  let out = ws;
  for (let guard = 0; guard < 16 && out.length > 0; guard++) {
    const idx = dispatchers.get(unquote(out[0]));
    if (!idx) break;
    out = commandHead(out.slice(idx));
  }
  return out;
}

/** Sites in `text` that write a variable whose NAME is computed at run time. */
export function dynamicNameWrites(text, dispatchers = new Map()) {
  const out = [];
  if (
    /\(\((?:[^()]|\([^()]*\))*\$\{?[A-Za-z_]\w*\}?(?:\[[^\]]*\])?\s*([-+*/%&|^]|<<|>>)?=(?!=)/.test(
      text,
    )
  )
    out.push('an arithmetic assignment to a $-expanded name');
  // `${!1:=v}` / `${!n=v}` ASSIGN the variable whose name `$1` / `$n` holds.
  if (/\$\{![\w@*#?$-]+(?:\[[^\]]*\])?:?=/.test(text))
    out.push('an indirect default assignment (`$' + '{!x:=…}`)');
  // An alias can make ANY word a writer (`alias rd=read; rd V`); bash expands
  // them in a script under `shopt -s expand_aliases` or POSIX mode.
  if (/(^|[\s;&|(])alias\s+[^\s=]+=|\bexpand_aliases\b/.test(text))
    out.push('an alias is defined, so any word may be a variable-writing builtin');
  for (const seg of commandPieces(text)) {
    const raw = dispatchedCommand(commandHead(words(seg)), dispatchers);
    const ws = raw.map(unquote);
    const cmd = ws[0];
    if (cmd === undefined) continue;
    const args = withoutRedirects(ws.slice(1));
    const hit = (w) => out.push(`\`${seg.trim().slice(0, 100)}\` (name \`${w}\`)`);
    // A dispatcher whose dispatch index is unknown: from the first argument
    // that may be a binding command on, a run-time word may be the name.
    if (dispatchers.get(cmd) === 0) {
      const k = raw.findIndex((a, j) => j > 0 && mayBeBindingCommand(a, dispatchers));
      const n = k === -1 ? undefined : raw.slice(k + 1).find((a) => RUNTIME.test(a));
      if (n !== undefined) hit(n);
      continue;
    }
    // `eval "$1=…"`: the evaluated text, and so the name it binds, is run-time.
    if (cmd === 'eval') {
      for (const a of raw.slice(1)) if (RUNTIME.test(a)) hit(a);
      continue;
    }
    if (DECLARERS.has(cmd)) {
      // A nameref (`local -n r="$1"`, or `declare -n r` bound later by `r=…`)
      // writes whatever its target names: run-time unless given literally here.
      const nameref = args.some((a) => /^-[A-Za-z]*n/.test(a));
      for (const a of args) {
        if (a.startsWith('-')) continue;
        if (RUNTIME.test(a.split('=')[0])) hit(a);
        else if (nameref && (!a.includes('=') || RUNTIME.test(a.slice(a.indexOf('=') + 1)))) hit(a);
      }
      continue;
    }
    const spec = NAME_BINDERS[cmd];
    if (!spec) continue;
    const positional = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === '--') {
        positional.push(...args.slice(k + 1));
        break;
      }
      const o = a.match(/^-([A-Za-z]+)(.*)$/);
      if (!o) {
        positional.push(a);
        continue;
      }
      const letters = o[1];
      const vi = letters.split('').findIndex((c) => spec.valued.includes(c));
      if (vi === -1) continue;
      const attached = letters.slice(vi + 1) + o[2];
      const val = attached !== '' ? attached : (args[++k] ?? '');
      if (spec.nameOpts.includes(letters[vi]) && RUNTIME.test(val)) hit(val);
    }
    const names =
      spec.positional === 'all'
        ? positional
        : spec.positional === 'first'
          ? positional.slice(0, 1)
          : spec.positional === 'second'
            ? positional.slice(1, 2)
            : [];
    for (const n of names) if (RUNTIME.test(n)) hit(n);
  }
  return out;
}

/**
 * The helpers that RUN their arguments as a command, each mapped to the
 * argument index that becomes the command word (0: not determinable). A body
 * command whose command word is a positional expansion — `"$@"`/`"$*"` (index
 * 1 + the `shift`s before it: `retry() { shift; "$@"; }` → 2), `$k`, `"${@:k}"`
 * — or a variable the body sets from one (`run() { local c=$1; shift; $c "$@"; }`
 * → 1); and, to a fixpoint, a helper that calls one with its OWN positionals
 * (index 0). A call site is then classified as the command at that index
 * (`retry 3 read V` is `read V`); at index 0 every word may be the command.
 * A run-time command word from a GLOBAL (`DRILL_PSQL() { $KD exec … "$1"; }`)
 * passes its arguments as DATA, so it is not a dispatcher; a global assigned
 * from a positional elsewhere is not followed.
 */
function dispatcherNames(st) {
  const key = `\0disp\0${st.functions.size}`;
  let out = st.writeSiteCache.get(key);
  if (out) return out;
  out = new Map();
  const merge = (name, idx) => {
    const prev = out.get(name);
    if (prev === undefined) out.set(name, idx);
    else if (prev !== idx) out.set(name, 0);
    return prev !== out.get(name);
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, body] of st.functions) {
      const pieces = commandPieces(body);
      let shifts = 0; // positional shifts so far (NaN once not a literal count)
      // The positional index a word expands to (after `shifts`), or null.
      const posIndex = (w, sh) => {
        const u = unquote(w);
        const m = u.match(/^\$(?:([1-9])|\{([1-9])\}|([@*])|\{([@*])\}|\{@:([1-9])\})$/);
        if (!m) return POSITIONAL.test(w) ? 0 : null;
        const k = m[1] ?? m[2] ?? m[5];
        const idx = (k === undefined ? 1 : Number(k)) + sh;
        return Number.isFinite(idx) ? idx : 0;
      };
      const assigned = new Map(); // variable → index of the positional it was set from
      for (const seg of pieces) {
        const ws = commandHead(words(seg));
        const w = ws[0];
        const raw = words(seg);
        if (w === undefined) {
          // `c=$1` / `c="$1"`: a bare assignment.
          for (const a of raw) {
            const m = a.match(/^([A-Za-z_]\w*)=(.+)$/s);
            if (m && POSITIONAL.test(m[2])) assigned.set(m[1], posIndex(m[2], shifts) ?? 0);
          }
          continue;
        }
        const cmd = unquote(w);
        if (cmd === 'shift') {
          shifts += ws.length === 1 ? 1 : /^[0-9]+$/.test(ws[1]) ? Number(ws[1]) : Number.NaN;
          continue;
        }
        if (DECLARERS.has(cmd) || Object.hasOwn(NAME_BINDERS, cmd)) {
          for (const a of ws.slice(1)) {
            const m = a.match(/^([A-Za-z_]\w*)=(.+)$/s);
            if (m && POSITIONAL.test(m[2])) assigned.set(m[1], posIndex(m[2], shifts) ?? 0);
            else if (POSITIONAL.test(seg) && /^[A-Za-z_]\w*$/.test(a)) assigned.set(a, 0);
          }
        }
        let idx = null;
        if (RUNTIME.test(w)) {
          idx = posIndex(w, shifts);
          if (idx === null) {
            const refs = varRefs(w).filter((r) => assigned.has(r));
            if (refs.length > 0) idx = refs.length === 1 ? assigned.get(refs[0]) : 0;
          }
        } else if (out.has(cmd) && ws.slice(1).some((a) => POSITIONAL.test(a))) idx = 0;
        if (idx !== null && merge(name, idx)) changed = true;
      }
    }
  }
  st.writeSiteCache.set(key, out);
  return out;
}

/**
 * dynamicNameWrites over the texts visible in `scope` (#1716: function-local,
 * see `scopedTexts`), cached per scope + corpus size.
 */
function corpusDynamicWrites(st, scope = null) {
  const key = `\0dyn\0${scope ?? ''}\0${st.corpus.length}`;
  let d = st.writeSiteCache.get(key);
  if (!d) {
    const disp = dispatcherNames(st);
    d = scopedTexts(st, scope).flatMap((t) => dynamicNameWrites(t, disp));
    st.writeSiteCache.set(key, d);
  }
  return d;
}

/**
 * An UNQUOTED heredoc body is expanded by the current shell, so a `${V:=…}` /
 * `${V=…}` / `$(( V = … ))` in it assigns V. Its literal text (YAML, prose) is
 * not code, so only those expansions join the corpus.
 */
function heredocWriteText(heredocs) {
  const out = [];
  for (const hd of heredocs) {
    if (hd.quoted) continue;
    for (const m of hd.body.matchAll(/\$\{[A-Za-z_]\w*(?:\[[^\]]*\])?:?=|\$\(\([^)]*=/g))
      out.push(`: ${hd.body.slice(m.index, m.index + 200)}`);
  }
  return out;
}

// A `local`/`declare`/`typeset` keyword at a command boundary; `declare`/
// `typeset` at a script's OWN top level are not function-scoping at all, but
// this is only ever consulted against a FUNCTION body (see `declaresLocal`),
// where all three create a private binding unless `declare` carries `-g`.
const LOCAL_KEYWORD_RE = /(?:^|[\s;&|(])(local|declare|typeset)\b/g;

/**
 * Whether `body` (a FUNCTION's own text) declares `name` function-local
 * anywhere — `local name`, `local name=…`, `declare name` / `typeset name`
 * (but NOT `declare -g name`, which is explicitly global). #1716 round 2: a
 * reviewer-found bypass — `scopedTexts`/`reachableFunctionNames` scope
 * PURELY by call graph, so a function that writes a followed name WITHOUT
 * `local`izing it (a real bash global, however it got that value) escaped
 * detection the moment it was not reachable from the tracing function, e.g.
 * a helper called only from an unrelated command dispatcher. bash has no
 * "file-scoped" variable: a write not `local`'d in the function that makes
 * it is either a script-level global (if nothing ever locals it) or binds
 * whatever enclosing call frame first declared it local (dynamic scoping) —
 * this scanner does not attempt to resolve the LATTER precisely; it just
 * treats any non-`local`'d write anywhere as a possible global and includes
 * it from every scope (fail closed, see `globalWriterTexts`).
 */
function declaresLocal(body, name) {
  for (const m of body.matchAll(LOCAL_KEYWORD_RE)) {
    const kw = m[1];
    const from = m.index + m[0].length;
    const rest = body.slice(from, from + 2000).split(/[\n;&|]/, 1)[0];
    let global = false;
    let found = false;
    for (const w of rest.trim().split(/\s+/)) {
      if (w === '') continue;
      if (w.startsWith('-')) {
        // `typeset` is a full synonym of `declare`, `-g` included (#1716 round 3).
        if ((kw === 'declare' || kw === 'typeset') && /g/.test(w)) global = true;
        continue;
      }
      const n = w.split('=')[0].replace(/\[.*$/, '');
      if (n === name) found = true;
    }
    if (found && !global) return true;
  }
  return false;
}

/**
 * Every FUNCTION body that writes `name` (any `writeSites`/`assembledWrites`
 * hit) without `local`izing it there (`declaresLocal`) — a real bash global,
 * visible to every scope regardless of the call graph (#1716 round 2). Never
 * scoped by reachability: that is exactly the bypass this closes. Cached per
 * name + function-table size.
 */
function globalWriterTexts(st, name) {
  const key = `\0globalWriters\0${name}\0${st.functions.size}`;
  let texts = st.writeSiteCache.get(key);
  if (!texts) {
    const disp = dispatcherNames(st);
    texts = [];
    for (const body of st.functions.values()) {
      if (declaresLocal(body, name)) continue;
      if (writeSites(body, name, disp).length > 0 || assembledWrites(body, name, disp).length > 0)
        texts.push(body);
    }
    st.writeSiteCache.set(key, texts);
  }
  return texts;
}

/**
 * writeSites over the texts visible in `scope` (#1716: function-local, see
 * `scopedTexts`) UNIONED with every function that writes `name` as a bash
 * global anywhere in the file (#1716 round 2: `globalWriterTexts` — a
 * non-`local`'d write is not something call-graph scoping may exclude).
 * Cached per name + scope + corpus size.
 */
function corpusWriteSites(name, st, scope = null) {
  const key = `${name}\0${scope ?? ''}\0${st.corpus.length}`;
  let sites = st.writeSiteCache.get(key);
  if (!sites) {
    const disp = dispatcherNames(st);
    const texts = new Set([...scopedTexts(st, scope), ...globalWriterTexts(st, name)]);
    sites = [...texts].flatMap((t) => [
      ...writeSites(t, name, disp),
      ...assembledWrites(t, name, disp),
    ]);
    st.writeSiteCache.set(key, sites);
  }
  return sites;
}

/**
 * A builtin receives its arguments AFTER quote removal, so `printf -v V"AR"`,
 * `read 'V'AR`, `read V\AR`, `read V$'AR'` all bind VAR while no occurrence of
 * the text `VAR` exists. Every argument of a shell builtin / keyword / run-time
 * command whose spelling contains quoting is compared in its DEQUOTED form.
 */
const assembledCache = new Map();
function assembledWords(text) {
  let out = assembledCache.get(text);
  if (out) return out;
  out = [];
  // Every simple command at any nesting (a helper body included), after its
  // redirection / assignment / keyword / wrapper prefix.
  for (const seg of commandPieces(text)) {
    const ws = commandHead(words(seg));
    for (const w of ws.slice(1)) {
      if (!/["'\\]/.test(w)) continue;
      const dq = w
        .replace(/\$'((?:[^'\\]|\\.)*)'/g, '$1')
        .replace(/\\(.)/g, '$1')
        .replace(/["']/g, '');
      if (dq !== w) out.push({ raw: w, dq, head: ws, snippet: seg.trim().slice(0, 100) });
    }
  }
  if (assembledCache.size > 500) assembledCache.clear();
  assembledCache.set(text, out);
  return out;
}
function assembledWrites(text, name, dispatchers = new Map()) {
  const re = new RegExp(`(?<![\\w$])(?:-[A-Za-z]+)?${name}(?!\\w)`);
  return assembledWords(text)
    .filter((a) => re.test(a.dq) && !re.test(a.raw) && headCanBind(a.head, dispatchers))
    .map((a) => ({ kind: 'other', snippet: a.snippet }));
}

// `set -- …` / `set x …` rewrites the positional parameters.
const SETS_POSITIONALS = /(?:^|[\n;&|(])[ \t]*set[ \t]+(?:-[A-Za-z]*[ \t]+)*(?:--|[^-+\s])/;

/** Whether `text` runs a positional-rewriting `set` as CODE (not inside a string). */
function setsPositionals(text) {
  const re = new RegExp(SETS_POSITIONALS.source, 'g');
  let frames = null;
  for (const m of text.matchAll(re)) {
    frames ??= frameMap(text);
    const at = m.index + m[0].indexOf('set');
    if (frames[at] === 'code' || frames[at] === 'bq') return true;
  }
  return false;
}

/** A positional-parameter expansion outside single quotes (`'{print $1}'` is awk's). */
function hasPositional(text) {
  const frames = frameMap(text);
  for (const m of text.matchAll(/\$\{?[1-9@*]/g))
    if (frames[m.index] !== 'sq' && frames[m.index] !== 'sqa') return true;
  return false;
}

/**
 * Where the positional parameters in `word` (a `NAME=…$1…` write site) come
 * from: every static call site of each helper whose body holds the write (the
 * whole call line is traced, so every argument is), or — outside any helper —
 * the script's own arguments, which are the caller's like the environment,
 * unless `set` rewrites them. A helper with no static call site, or one that is
 * also referenced as a VALUE (`cmd=F`, `for s in F`), is called with arguments
 * nothing static reveals: opaque.
 */
function positionalSources(word, r, st, depth, ctx) {
  // #1716: `word` was found by `corpusWriteSites` searching ONLY the texts
  // `scopedTexts(st, ctx.scope)` returns (the script's own top level,
  // `ctx.scope`'s own body, and every function `ctx.scope` transitively
  // calls) — so the owner, if any, is among THOSE, never an unrelated
  // sibling function with the same literal write text (which would
  // launder/taint across unrelated functions the old whole-corpus substring
  // search did).
  const scope = ctx.scope ?? null;
  const candidates = [
    ...(scope !== null ? [scope] : []),
    ...reachableFunctionNames(st, scope),
    ...orphanFunctionNames(st),
  ];
  const owner = candidates.find((s) => st.functions.get(s)?.includes(word)) ?? null;
  const owners = owner !== null ? [owner] : [];
  // `set -- …` rewrites the positionals of whatever scope RECEIVES them: the
  // owning function's own body when `word` lives in one, or the script's own
  // top level when it does not (#1716: scoped, so an unrelated function's
  // `set --` elsewhere in the file cannot taint this one).
  const rewriteScopes = owners.length > 0 ? owners : [null];
  if (rewriteScopes.some((s) => scopedTexts(st, s).some(setsPositionals)))
    ctx.out.add(`opaque:$${r} is assigned from positional parameters that \`set\` rewrites`);
  if (owners.length === 0) return; // the script's own arguments: the caller's, like its environment
  for (const fn of owners) {
    const key = `\0callers\0${fn}`;
    if (ctx.fns.has(key)) continue;
    ctx.fns.add(key);
    const re = new RegExp(
      `(?<![\\w$./-])${fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`,
      'g',
    );
    let calls = 0;
    for (const t of st.corpus) {
      for (const m of t.matchAll(re)) {
        const from = t.lastIndexOf('\n', m.index) + 1;
        const to = t.indexOf('\n', m.index);
        const line = t.slice(from, to === -1 ? t.length : to);
        const rest = t.slice(m.index + fn.length);
        if (/^\s*\(\s*\)/.test(rest) || /function\s+$/.test(t.slice(from, m.index))) continue;
        if (/=["']?$/.test(t.slice(from, m.index)) || /^\s*(for|select)\s/.test(line)) {
          ctx.out.add(
            `opaque:$${r} is assigned from the arguments of ${fn}(), which is referenced as a value in \`${line.trim().slice(0, 80)}\``,
          );
          continue;
        }
        calls++;
        taintSources(line, st, depth + 1, ctx);
      }
    }
    if (calls === 0)
      ctx.out.add(
        `opaque:$${r} is assigned from the arguments of ${fn}(), which has no static call site`,
      );
  }
}

/** Every name the corpus READS as a variable (`$N`, `${N…}`), cached per corpus size. */
function referencedVars(st) {
  const key = `\0refs\0${st.corpus.length}`;
  let refs = st.writeSiteCache.get(key);
  if (!refs) {
    refs = new Set(st.corpus.flatMap((t) => varRefs(t)));
    st.writeSiteCache.set(key, refs);
  }
  return refs;
}

/**
 * The general walk's half of the same rule: a clause that writes a variable
 * by any construct other than a leading `NAME=` binds it FROM THE WHOLE
 * CLAUSE (every pipeline stage, process substitution, redirection and, for a
 * `while`/`until` loop, the `done < …` that feeds it). Its value becomes
 * unknown (paths stay `$NAME`), and it holds network content / a URL if
 * that producer does. Implicitly-assigned names are bound from any network clause.
 */
function bindUnmodeledWrites(text, loopTail, st, depth) {
  // The `${V:=…}` expansions of the unquoted heredocs this clause feeds.
  const hd = [...`${text} ${loopTail}`.matchAll(/<<__HD(\d+)__/g)].flatMap((m) =>
    heredocWriteText(st.heredocs[Number(m[1])] ? [st.heredocs[Number(m[1])]] : []),
  );
  const clauseText = hd.length > 0 ? `${text}\n${hd.join('\n')}` : text;
  const refs = referencedVars(st);
  let producer = null;
  let why;
  const produce = () => {
    if (producer === null) {
      const stdin = splitPipeline(`${clauseText} ${loopTail}`)
        .flatMap((seg) => stdinSources(words(seg)))
        .filter((x) => !/^<<__HD/.test(x));
      producer = [clauseText, loopTail, ...stdin].filter(Boolean).join('\n');
      why = producerIsNetwork(producer, st, depth + 1);
    }
  };
  const bind = (name) => {
    produce();
    const prev = st.vars.get(name);
    st.vars.set(name, {
      value: undefined,
      producer: [prev?.producer, prev?.value, producer].filter((x) => x !== undefined).join('\n'),
      url: !!prev?.url || URL_RE.test(canonical(producer, st.vars)),
      content: !!prev?.content || !!why,
    });
  };
  for (const name of refs) {
    if (!clauseText.includes(name) && !loopTail.includes(name) && !/["'\\]/.test(clauseText))
      continue;
    if (
      writeSites(clauseText, name, dispatcherNames(st)).some((s) => s.kind === 'other') ||
      assembledWrites(clauseText, name, dispatcherNames(st)).length > 0
    )
      bind(name);
  }
  for (const name of IMPLICIT_VARS) {
    if (!refs.has(name)) continue;
    produce();
    if (why) bind(name);
  }
  if (RUNTIME.test(clauseText) && dynamicNameWrites(clauseText, dispatcherNames(st)).length > 0) {
    produce();
    if (why) for (const name of refs) bind(name);
  }
}

/** For a clause opening a `while`/`until` loop, the text of its matching `done` clause. */
function loopTailOf(clauses, ci) {
  if (!/^\s*(while|until)\b/.test(clauses[ci].text)) return '';
  let d = 0;
  for (let j = ci; j < clauses.length; j++) {
    const t = clauses[j].text.trim();
    for (const m of t.matchAll(/(^|\s)(while|until|for|select)(\s|$)/g)) if (m) d++;
    if (/^done\b/.test(t) && --d === 0) return t;
  }
  return '';
}

/**
 * A loopback URL (`http://localhost:9898/…` from `kubectl exec pod -- curl`)
 * reads a local process's state, not an upstream artifact. Strict on
 * purpose: a literal loopback host only, never a variable host, and no second
 * `://` (a local proxy handed an upstream URL is still upstream).
 */
const LOOPBACK_URL = /^https?:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(:\d+)?(\/|$)/;

export function isLoopbackUrl(u) {
  return LOOPBACK_URL.test(u) && u.split('://').length === 2 && !/\$/.test(u.split('/')[2]);
}

const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\])$/;
export function isLoopbackHost(h) {
  return LOOPBACK_HOST.test(h);
}

/**
 * #1715 round 2: per-character tokenizer for a followed `.mjs`/`.cjs`/`.js`
 * source. Tags every character `'code'`, `'string'` (single/double-quoted
 * OR a regex literal), `'templatelit'` (the literal parts and the `` ` ``/
 * `${`/`}` delimiters of a template literal), or `'comment'` (`//` or
 * a slash-star…star-slash span). This is what makes `stripNonFetchText`
 * STRING-AWARE: the round-2 bug was that the previous implementation
 * matched block/line comments against the raw text with no notion of "am
 * I inside a string right now", so a slash-star-space string literal
 * followed by a real `fetch(…)` followed by a star-slash string literal —
 * three ordinary statements, none of them an actual comment — was read as
 * one giant comment swallowing the fetch. Each character's tag now reflects
 * the LEXICAL state machine was actually in when it was scanned, so a
 * quote/backtick/regex-slash always wins over a `/` that merely happens to
 * sit next to another `/` or `*` inside string data.
 *
 * A `${…}` expression inside a template literal is tagged `'code'`
 * throughout (recursing through the SAME state machine for any nested
 * template/string/comment inside it) — a real call written there is
 * genuine code, never string data, and must not be strippable.
 *
 * Regex literals are detected with the standard (conservative) JS lexer
 * heuristic: a `/` opens a regex only when the previous significant
 * character is one that cannot end an expression (an operator/punctuator,
 * start-of-file, or a keyword like `return`/`typeof`/`case`/…) — otherwise
 * it is division and left as plain code.
 */
function tagCharacters(src) {
  const n = src.length;
  const tags = new Array(n);
  // Stack of lexical contexts. 'code' at index 0 is the top-level program.
  // A 'code' pushed later (braceDepths gets a matching entry) means "inside
  // a template literal's `${…}` expression hole".
  const stack = ['code'];
  const braceDepths = [];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';
    const ctx = top();

    if (ctx === 'linecomment') {
      tags[i] = 'comment';
      if (c === '\n') stack.pop();
      i++;
      continue;
    }
    if (ctx === 'blockcomment') {
      tags[i] = 'comment';
      if (c === '*' && c2 === '/') {
        tags[i + 1] = 'comment';
        stack.pop();
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ctx === 'squote' || ctx === 'dquote' || ctx === 'regex') {
      tags[i] = 'string';
      if (c === '\\' && i + 1 < n) {
        tags[i + 1] = 'string';
        i += 2;
        continue;
      }
      const closer = ctx === 'squote' ? "'" : ctx === 'dquote' ? '"' : '/';
      if (c === closer) {
        stack.pop();
        i++;
        if (ctx === 'regex') {
          // trailing flags (g, i, m, …) are part of the literal too
          while (i < n && /[a-zA-Z]/.test(src[i])) {
            tags[i] = 'string';
            i++;
          }
        }
        continue;
      }
      i++;
      continue;
    }
    if (ctx === 'templatelit') {
      if (c === '\\' && i + 1 < n) {
        tags[i] = 'templatelit';
        tags[i + 1] = 'templatelit';
        i += 2;
        continue;
      }
      if (c === '`') {
        tags[i] = 'templatelit';
        stack.pop();
        i++;
        continue;
      }
      if (c === '$' && c2 === '{') {
        tags[i] = 'templatelit';
        tags[i + 1] = 'templatelit';
        stack.push('code');
        braceDepths.push(0);
        i += 2;
        continue;
      }
      tags[i] = 'templatelit';
      i++;
      continue;
    }

    // ctx === 'code' (top-level program OR inside a template `${…}` hole)
    const inTemplateExpr = braceDepths.length > 0;
    if (c === '/' && c2 === '/') {
      tags[i] = 'comment';
      tags[i + 1] = 'comment';
      stack.push('linecomment');
      i += 2;
      continue;
    }
    if (c === '/' && c2 === '*') {
      tags[i] = 'comment';
      tags[i + 1] = 'comment';
      stack.push('blockcomment');
      i += 2;
      continue;
    }
    if (c === "'") {
      tags[i] = 'string';
      stack.push('squote');
      i++;
      continue;
    }
    if (c === '"') {
      tags[i] = 'string';
      stack.push('dquote');
      i++;
      continue;
    }
    if (c === '`') {
      tags[i] = 'templatelit';
      stack.push('templatelit');
      i++;
      continue;
    }
    if (c === '{' && inTemplateExpr) {
      braceDepths[braceDepths.length - 1]++;
      tags[i] = 'code';
      i++;
      continue;
    }
    if (c === '}' && inTemplateExpr) {
      if (braceDepths[braceDepths.length - 1] === 0) {
        tags[i] = 'templatelit';
        stack.pop();
        braceDepths.pop();
        i++;
        continue;
      }
      braceDepths[braceDepths.length - 1]--;
      tags[i] = 'code';
      i++;
      continue;
    }
    if (c === '/' && looksLikeRegexStart(src, tags, i)) {
      tags[i] = 'string';
      stack.push('regex');
      i++;
      continue;
    }
    tags[i] = 'code';
    i++;
  }
  // The caller (`classifyJsScript`) checks this for "did the whole file
  // tokenize cleanly" — exported only for that fail-closed check, which is
  // why `stack`/`braceDepths` are returned alongside the per-char tags
  // rather than thrown away.
  return { tags, clean: stack.length === 1 && stack[0] === 'code' && braceDepths.length === 0 };
}

/**
 * Standard (conservative) JS lexer heuristic for "is this `/` a regex
 * literal or division": look at the previous significant (non-whitespace,
 * non-comment) character already tagged by the walk so far. An identifier/
 * number/`)`/`]` means the previous token was a value, so `/` is division —
 * UNLESS that identifier is a keyword that itself introduces an expression
 * (`return`, `typeof`, `case`, …), in which case `/` still opens a regex.
 * Any operator/punctuator, or start-of-file, opens a regex.
 */
function looksLikeRegexStart(src, tags, i) {
  let j = i - 1;
  while (j >= 0 && (tags[j] === 'comment' || /\s/.test(src[j]))) j--;
  if (j < 0) return true;
  const c = src[j];
  if (/[A-Za-z0-9_$)\]]/.test(c)) {
    const word = src.slice(0, j + 1).match(/[A-Za-z_$][A-Za-z0-9_$]*$/);
    if (
      word &&
      /^(return|typeof|instanceof|in|of|new|delete|void|throw|yield|case|do|else)$/.test(word[0])
    ) {
      return true;
    }
    return false;
  }
  return true;
}

/**
 * #1715: removes text that can never be an outbound fetch target before
 * `classifyJsScript` scans a followed `.mjs`/`.cjs`/`.js` source for a
 * literal host/URL. Two shapes, each independently justified, and each
 * removed ONLY when `tagCharacters` (above) says the removed span is
 * genuinely that shape — not merely text that LOOKS like it inside a
 * string/template-literal payload (the round-2 fix):
 *   - `/* … *\/` block comments and `// …` line comments (a comment can
 *     mention a URL as documentation — e.g. "cluster-internal DNS, e.g.
 *     http://foo.svc.cluster.local" — without the file ever fetching it).
 *     Only characters `tagCharacters` tagged `'comment'` are dropped.
 *   - `new URL(…)` call expressions: the WHATWG `URL` constructor is a pure
 *     parser (resolves/joins a path against a base) and performs no network
 *     I/O under any Node/Bun/browser semantics. Matched textually (`new`,
 *     whitespace, `URL`, `(`), but the call is ONLY removed when both the
 *     `new`/`URL(` text and its matching close paren are `'code'`-tagged,
 *     and the paren depth used to find that matching close paren counts
 *     ONLY `'code'`-tagged parens — so a `)` inside a string/template
 *     argument can never end the call early, and a `(`/`)` that is itself
 *     inside a comment or string is never treated as structural.
 *
 * Returns `{ text, clean }` — `clean` is `tagCharacters`'s own verdict on
 * whether the WHOLE file tokenized unambiguously (no unterminated string/
 * template/comment/regex at EOF). `classifyJsScript` fails closed on
 * `clean === false` regardless of what `text` contains — see its own
 * docstring for why that is a SEPARATE guarantee from "the tokenizer is
 * correct", not a restatement of it.
 */
export function stripNonFetchText(src) {
  const { tags, clean } = tagCharacters(src);
  const n = src.length;
  const drop = new Array(n).fill(false);
  for (let i = 0; i < n; i++) if (tags[i] === 'comment') drop[i] = true;

  const NEW_URL_RE = /\bnew\s+URL\s*\(/g;
  for (const m of src.matchAll(NEW_URL_RE)) {
    const start = m.index;
    if (tags[start] !== 'code') continue; // `new` appeared inside a string/comment/template
    const openParen = start + m[0].length - 1;
    if (tags[openParen] !== 'code') continue;
    let depth = 1;
    let j = openParen + 1;
    while (j < n && depth > 0) {
      if (tags[j] === 'code') {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') depth--;
      }
      j++;
    }
    if (depth !== 0) continue; // unterminated at EOF — `clean` already covers this
    // Guard against `new URL(fetch(…), base)` — an unusual but syntactically
    // legal nesting where a REAL fetch call is itself one of the `new URL`
    // arguments. Never drop the span if its own CODE-tagged text (i.e.
    // excluding any string/template-literal argument data) matches
    // INTERPRETER_FETCH; leave it untouched so the later host/URL scan can
    // still see and flag it.
    let codeOnly = '';
    for (let k = start; k < j; k++) if (tags[k] === 'code') codeOnly += src[k];
    if (INTERPRETER_FETCH.test(codeOnly)) continue;
    for (let k = start; k < j; k++) drop[k] = true;
  }

  let out = '';
  for (let i = 0; i < n; i++) if (!drop[i]) out += src[i];
  return { text: out, clean };
}

/**
 * #1512: classifies the fetch shapes a `node <file>.mjs` / `bun <file>.mjs`
 * invocation can reach that this scanner otherwise never sees. Resolves the
 * script via `st.resolveSource` (the same hook `source` uses), then looks
 * for the same fetch-shaped substrings `INTERPRETER_FETCH` matches inline.
 * A literal `host: '…'` object field is checked first (the `http.get`/
 * `.request` shape `e2e-probe-http.mjs` uses); a bare `https?://…` literal
 * URL is checked next. Anything neither shape can pin down — no fetch shape
 * at all, an unresolvable file, or a fetch whose host/URL is NOT a literal
 * (a variable, `process.env…`, a template expression) — fails closed: "no
 * fetch shape" passes silently, everything else is an offender. Cached per
 * scanned source (`st.sourced`) so one script invoked from several call
 * sites is read and judged once.
 *
 * #1715: the host/URL literal search runs on `stripNonFetchText(src)`, not
 * raw `src` — a doc-comment mentioning a URL as an example, or a literal URL
 * string handed only to `new URL(…)` (a pure path-join/parse, never network
 * I/O), is not a fetch target and must not be read as one.
 *
 * #1715 round 2 — exactly two guarantees, stated precisely (a round-1
 * review found the previous docstring's "can never hide a REAL `fetch(`
 * call" claim was FALSE — it stripped by raw-text regex with no notion of
 * string/comment context, so a decoy slash-star-space string literal, a
 * real `fetch(…)`, and a star-slash string literal, as three ordinary
 * statements, were read as one giant comment):
 *   1. `stripNonFetchText` only ever drops a character `tagCharacters`
 *      itself tagged `'comment'`, or a `new URL(…)` call whose open/close
 *      parens AND surrounding `new`/`URL(` text are `'code'`-tagged (so a
 *      quote/backtick/regex-slash inside the dropped text always wins over
 *      a `/` that merely looks like a comment delimiter) — this is the
 *      PRIMARY fix, and is what the adversarial fixtures below exercise.
 *   2. INDEPENDENT of (1)'s correctness: if `tagCharacters` could not
 *      tokenize the WHOLE file unambiguously (`clean === false` — an
 *      unterminated string/template/comment/regex at EOF), this function
 *      fails closed UNCONDITIONALLY, before even checking for a fetch
 *      shape. "The tokenizer is uncertain" and "the tokenizer found no
 *      fetch" are different facts, and only the tokenizer-is-correct
 *      guarantee (1) backs the second one — point (2) is what still holds
 *      if (1) ever has a bug this module's own author did not anticipate.
 */
function classifyJsScript(path, st) {
  const key = `\0jsfetch\0${path}`;
  if (st.sourced.has(key)) return null;
  st.sourced.add(key);
  const rawSrc = st.resolveSource(path);
  if (rawSrc === null || rawSrc === undefined)
    return `node/bun script ${path} could not be resolved to classify its fetches`;
  const { text: src, clean } = stripNonFetchText(rawSrc);
  if (!clean)
    return `${path}: could not tokenize unambiguously (unterminated string/template/comment/regex) — fail closed`;
  // #1787: a computed `globalThis`/`window`/`self[…]` access with a
  // non-literal key opens the gate too, even with no `INTERPRETER_FETCH`
  // text anywhere (`globalThis["fe"+"tch"](url)` never spells "fetch").
  if (!INTERPRETER_FETCH.test(src) && !hasComputedGlobalAccess(src) && !hasExtraNetworkShape(src))
    return null;
  const hostMatches = [...src.matchAll(/\bhost\s*:\s*(['"`])([^'"`]*)\1/g)];
  if (hostMatches.length > 0) {
    for (const m of hostMatches) {
      if (!isLoopbackHost(m[2])) return `${path}: fetch to non-loopback host '${m[2]}'`;
    }
    return null;
  }
  const urlMatches = [...src.matchAll(/https?:\/\/[^\s'"`)]+/g)];
  if (urlMatches.length > 0) {
    for (const m of urlMatches) {
      if (!isLoopbackUrl(m[0])) return `${path}: fetch of ${m[0]}`;
    }
    return null;
  }
  return `${path}: fetch-shaped call with no literal host/URL to classify (fail closed)`;
}

/**
 * #1787 / #1801 round 3 (fix 4): the aliasing shapes `INTERPRETER_FETCH`'s
 * bare `\bfetch\b` cannot catch — the fetch-capable reference is reached
 * through a COMPUTED member access on a global object (`globalThis`/
 * `window`/`self`), whose bracketed key is not a single string/number
 * literal. Such a key could evaluate to `fetch` (or anything else) at
 * runtime, so it is unclassifiable REGARDLESS of what the key actually
 * spells — fail closed on the shape itself, not on recognizing "fetch"
 * inside it. A literal key (`globalThis["fetch"]`) is NOT this function's
 * concern: it contains the literal substring `fetch` and is already caught
 * by `INTERPRETER_FETCH`'s bare-word match. Four spellings of "a reference
 * to one of these three globals", each independently matched:
 *   - direct, with or without optional chaining: `globalThis[k]`,
 *     `globalThis?.[k]`;
 *   - parenthesized: `(globalThis)[k]`, `(window)?.[k]`;
 *   - aliased: `const g = globalThis; g[k]` — a FIRST PASS collects every
 *     `IDENT = globalThis|window|self` assignment (the RHS must be the bare
 *     identifier, not `globalThis.foo` — a terminator char after it,
 *     checked below, excludes that), then the SAME bracket check runs
 *     against every alias name too, exactly as it would against the
 *     literal global name;
 *   - `Reflect.get(globalThis, k)` — a computed access spelled as a
 *     function call instead of `[...]`; the second ARGUMENT is the key,
 *     bounded by the first top-level comma or the call's own closing paren
 *     (`callArgSpanEnd`), not by a matching `]`.
 * Scans with hand-rolled balance walks (quote-aware, so a `]`/`[`/`,`/`)`
 * inside a string key never miscounts) — deliberately NOT `tagCharacters`-
 * based, so this same function works unchanged on BOTH a followed `.mjs`/
 * `.cjs`/`.js` source (JS) and a joined shell-word string (an inline
 * `node -e '…'`/`bun -e '…'` payload, not real JS lexing). Over-
 * approximating (treating any non-plain-literal key as computed) only ever
 * makes the scan stricter — consistent with this module's stated design.
 */
/**
 * True iff `s` is EXACTLY one quoted string literal (no concatenation, no
 * early close) or a plain number — the only two bracketed-key shapes
 * `hasComputedGlobalAccess` treats as "not computed". A naive
 * `/^(['"\`])(?:[^\\]|\\.)*\1$/` regex is NOT sufficient here: `[^\\]`
 * happily matches an interior unescaped quote too, so it would wrongly
 * accept `"fe" + "tch"` as a single literal (it starts and ends with `"`
 * with no backslash anywhere) — exactly the shape #1787 must flag. This
 * walks the string and rejects the moment the SAME quote character closes
 * before the final character.
 */
function isSinglePlainLiteral(s) {
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  if (s.length < 2) return false;
  const q = s[0];
  if (q !== '"' && q !== "'" && q !== '`') return false;
  if (s[s.length - 1] !== q) return false;
  let i = 1;
  while (i < s.length - 1) {
    if (s[i] === '\\') {
      i += 2;
      continue;
    }
    if (s[i] === q) return false; // closes before the end — not a single literal
    i++;
  }
  return true;
}

/**
 * Quote-aware balanced-bracket walk: `start` is the index right AFTER an
 * already-consumed `openChar`; returns the index right AFTER the matching
 * `closeChar`, or -1 if `text` ends before depth returns to 0 (unterminated
 * — the caller skips it, consistent with every other "not this function's
 * rule to flag" unterminated case in this module).
 */
function balancedSpanEnd(text, start, openChar, closeChar) {
  let depth = 1;
  let j = start;
  let inStr = null;
  while (j < text.length && depth > 0) {
    const c = text[j];
    if (inStr) {
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      j++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      j++;
      continue;
    }
    if (c === openChar) depth++;
    else if (c === closeChar) depth--;
    j++;
  }
  return depth === 0 ? j : -1;
}

/**
 * Quote-aware scan for a function-call ARGUMENT's end, starting right after
 * the argument's own first character: a top-level (depth-0) `,` or the
 * call's own closing `)` — whichever comes first — ends the argument. Any
 * nested `(`/`[`/`{` the argument itself opens is balanced before depth can
 * return to 0, so `Reflect.get(g, fn(a, b))` does not mistake `fn`'s inner
 * comma for the end of `Reflect.get`'s own second argument. Returns -1 if
 * `text` ends first (unterminated).
 */
function callArgSpanEnd(text, start) {
  let depth = 0;
  let j = start;
  let inStr = null;
  while (j < text.length) {
    const c = text[j];
    if (inStr) {
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      j++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      j++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      j++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return j;
      depth--;
      j++;
      continue;
    }
    if (c === ',' && depth === 0) return j;
    j++;
  }
  return -1;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function hasComputedGlobalAccess(text) {
  // #1801 (final round): `global` joins `globalThis`/`window`/`self` as a
  // fourth direct global-object name — Node's own legacy alias, matched the
  // same as the other three everywhere below (`global[k]`).
  const names = new Set(['globalThis', 'window', 'self', 'global']);
  // #1801 (final round): the alias RHS may be parenthesized
  // (`const g = (globalThis)`) — the previous pattern required the bare
  // identifier immediately after `=`, so a wrapping paren broke the match.
  for (const m of text.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*=\s*\(?\s*(?:globalThis|window|self|global)\s*\)?(?=[;,\n)]|$)/g,
  )) {
    names.add(m[1]);
  }
  const alt = [...names].map(escapeRe).join('|');

  const bracketRes = [
    new RegExp(`\\b(?:${alt})\\s*(?:\\?\\.)?\\s*\\[`, 'g'),
    new RegExp(`\\(\\s*(?:${alt})\\s*\\)\\s*(?:\\?\\.)?\\s*\\[`, 'g'),
    // #1801 (final round): a sequence (comma) expression ending in the
    // global reference — `(0, globalThis)[k]` — never binds an alias name
    // at all, so it has to be matched structurally like the plain-paren
    // form above, just with an arbitrary leading expression before the comma.
    new RegExp(`\\([^()]*,\\s*(?:${alt})\\s*\\)\\s*(?:\\?\\.)?\\s*\\[`, 'g'),
  ];
  for (const re of bracketRes) {
    for (const m of text.matchAll(re)) {
      const start = m.index + m[0].length;
      const end = balancedSpanEnd(text, start, '[', ']');
      if (end === -1) continue;
      const inner = text.slice(start, end - 1).trim();
      if (!isSinglePlainLiteral(inner)) return true;
    }
  }

  // #1801 (final round): `Object.getOwnPropertyDescriptor(globalThis, k)` is
  // the same "computed access spelled as a function call" shape
  // `Reflect.get` already covers, under a different name.
  const reflectRe = new RegExp(
    `\\b(?:Reflect\\s*\\.\\s*get|Object\\s*\\.\\s*getOwnPropertyDescriptor)\\s*\\(\\s*(?:${alt})\\s*,\\s*`,
    'g',
  );
  for (const m of text.matchAll(reflectRe)) {
    const start = m.index + m[0].length;
    const end = callArgSpanEnd(text, start);
    if (end === -1) continue;
    const inner = text.slice(start, end).trim();
    if (!isSinglePlainLiteral(inner)) return true;
  }

  // #1801 (final round): destructuring a computed key straight off the
  // global object — `const {[k]: f} = globalThis` — reads `globalThis[k]`
  // without ever spelling a `[...]` access on `globalThis` itself; the
  // bracket sits inside the destructuring PATTERN on the left of `=`, not on
  // the global reference on the right.
  const destructureRe = new RegExp(`\\{[^{}]*\\[([^\\]]+)\\][^{}]*\\}\\s*=\\s*(?:${alt})\\b`, 'g');
  for (const m of text.matchAll(destructureRe)) {
    if (!isSinglePlainLiteral(m[1].trim())) return true;
  }
  return false;
}

/**
 * #1801 (final round): a `child_process` `exec`/`execSync`/`spawn`/
 * `spawnSync` call whose own argument text mentions `curl`/`wget` — the
 * fetch happens in a CHILD process this scanner would otherwise never read,
 * because it only ever classifies the JS source text itself, never what it
 * spawns. Requires the module to actually be imported/required so an
 * unrelated local function literally named `exec` does not false-positive;
 * requiring BOTH halves (the import AND the curl/wget mention inside a
 * call) keeps this narrow rather than flagging every `child_process` use.
 */
function hasChildProcessNetworkExec(text) {
  if (!/require\(\s*['"`]child_process['"`]\s*\)|from\s*['"`]child_process['"`]/.test(text))
    return false;
  for (const m of text.matchAll(/\b(?:exec|execSync|spawn|spawnSync)\s*\(([^)]*)\)/g)) {
    if (/\b(?:curl|wget)\b/.test(m[1])) return true;
  }
  return false;
}

/**
 * #1801 (final round): the Python equivalent of `hasChildProcessNetworkExec`
 * — a `subprocess.run`/`call`/`check_call`/`check_output`/`Popen` call whose
 * own argument text mentions `curl`/`wget`.
 */
function hasSubprocessNetworkExec(text) {
  if (!/\bsubprocess\b/.test(text)) return false;
  for (const m of text.matchAll(
    /\bsubprocess\s*\.\s*(?:run|call|check_call|check_output|Popen)\s*\(([^)]*)\)/g,
  )) {
    if (/\b(?:curl|wget)\b/.test(m[1])) return true;
  }
  return false;
}

/**
 * #1801 (final round): the alias/destructuring shapes of `https`/`http`/
 * `undici` that `INTERPRETER_FETCH`'s literal substring matches cannot
 * reach — none of `const h = require('node:https'); h.get(...)`,
 * `require('https').get(...)` (now covered directly by
 * `REQUIRE_FETCH_MODULE_RE`, kept here too for the aliased-identifier form),
 * `const {request} = require('undici')`, `import {request} from 'undici'`,
 * or `import * as u from 'undici'; u.request(...)` ever spell the literal
 * substring `https?\.get`/`https?\.request`/`undici\s*\.\s*(request|fetch)`
 * `INTERPRETER_FETCH` matches directly — the identifier bound to the module
 * is either a local alias or a destructured function reference.
 */
function hasAliasedModuleNetworkCall(text) {
  const httpAliases = new Set();
  for (const m of text.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"`](?:node:)?https?['"`]\s*\)/g,
  ))
    httpAliases.add(m[1]);
  for (const m of text.matchAll(
    /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+['"`](?:node:)?https?['"`]/g,
  ))
    httpAliases.add(m[1]);
  for (const a of httpAliases) {
    if (new RegExp(`\\b${escapeRe(a)}\\s*\\.\\s*(?:get|request)\\b`).test(text)) return true;
  }

  const undiciAliases = new Set();
  for (const m of text.matchAll(
    /\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s+['"`]undici['"`]/g,
  ))
    undiciAliases.add(m[1]);
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"`]undici['"`]\s*\)/g))
    undiciAliases.add(m[1]);
  for (const a of undiciAliases) {
    if (new RegExp(`\\b${escapeRe(a)}\\s*\\.\\s*(?:request|fetch)\\b`).test(text)) return true;
  }

  if (/\{[^}]*\brequest\b[^}]*\}\s*=\s*require\(\s*['"`]undici['"`]\s*\)/.test(text)) return true;
  if (/\bimport\s*\{[^}]*\brequest\b[^}]*\}\s*from\s*['"`]undici['"`]/.test(text)) return true;
  return false;
}

/**
 * #1801 (final round): dynamic code (`eval(…)`, `new Function(…)`) can
 * construct and run any of the above shapes as a STRING, which no literal
 * scan can ever classify — gated here as a pure widener (never a positive
 * identification of a fetch target), consistent with this module's
 * documented "unclassifiable → fail closed" treatment of every shape the
 * walk cannot follow. Bundles the four sibling network shapes above, each on
 * its own line so the mutation prover can disable one without the others.
 */
export function hasExtraNetworkShape(text) {
  if (/\beval\s*\(/.test(text)) return true;
  if (/\bnew\s+Function\s*\(/.test(text)) return true;
  if (hasChildProcessNetworkExec(text)) return true;
  if (hasSubprocessNetworkExec(text)) return true;
  if (hasAliasedModuleNetworkCall(text)) return true;
  return false;
}

export function isFetchSegment(ws, st) {
  for (let k = 0; k < ws.length; k++) {
    const w = canonical(ws[k], st.vars).replace(/^\\/, '');
    const base = w.split('/').pop();
    if (base === 'gh' && /^(api|release|run)$/.test(unquote(ws[k + 1] ?? ''))) return true;
    if (
      INTERPRETERS.has(base) &&
      (INTERPRETER_FETCH.test(ws.slice(k + 1).join(' ')) ||
        hasComputedGlobalAccess(ws.slice(k + 1).join(' ')) ||
        hasExtraNetworkShape(ws.slice(k + 1).join(' ')))
    )
      return true;
    if (!FETCH_WORDS.has(base)) continue;
    // Every fetcher is a taint source — a loopback URL included: `localhost`
    // is only local until a port-forward, `--connect-to`, `--resolve`, a proxy
    // or a Host header says otherwise, and `kubectl exec … curl` reads
    // whatever the pod serves. There is NO generic "loopback scalar" carve-out:
    // a fetched value can carry newlines, `---` and arbitrary YAML, so it can
    // never be interpolated into a document. The few real sites that do it are
    // named, byte-exact, in STATEMENT_ALLOWLIST.
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Unclassified remote fetches (#1410 round 5)
// ---------------------------------------------------------------------------

/**
 * Remote-fetch shapes the taint walk CANNOT follow, reported as
 * "unclassified remote fetch" rather than passed. The walk tracks what curl,
 * wget and friends write (`-o`, redirects, tee, pipes); these shapes write or
 * run remote content through a channel it never sees — an interpreter's own
 * file I/O, a cloned tree, a helm chart cache, a script piped into a shell.
 * Allowlisted shapes (below) must each match exactly once in the real tree.
 *
 * Each rule is its own line so the mutation prover can remove it alone.
 */
export function unclassifiedFetch(ws, st, { pipedFromNetwork = false, depth = 0 } = {}) {
  const u = ws.map(unquote);
  for (let k = 0; k < u.length; k++) {
    const b = u[k].split('/').pop();
    const args = u.slice(k + 1);
    const why = fetchShape(b, args, ws.slice(k + 1), st, pipedFromNetwork, depth);
    if (why) return why;
  }
  return null;
}

function fetchShape(b, args, rawArgs, st, pipedFromNetwork, depth) {
  if (
    INTERPRETERS.has(b) &&
    (INTERPRETER_FETCH.test(args.join(' ')) ||
      hasComputedGlobalAccess(args.join(' ')) ||
      hasExtraNetworkShape(args.join(' ')))
  )
    return interpreterFetch(b);
  // #1512/#1715: `node <file>.mjs` / `bun <file>.mjs` moves a fetch OUT of
  // shell text into a JS file this module never reads — the escape hatch F6
  // (#1497) used legitimately. Follow it, opt-in on BOTH `st.followScripts`
  // and `st.resolveSource`, so no existing caller sees new noise by default.
  // Only the FIRST argument is checked (`node script.mjs …`, `bun
  // script.mjs`), never any `.mjs`-suffixed word anywhere in the command —
  // `bun build --compile … ./entry.mjs --outfile x` COMPILES a file, it does
  // not RUN it, and must not be misread as one. #1715 widens this to
  // `.js`/`.cjs` targets too (same follow, same fail-closed shape) — plain
  // CommonJS/`.js` tooling scripts invoked from workflow `run:` steps are the
  // common case, not just `.mjs`.
  //
  // #1715: also gated on `st.hasApplyAnywhere` — UNIQUELY to this branch,
  // not the other `unclassifiedFetch` shapes below. This rule exists
  // specifically to close the #1497/F6 escape hatch (a fetch moved out of
  // shell text so it can feed an apply undetected); a followed script in a
  // unit with NO apply anywhere cannot feed one. `curl | sh`, `git clone`,
  // `gh release download`, a remote helm chart etc. stay UNGATED: those are
  // independently dangerous (arbitrary fetched code execution) whether or
  // not an apply is nearby, which is exactly what the fixtures below
  // (helmRemoteChart, curlPipeSh, …) assert with no apply in sight.
  if (
    (b === 'node' || b === 'bun') &&
    st.followScripts &&
    st.resolveSource &&
    st.hasApplyAnywhere
  ) {
    const first = args[0] ?? '';
    if (/\.(mjs|cjs|js)$/.test(first) && !/[$`]/.test(first)) {
      const why = classifyJsScript(first, st);
      if (why) return why;
    }
  }
  if (b === 'git' && gitFetches(args)) return 'git fetches a remote repository';
  if (b === 'gh' && ghDownloads(args)) return 'gh downloads a release/repo/run artifact';
  if (b === 'helm' && helmFetches(args)) return 'helm pulls a remote chart or repo index';
  if (pipedFromNetwork && runsStdinAsCode(b, args)) return `${b} executes piped network content`;
  if (runsNetworkCode(b, rawArgs, st, depth)) return `${b} executes network content`;
  return null;
}

const interpreterFetch = (b) => `${b} fetches in-process (the files it writes are invisible)`;

/** First non-option word, skipping the values of `-C`/`-c`-style options. */
function subcommand(args, valued) {
  for (let k = 0; k < args.length; k++) {
    if (valued.has(args[k])) {
      k++;
      continue;
    }
    if (!args[k].startsWith('-')) return { sub: args[k], rest: args.slice(k + 1) };
  }
  return { sub: '', rest: [] };
}

const hasRemoteArg = (args) => args.some((a) => REMOTE_ARG_RE.test(a));

/** git clone options that take a separate value (so it is not the source). */
const CLONE_VALUED = new Set(
  '-b --branch --depth -o --origin --reference --config -c --jobs -j --separate-git-dir --template --filter'.split(
    ' ',
  ),
);

/**
 * A clone whose source is a plain filesystem path (no `://`, no `host:` form,
 * no variable) reads a local repository, not a remote one.
 */
function cloneSourceIsLocalPath(rest) {
  const { sub: source } = subcommand(rest, CLONE_VALUED);
  return source !== '' && !/:\/\//.test(source) && !/^[^/]*:/.test(source) && !/[$`]/.test(source);
}

function gitFetches(args) {
  const { sub, rest } = subcommand(args, new Set(['-C', '-c', '--git-dir', '--work-tree']));
  if (sub === 'svn') return true;
  if (sub === 'clone') return !cloneSourceIsLocalPath(rest);
  if (/^(fetch|pull|ls-remote|archive|submodule|remote)$/.test(sub)) return hasRemoteArg(rest);
  return false;
}

function ghDownloads(args) {
  const { sub, rest } = subcommand(args, new Set(['-R', '--repo']));
  const verb = rest.find((a) => !a.startsWith('-')) ?? '';
  return /^(release|run|attestation)$/.test(sub)
    ? verb === 'download'
    : /^(repo|gist)$/.test(sub) && verb === 'clone';
}

function helmFetches(args) {
  const { sub, rest } = subcommand(args, new Set(['-n', '--namespace', '--kube-context']));
  const verb = rest.find((a) => !a.startsWith('-')) ?? '';
  if (sub === 'repo') return verb === 'add' || verb === 'update';
  if (sub === 'pull' || sub === 'fetch' || sub === 'dependency' || sub === 'dep') return true;
  return hasRemoteArg(rest) || rest.some((a) => /^--repo(=|$)/.test(a));
}

/** A shell or interpreter that reads its PROGRAM from stdin (`sh`, `bash -s`, `python3 -`). */
function runsStdinAsCode(b, args) {
  const nonOpt = args.filter((a) => !a.startsWith('-'));
  if (EXEC_STRING_SHELLS.has(b))
    return !args.some((a) => /^-[a-z]*c$/.test(a)) && (nonOpt.length === 0 || args.includes('-s'));
  if (INTERPRETERS.has(b))
    return !args.some((a) => /^-(c|e|p)$/.test(a)) && (nonOpt.length === 0 || args.includes('-'));
  return false;
}

/** `bash <(curl …)`, `source <(curl …)`, `sh -c "$(curl …)"`, `bash fetched.sh`. */
function runsNetworkCode(b, rawArgs, st, depth) {
  const shellLike = EXEC_STRING_SHELLS.has(b) || b === 'source' || b === '.' || b === 'eval';
  if (!shellLike && !INTERPRETERS.has(b)) return false;
  const judged = shellLike
    ? rawArgs
    : rawArgs.filter((a) => !unquote(a).startsWith('-')).slice(0, 1);
  return judged.some(
    (w) =>
      innerSubstitutions(w).some((inner) => textIsNetwork(inner, st, depth + 1)) ||
      isTaintedPath(canonical(w, st.vars), st),
  );
}

/** Rebases a nested source's heredoc placeholders onto `st.heredocs`. */
function adoptHeredocs(code, heredocs, st) {
  const base = st.heredocs.length;
  st.heredocs.push(...heredocs);
  return code.replace(/<<__HD(\d+)__/g, (_, n) => `<<__HD${Number(n) + base}__`);
}

/** Lexes a nested script (a heredoc fed to a shell) and walks it as code. */
function walkScript(text, st, ctx) {
  const { code, heredocs, error } = lex(text);
  if (error) {
    offend(st, 'unparseable', `${error} in a script fed to a shell`);
    return;
  }
  const { code: top, functions } = extractFunctions(adoptHeredocs(code, heredocs, st));
  for (const [n, b] of functions) if (!st.functions.has(n)) st.functions.set(n, b);
  walk(top, st, ctx);
}

/** `ssh [opts] host` with no remote command (or a shell) runs its stdin remotely. */
const SSH_VALUED = new Set('bcDEeFIiJLlmOopQRSWw'.split('').map((c) => `-${c}`));
function sshRunsStdin(args) {
  const { rest } = subcommand(args, SSH_VALUED);
  const cmd = rest.find((a) => !a.startsWith('-'));
  return (
    cmd === undefined || runsStdinAsCode(cmd.split('/').pop(), rest.slice(rest.indexOf(cmd) + 1))
  );
}

/**
 * The stdin bodies (heredocs, here-strings) a segment executes as a program,
 * and what runs them: 'shell' (a local shell, `ssh host`, `docker exec -i c sh`)
 * or an interpreter name (`node - <<EOF`), whose body is not shell.
 */
/** Drops redirections — and a bare operator's target word — from unquoted args. */
function withoutRedirects(args) {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    if (/^(\d*|&)?(<<<|<<-?|<|>>|>\|?)$/.test(args[k])) k++;
    else if (!/^(\d*|&)?[<>]/.test(args[k])) out.push(args[k]);
  }
  return out;
}

function scriptBodies(ws, st) {
  const u = ws.map(unquote);
  let runner = null;
  for (let k = 0; k < u.length && runner === null; k++) {
    const b = u[k].split('/').pop();
    const args = withoutRedirects(u.slice(k + 1));
    if (
      (b === 'ssh' && sshRunsStdin(args)) ||
      (EXEC_STRING_SHELLS.has(b) && runsStdinAsCode(b, args))
    )
      runner = 'shell';
    else if (runsStdinAsCode(b, args)) runner = b;
  }
  if (runner === null) return { runner, bodies: [] };
  const out = [];
  for (let k = 0; k < ws.length; k++) {
    const hd = ws[k].match(/^<<__HD(\d+)__$/);
    if (hd) out.push(st.heredocs[Number(hd[1])]?.body ?? '');
    else if (ws[k] === '<<<') out.push(unquote(ws[k + 1] ?? ''));
    else if (ws[k].startsWith('<<<')) out.push(unquote(ws[k].slice(3)));
  }
  return { runner, bodies: out };
}

/** `source f` / `. f`: adopt f's functions, or remember that it could not be read. */
function loadSource(word, st) {
  if (/^[<>]\(/.test(word)) return; // `source <(curl …)` is judged by runsNetworkCode
  const path = canonical(word, st.vars);
  if (st.sourced.has(path)) return;
  st.sourced.add(path);
  const text = st.resolveSource ? st.resolveSource(path) : null;
  if (text === null || text === undefined) {
    st.unresolvedSource = st.unresolvedSource ?? path;
    return;
  }
  const { code, heredocs, error } = lex(text);
  if (error) {
    offend(st, 'unparseable', `${error} in sourced ${path}`);
    return;
  }
  const adopted = adoptHeredocs(code, heredocs, st);
  st.corpus.push(adopted, ...heredocWriteText(heredocs));
  const { code: sourcedTop, functions: sourcedFns } = extractFunctions(adopted);
  for (const [n, fn] of sourcedFns) if (!st.functions.has(n)) st.functions.set(n, fn);
  // #1716: a sourced file's own top level (and its unquoted heredocs' own
  // expansions, same as the main file's) runs in the including script's
  // global scope, same as `scopedTexts` treats the main file's.
  st.topLevelText = `${st.topLevelText}\n${sourcedTop}\n${heredocWriteText(heredocs).join('\n')}`;
}

/** A call that may resolve into an unread sourced file, handed a remote URL. */
function unresolvedCallWithUrl(ws, st) {
  if (st.unresolvedSource === null) return false;
  const cmd = unquote(ws[0] ?? '');
  if (!/^[A-Za-z_][\w-]*$/.test(cmd) || st.functions.has(cmd)) return false;
  if (NON_FETCHING.has(cmd) || FETCH_WORDS.has(cmd)) return false;
  return hasRemoteArg(ws.slice(1).map((w) => canonical(w, st.vars)));
}

/**
 * Whether a text fragment (a producer, an inner `$(…)`, a heredoc's
 * expansions) carries network content. Returns a reason string (truthy) or
 * false, so an offender says WHY.
 */
export function textIsNetwork(text, st, depth, { urlLiteralCounts = true, seen = new Set() } = {}) {
  if (depth > MAX_DEPTH) return 'nesting too deep to classify'; // fail closed
  const opts = { seen };
  const { code } = lex(text);
  for (const cl of splitClauses(code)) {
    for (const seg of splitPipeline(cl.text)) {
      const ws = words(seg);
      if (isFetchSegment(ws, st)) return `fetch command in \`${seg.slice(0, 80)}\``;
      // `envsubst` (with no name list, or naming a tainted var) substitutes
      // every EXPORTED shell variable into its stdin/template — a value
      // fetched over the network and exported reaches the output the same as
      // any other producer of network content would (#1466.2).
      const envsubstBase = unquote(ws[0] ?? '')
        .split('/')
        .pop();
      if (envsubstBase === 'envsubst') {
        const named = withoutRedirects(ws.slice(1)).filter((w) => !unquote(w).startsWith('-'));
        const names =
          named.length > 0
            ? named.flatMap((w) =>
                unquote(w)
                  .split(/[:,]/)
                  .map((n) => n.replace(/^\$/, '')),
              )
            : null;
        for (const [name, v] of st.vars) {
          if (!v.exported || !v.content) continue;
          if (names && !names.includes(name)) continue;
          return `envsubst substitutes $${name}, which holds network content`;
        }
      }
      for (let k = 0; k < ws.length; k++) {
        const w = ws[k];
        const u = unquote(w);
        if (st.functions.has(u)) {
          // Judge the helper with THIS call's arguments, as inlineCall does;
          // a shift-using helper keeps its positionals unresolved (stricter).
          const raw = st.functions.get(u);
          const args = ws
            .slice(k + 1)
            .filter((a) => !/^(\d*|&)?[<>]/.test(a))
            .map(unquote);
          const body = /(^|[\s;])shift\b/.test(raw) ? raw : substituteArgs(raw, args);
          const key = `${u}\0${args.join('\0')}`;
          if (!seen.has(key) && !seen.has(u)) {
            seen.add(key);
            seen.add(u);
            const why = textIsNetwork(body, st, depth + 1, opts);
            seen.delete(u);
            if (why) return `${u}(): ${why}`;
          }
        }
        for (const inner of innerSubstitutions(w)) {
          const why = textIsNetwork(inner, st, depth + 1, opts);
          if (why) return why;
        }
        const c = canonical(w, st.vars);
        // A URL handed to a command AS AN ARGUMENT (kustomize build URL,
        // helm template URL, an unknown fetcher) is network content; a URL
        // embedded inside a larger word (a sed expression) is text.
        if (urlLiteralCounts && /^https?:\/\//.test(c) && !isLoopbackUrl(c))
          return `URL argument ${c}`;
        if (isTaintedPath(c, st)) return `reads network-fetched file ${c}`;
        const wholeVar = u.match(/^\$\{?([A-Za-z_]\w*)\}?$/);
        if (urlLiteralCounts && wholeVar && st.vars.get(wholeVar[1])?.url)
          return `URL variable ${u}`;
        for (const r of varRefs(w)) {
          if (st.vars.get(r)?.content) return `variable $${r} holds network content`;
        }
      }
    }
  }
  return false;
}

function innerSubstitutions(w) {
  const out = [];
  for (let i = 0; i < w.length; i++) {
    if (w[i] === '\\') {
      i++; // an escaped `\$(` is literal text, not a substitution
    } else if ((w[i] === '$' || w[i] === '<' || w[i] === '>') && w[i + 1] === '(') {
      let d = 0;
      for (let j = i + 1; j < w.length; j++) {
        if (w[j] === '(') d++;
        else if (w[j] === ')') {
          d--;
          if (d === 0) {
            const inner = w
              .slice(i + 2, j)
              .replace(/^\(/, '')
              .replace(/\)$/, '');
            // `$(<file)` reads file exactly as `$(cat file)` does.
            out.push(
              w[i] === '$' && /^\s*<(?![<(])/.test(inner) ? inner.replace(/^\s*</, 'cat ') : inner,
            );
            i = j;
            break;
          }
        }
      }
    } else if (w[i] === '`') {
      const j = w.indexOf('`', i + 1);
      if (j > i) {
        out.push(w.slice(i + 1, j));
        i = j;
      }
    }
  }
  return out;
}

function pathMatches(a, b) {
  if (a === b) return true;
  const strip = (s) => s.replace(/\/+$/, '');
  const A = strip(a);
  const B = strip(b);
  if (A === B) return true;
  if (A.startsWith(`${B}/`) || B.startsWith(`${A}/`)) return true;
  if (A.endsWith(`/${B}`) || B.endsWith(`/${A}`)) return true;
  if (/[*?[]/.test(B)) {
    const re = new RegExp(
      `^${B.replace(/[.+^${}()|\\[\]]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
    );
    if (re.test(A)) return true;
  }
  return false;
}

function isTaintedPath(c, st) {
  for (const t of st.tainted) if (pathMatches(t, c)) return true;
  return false;
}

/** Every path a segment writes: redirects, tee args, and fetch-output flags. */
function writtenPaths(ws, st, isFetch) {
  const out = [];
  const url = ws.map((w) => canonical(w, st.vars)).find((w) => URL_RE.test(w));
  const urlBase = url
    ? url
        .replace(/[?#].*$/, '')
        .split('/')
        .filter(Boolean)
        .pop()
    : null;
  let outDir = null;
  let remoteName = false;
  for (let k = 0; k < ws.length; k++) {
    const raw = ws[k];
    const w = unquote(raw);
    const redir = w.match(/^(?:\d*|&)>{1,2}\|?(.*)$/);
    if (redir && !w.startsWith('>(')) {
      const target = redir[1] || unquote(ws[k + 1] ?? '');
      if (target && !/^&\d$/.test(target) && target !== '/dev/null')
        out.push(canonical(target, st.vars));
      if (!redir[1]) k++;
      continue;
    }
    if (w === 'tee' || w.endsWith('/tee')) {
      for (let j = k + 1; j < ws.length; j++) {
        const a = unquote(ws[j]);
        if (!a.startsWith('-')) out.push(canonical(ws[j], st.vars));
      }
      break;
    }
    if (!isFetch) continue;
    let m = w.match(/^--(?:output|output-document)(?:=(.*))?$/);
    if (m) {
      out.push(canonical(m[1] ?? ws[++k] ?? '', st.vars));
      continue;
    }
    m = w.match(/^--(?:output-dir|directory-prefix)(?:=(.*))?$/);
    if (m) {
      outDir = canonical(m[1] ?? ws[++k] ?? '', st.vars);
      continue;
    }
    if (w === '--remote-name' || w === '--remote-name-all') {
      remoteName = true;
      continue;
    }
    m = w.match(/^-([A-Za-z]+)(.*)$/);
    if (m && !w.startsWith('--')) {
      const letters = m[1];
      const oIdx = letters.search(/[oOP]/);
      if (oIdx !== -1) {
        const attached = letters.slice(oIdx + 1) + m[2];
        const flag = letters[oIdx];
        const val = attached !== '' ? attached : unquote(ws[k + 1] ?? '');
        if (attached === '') k++;
        if (flag === 'P') outDir = canonical(val, st.vars);
        else if (flag === 'O' && attached === '' && !isWget(ws)) {
          // curl -O: remote name; the next word was not a value, give it back.
          k--;
          remoteName = true;
        } else if (val && val !== '-') out.push(canonical(val, st.vars));
        // Over-approximate: every letter after o/O in a cluster could be the
        // value, so the whole attached remainder is ALSO recorded above.
      }
    }
  }
  if (isFetch && urlBase) {
    if (remoteName || isWget(ws) || outDir) out.push(outDir ? `${outDir}/${urlBase}` : urlBase);
  }
  return out.filter(Boolean);
}

function isWget(ws) {
  return ws.some((w) => unquote(w).split('/').pop() === 'wget');
}

/**
 * #1715: a coarse, line-based pre-scan for "does this text contain a
 * manifest apply anywhere" (`kubectl apply|create|replace -f/-k`, or
 * equivalent) — gates `unclassifiedFetch`'s fail-closed rules. Deliberately
 * cheap and approximate (joins `\`-continued lines, splits on whitespace,
 * reuses `applyTargets` per line) rather than a full shell parse: a false
 * POSITIVE here only means the gate stays open (no behavior change from
 * before #1715), and a false NEGATIVE would need an apply verb to appear
 * nowhere near its own `-f`/`-k` flag on one logical line, which no real
 * apply call in this tree does.
 */
function textHasManifestApply(text) {
  const joined = String(text).replace(/\\\r?\n\s*/g, ' ');
  for (const line of joined.split(/\r?\n/)) {
    const words = line
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/^["']|["']$/g, ''));
    if (words.length > 0 && applyTargets(words)) return true;
  }
  return false;
}

/** Locates the apply verb and returns every -f/-k target after it, or null if the segment is not a manifest apply. */
export function applyTargets(ws) {
  let v = -1;
  for (let k = 0; k < ws.length; k++) {
    if (APPLY_VERBS.has(ws[k])) {
      v = k;
      break;
    }
  }
  if (v === -1) return null;
  const targets = [];
  for (let k = v + 1; k < ws.length; k++) {
    const w = unquote(ws[k]);
    let m = w.match(/^--(filename|kustomize)(?:=(.*))?$/);
    if (m) {
      targets.push({
        raw: m[2] !== undefined ? ws[k].replace(/^--\w+=/, '') : (ws[++k] ?? ''),
        kustomize: m[1] === 'kustomize',
      });
      continue;
    }
    m = ws[k].match(/^-([A-Za-z]*?)([fk])(=?)(.*)$/);
    if (m && !ws[k].startsWith('--')) {
      const attached = m[4];
      if (attached !== '' || m[3] === '=') targets.push({ raw: attached, kustomize: m[2] === 'k' });
      else targets.push({ raw: ws[++k] ?? '', kustomize: m[2] === 'k' });
    }
  }
  return targets.length > 0 ? targets : null;
}

function recordAssignments(ws, st, depth) {
  let k = 0;
  let nameref = false;
  const exported = ws[0] === 'export';
  if (['export', 'local', 'declare', 'readonly', 'typeset'].includes(ws[0])) {
    k = 1;
    while (ws[k]?.startsWith('-')) {
      if (/^-[A-Za-z]*n/.test(ws[k])) nameref = true;
      k++;
    }
  }
  let any = false;
  for (; k < ws.length; k++) {
    // `export NAME` (no `=`): marks an already-set var exported, without
    // touching its value/taint.
    if (exported) {
      const bare = ws[k].match(/^([A-Za-z_]\w*)$/);
      if (bare) {
        any = true;
        const prev = st.vars.get(bare[1]);
        if (prev) st.vars.set(bare[1], { ...prev, exported: true });
        continue;
      }
    }
    const m = ws[k].match(/^([A-Za-z_]\w*)=(.*)$/s);
    if (!m) break;
    any = true;
    const value = m[2];
    const expanded = canonical(value, st.vars);
    const refs = varRefs(value)
      .map((r) => st.vars.get(r))
      .filter(Boolean);
    const content =
      innerSubstitutions(value).some((inner) => textIsNetwork(inner, st, depth + 1)) ||
      refs.some((r) => r.content) ||
      (!!st.vars.get('@')?.content && hasPositional(value));
    if (nameref) {
      // `declare -n R=V`: `$R` reads V at RUN time; nothing static says what
      // V will hold then, so R is network content (fail closed).
      st.vars.set(m[1], { value: undefined, producer: value, url: true, content: true, exported });
      continue;
    }
    st.vars.set(m[1], {
      value,
      url: URL_RE.test(expanded) || refs.some((r) => r.url),
      content,
      exported,
    });
  }
  return any && k >= ws.length;
}

function offend(st, kind, text) {
  st.offenders.push(`${kind}: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`);
}

/**
 * Remote fetches the real tree makes on purpose and that cannot reach a
 * cluster apply. Each entry must match EXACTLY ONE segment across the whole
 * tree (the spec asserts it), so an entry can neither go stale nor quietly
 * grow into a pattern that blesses a new call site.
 */
export const REMOTE_FETCH_ALLOWLIST = [
  {
    id: 'wayfinder-ssr-probe',
    // docs/wayfinder/spike-vinext-ssr-embed/e2e-container-arm.sh: fetches the
    // spike container's SSR page and PRINTS its size/markers; writes no file,
    // and the script applies nothing to any cluster.
    segment:
      /^node -e '\s*const r = await fetch\(process\.argv\[1\]\);\s*const b = await r\.text\(\);/,
  },
  {
    id: 'bun-base-upstream-source',
    // infra/bun-base/build.sh (Cloud Build only): names the upstream Bun repository as `origin` in a
    // fresh local clone. `git remote add` itself contacts nothing (no -f); the fetch that follows,
    // `git fetch -q --depth 1 origin "$UPSTREAM_SHA"`, asks for one commit pinned in the repo and is
    // checked by `test "$(git rev-parse HEAD)" = "$UPSTREAM_SHA"` (tests/bun-base-supply-chain.test.ts
    // enforces that pairing). The tree is only compiled into CI-verification binaries; the script
    // applies nothing to any cluster.
    segment: /^git remote add origin https:\/\/github\.com\/oven-sh\/bun\.git$/,
  },
  {
    id: 'bun-patched-upstream-source',
    // deploy/bun-patched/build.sh (Cloud Build only, #1822): names the upstream Bun repository as
    // `upstream` in a fresh local clone; the fetch that follows asks for the `bun-v1.4.2` tag and
    // is checked by `test "$(git rev-parse HEAD)" = "$UPSTREAM_SHA"` (the commit pinned in
    // deploy/bun-patched/UPSTREAM). The tree is compiled into the opt-in patched Bun toolchain; the
    // script applies nothing to any cluster.
    segment: /^git remote add upstream https:\/\/github\.com\/oven-sh\/bun\.git$/,
  },
  {
    id: 'bun-patched-release-assets',
    // .github/workflows/bun-patched-release.yml (#1822): downloads THIS repo's draft release of the
    // patched Bun toolchain; the very next step checks every binary against
    // deploy/bun-patched/RELEASE.sha256 at the tagged commit (fail closed) before anything is signed
    // or published. Nothing is applied to any cluster.
    segment: /^gh release download "\$TAG" -R "\$GITHUB_REPOSITORY" -D out$/,
  },
  {
    id: 'bun-patched-release-assets-publish',
    // .github/workflows/bun-patched-release.yml, publish job: re-downloads the same draft (the
    // gates ran in other jobs) and re-checks every binary against RELEASE.sha256 at the tagged
    // commit before signing, attesting or publishing it. Nothing is applied to any cluster.
    segment: /^gh release download "\$TAG" -R "\$GITHUB_REPOSITORY" -D out --pattern '\*'$/,
  },
  // #1715 (followScripts enabled for workflow `run:` steps): the four
  // entries below are file-manager-platform-e2e.yml#platform-e2e findings
  // that only exist because `followScripts` can now see workflow steps at
  // all — none is a NEW fetch, each already ran on every nightly/PR e2e
  // round before this change.
  {
    id: 'platform-e2e-http-check',
    // apps/file-manager/scripts/platform-e2e.mjs: makes real HTTP requests,
    // but only to PLATFORM_E2E_BASE_URL — the SAME runner-local Kourier
    // port-forward (http://127.0.0.1:8080) the step just stood up a few
    // lines earlier in this job, to assert the already-deployed app serves
    // correctly. It reads; it never writes a file, let alone one `kubectl
    // apply` could read. (The one non-loopback-shaped literal classifyJsScript
    // can see, `http://x${p}`, is a `new URL(…)` base for client-side path
    // parsing, not a fetch target — see `stripNonFetchText`.)
    segment: /^node apps\/file-manager\/scripts\/platform-e2e\.mjs$/,
  },
  {
    id: 'storage-mode-e2e-http-check',
    // apps/file-manager/scripts/storage-mode-e2e.mjs: same shape as
    // platform-e2e-http-check above, for the storage-mode (object-storage)
    // leg — verifies served asset URLs resolve against the already-running
    // in-cluster MinIO (reached via its own runner-local port-forward) and
    // writes nothing any apply could read. Its only literal host (used
    // purely in a file-header doc comment as a worked example, never
    // fetched) is stripped by `stripNonFetchText` before matching; with no
    // literal fetch target left, the file's genuine `http.request` calls
    // (host comes from env, resolved at runtime) fall through to the
    // "no literal host/URL" fail-closed branch, which this entry covers.
    segment: /^node apps\/file-manager\/scripts\/storage-mode-e2e\.mjs$/,
  },
  {
    id: 'platform-e2e-knext-deploy-image-leg',
    // ../../packages/kn-next/dist/cli/kn-next.js deploy (image-served leg):
    // `dist/` is build output, untracked, so `resolveSource` can never read
    // it — fails closed as "could not be resolved" regardless of what it
    // actually does. What it does is published, reviewed @getknext/core
    // behavior: build, push by digest, and apply the `NextApp` CR per
    // ADR-0001 — never a raw fetched manifest. `--registry`/`--namespace`/
    // `--tag` here are workflow-literal/CI-controlled (`$APP_NS`,
    // `${GITHUB_RUN_ID}`), not attacker- or network-fetched values.
    segment: /localhost:5001 --namespace "\$APP_NS" --tag "\$\{GITHUB_RUN_ID\}"/,
  },
  {
    id: 'platform-e2e-knext-deploy-storage-leg',
    // Same CLI invocation and same justification as
    // platform-e2e-knext-deploy-image-leg above, for the storage-mode leg
    // (`$STORAGE_TAG` in place of `${GITHUB_RUN_ID}`); the AWS_* prefix vars
    // configure the CLI's OWN `aws s3` calls against the runner-local MinIO
    // port-forward, not a fetch this scanner needs to classify.
    segment: /localhost:5001 --namespace "\$APP_NS" --tag "\$STORAGE_TAG"/,
  },
  {
    id: 'rc-scaffold-platform-e2e-http-check',
    // scripts/rc-scaffold-platform-e2e.mjs (the rc-default-scaffold-
    // platform-e2e-weekly.yml#rc-scaffold-platform-e2e job, surfaced only
    // because that job ALSO does `kubectl apply -f -` for an unrelated
    // Secret/scrape-config heredoc). Same shape as platform-e2e-http-check:
    // real HTTP requests, but only to the Kourier/MinIO port-forwards this
    // same job stood up, with the target `host` read back from `kubectl get
    // nextapp … -o jsonpath={.status.url}` — the cluster's own status, not
    // fetched/attacker content — to verify the already-deployed rc app.
    // Writes nothing any apply could read.
    segment: /^node scripts\/rc-scaffold-platform-e2e\.mjs$/,
  },
  {
    id: 'write-free-e2e-http-check',
    // .github/workflows/write-free-runtime-kind-e2e.yml#write-free-e2e reuses
    // the SAME assertion script as rc-scaffold-platform-e2e-http-check above
    // (invoked as `./scripts/…` so each call site matches exactly one entry),
    // with the same justification: HTTP only to the Kourier/MinIO
    // port-forwards this job stood up, host read back from the NextApp's own
    // status. The job's only apply is its own redis/minio heredoc, which
    // reads nothing this script writes (it writes nothing at all).
    segment: /^node \.\/scripts\/rc-scaffold-platform-e2e\.mjs$/,
  },
  {
    id: 'write-free-e2e-knext-create',
    // .github/workflows/write-free-runtime-kind-e2e.yml: `kn-next create` from
    // this commit's build output scaffolds the app under test into
    // $RUNNER_TEMP. `dist/` is untracked build output, so `resolveSource`
    // cannot read it and it fails closed as "could not be resolved" (same as
    // platform-e2e-knext-deploy-image-leg). What it does is published
    // @getknext/core behavior: render templates to local files. It applies
    // nothing to any cluster and fetches nothing an apply reads.
    segment:
      /^node packages\/kn-next\/dist\/cli\/kn-next\.js create "\$APP_DIR" --name "\$APP_NAME"$/,
  },
  {
    id: 'node-redis-e2e-http-check',
    // .github/workflows/node-runtime-redis-kind-e2e.yml#node-redis-e2e reuses
    // the SAME assertion script as the two http-check entries above (invoked
    // as `scripts/./…` so each call site matches exactly one entry), with the
    // same justification: HTTP only to the Kourier/MinIO port-forwards this
    // job stood up, host read back from the NextApp's own status. The job's
    // only apply is its own redis/minio heredoc, which reads nothing this
    // script writes (it writes nothing at all).
    segment: /^node scripts\/\.\/rc-scaffold-platform-e2e\.mjs$/,
  },
  {
    id: 'node-redis-e2e-knext-create',
    // .github/workflows/node-runtime-redis-kind-e2e.yml: the same `kn-next
    // create` from this commit's untracked build output as
    // write-free-e2e-knext-create above (spelled `./packages/…` so each call
    // site matches exactly one entry). It renders templates to local files
    // under $RUNNER_TEMP, applies nothing to any cluster and fetches nothing
    // an apply reads.
    segment:
      /^node \.\/packages\/kn-next\/dist\/cli\/kn-next\.js create "\$APP_DIR" --name "\$APP_NAME"$/,
  },
  {
    id: 'release-audit-npm-closure-fetch',
    // #1801 round 3 (fix 5): release.yml#audit's `node scripts/audit-published.mjs`
    // surfaced ONLY because `audit` is now needs:+artifact-linked into the
    // SAME component as release.yml#release, whose `changesets/action` step
    // passes `publish-script: ${{ steps.gate.outputs.publish }}` — a dynamic
    // expression `changesetsActionStepMightApply` fails closed on (it cannot
    // read what a prior step's own output resolves to at run time). That
    // gate value is a LOCAL boolean/script decision computed entirely inside
    // `release.yml#release` itself (see its own `gate` step) — never
    // influenced by anything `audit-published.mjs` fetches (npm
    // registry/advisory data, written only to `sbom/*.json` and the audit
    // job's own exit code). The two are needs:-linked for ordering only; no
    // data flows from the fetch to the publish gate. `audit-published.mjs`
    // itself makes real network calls (`npm audit`, the registry) but
    // writes only SBOM/audit-report files no apply in this workflow ever
    // reads.
    segment: /^node scripts\/audit-published\.mjs$/,
  },
];

/**
 * Statements that interpolate a value read from an IN-CLUSTER endpoint (the
 * pageserver's own `last_record_lsn`, a `compute_ctl` control blob this drill
 * crafted a few lines earlier) into a manifest that is applied to the same
 * throwaway drill cluster. The statement text is pinned AND so is every source
 * that can feed the variables it interpolates (`sources`). A fetched value can carry newlines and `---`, so
 * this can NEVER be a generic rule ("loopback scalar", "field position",
 * "data not document"): each site is named here, byte-exact, per file.
 *
 * `anchor` is a raw single-line substring of the file that must occur exactly
 * once in it (the spec asserts it), so a copy-pasted second site is red even
 * though the scanner sees it through helper inlining more than once.
 * `statement` is the whole clause exactly as the scanner sees it (line
 * continuations folded, each heredoc body inlined as `<<[body]`). An entry
 * matches only that text in that file, so widening it to a prefix or a
 * pattern is impossible by construction, and the spec asserts every entry is
 * matched by the real tree and its anchor occurs EXACTLY ONCE in its file — an
 * entry that goes stale, or a second copy of the same text, is red.
 */
export const STATEMENT_ALLOWLIST = [
  {
    id: 'lsn-inject-objstore',
    anchor: 'awk -v lsn="$STATIC_LSN"',
    file: 'packages/scale-zero-pg/deploy/_verify-objstore.sh',
    // Every source that can reach a variable this statement interpolates, byte-exact
    // (the scanner follows each variable's assignment and each helper it calls). Any
    // other fetch / URL / network-written file feeding it reds the scan.
    sources: [
      'fetch:$KD exec sts/pageserver -- curl -s "http://localhost:9898/v1/tenant/$TENANT/timeline/$TIMELINE" 2>/dev/null',
    ],
    statement:
      'sed -e "s#safekeeper-0.safekeeper:5454,safekeeper-1.safekeeper:5454,safekeeper-2.safekeeper:5454#safekeeper-0.safekeeper:5454#g"     -e "s/^  namespace: $SRC_NS/  namespace: $DRILL_NS/"     "$COMPUTE_FILES_SRC"   | awk -v lsn="$STATIC_LSN" \'{print} /"format_version": 1.0,/{print "            \\"mode\\": {\\"Static\\": \\"" lsn "\\"},"}\'   | $KD apply -f - >/dev/null',
  },
  {
    id: 'lsn-inject-restore',
    anchor: 'awk -v lsn="$STATIC_LSN"',
    file: 'packages/scale-zero-pg/deploy/_verify-restore.sh',
    // Every source that can reach a variable this statement interpolates, byte-exact
    // (the scanner follows each variable's assignment and each helper it calls). Any
    // other fetch / URL / network-written file feeding it reds the scan.
    sources: [
      'fetch:$KD exec sts/pageserver -- curl -s "http://localhost:9898/v1/tenant/$TENANT/timeline/$TIMELINE" 2>/dev/null',
    ],
    statement:
      'sed -e "s#safekeeper-0.safekeeper:5454,safekeeper-1.safekeeper:5454,safekeeper-2.safekeeper:5454#safekeeper-0.safekeeper:5454#g"     -e "s/^  namespace: $SRC_NS/  namespace: $DRILL_NS/"     "$COMPUTE_FILES_SRC"   | awk -v lsn="$STATIC_LSN" \'{print} /"format_version": 1.0,/{print "            \\"mode\\": {\\"Static\\": \\"" lsn "\\"},"}\'   | $KD apply -f - >/dev/null',
  },
  {
    id: 'lsn-inject-app-restore',
    anchor: 'awk -v lsn="$MODE_LSN"',
    file: 'packages/scale-zero-pg/deploy/_verify-app-restore.sh',
    // Every source that can reach a variable this statement interpolates, byte-exact
    // (the scanner follows each variable's assignment and each helper it calls). Any
    // other fetch / URL / network-written file feeding it reds the scan.
    sources: [
      'fetch:$KUBECTL -n "$_ns" $RT exec sts/pageserver -- curl -s "http://localhost:9898/v1/tenant/$_tn/timeline/$_tl" 2>/dev/null',
    ],
    statement:
      'sed -e "s#safekeeper-0.safekeeper:5454,safekeeper-1.safekeeper:5454,safekeeper-2.safekeeper:5454#safekeeper-0.safekeeper:5454#g"       -e "s/^  namespace: $SRC_NS/  namespace: $DRILL_NS/"       -e "s/f000f000f000f000f000f000f000f001/$APPS_TENANT/g"       -e "s/f000f000f000f000f000f000f000f002/$VICTIM_TL/g"       "$COMPUTE_FILES_SRC"   | if [ -n "$_inject" ]; then awk -v lsn="$MODE_LSN" \'{print} /"format_version": 1.0,/{print "            \\"mode\\": {\\"Static\\": \\"" lsn "\\"},"}\'; else cat; fi   | $KD apply -f - >/dev/null',
  },
  {
    id: 'ctl-seed-heredoc',
    anchor: '{ name: CTL_B64, value: "$_ctl" }',
    file: 'packages/scale-zero-pg/deploy/_restore-writable.sh',
    // `value: "$_ctl"` inside the sk-seed Pod heredoc: the base64 control blob
    // this same script crafts with `python3 "$SKCTL" craft` two lines earlier.
    // The heredoc body is committed by hash, so editing it re-reviews the entry.
    // Every source that can reach a variable this statement interpolates, byte-exact
    // (the scanner follows each variable's assignment and each helper it calls). Any
    // other fetch / URL / network-written file feeding it reds the scan.
    sources: [
      'fetch:$KD exec sts/pageserver -- curl -s "http://localhost:9898/v1/tenant/$TENANT/timeline/$TIMELINE" 2>/dev/null',
      'url:http://minio:9000',
    ],
    statement:
      'cat <<[sha256:cd45b43f7d259d912957deba67fadacf777dcb4b899162e959eb699ef70b15a4] | $KD apply -f - >/dev/null',
  },
  // #1716: `record_reclaim_pending`/`clear_reclaim_pending` in provision-app.sh
  // interpolate `$tl` (validated 32-hex by `reclaim_tl_valid`, see that
  // function's own comment) and, for the merge patch, `$ords`, into a
  // `kubectl patch` body built by `python3 -c '...json.dumps(...)'` (never raw
  // string interpolation — #1714). Function-local scoping (this module's
  // `scopedTexts`) is what makes these four entries REVIEWABLE: before it, a
  // trace of `$tl`/`$ords` from this statement walked EVERY other same-named
  // write site in this large, multi-function script (~30 of them, spanning
  // functions with no relationship to timeline reclamation) — not a
  // reviewable list, so this site stayed a raw, carved-out offender instead
  // of an allowlist entry. Scoped, the found set is exactly: the `url`/
  // `content` flag this module's general walk already carried for `$tl`/
  // `$ords` at this call site (`urlvar:…`), the pinned `$patch_body` value
  // itself, and the pre-existing (unrelated to this fix) false-positive in
  // `setsPositionals` that any `set -euo pipefail` shebang trips — none of
  // these name a SPECIFIC producer, so a genuinely new fetch introduced
  // inside either function (round-8 `PRODUCER_SWAPS` below) still reds.
  // Each clause-text pair below is the SAME source line seen twice: once as
  // literally written (`K patch …`) and once with `K` (a `kubectl --context
  // "$KCTX" -n "$NS" "$@"` wrapper) inlined at its call site — both are
  // independently recognised as patch-like statements by this module (found
  // by VERB, not by the literal word `kubectl`), so both need an entry.
  {
    id: 'reclaim-record-merge-inlined',
    anchor: '--type merge -p "$patch_body"',
    file: 'packages/scale-zero-pg/deploy/provision-app.sh',
    sources: ['urlvar:$tl', 'urlvar:$patch_body'],
    statement:
      'kubectl --context "$KCTX" -n "$NS" "patch" "configmap" "$RECLAIM_CM" "--type" "merge" "-p" "$patch_body"',
  },
  {
    id: 'reclaim-record-merge-raw',
    anchor: '--type merge -p "$patch_body"',
    file: 'packages/scale-zero-pg/deploy/provision-app.sh',
    sources: [
      'urlvar:$tl',
      'opaque:$tl is assigned from positional parameters that `set` rewrites',
      'opaque:$ords is assigned from positional parameters that `set` rewrites',
      'urlvar:$patch_body',
    ],
    statement: 'K patch configmap "$RECLAIM_CM" --type merge -p "$patch_body" >/dev/null 2>&1',
  },
  {
    id: 'reclaim-clear-json-inlined',
    anchor: '--type json -p "$patch_body"',
    file: 'packages/scale-zero-pg/deploy/provision-app.sh',
    sources: ['urlvar:$tl', 'urlvar:$patch_body'],
    statement:
      'kubectl --context "$KCTX" -n "$NS" "patch" "configmap" "$RECLAIM_CM" "--type" "json" "-p" "$patch_body"',
  },
  {
    id: 'reclaim-clear-json-raw',
    anchor: '--type json -p "$patch_body"',
    file: 'packages/scale-zero-pg/deploy/provision-app.sh',
    sources: [
      'urlvar:$tl',
      'opaque:$tl is assigned from positional parameters that `set` rewrites',
      'urlvar:$patch_body',
    ],
    statement: 'K patch configmap "$RECLAIM_CM" --type json -p "$patch_body" >/dev/null 2>&1',
  },
];

/** The clause with each heredoc placeholder replaced by its literal body. */
function statementText(clause, st) {
  return clause.replace(/<<__HD(\d+)__/g, (m, n) =>
    st.heredocs[Number(n)]
      ? `<<[sha256:${createHash('sha256').update(st.heredocs[Number(n)].body).digest('hex')}]`
      : m,
  );
}

// Variables and helpers are visited at most once each, so this only bounds a
// helper whose arguments grow on every recursive call.
const TAINT_TRACE_DEPTH = 60;

/**
 * Every place a byte can enter `text` from outside the script: a fetch command,
 * a URL argument or URL variable, a read of a network-written file — followed
 * through each variable the text interpolates (its assigned value, recursively)
 * and each helper function it calls (its body, with this call's arguments).
 * Returns a Set of `kind:exact-text` strings. Unlike `textIsNetwork` it does
 * not stop at the first hit, because an allowlisted statement must be judged
 * on WHERE ITS VARIABLES GET THEIR VALUES, not only on its own text. Anything
 * it cannot follow is reported as `opaque:` (fail closed).
 */
function taintSources(text, st, depth, ctx) {
  const { out, vars, fns, scope = null } = ctx;
  if (depth > TAINT_TRACE_DEPTH) {
    out.add('opaque:nesting too deep');
    return;
  }
  if (/\$\{!/.test(text)) out.add(`opaque:indirect expansion in \`${text.slice(0, 80)}\``);
  const followVar = (r) => {
    if (vars.has(r)) return;
    vars.add(r);
    // The walk-time value (last `NAME=` write reached so far) …
    const v = st.vars.get(r);
    if (v?.value !== undefined) taintSources(v.value, st, depth + 1, ctx);
    // … AND every write site VISIBLE IN THIS SCOPE (#1716: the script's own
    // top level plus this ONE function's own body — never a sibling
    // function's, so a same-named `local` elsewhere can neither launder nor
    // taint this one), in any order: a modeled `NAME=value` is traced,
    // anything else that can bind the name is opaque. Found by scanning
    // every occurrence of the name, so a write construct nobody listed is
    // still opaque.
    if (IMPLICIT_VARS.has(r)) out.add(`opaque:$${r} is assigned implicitly by the shell`);
    // A `source`d file the resolver could not read may write anything.
    if (st.unresolvedSource !== null)
      out.add(`opaque:$${r} may be written by unresolved sourced ${st.unresolvedSource}`);
    for (const d of corpusDynamicWrites(st, scope))
      out.add(`opaque:$${r} may be written through a run-time variable name: ${d}`);
    for (const site of corpusWriteSites(r, st, scope)) {
      if (site.kind === 'other') {
        out.add(`opaque:$${r} is written by \`${site.snippet}\``);
        continue;
      }
      const m = site.word.match(/^[A-Za-z_]\w*=(.*)$/s);
      if (m && hasPositional(m[1])) positionalSources(site.word, r, st, depth, ctx);
      if (m) taintSources(m[1], st, depth + 1, ctx);
      else out.add(`opaque:$${r} assignment \`${site.word.slice(0, 80)}\``);
    }
  };
  for (const r of varRefs(text)) followVar(r);
  const { code } = lex(text);
  for (const cl of splitClauses(code)) {
    for (const seg of splitPipeline(cl.text)) {
      const ws = words(seg);
      if (isFetchSegment(ws, st)) out.add(`fetch:${seg.trim()}`);
      for (let k = 0; k < ws.length; k++) {
        const w = ws[k];
        const u = unquote(w);
        if (st.functions.has(u)) {
          const raw = st.functions.get(u);
          const args = ws
            .slice(k + 1)
            .filter((a) => !/^(\d*|&)?[<>]/.test(a))
            .map(unquote);
          const body = /(^|[\s;])shift\b/.test(raw) ? raw : substituteArgs(raw, args);
          const key = `${u}\0${args.join('\0')}`;
          if (!fns.has(key)) {
            fns.add(key);
            // #1716: tracing INTO a callee enters ITS scope, not the caller's
            // — its own `local` writes are visible, a sibling's are not.
            taintSources(body, st, depth + 1, { ...ctx, scope: u });
          }
        }
        for (const inner of innerSubstitutions(w)) taintSources(inner, st, depth + 1, ctx);
        const c = canonical(w, st.vars);
        if (/^https?:\/\//.test(c) && !isLoopbackUrl(c)) out.add(`url:${c}`);
        if (isTaintedPath(c, st)) out.add(`path:${c}`);
        const wholeVar = u.match(/^\$\{?([A-Za-z_]\w*)\}?$/);
        if (wholeVar && st.vars.get(wholeVar[1])?.url) out.add(`urlvar:${u}`);
      }
    }
  }
}

/** The clause with each heredoc placeholder replaced by its literal body (for source tracing). */
function clauseWithBodies(clause, st) {
  return clause.replace(/<<__HD(\d+)__/g, (m, n) =>
    st.heredocs[Number(n)] ? `<<\n${st.heredocs[Number(n)].body}\n` : m,
  );
}

/**
 * The ONE `STATEMENT_ALLOWLIST` check both `reportStdinApply` (a stdin
 * apply) and `reportPatchTaint` (#1466.3: a `kubectl patch`/`set env`
 * value) use — factored out rather than carried twice, so a round-8 review
 * finding fixed here is fixed for both offense classes, and a mutation
 * prover's anchor on this logic never has to pick one copy over the other.
 * `valueText` is what `taintSources` traces: the WHOLE clause for a stdin
 * apply (the value could be anywhere in it), or just the interpolated
 * value for a patch/set-env (the rest of the clause is literal `kubectl`
 * plumbing, not part of what was fetched). `ctx` is the walk context at the
 * statement's call site — its `callStack` names the enclosing function (if
 * any), so the trace starts scoped to THAT function (#1716).
 */
function checkStatementAllowlist(st, why, clause, valueText, ctx) {
  const stmt = statementText(clause, st);
  const entry = STATEMENT_ALLOWLIST.find((e) => e.file === st.file && e.statement === stmt);
  if (entry) {
    // The statement text is pinned, but a variable it interpolates takes its
    // value elsewhere: judge every source that can reach it against the sources
    // this entry names. A new or different one reds the scan.
    const found = new Set();
    const scope = ctx?.callStack?.at(-1) ?? null;
    taintSources(clauseWithBodies(valueText, st), st, 0, {
      out: found,
      vars: new Set(),
      fns: new Set(),
      scope,
    });
    const allowed = new Set(entry.sources);
    const extra = [...found].filter((x) => !allowed.has(x));
    if (extra.length > 0) {
      offend(
        st,
        `${why}; allowlisted statement '${entry.id}' interpolates a value from an unpinned source: ${extra.join(' ; ')}`,
        clause,
      );
      return;
    }
    for (const x of found) countAllowHit(st, `${entry.id}::${x}`);
    countAllowHit(st, entry.id);
    return;
  }
  offend(st, why, clause);
}

function reportStdinApply(st, why, clause, ctx) {
  checkStatementAllowlist(st, why, clause, clause, ctx);
}

/** Counts one allowlist match for the spec's exactly-once / liveness checks. */
function countAllowHit(st, id) {
  st.allowHits?.set(id, (st.allowHits.get(id) ?? 0) + 1);
}

function reportRemoteFetch(st, why, seg) {
  const entry = REMOTE_FETCH_ALLOWLIST.find((e) => e.segment.test(seg));
  if (entry) {
    countAllowHit(st, entry.id);
    return;
  }
  offend(st, `unclassified remote fetch (${why})`, seg);
}

/**
 * Walks clauses in order. `ctx` carries: depth, whether verifications here
 * are defeated by the caller (a call in a condition / after `||`), the
 * inherited stdin producer (for a function body that applies `-f -`), and
 * `standalone` (a function body walked on its own, where a producer-less
 * stdin apply is fed by callers and judged at those call sites instead).
 */
function walk(code, st, ctx) {
  if (ctx.depth > MAX_DEPTH) {
    offend(st, 'unclassifiable (nesting too deep)', code.trim());
    return;
  }
  const clauses = splitClauses(code);
  const walkId = ++st.walkSeq;
  let chainStart = 0;
  for (let ci = 0; ci < clauses.length; ci++) {
    const cl = clauses[ci];
    if (!['&&', '||'].includes(cl.sepBefore)) chainStart = ci;
    let text = cl.text;
    bindUnmodeledWrites(text, loopTailOf(clauses, ci), st, ctx.depth);

    // Control-flow keywords: track blocks so a verification inside one only
    // covers applies inside the same branch.
    let kw = text.match(
      /^(if|elif|while|until|for|select|case|then|else|do|fi|done|esac|!)(\s+|$)/,
    );
    let inCondition = false;
    let negated = false;
    while (kw) {
      const k = kw[1];
      if (
        k === 'if' ||
        k === 'while' ||
        k === 'until' ||
        k === 'for' ||
        k === 'select' ||
        k === 'case'
      ) {
        st.blockStack.push(`${k}${++st.blockSeq}`);
        if (k !== 'for' && k !== 'select' && k !== 'case') inCondition = true;
      } else if (k === 'elif') {
        st.blockStack[st.blockStack.length - 1] = `elif${++st.blockSeq}`;
        inCondition = true;
      } else if (k === 'then' || k === 'else' || k === 'do') {
        if (st.blockStack.length === 0) st.blockStack.push(`orphan${++st.blockSeq}`);
        st.blockStack[st.blockStack.length - 1] = `${k}${++st.blockSeq}`;
      } else if (k === 'fi' || k === 'done' || k === 'esac') {
        st.blockStack.pop();
      } else if (k === '!') {
        negated = true;
      }
      text = text.slice(kw[0].length).trim();
      if (k === 'case') text = text.replace(/^\S+\s+in(\s+|$)/, '');
      if (k === 'for' || k === 'select') text = '';
      kw = text.match(/^(if|elif|while|until|for|select|case|then|else|do|fi|done|esac|!)(\s+|$)/);
    }
    // A case arm `pattern)` opens a new branch.
    const arm = text.match(/^\(?[^()\s|]*(\s*\|\s*[^()\s|]*)*\)\s*/);
    if (arm && /^(case|arm)/.test(st.blockStack.at(-1) ?? '')) {
      st.blockStack[st.blockStack.length - 1] = `arm${++st.blockSeq}`;
      text = text.slice(arm[0].length).trim();
    }
    if (!text) continue;

    const verifyDefeated =
      ctx.defeated ||
      !st.errexit ||
      inCondition ||
      negated ||
      cl.sepAfter === '||' ||
      cl.sepAfter === '&' ||
      clauses.slice(chainStart, ci).some((c) => c.sepAfter === '||');
    // A verification may cover LATER clauses only if it ends its chain (a
    // failing non-last element of an && list does not trip errexit); inside
    // its own chain it covers later elements only while every separator so
    // far is `&&`.
    const allAnd = clauses.slice(chainStart, ci).every((c) => c.sepAfter === '&&');
    const chainTag = `w${walkId}.c${chainStart}`;
    st.curChainTag = allAnd ? chainTag : null;
    // Covering LATER clauses needs the verification to be its whole chain:
    // not first (`false && verify`) means an earlier element can skip it,
    // not last (`verify && x`) means its failure does not trip errexit.
    const chainOk = {
      endsChain: !['&&', '||'].includes(cl.sepAfter) && ci === chainStart,
      chainTag,
    };

    // Grouping: recurse into ( … ) and { …; }.
    const group = text.match(/^\(\s*([\s\S]*)\)\s*$/) ?? text.match(/^\{\s+([\s\S]*?);?\s*\}\s*$/);
    if (group && !text.startsWith('((')) {
      walk(group[1], st, { ...ctx, defeated: verifyDefeated, depth: ctx.depth + 1 });
      continue;
    }

    // set -e / set +e
    const setM = text.match(/^set\s+(.*)$/);
    if (setM) {
      for (const flag of setM[1].split(/\s+/)) {
        if (/^-[a-z]*e/.test(flag)) st.errexit = true;
        if (/^\+[a-z]*e/.test(flag)) st.errexit = false;
      }
      if (/(^|\s)-o\s+errexit/.test(setM[1])) st.errexit = true;
      if (/(^|\s)\+o\s+errexit/.test(setM[1])) st.errexit = false;
      // `set -- …` / `set x …` rewrites $1…: they carry that producer, and the
      // clause is judged like any other (a fetch in it is still a fetch).
      if (!SETS_POSITIONALS.test(text)) continue;
      const prevPos = st.vars.get('@');
      st.vars.set('@', {
        value: undefined,
        url: !!prevPos?.url,
        content: !!prevPos?.content || !!producerIsNetwork(text, st, ctx.depth + 1),
      });
    }

    const segs = splitPipeline(text);
    const segWords = segs.map(words);

    // Pure assignment clause.
    if (segs.length === 1 && recordAssignments(segWords[0], st, ctx.depth)) continue;
    // `local out; out=…` style and leading assignments before a command.
    recordAssignments(segWords[0], st, ctx.depth);

    // GitHub env files carry values into later steps.
    const ghEnv = text.match(
      /^echo\s+["']?([A-Za-z_]\w*)=(.*?)["']?\s*>>\s*"?\$\{?GITHUB_ENV\}?"?$/,
    );
    if (ghEnv) {
      recordAssignments([`${ghEnv[1]}=${ghEnv[2]}`], st, ctx.depth);
      st.persistedEnv.set(ghEnv[1], st.vars.get(ghEnv[1]));
    }

    handleVerification(segWords, text, st, verifyDefeated, chainOk);

    let networkSoFar = false;
    for (let si = 0; si < segs.length; si++) {
      const ws = segWords[si];
      if (ws.length === 0) continue;
      const cmd = unquote(ws[0]);

      // Re-scan strings handed to a shell.
      const execStr = execString(ws, st);
      if (execStr !== null) {
        walk(lex(execStr).code, st, { ...ctx, defeated: verifyDefeated, depth: ctx.depth + 1 });
      }

      // A heredoc / here-string fed to a shell (locally, over ssh, into a
      // container) is a script: walk it as one.
      const fed = scriptBodies(ws, st);
      for (const body of fed.bodies) {
        if (fed.runner === 'shell')
          walkScript(body, st, { ...ctx, defeated: verifyDefeated, depth: ctx.depth + 1 });
        else if (INTERPRETER_FETCH.test(body) || hasComputedGlobalAccess(body))
          reportRemoteFetch(st, interpreterFetch(fed.runner), segs[si]);
      }

      // `source f` / `. f` adopts f's functions (or records that it could not).
      if ((cmd === 'source' || cmd === '.') && ws.length >= 2) loadSource(ws[1], st);

      // Function call (anywhere in the segment: wrappers like `retry 3 fn …`).
      for (let k = 0; k < ws.length; k++) {
        const name = unquote(ws[k]);
        if (!st.functions.has(name)) continue;
        if (k > 0 && /^(echo|printf|log|warn|fail|die|info|bad|ok)$/.test(cmd)) break;
        const producer = [...segs.slice(0, si), ...stdinSources(ws)].join(' | ');
        inlineCall(name, ws.slice(k + 1), st, {
          ...ctx,
          // errexit is suspended for the whole body of a call that is not the
          // last element of its && list, or is wrapped by another command.
          defeated: verifyDefeated || k > 0 || !chainOk.endsChain,
          stdinProducer: producer || null,
          depth: ctx.depth + 1,
        });
        break;
      }

      const pipedFromNetwork = networkSoFar;
      const isFetch = isFetchSegment(ws, st);
      if (isFetch) networkSoFar = true;
      const remote = unclassifiedFetch(ws, st, { pipedFromNetwork, depth: ctx.depth });
      if (remote) reportRemoteFetch(st, remote, segs[si]);
      if (unresolvedCallWithUrl(ws, st))
        reportRemoteFetch(
          st,
          `${cmd} may be defined in unresolved sourced ${st.unresolvedSource}`,
          segs[si],
        );
      // A heredoc this segment READS (as stdin, `cat <<HD`) or, more commonly,
      // WRITES (`cat > f <<HD`) can interpolate a fetched value the shell
      // itself expands — a redirect target fed by such a heredoc is a network
      // write the same as a fetcher's own `-o` would be (#1466.1: heredoc ->
      // file -> apply). Only an UNQUOTED delimiter expands.
      const heredocNetwork = ws.some((w) => {
        const m = w.match(/^<<__HD(\d+)__$/);
        if (!m) return false;
        const hd = st.heredocs[Number(m[1])];
        if (!hd || hd.quoted) return false;
        return !!textIsNetwork(heredocExpansions(hd.body), st, ctx.depth + 1, {
          urlLiteralCounts: false,
        });
      });
      const readsNetwork =
        networkSoFar ||
        heredocNetwork ||
        ws.some((w) => {
          const c = canonical(w, st.vars);
          return isTaintedPath(c, st) || varRefs(w).some((r) => st.vars.get(r)?.content);
        });
      if (readsNetwork) networkSoFar = true;

      // File-to-file taint flow: cp/mv/install/ln of a tainted source.
      if (/^(cp|mv|install|ln|rsync)$/.test(cmd)) {
        const args = ws.slice(1).filter((w) => !unquote(w).startsWith('-'));
        if (
          args.length >= 2 &&
          args.slice(0, -1).some((a) => isTaintedPath(canonical(a, st.vars), st))
        ) {
          markTainted(canonical(args.at(-1), st.vars), st);
        }
      }

      for (const p of writtenPaths(ws, st, isFetch)) {
        if (networkSoFar) markTainted(p, st);
        else if (!isFetch) {
          // A local rewrite of a verified file (pin-known-images) keeps it verified;
          // a local overwrite of a tainted one does not clear the taint.
        }
      }

      const targets = applyTargets(ws);
      if (targets) {
        const producerText = [...segs.slice(0, si), ...stdinSources(ws)].join(' | ');
        for (const t of targets) classifyTarget(t, { producerText, clause: text, st, ctx });
      }

      classifyPatchLike(ws, st, ctx, text);
    }
  }
}

function markTainted(p, st) {
  st.tainted.add(p);
  st.verified.delete(p);
}

/**
 * What a segment's stdin redirections feed it, as producer text: a heredoc
 * placeholder (`<<__HD3__`), a here-string (`<<< "$X"`), or `< file` (as
 * `cat file`, so a tainted file is seen).
 */
function stdinSources(ws) {
  const out = [];
  for (let k = 0; k < ws.length; k++) {
    const w = ws[k];
    if (/^<<__HD\d+__$/.test(w)) out.push(w);
    else if (w === '<<<') out.push(`echo ${ws[k + 1] ?? ''}`);
    else if (w.startsWith('<<<')) out.push(`echo ${w.slice(3)}`);
    else if (w === '<' || /^0?<$/.test(w)) out.push(`cat ${ws[k + 1] ?? ''}`);
    else if (/^0?<[^<(]/.test(w)) out.push(`cat ${w.replace(/^0?</, '')}`);
  }
  return out;
}

/** Producer text is network content: its commands, and what its heredocs EXPAND. */
function producerIsNetwork(text, st, depth) {
  const why = textIsNetwork(text.replace(/<<__HD\d+__/g, ''), st, depth);
  if (why) return why;
  for (const m of text.matchAll(/<<__HD(\d+)__/g)) {
    const hd = st.heredocs[Number(m[1])];
    if (hd && !hd.quoted) {
      const hwhy = textIsNetwork(heredocExpansions(hd.body), st, depth, {
        urlLiteralCounts: false,
      });
      if (hwhy) return `heredoc expands ${hwhy}`;
      // `${!N}` names its variable at RUN time, so no static reference reveals a
      // fetched value it dereferences: refuse it whenever any variable holds one.
      if (/\$\{![A-Za-z_]/.test(hd.body)) {
        const tainted = [...st.vars].find(([, v]) => v.content);
        if (tainted)
          return `heredoc uses indirect expansion \${!…} while $${tainted[0]} holds network content`;
      }
    }
  }
  return false;
}

function execString(ws, _st) {
  const cmd = unquote(ws[0]).split('/').pop();
  if (cmd === 'eval') return ws.slice(1).map(unquote).join(' ');
  for (let k = 0; k < ws.length; k++) {
    const base = unquote(ws[k]).split('/').pop();
    if (EXEC_STRING_SHELLS.has(base)) {
      const c = ws.indexOf('-c', k + 1);
      const cc = ws.findIndex((w, j) => j > k && /^-[a-z]*c$/.test(w));
      const idx = c !== -1 ? c : cc;
      if (idx !== -1 && ws[idx + 1] !== undefined) return unquote(ws[idx + 1]);
    }
    if (base === 'ssh' || base === 'xargs') {
      const rest = ws.slice(k + 1).filter((w) => !unquote(w).startsWith('-'));
      if (rest.length) return rest.map(unquote).join(' ');
    }
  }
  return null;
}

function handleVerification(segWords, text, st, defeated, chainOk) {
  const last = segWords.at(-1) ?? [];
  const base = unquote(last[0] ?? '')
    .split('/')
    .pop();
  let isCheck = false;
  if (base === 'sha256sum' && last.some((w) => /^(-c|--check|-[a-z]*c[a-z]*)$/.test(w)))
    isCheck = true;
  if (
    base === 'shasum' &&
    last.some((w) => /^(-c|--check)$/.test(w)) &&
    /-a\s*256\b/.test(last.join(' '))
  )
    isCheck = true;
  if (!isCheck) {
    if (/\bsha256sum\b|\bshasum\b/.test(text) && /(-c|--check)\b/.test(text)) {
      // A checksum in an unrecognized shape verifies nothing (fail closed) —
      // e.g. piped onward, captured, or checking a separate checksums file.
    }
    return;
  }
  let lineText = null;
  if (segWords.length >= 2) {
    const prod = segWords.at(-2);
    const pc = unquote(prod[0] ?? '');
    if (pc === 'echo' || pc === 'printf') {
      const args = prod.slice(1).filter((w) => !/^-[neE]+$/.test(w));
      if (pc === 'printf' && args.length > 1) {
        // printf '%s  %s\n' "$SHA" "$F": the file is the last argument.
        lineText = args.slice(1).join('  ');
      } else lineText = args.join(' ');
    }
  } else {
    const ps = last.find((w) => w.startsWith('<('));
    if (ps) {
      const inner = words(ps.slice(2, -1));
      if (['echo', 'printf'].includes(unquote(inner[0] ?? ''))) lineText = inner.slice(1).join(' ');
    }
    const herestr = last.indexOf('<<<');
    if (herestr !== -1) lineText = last[herestr + 1] ?? null;
  }
  if (lineText === null) return;
  const parts = unquote(lineText).trim().split(/\s+/);
  if (parts.length < 2) return;
  const file = canonical(parts.at(-1).replace(/^\*/, ''), st.vars);
  if (defeated) {
    offend(st, 'defeated verification (exit status can be ignored)', text);
    return;
  }
  st.verified.set(file, {
    block: blockKey(st),
    chain: chainOk.endsChain ? null : chainOk.chainTag,
  });
  st.tainted.delete(file);
}

function verificationCovers(c, st) {
  const v = st.verified.get(c);
  if (v === undefined) return false;
  if (v.chain !== null && v.chain !== st.curChainTag) return false;
  const here = blockKey(st);
  return v.block === '' || here === v.block || here.startsWith(`${v.block}/`);
}

const POSITIONAL = /\$\{?[1-9@*]/;
const APPLIES_POSITIONAL =
  /(^|[\s;|&])(apply|create|replace)\s[^\n;|&]*(-f|--filename|-k|--kustomize)[\s=]*"?\$\{?[1-9@*]/;

function inlineCall(name, args, st, ctx) {
  const stack = ctx.callStack ?? [];
  // A recursive call adds no behaviour the enclosing walk of this body is
  // not already judging.
  if (stack.includes(name)) return;
  const callCtx = { ...ctx, inFunction: true, standalone: false, callStack: [...stack, name] };
  const body = st.functions.get(name);
  const argVals = args.filter((a) => !/^(\d*|&)?[<>]/.test(a)).map(unquote);
  const saved = st.blockStack.slice();
  if (/(^|[\s;])shift\b/.test(body) && POSITIONAL.test(body)) {
    // After `shift` the positional mapping is unknowable, so over-approximate
    // instead of guessing: walk the body with positionals unresolved and its
    // verifications disabled; whatever it taints through a positional taints
    // EVERY argument, and an apply of a positional is an apply of EVERY one.
    const before = new Set(st.tainted);
    walk(body, st, { ...callCtx, defeated: true });
    st.blockStack = saved;
    for (const p of [...st.tainted]) {
      if (before.has(p) || !POSITIONAL.test(p)) continue;
      st.tainted.delete(p);
      for (const a of argVals) if (!a.startsWith('-')) markTainted(canonical(a, st.vars), st);
    }
    if (APPLIES_POSITIONAL.test(body)) {
      for (const a of argVals) {
        if (a.startsWith('-') && a !== '-') continue;
        classifyTarget(
          { raw: a, kustomize: false },
          {
            producerText: ctx.stdinProducer ?? '',
            clause: `${name} ${args.join(' ')}`,
            st,
            ctx: callCtx,
          },
        );
      }
    }
    return;
  }
  walk(substituteArgs(body, argVals), st, callCtx);
  st.blockStack = saved;
}

/** Replaces `$1`…`$9`, `${N}`, `${N:-d}`, `"$@"`, `$*` in a helper body with a call's arguments. */
function substituteArgs(body, argVals) {
  return body
    .replace(/"\$@"|"\$\*"|\$@|\$\*|"\$\{@\}"|\$\{@\}/g, () =>
      argVals.map((a) => `"${a}"`).join(' '),
    )
    .replace(
      /\$\{([1-9])(?:[:]?[-=?+][^}]*)?\}|\$([1-9])/g,
      (_, a, b) => argVals[Number(a ?? b) - 1] ?? '',
    );
}

function classifyTarget(t, { producerText, clause, st, ctx }) {
  const raw = t.raw;
  const u = unquote(raw);
  if (u === '') {
    offend(st, 'unclassifiable apply (no target)', clause);
    return;
  }
  if (/\$\{\{/.test(raw)) {
    offend(st, 'unclassifiable apply target (a workflow expression)', clause);
    return;
  }
  if (u === '-' || u === '/dev/stdin' || u === '/dev/fd/0' || u === '/proc/self/fd/0') {
    if (!producerText) {
      if (ctx.stdinProducer) {
        const why = producerIsNetwork(ctx.stdinProducer, st, ctx.depth + 1);
        if (why) offend(st, `stdin apply fed by network content via a helper (${why})`, clause);
        return;
      }
      if (ctx.standalone) return; // a helper's stdin is judged at each call site
      offend(st, 'unclassifiable stdin apply (no producer in this source)', clause);
      return;
    }
    const why = producerIsNetwork(producerText, st, ctx.depth + 1);
    if (why) reportStdinApply(st, `stdin apply fed by network content (${why})`, clause, ctx);
    return;
  }
  if (/^[<>]\(/.test(raw)) {
    const why = textIsNetwork(raw.slice(2, -1), st, ctx.depth + 1);
    if (why) offend(st, `process-substitution apply of network content (${why})`, clause);
    return;
  }
  for (const inner of innerSubstitutions(raw)) {
    const why = textIsNetwork(inner, st, ctx.depth + 1);
    if (why) {
      offend(st, `apply target computed from network content (${why})`, clause);
      return;
    }
  }
  const c = canonical(raw, st.vars);
  if (URL_RE.test(c) || varRefs(raw).some((r) => st.vars.get(r)?.url)) {
    offend(st, 'bare URL apply, no checksum possible', clause);
    return;
  }
  if (t.kustomize && (/^[\w.-]+\.[a-z]{2,}\//i.test(c) || /\?ref=|\/\/|^git[@:]/.test(c))) {
    offend(st, 'remote kustomization apply', clause);
    return;
  }
  if (varRefs(raw).some((r) => st.vars.get(r)?.content)) {
    offend(st, 'apply of a variable holding network content', clause);
    return;
  }
  const hits = [...st.tainted].filter((p) => pathMatches(p, c));
  if (st.verified.has(c) && !verificationCovers(c, st)) {
    offend(st, 'apply of a file whose checksum does not dominate the apply', clause);
    return;
  }
  if (hits.length > 0) {
    offend(st, 'apply of a network-fetched file that was not checksum-verified', clause);
  }
}

/**
 * Reports a `kubectl patch`/`set env` value's taint the SAME way
 * `reportStdinApply` reports a stdin-apply's: `STATEMENT_ALLOWLIST`-aware, so
 * the one existing mechanism this module uses to pin "a value from an
 * in-cluster endpoint, interpolated into content applied to the SAME
 * cluster" (byte-exact statement text, every reachable source named and
 * matched) covers this offense class too, rather than growing a second,
 * unreviewed one. `val` is the specific interpolated value (the patch body,
 * or a `set env` value) whose sources are traced against the entry's
 * `sources` list; `clause` is the whole statement, used as the pin key.
 */
function reportPatchTaint(st, why, clause, val, ctx) {
  checkStatementAllowlist(st, why, clause, val, ctx);
}

/**
 * `kubectl patch … -p/--patch <body>` and `kubectl … set env RESOURCE
 * KEY=VALUE …` mutate a live cluster resource with a value the shell hands
 * them directly — no `-f` manifest, so `applyTargets`/`classifyTarget` never
 * see them (#1466.3). Found by VERB (`patch`, or `set` followed by `env`),
 * never by the literal word `kubectl`, matching the rest of this module.
 * `--patch-file <path>` is judged like any other applied file: a network-
 * tainted, unverified path is an offender.
 */
function classifyPatchLike(ws, st, ctx, clause) {
  const u = ws.map(unquote);
  const patchIdx = u.indexOf('patch');
  if (patchIdx !== -1) {
    for (let k = patchIdx + 1; k < ws.length; k++) {
      const w = unquote(ws[k]);
      if (w === '-p' || w === '--patch') {
        const val = unquote(ws[++k] ?? '');
        const why = textIsNetwork(val, st, ctx.depth + 1);
        if (why) {
          reportPatchTaint(
            st,
            `kubectl patch body carries network content (${why})`,
            clause,
            val,
            ctx,
          );
          return;
        }
        continue;
      }
      const m = w.match(/^-p=(.*)$/) ?? w.match(/^--patch=(.*)$/);
      if (m) {
        const why = textIsNetwork(m[1], st, ctx.depth + 1);
        if (why) {
          reportPatchTaint(
            st,
            `kubectl patch body carries network content (${why})`,
            clause,
            m[1],
            ctx,
          );
          return;
        }
        continue;
      }
      let file = null;
      const patchFileEq = w.match(/^--patch-file=(.*)$/);
      if (w === '--patch-file') file = unquote(ws[++k] ?? '');
      else if (patchFileEq) file = patchFileEq[1];
      if (file) {
        const c = canonical(file, st.vars);
        if (isTaintedPath(c, st) && !verificationCovers(c, st))
          offend(
            st,
            `kubectl --patch-file names a network-fetched file that was not checksum-verified (${c})`,
            clause,
          );
      }
    }
  }
  const setIdx = u.findIndex((w, i) => w === 'set' && u[i + 1] === 'env');
  if (setIdx !== -1) {
    for (let k = setIdx + 2; k < ws.length; k++) {
      const w = unquote(ws[k]);
      const m = w.match(/^[A-Za-z_][\w.-]*=(.*)$/s);
      if (!m) continue;
      const why = textIsNetwork(m[1], st, ctx.depth + 1);
      if (why)
        reportPatchTaint(
          st,
          `kubectl set env value carries network content (${why})`,
          clause,
          m[1],
          ctx,
        );
    }
  }
}

function heredocExpansions(body) {
  // Only what an unquoted heredoc EXPANDS matters; its literal YAML text does not.
  const bits = [];
  for (const m of body.matchAll(/\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)|`([^`]*)`/g))
    bits.push(m[1] ?? m[2]);
  // Every interpolated variable is EMITTED: a fetched value can carry newlines
  // and `---`, so it can never be data inside a document.
  for (const m of body.matchAll(/\$\{?([A-Za-z_]\w*)\}?/g)) bits.push(`echo "$${m[1]}"`);
  return bits.join('\n');
}

/**
 * Scans one shell source. `errexit` is the starting errexit state (true for
 * a GitHub Actions bash step, false for a script until it runs `set -e`).
 * `vars` seeds known variables (a workflow's `env:`). `tainted`/`verified`
 * may be passed in to carry FILE state across the steps of one job.
 * `resolveSource(path)` returns the text of a `source`d file, or null when it
 * cannot be read (then a URL-taking call that may live in it fails closed).
 * `allowHits` (a Map) counts REMOTE_FETCH_ALLOWLIST / STATEMENT_ALLOWLIST
 * matches for the spec; `file` (repo-relative) keys STATEMENT_ALLOWLIST.
 * @param {string} rawText
 * @param {{
 *   errexit?: boolean,
 *   vars?: Array<[string, {value: string, url: boolean, content: boolean}]>,
 *   carry?: {tainted: Set<string>, verified: Map<string, unknown>} | null,
 *   persisted?: Map<string, unknown> | null,
 *   finalCheck?: boolean,
 *   resolveSource?: ((path: string) => string | null) | null,
 *   allowHits?: Map<string, number> | null,
 *   file?: string | null,
 *   followScripts?: boolean,
 *   hasApplyAnywhere?: boolean,
 * }} [options]
 * @returns {string[]}
 */
export function unsafeApplies(
  rawText,
  {
    errexit = false,
    vars = [],
    carry = null,
    persisted = null,
    finalCheck = true,
    resolveSource = null,
    allowHits = null,
    file = null,
    followScripts = false,
    hasApplyAnywhere = false,
  } = {},
) {
  const { code, heredocs, error } = lex(rawText);
  const st = new State({ errexit: errexit || /^#!.*\s-[a-z]*e/.test(rawText), vars });
  st.resolveSource = resolveSource;
  st.allowHits = allowHits;
  st.file = file;
  st.followScripts = followScripts;
  // #1715: caller-asserted (workflow-job-wide) OR this text's own scan —
  // either is sufficient to open the gate in `unclassifiedFetch`.
  st.hasApplyAnywhere = hasApplyAnywhere || textHasManifestApply(rawText);
  if (carry) {
    st.tainted = carry.tainted;
    st.verified = carry.verified;
  }
  st.heredocs = heredocs;
  st.corpus.push(code, ...heredocWriteText(heredocs));
  if (error) offend(st, 'unparseable', error);
  const { code: top, functions } = extractFunctions(code);
  st.functions = functions;
  // #1716: the script's own top-level text is the GLOBAL half of function-
  // local scoping — see `scopedTexts`. Set once `top` is known. An unquoted
  // heredoc's `${V:=…}`/`${V=…}`/`$(( V = … ))` expansions are evaluated by
  // whichever shell reads the heredoc body — not a lexical write inside one
  // function — so they join the global text too.
  st.topLevelText = `${top}\n${heredocWriteText(heredocs).join('\n')}`;
  // A `trap` handler is a string the CURRENT shell runs later, not at a
  // lexical call site inside any one function: its writes count, and — like
  // the top level itself — it stays visible from every scope. Read back from
  // `st.corpus` (rather than appending `m[1] ?? m[2]` again independently) so
  // the two stay a single fact: removing the push below also drops it here.
  for (const m of code.matchAll(/(?:^|[\s;&|(])trap\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g)) {
    const before = st.corpus.length;
    st.corpus.push(m[1] ?? m[2]);
    st.topLevelText += `\n${st.corpus.slice(before).join('\n')}`;
  }

  walk(top, st, { depth: 0, defeated: false, stdinProducer: null, standalone: false });

  // Every helper body is also scanned on its own, so a helper reached only
  // indirectly (trap, `"$cmd"` dispatch, a sourcing script) is still judged.
  for (const [name, body] of functions) {
    const sub = new State({ errexit: st.errexit, vars: st.vars });
    sub.functions = functions;
    sub.heredocs = heredocs;
    sub.tainted = new Set(st.tainted);
    sub.verified = new Map(st.verified);
    sub.resolveSource = st.resolveSource;
    sub.followScripts = st.followScripts;
    sub.hasApplyAnywhere = st.hasApplyAnywhere;
    sub.allowHits = null; // a helper body is judged again at its call sites, which count
    sub.file = st.file;
    sub.sourced = new Set(st.sourced);
    sub.unresolvedSource = st.unresolvedSource;
    sub.corpus = st.corpus;
    sub.writeSiteCache = st.writeSiteCache;
    sub.topLevelText = st.topLevelText;
    walk(body, sub, {
      depth: 1,
      defeated: false,
      stdinProducer: null,
      standalone: true,
      inFunction: true,
      // #1716: this standalone sub-walk IS `name`'s own body, so scope a
      // STATEMENT_ALLOWLIST trace reached from here to `name`, the same as
      // a call-site walk would (an empty callStack would fall back to the
      // global scope and re-admit the flat, whole-file namespace here).
      callStack: [name],
    });
    for (const o of sub.offenders) {
      const tagged = `${o} [in ${name}()]`;
      if (!st.offenders.some((x) => x.startsWith(o.slice(0, 60)))) st.offenders.push(tagged);
    }
  }

  // Cross-source hole: a manifest fetched here and applied by ANOTHER script
  // is invisible to that script. So a fetched manifest must be verified in
  // the source that fetched it.
  if (finalCheck) {
    for (const p of st.tainted) {
      if (MANIFEST_RE.test(p))
        offend(st, 'manifest fetched without checksum verification in this source', p);
    }
  }

  if (persisted) for (const [k, v] of st.persistedEnv) persisted.set(k, v);
  return [...new Set(st.offenders)];
}

/**
 * The errexit state a step's shell starts with, or null when the shell is not
 * a POSIX shell the scanner can read (pwsh, python, cmd, node, a `${{ }}`
 * expression) — the step is then unclassifiable. GitHub runs `shell: bash` as
 * `bash --noprofile --norc -eo pipefail {0}` and `shell: sh` as `sh -e {0}`; a
 * custom template (`bash {0}`) has errexit only if IT passes -e / -o errexit.
 */
export function shellErrexit(shell) {
  const s = String(shell).trim();
  if (s === 'bash' || s === 'sh') return true;
  const ws = s.split(/\s+/);
  if (!EXEC_STRING_SHELLS.has(ws[0].split('/').pop()) || /\$\{\{/.test(s)) return null;
  let errexit = false;
  for (let k = 1; k < ws.length && ws[k] !== '{0}'; k++) {
    if (/^-[A-Za-z]*e[A-Za-z]*$/.test(ws[k])) errexit = true;
    if (ws[k] === '-o' && ws[k + 1] === 'errexit') errexit = true;
  }
  return errexit;
}

/** The shell a step runs under: its own, else job then workflow `defaults.run.shell`. */
export function effectiveShell(doc, job, step) {
  const onWindows = /windows/i.test(JSON.stringify(job?.['runs-on'] ?? ''));
  return (
    step.shell ??
    job?.defaults?.run?.shell ??
    doc?.defaults?.run?.shell ??
    (onWindows ? 'pwsh' : 'bash')
  );
}

const truthyKey = (v) => v === true || v === 'true' || (typeof v === 'string' && /\$\{\{/.test(v));

/**
 * Whether a step's checksum can be relied on by LATER steps. With
 * `continue-on-error` a failed check lets the job carry on; with `if:` the
 * step may never run. Either way the verification does not dominate an apply
 * in a later step (inside the step, errexit still aborts before the apply).
 */
export function stepGuaranteed(step) {
  if (truthyKey(step['continue-on-error'])) return false;
  if (step.if !== undefined) return false;
  return true;
}

/** A `uses:` target that names a LOCAL path (composite action directory or
 * reusable workflow file) rather than a remote `owner/repo@ref`. */
function usesLocalPath(uses) {
  return typeof uses === 'string' && /^\.{1,2}\//.test(uses.split('@')[0]);
}

/**
 * Resolves and parses a LOCAL `uses:` target's YAML. A composite action
 * names a DIRECTORY (tries `action.yml`/`action.yaml` inside it); a
 * reusable workflow names the `.yml`/`.yaml` file directly. Returns null
 * when unreadable (no `resolveSource`, or every candidate path comes back
 * empty) — this function itself just reports "could not read it", never
 * guesses; the caller (`localUsesMightApply`) is the one that turns a null
 * into a fail-closed verdict.
 */
function loadLocalUsesDoc(usesRaw, resolveSource) {
  if (!resolveSource) return null;
  const usesPath = usesRaw.split('@')[0];
  const candidates = /\.ya?ml$/i.test(usesPath)
    ? [usesPath]
    : [`${usesPath}/action.yml`, `${usesPath}/action.yaml`];
  for (const c of candidates) {
    const text = resolveSource(c);
    if (typeof text === 'string') {
      try {
        return parseYaml(text);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Third-party GitHub Actions this repo's workflows actually call (derived by
 * scanning every tracked `.github/workflows/*.yml` for a `uses:` base name
 * — `git grep -hoE 'uses:\s*[A-Za-z0-9._/-]+@' .github/workflows/*.yml`). Every
 * one is runner/toolchain setup, caching, artifact transfer, container
 * build/scan/sign, or release automation that does NOT run an arbitrary,
 * attacker-reachable shell command of its own — every `kubectl`/`helm
 * template | kubectl apply` in this repo is a `run:` shell step, which
 * `textHasManifestApply` already scans directly. `usesStepMightApply`
 * (#1780/#1801 round 3) uses this to scope its fail-closed widening to a
 * remote `uses:` that is NOT already a known, auditable, non-applying
 * action. This is a known, finite SET, not a blanket carve-out: a NEW
 * remote action anywhere on a job's `uses:` surface is NOT on this list and
 * still widens the gate, matching the issue's fail-closed intent for the
 * unknown case.
 *
 * `changesets/action` is DELIBERATELY ABSENT (round 3, #1801): it is the one
 * action in this repo's real tree whose `with:` inputs (`publish-script`/
 * `version-script`) are handed to the action's OWN shell execution — not a
 * parameter, a COMMAND. `changesetsActionStepMightApply` scans those inputs
 * specifically instead of exempting the action outright. Every other entry
 * here was individually checked for the same "a `with:` input is executed
 * as shell" shape and does NOT have it (cache keys/paths, SBOM/scan config,
 * toolchain versions, PR-comment bodies, release notes — none of them run
 * what they're handed).
 */
const KNOWN_NON_APPLYING_ACTIONS = new Set([
  'actions/cache',
  // #1801 (final round, round-2 review fix): `actions/cache/save` and
  // `actions/cache/restore` are DELIBERATELY ABSENT here, unlike the
  // combined `actions/cache` action above. Allowlisting them was tried and
  // reverted: it silenced the PRE-EXISTING generic "unknown remote action"
  // fail-closed widening (`usesStepMightApply`) for every job using either
  // split action, which is exactly what caught a save/restore-based
  // exfiltration job on its own (no `needs:` edge, or the real apply in a
  // DIFFERENT workflow file, required) before this module ever had a
  // dedicated cache-linking rule. Leaving them unknown keeps that
  // protection; the dedicated `jobsLinkedByArtifactOrOutputs` cache rule
  // below is additional, cross-job evidence, not a substitute for it, and
  // is proven by a DIRECT unit test precisely so it is never masked by this
  // allowlist decision again.
  'actions/checkout',
  'actions/download-artifact',
  'actions/setup-go',
  'actions/setup-node',
  'actions/setup-python',
  'actions/upload-artifact',
  'anchore/sbom-action',
  'anchore/sbom-action/download-syft',
  'anchore/scan-action/download-grype',
  'aquasecurity/trivy-action',
  'codecov/codecov-action',
  'docker/build-push-action',
  'docker/login-action',
  'docker/setup-buildx-action',
  'docker/setup-qemu-action',
  'dorny/paths-filter',
  'google-github-actions/auth',
  'google-github-actions/setup-gcloud',
  'helm/kind-action',
  'marocchino/sticky-pull-request-comment',
  'oven-sh/setup-bun',
  'pnpm/action-setup',
  'sigstore/cosign-installer',
  'softprops/action-gh-release',
]);

/**
 * #1801 round 3, fix 5: `changesets/action`'s `publish-script`/
 * `version-script` inputs are shell commands the action itself runs (not
 * ordinary parameters) — the real tree's `release.yml` passes
 * `publish-script: ${{ steps.gate.outputs.publish }}`, a `${{ }}` EXPRESSION
 * this module cannot read at parse time (its value comes from a prior
 * step's output at run time). A literal string value is scanned with
 * `textHasManifestApply` same as any other run text; an unreadable `${{ }}`
 * expression fails closed — "comes from elsewhere, unverifiable" is exactly
 * this module's fail-closed case everywhere else (an unresolvable `source`d
 * file, an unreadable followed script, …).
 */
const CHANGESETS_ACTION_SCRIPT_KEYS = ['publish-script', 'version-script'];
function changesetsActionStepMightApply(s) {
  for (const key of CHANGESETS_ACTION_SCRIPT_KEYS) {
    const v = s?.with?.[key];
    if (typeof v !== 'string') continue;
    if (/\$\{\{/.test(v)) return true; // a dynamic expression — cannot verify, fail closed
    if (textHasManifestApply(v)) return true;
  }
  return false;
}

/**
 * #1801 round 3, fix 2: a `docker://<image>` step runs an arbitrary
 * container ENTRYPOINT this module cannot read — unlike a GH Action's own
 * composite/reusable YAML, there is no manifest text to parse at all. Fail
 * CLOSED unconditionally: every `docker://` step is "might apply" (today's
 * real tree has none, so this costs nothing there). `with.args`/
 * `with.entrypoint` — the container-action override GitHub Actions itself
 * defines — are still scanned with `textHasManifestApply` first so an
 * OBVIOUS apply (`args: ['apply', '-f', 'm.yaml']`) is named explicitly in
 * the offender rather than only ever reported as the generic unknown-image
 * verdict; this can only ever ADD a positive match, never clear one, since
 * the function's own fallthrough is also `true`.
 */
function dockerStepMightApply(s) {
  const argsRaw = s?.with?.args;
  const args = Array.isArray(argsRaw)
    ? argsRaw.join(' ')
    : typeof argsRaw === 'string'
      ? argsRaw
      : '';
  const entrypoint = typeof s?.with?.entrypoint === 'string' ? s.with.entrypoint : '';
  if (textHasManifestApply(`${args} ${entrypoint}`)) return true;
  return true; // unconditional fail-closed — no "clearly non-applying image" carve-out exists yet
}

/**
 * #1801 round 3, fix 3: follows a LOCAL `uses:` target RECURSIVELY into its
 * own `uses:` steps — a local composite that merely wraps a remote deploy
 * action, or wraps ANOTHER local composite, is no longer invisible past one
 * hop. `visited` (keyed by the path with any `@ref` stripped) is shared
 * across one whole top-level call so a cycle (A wraps B, B wraps A) cannot
 * recurse forever; revisiting an in-progress path reports "no NEW apply
 * found via this edge" (`false`) rather than fail-closed `true` — the cycle
 * itself is not evidence of an apply, and the first visit to that node
 * already covers everything reachable from it.
 *
 * An UNRESOLVABLE local path (no `resolveSource`, or every candidate read
 * comes back empty) now FAILS CLOSED (`true`) — round 2 had this return
 * `false` (fail OPEN) via `calledUnitHasApply(null)`, which was itself the
 * round-3 finding: "can't prove it's safe" and "proved it's safe" must
 * never share a verdict.
 */
function localUsesMightApply(usesRaw, resolveSource, visited) {
  const key = usesRaw.split('@')[0];
  if (visited.has(key)) return false;
  visited.add(key);
  const doc = loadLocalUsesDoc(usesRaw, resolveSource);
  if (!doc) return true; // unresolvable — fail closed
  return calledUnitMightApply(doc, resolveSource, visited);
}

/**
 * #1801 round 3: does a called composite action / reusable workflow
 * document apply a manifest ANYWHERE, recursing into every `uses:` step it
 * itself has (`usesStepMightApply`)? Deliberately just a gate-widening
 * signal, not a full scan of the called file's own safety — that file is
 * scanned on its own merits wherever it is discovered as a tracked
 * workflow/composite-action source in its own right.
 *
 * #1801 round 4: this function used to inspect ONLY `runs.steps` (a
 * composite action) and `jobs` (a reusable workflow) — a resolvable LOCAL
 * action whose `action.yml` is neither of those shapes fell all the way
 * through to the final `return false`, i.e. "proven safe", when it had
 * proven NOTHING. Three real `action.yml` shapes read exactly that way:
 * `runs.using: docker` + `image: Dockerfile` (a built image, no `steps` to
 * scan at all), `runs.using: docker` + `image: docker://…` + `args: […]`
 * (the action's OWN `apply -f …` args, never routed through
 * `dockerStepMightApply` because that function only ever sees a CALLING
 * job's `uses:` step, not a called action's own `runs:` block), and
 * `using: node20` + `main: index.js` (an arbitrary compiled/bundled JS
 * entry this module has no way to scan for manifest applies). None of
 * these is a composite action or a reusable workflow, so NEITHER of the
 * two recognized shapes applies — and "neither recognized shape" must fail
 * CLOSED, not fall through to "no apply found". The real tree has no local
 * actions at all, so this costs nothing there.
 */
function calledUnitMightApply(calledDoc, resolveSource, visited) {
  // #1801 (final round): a `jobs:` key that is present but malformed — `{}`
  // (empty) or not a map at all (a string, an array) — is NOT "a reusable
  // workflow with zero jobs, safe by construction". It is especially
  // suspicious paired with `runs.using: docker` (two shapes of the SAME
  // document disagreeing about what kind of action/workflow this is), but
  // fails closed regardless of what else is present: neither recognized
  // shape (reusable workflow, composite action) can be proven here.
  const jobsVal = calledDoc?.jobs;
  const jobsIsValidMap =
    jobsVal !== undefined &&
    jobsVal !== null &&
    typeof jobsVal === 'object' &&
    !Array.isArray(jobsVal) &&
    Object.keys(jobsVal).length > 0;
  if (jobsVal !== undefined && !jobsIsValidMap) return true;
  if (jobsIsValidMap) {
    for (const [, j] of Object.entries(jobsVal)) {
      const steps = j?.steps ?? [];
      for (const s of steps) {
        if (typeof s?.run === 'string' && textHasManifestApply(s.run)) return true;
        if (typeof s?.uses === 'string' && usesStepMightApply(s, resolveSource, visited))
          return true;
      }
      // #1801 (final round): a JOB-LEVEL `uses:` inside the called reusable
      // workflow is a NESTED reusable-workflow call (local or remote) — this
      // loop used to look only at `j.steps`, so a job made entirely of
      // `uses: ./another-workflow.yml` (no `steps` at all) was invisible.
      if (
        typeof j?.uses === 'string' &&
        usesStepMightApply({ uses: j.uses, with: j.with }, resolveSource, visited)
      )
        return true;
    }
    return false;
  }
  if (calledDoc?.runs?.using === 'composite') {
    const steps = Array.isArray(calledDoc.runs.steps) ? calledDoc.runs.steps : [];
    for (const s of steps) {
      if (typeof s?.run === 'string' && textHasManifestApply(s.run)) return true;
      if (typeof s?.uses === 'string' && usesStepMightApply(s, resolveSource, visited)) return true;
    }
    return false;
  }
  // Neither a reusable workflow nor a composite action — a docker action
  // (`using: docker`, `image: Dockerfile` or `docker://…` + its own `args:`),
  // a JS action (`using: node20`/`node24`, `main: index.js`), or anything
  // else this module has no way to read the behavior of. Fail closed.
  return true;
}

/**
 * The single place that judges ONE `uses:` reference, however it is
 * reached (a job-level reusable-workflow call, an ordinary step, or a step
 * recursively discovered inside a called local composite action):
 *   - `docker://…` → `dockerStepMightApply` (fail closed, unconditional);
 *   - `changesets/action@…` → `changesetsActionStepMightApply` (scans its
 *     script inputs; #1801 round 3 fix 5);
 *   - a LOCAL path (`./…`) → `localUsesMightApply`, recursive, fail-closed
 *     on an unresolvable target (#1801 round 3 fix 3);
 *   - anything else (a remote action/reusable-workflow ref this module can
 *     never read) → "might apply" UNLESS it is on `KNOWN_NON_APPLYING_ACTIONS`.
 */
function usesStepMightApply(s, resolveSource, visited) {
  const uses = s.uses;
  if (uses.startsWith('docker://')) return dockerStepMightApply(s);
  const base = uses.split('@')[0];
  if (base === 'changesets/action') return changesetsActionStepMightApply(s);
  if (usesLocalPath(uses)) return localUsesMightApply(uses, resolveSource, visited);
  return !KNOWN_NON_APPLYING_ACTIONS.has(base);
}

/**
 * #1801 round 3, fix 1: a job's `uses:` surface is now checked WHETHER OR
 * NOT it also has `run:` steps of its own — `run: node get.mjs` (a fetch)
 * followed by `uses: ./.github/actions/apply` or `uses: azure/k8s-deploy`
 * used to scan clean because the job-level reusable-workflow branch and the
 * uses:-only step branch were each gated on "this job has NO `run:` text at
 * all" (`jobIsUsesOnly`, round 2). That gate is GONE: every step's `uses:`
 * is judged independently of whatever else the job's `run:` steps do.
 * Measured on the real tree: 0 extra offenders from this widening — the
 * jobs that mix `run:` and `uses:` in this repo only ever call a step from
 * `KNOWN_NON_APPLYING_ACTIONS` (checkout/setup/cache/…) alongside their own
 * shell, never a local or unknown-remote action.
 */
function jobUsesSurfaceMightApply(job, resolveSource, visited) {
  if (typeof job?.uses === 'string') {
    if (usesStepMightApply({ uses: job.uses, with: job.with }, resolveSource, visited)) return true;
  }
  return (job?.steps ?? []).some(
    (s) => typeof s?.uses === 'string' && usesStepMightApply(s, resolveSource, visited),
  );
}

/**
 * #1801 (final round): whether the workflow's own trigger includes
 * `workflow_run` — a run of THIS workflow caused by another workflow
 * finishing, in which the upstream run's identity (and so its artifacts)
 * cannot be verified here (the classic "pwn request" pattern: a fork PR's
 * untrusted workflow finishes, triggering a privileged base-repo workflow
 * that then downloads the fork's own artifact). `on:` may be a bare string,
 * an array of trigger names, or a map of trigger → config.
 */
function hasWorkflowRunTrigger(on) {
  if (!on) return false;
  if (typeof on === 'string') return on === 'workflow_run';
  if (Array.isArray(on)) return on.includes('workflow_run');
  if (typeof on === 'object') return Object.hasOwn(on, 'workflow_run');
  return false;
}

/** Every job id a `needs:` value names, normalized to an array. */
function jobNeeds(job) {
  const n = job?.needs;
  if (!n) return [];
  return Array.isArray(n) ? n : [n];
}

/**
 * #1780: are `depJob` (named by `depId`, something `job` `needs:`) and
 * `job` linked closely enough that an apply in one should open the
 * followed-script gate for a fetch in the other? Two kinds of evidence,
 * matching the issue's own scoping — a bare `needs:` edge with NEITHER is
 * NOT enough (most `needs:` edges in this repo are pure sequencing, e.g. a
 * "red-alert" job that only needs its predecessor to decide whether to
 * fire — widening on `needs:` alone would flag nearly every multi-job
 * workflow in the tree and defeat the point of a gate):
 *   - an artifact hand-off (`actions/upload-artifact` in the dependency,
 *     `actions/download-artifact` in the dependent) — either side is
 *     sufficient evidence SOMETHING could flow between them;
 *   - an outputs hand-off — the dependency declares job-level `outputs:`,
 *     or the dependent's own text references `needs.<depId>.outputs`/
 *     `.result` anywhere (steps, `if:`, `with:`, `env:`).
 */
export function jobsLinkedByArtifactOrOutputs(depJob, depId, job) {
  const depProducesArtifact = (depJob?.steps ?? []).some(
    (s) => typeof s?.uses === 'string' && /actions\/upload-artifact/.test(s.uses),
  );
  const jobConsumesArtifact = (job?.steps ?? []).some(
    (s) => typeof s?.uses === 'string' && /actions\/download-artifact/.test(s.uses),
  );
  if (depProducesArtifact || jobConsumesArtifact) return true;
  // #1801 (final round): the SAME hand-off evidence, via `actions/cache`'s
  // split save/restore actions instead of upload/download-artifact — a
  // `save` in the dependency and a `restore` in the dependent is exactly as
  // much a cross-job channel as an artifact upload/download. Deliberately
  // scoped to the SPLIT actions (`actions/cache/save`, `actions/cache/
  // restore`), not the combined `actions/cache` action every ordinary
  // same-job dependency-cache step in this repo already uses — widening to
  // the combined action would link nearly every `needs:`-connected pair in
  // the real tree that merely caches its own dependencies independently.
  const depSavesCache = (depJob?.steps ?? []).some(
    (s) => typeof s?.uses === 'string' && /actions\/cache\/save\b/.test(s.uses),
  );
  const jobRestoresCache = (job?.steps ?? []).some(
    (s) => typeof s?.uses === 'string' && /actions\/cache\/restore\b/.test(s.uses),
  );
  if (depSavesCache || jobRestoresCache) return true;
  if (depJob?.outputs && Object.keys(depJob.outputs).length > 0) return true;
  const hay = JSON.stringify(job ?? {});
  if (new RegExp(`needs\\.${depId}\\.(outputs|result)\\b`).test(hay)) return true;
  return false;
}

/**
 * Scans a parsed GitHub workflow (or composite action) document. A job's
 * `run:` steps execute in order on ONE runner filesystem, so they share FILE
 * state (a file fetched in step 1 and applied in step 3 is caught), while
 * shell variables and errexit reset per step, as they do on a runner. A
 * step's errexit comes from its EFFECTIVE shell (step `shell:`, else job, else
 * workflow `defaults.run.shell`, else bash) — see shellErrexit. A step whose
 * shell is not a POSIX shell is unclassifiable. A verification in a step that
 * is not guaranteed to run to completion (stepGuaranteed) does not carry to
 * later steps. `env:` at workflow, job and step level seeds variables, as do
 * `>> $GITHUB_ENV` writes from earlier steps, so `env: { M: https://… }` +
 * `apply -f "$M"` is a bare-URL apply. The YAML parser has already folded
 * `run: >` blocks — exactly the single-line form bash receives.
 *
 * #1780: `hasApplyAnywhere` is no longer purely job-scoped. It is the OR of:
 *   - this job's own `run:` text (as before);
 *   - this job's `uses:`-only surface, if it has one (`jobUsesSurfaceMightApply`
 *     — a job-level reusable-workflow call, or a job made ENTIRELY of
 *     composite-action steps with no `run:` text of its own): a LOCAL
 *     target is read and judged for real, a REMOTE one not on the known
 *     non-applying list fails closed as "might apply";
 *   - every job in its `needs:`-linked COMPONENT (see
 *     `jobsLinkedByArtifactOrOutputs` for what "linked" requires), unioned
 *     the same way.
 * @param {unknown} doc
 * @param {{
 *   resolveSource?: ((path: string) => string | null) | null,
 *   allowHits?: Map<string, number> | null,
 *   followScripts?: boolean,
 * }} [options]
 * @returns {string[]}
 */
export function unsafeAppliesInWorkflow(
  doc,
  { resolveSource = null, allowHits = null, followScripts = false } = {},
) {
  const offenders = [];
  const envPairs = (env) =>
    Object.entries(env ?? {}).map(([k, v]) => [
      k,
      { value: String(v), url: URL_RE.test(String(v)), content: false },
    ]);
  let jobs = [];
  if (doc?.jobs) jobs = Object.entries(doc.jobs);
  else if (doc?.runs?.steps) jobs = [['(composite)', { steps: doc.runs.steps }]];
  const byId = new Map(jobs);

  // #1780: union-find over `needs:` edges with artifact/outputs evidence —
  // every job starts in its own singleton component.
  const parent = new Map(jobs.map(([id]) => [id, id]));
  const find = (x) => {
    while (parent.get(x) !== x) x = parent.get(x);
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const [jobId, job] of jobs) {
    for (const depId of jobNeeds(job)) {
      const depJob = byId.get(depId);
      if (!depJob) continue;
      if (jobsLinkedByArtifactOrOutputs(depJob, depId, job)) union(jobId, depId);
    }
  }
  const jobOwnApply = (job) =>
    (job?.steps ?? []).some((s) => typeof s?.run === 'string' && textHasManifestApply(s.run)) ||
    jobUsesSurfaceMightApply(job, resolveSource, new Set());
  const componentApply = new Map();
  for (const [jobId, job] of jobs) {
    const root = find(jobId);
    componentApply.set(root, (componentApply.get(root) ?? false) || jobOwnApply(job));
  }

  for (const [jobId, job] of jobs) {
    const carry = { tainted: new Set(), verified: new Map() };
    const persisted = new Map();
    const steps = (job?.steps ?? []).filter((s) => typeof s?.run === 'string');
    const jobHasApply = componentApply.get(find(jobId)) ?? false;
    steps.forEach((step, i) => {
      const shell = effectiveShell(doc, job, step);
      const errexit = shellErrexit(shell);
      if (errexit === null) {
        offenders.push(`${jobId}[${i}]: unclassifiable step shell ${JSON.stringify(shell)}`);
        return;
      }
      const vars = [
        ...envPairs(doc.env),
        ...envPairs(job.env),
        ...persisted,
        ...envPairs(step.env),
      ];
      const before = new Map(carry.verified);
      const result = unsafeApplies(step.run, {
        errexit,
        vars,
        carry,
        persisted,
        finalCheck: i === steps.length - 1,
        resolveSource,
        allowHits,
        followScripts,
        hasApplyAnywhere: jobHasApply,
      });
      for (const o of result) offenders.push(`${jobId}[${i}]: ${o}`);
      if (!stepGuaranteed(step)) revokeStepVerifications(carry, before);
    });
  }
  // #1801 (final round): a workflow_run-triggered workflow that downloads
  // an artifact AND applies a manifest anywhere — see `hasWorkflowRunTrigger`
  // for why the artifact's provenance cannot be trusted here.
  if (hasWorkflowRunTrigger(doc?.on) && [...componentApply.values()].some(Boolean)) {
    for (const [jobId, job] of jobs) {
      const downloadsArtifact = (job?.steps ?? []).some(
        (s) => typeof s?.uses === 'string' && /actions\/download-artifact/.test(s.uses),
      );
      if (downloadsArtifact) {
        offenders.push(
          `${jobId}: workflow_run trigger downloads an artifact of unverifiable provenance, and this workflow applies a manifest (fail closed)`,
        );
      }
    }
  }
  return [...new Set(offenders)];
}

/** Un-verifies (re-taints) every file this step verified. */
function revokeStepVerifications(carry, before) {
  for (const [p, v] of [...carry.verified]) {
    if (before.get(p) === v) continue;
    carry.verified.delete(p);
    carry.tainted.add(p);
  }
}
