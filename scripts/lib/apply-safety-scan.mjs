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

/** Commands whose output is network content. */
const FETCH_WORDS = new Set(['curl', 'wget', 'aria2c', 'http', 'https', 'xh', 'httpie']);
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl']);
const INTERPRETER_FETCH =
  /fetch\(|urllib|requests\.|https?\.get|http\.request|open-uri|Net::HTTP|LWP/;
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

/**
 * Walks shell text with bash's quoting CONTEXTS, not flat quote toggles: a
 * `$( … )` inside `"…"` starts a fresh code context, so `"$(printf 'a "b')"`
 * is one word. Calls `visit(i, depth)` for every index, where depth 0 means
 * top-level code (outside every quote, `$(…)`, `(…)`, `${…}`, backtick).
 * An OPENING quote/`$` is reported at the outer depth and a CLOSING one at
 * the inner depth, so neither is ever mistaken for top-level code. `visit`
 * may return an index to jump to. Returns the final frame-stack height (1
 * when the text is balanced).
 */
export function scanFrames(text, visit) {
  const stack = [{ t: 'code', paren: 0 }];
  const depthOf = () => {
    let d = stack.length - 1;
    for (const f of stack) if (f.t === 'code') d += f.paren;
    return d;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const top = stack.at(-1);
    const d = depthOf();
    const jump = visit(i, d, top.t);
    if (typeof jump === 'number') {
      i = jump;
      continue;
    }
    // The second char of a `$(`/`${`/`$'` opener is visited (inside the new
    // frame) but is not itself a paren/brace/quote.
    if (top.opening) {
      top.opening = false;
      i++;
      continue;
    }
    if (top.t === 'sq') {
      if (c === "'") stack.pop();
      i++;
      continue;
    }
    if (top.t === 'sqa' || top.t === 'bq') {
      if (c === '\\') i += 2;
      else {
        if ((top.t === 'sqa' && c === "'") || (top.t === 'bq' && c === '`')) stack.pop();
        i++;
      }
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (top.t === 'dq') {
      if (c === '"') stack.pop();
      else if (c === '$' && text[i + 1] === '(') {
        stack.push({ t: 'code', paren: 0, opening: true });
        i++;
        continue;
      } else if (c === '$' && text[i + 1] === '{') {
        stack.push({ t: 'brace', n: 1, opening: true });
        i++;
        continue;
      } else if (c === '`') stack.push({ t: 'bq' });
      i++;
      continue;
    }
    if (top.t === 'brace') {
      if (c === '{') top.n++;
      else if (c === '}') {
        top.n--;
        if (top.n === 0) stack.pop();
      } else if (c === '"') stack.push({ t: 'dq' });
      else if (c === "'") stack.push({ t: 'sq' });
      i++;
      continue;
    }
    // code frame
    if (c === '$' && text[i + 1] === "'") {
      stack.push({ t: 'sqa', opening: true });
      i++;
      continue;
    }
    if (c === "'") stack.push({ t: 'sq' });
    else if (c === '"') stack.push({ t: 'dq' });
    else if (c === '`') stack.push({ t: 'bq' });
    else if (c === '$' && text[i + 1] === '(') {
      stack.push({ t: 'code', paren: 0, opening: true });
      i++;
      continue;
    } else if (c === '$' && text[i + 1] === '{') {
      stack.push({ t: 'brace', n: 1, opening: true });
      i++;
      continue;
    } else if (c === '(') top.paren++;
    else if (c === ')') {
      if (top.paren > 0) top.paren--;
      else if (stack.length > 1) stack.pop();
    }
    i++;
  }
  return stack.length;
}

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
    /** canonical paths already loaded via `source`, to stop cycles. */
    this.sourced = new Set();
    /** the first `source`d path that could not be resolved, if any. */
    this.unresolvedSource = null;
  }
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
 * A loopback URL (`http://localhost:9898/…` from `kubectl exec pod -- curl`)
 * reads a local process's state, not an upstream artifact. Strict on
 * purpose: a literal loopback host only, never a variable host, and no second
 * `://` (a local proxy handed an upstream URL is still upstream).
 */
const LOOPBACK_URL = /^https?:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(:\d+)?(\/|$)/;

export function isLoopbackUrl(u) {
  return LOOPBACK_URL.test(u) && u.split('://').length === 2 && !/\$/.test(u.split('/')[2]);
}

export function isFetchSegment(ws, st) {
  for (let k = 0; k < ws.length; k++) {
    const w = canonical(ws[k], st.vars).replace(/^\\/, '');
    const base = w.split('/').pop();
    if (base === 'gh' && /^(api|release|run)$/.test(unquote(ws[k + 1] ?? ''))) return true;
    if (INTERPRETERS.has(base) && INTERPRETER_FETCH.test(ws.slice(k + 1).join(' '))) return true;
    if (!FETCH_WORDS.has(base)) continue;
    // A fetcher whose every URL is loopback reads local state; any other
    // host — or no determinable URL at all — is network content.
    const urls = ws
      .slice(k + 1)
      .map((a) => canonical(a, st.vars))
      .filter((a) => /:\/\//.test(a));
    if (urls.length === 0 || !urls.every(isLoopbackUrl)) return true;
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
  if (INTERPRETERS.has(b) && INTERPRETER_FETCH.test(args.join(' '))) return interpreterFetch(b);
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

const hasRemoteArg = (args) => args.some((a) => REMOTE_ARG_RE.test(a) && !isLoopbackUrl(a));

function gitFetches(args) {
  const { sub, rest } = subcommand(args, new Set(['-C', '-c', '--git-dir', '--work-tree']));
  if (sub === 'clone' || sub === 'svn') return true;
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
  const { functions: sourcedFns } = extractFunctions(adoptHeredocs(code, heredocs, st));
  for (const [n, fn] of sourcedFns) if (!st.functions.has(n)) st.functions.set(n, fn);
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
            out.push(
              w
                .slice(i + 2, j)
                .replace(/^\(/, '')
                .replace(/\)$/, ''),
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
  if (['export', 'local', 'declare', 'readonly', 'typeset'].includes(ws[0])) {
    k = 1;
    while (ws[k]?.startsWith('-')) k++;
  }
  let any = false;
  for (; k < ws.length; k++) {
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
      refs.some((r) => r.content);
    st.vars.set(m[1], { value, url: URL_RE.test(expanded) || refs.some((r) => r.url), content });
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
];

function reportRemoteFetch(st, why, seg) {
  const entry = REMOTE_FETCH_ALLOWLIST.find((e) => e.segment.test(seg));
  if (entry) {
    st.allowHits?.set(entry.id, (st.allowHits.get(entry.id) ?? 0) + 1);
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
      continue;
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
        else if (INTERPRETER_FETCH.test(body))
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
      const readsNetwork =
        networkSoFar ||
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
    if (why) offend(st, `stdin apply fed by network content (${why})`, clause);
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

function heredocExpansions(body) {
  // Only what an unquoted heredoc EXPANDS matters; its literal YAML text does not.
  const bits = [];
  for (const m of body.matchAll(/\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)|`([^`]*)`/g))
    bits.push(m[1] ?? m[2]);
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
 * `allowHits` (a Map) counts REMOTE_FETCH_ALLOWLIST matches for the spec.
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
  } = {},
) {
  const { code, heredocs, error } = lex(rawText);
  const st = new State({ errexit: errexit || /^#!.*\s-[a-z]*e/.test(rawText), vars });
  st.resolveSource = resolveSource;
  st.allowHits = allowHits;
  if (carry) {
    st.tainted = carry.tainted;
    st.verified = carry.verified;
  }
  st.heredocs = heredocs;
  if (error) offend(st, 'unparseable', error);
  const { code: top, functions } = extractFunctions(code);
  st.functions = functions;

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
    sub.allowHits = st.allowHits;
    sub.sourced = new Set(st.sourced);
    sub.unresolvedSource = st.unresolvedSource;
    walk(body, sub, {
      depth: 1,
      defeated: false,
      stdinProducer: null,
      standalone: true,
      inFunction: true,
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
 */
export function unsafeAppliesInWorkflow(doc, { resolveSource = null, allowHits = null } = {}) {
  const offenders = [];
  const envPairs = (env) =>
    Object.entries(env ?? {}).map(([k, v]) => [
      k,
      { value: String(v), url: URL_RE.test(String(v)), content: false },
    ]);
  let jobs = [];
  if (doc?.jobs) jobs = Object.entries(doc.jobs);
  else if (doc?.runs?.steps) jobs = [['(composite)', { steps: doc.runs.steps }]];
  for (const [jobId, job] of jobs) {
    const carry = { tainted: new Set(), verified: new Map() };
    const persisted = new Map();
    const steps = (job?.steps ?? []).filter((s) => typeof s?.run === 'string');
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
      });
      for (const o of result) offenders.push(`${jobId}[${i}]: ${o}`);
      if (!stepGuaranteed(step)) revokeStepVerifications(carry, before);
    });
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
