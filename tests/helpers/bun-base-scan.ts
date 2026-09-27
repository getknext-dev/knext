/**
 * #1452 round 5 — the infra/bun-base allowlist scanner, on a REAL shell parser.
 *
 * Rounds 1-4 lexed build.sh by hand and every round found a desync (#1444 class): a quote the lexer
 * did not model let bash run lines the scanner never saw. This version parses with mvdan-sh (the
 * GopherJS build of mvdan.cc/sh/v3/syntax, the bash parser behind shfmt) and walks the AST. Every
 * rule below FAILS CLOSED: a parse error, a statement kind the walker does not model, a statement the
 * walker did not visit, or a construct outside the reviewed shapes is a problem, never a skip.
 *
 * What it enforces (README.md "How the guard works" is the prose version):
 *  1. parse errors / EOF inside a construct are red (the parser refuses them);
 *  2. every simple command's head is a literal word and matches the allowlist in an allowed shape;
 *  3. only pin() and lap() may be defined, once each, with the reviewed bodies;
 *  4. assignments only to known names; PATH/HOME/WS/SRC/OUT/… only as the one reviewed line;
 *  5. every redirection target/source is a reviewed path (so no /dev/tcp, however it is spelled);
 *  6. each network command runs in the script's top-level flow and is followed, in the same statement
 *     list and before the next network command, by its verifier (same file, same directory);
 *  7. prefix.sh: no network command and no function at all;
 *  8. unpinned-fetches.json entries each match exactly their declared number of calls;
 * 9. (round 9) no arithmetic context at all — `$(( ))`, `(( ))`, `let`, `for (( ))`, array subscripts,
 *     slices, `${!…}`, array assignments, `declare`/flagged `export`/`local`, `-eq`-family and `-v`
 *     tests — found by a GENERIC walk over every field of every node, never judged, only banned;
 * 10. every Stmt/CallExpr/Redirect/Assign/FuncDecl/DeclClause/CmdSubst/ProcSubst the generic walk
 *     finds was also reached by the rule walk (count-compared), so no field can hide code from it;
 * 11. (round 10) option/operator words are judged by their PARSED shape, never their source text:
 *     printf's format must be one static literal part not starting with `-` (so no `-v`, however
 *     quoted or expanded), and `[`/`test` must be one of the reviewed argc shapes with a plain
 *     unquoted operator from a fixed allowlist and no operand that can split or glob;
 * 12. (round 10) no word's static text may be re-evaluable as code — `$(`, `$[`, a backtick, or a
 *     `NAME[` subscript (with every expansion counted as possibly-anything), and no `$'…'`/`$"…"`.
 * 13. (round 11) every name has exactly ONE binding site — `=`, `export`/`local`, a prefix
 *     assignment, a `for` variable, `read`/`mapfile`/`readarray`/`printf -v`/`getopts`/`wait -p`
 *     targets, all found by scanning — except `line`, `have_patches`, `wkarch` at their exact
 *     reviewed sites; the verifiers' operands have one reviewed derivation each (CONSTS) and the
 *     committed pins must be static text, so no check input can be rebound around its check.
 *     (L2) Bash also binds names with no site to count — `BASH_REMATCH` (`[[ =~ ]]`), `PWD`/`OLDPWD`
 *     (`cd`), `_` — so "exactly once" holds for the names the SCRIPT binds; those four are
 *     BASH_IMPLICIT below, none is a verifier operand, and none is read today.
 * 14. (round 12) PRESENCE: every pinned name (CONSTS + STATIC_PINS) HAS its one site in build.sh.
 *     Rules 4 and 13 judge the sites that exist; deleting a pinned line left no site to judge, and
 *     the value then came from the executor's environment (review-1469-r11 E1–E7).
 * 15. (round 12) every name READ (every ParamExp, found by the generic walk) is bound in the script
 *     before the read, or is a bash special/implicit name, or is on ENV_READS — the reviewed list of
 *     what build.sh takes from cloudbuild.yaml's build step `env` (which that test pins exactly).
 */
import { isDeepStrictEqual } from 'node:util';
import sh, { type ShNode } from 'mvdan-sh';
import { parseDocument } from 'yaml';

const { syntax } = sh;
const T = (n: ShNode) => syntax.NodeType(n);
const newParser = () => syntax.NewParser(syntax.Variant(syntax.LangBash));

/** Where a command sits. Only 'top' (the script's own flow, loops and subshells included) may fetch. */
export type Kind = 'top' | 'branch' | 'cond' | 'fn' | 'subst' | 'errpath';

export type Cmd = {
  words: string[];
  redirs: string[];
  line: number;
  /** Byte offset of the statement's end (a name it binds through an argument is bound there). */
  end?: number;
  kind: Kind;
  /** Statement-list id; a subshell shares its parent's list (its status is the parent's check). */
  list: number;
  /** Its failure — or its not running at all — stops the script. */
  must: boolean;
  /** Left of `&&`: set -e ignores its failure. */
  andLhs: boolean;
  pipe: number | null;
  fn: string | null;
  /** Static working directory when it runs ('?' when not known). */
  cwd: string;
  /** Per word (aligned with `words`), its PARSED shape — CallExpr only (`[[ ]]` has none). */
  shapes?: WordShape[];
};

/** What the parser — not the source text — says a word is. */
export type WordShape = {
  /** Exactly one unquoted Lit part with no backslash: the word IS its source text. */
  plainLit: boolean;
  /** Exactly one part that is a Lit or a plain '…' (no expansion, no concatenation). */
  onePart: boolean;
  /** Its value when fully static (quotes removed), else null. */
  value: string | null;
  /** An unquoted expansion ($x, $(…), …): its value may split into several words. */
  unquotedDyn: boolean;
  /** An unquoted glob / brace character: it may expand into several words. */
  unquotedGlob: boolean;
};

/** Placeholder for an expansion's (unknown) text inside a word's static text (a private-use code
 *  point: it cannot occur in the scripts' own text). */
const DYN = '\uE000';
const unescapeLit = (v: string) => v.replace(/\\([\s\S])/g, '$1');
const unescapeDq = (v: string) => v.replace(/\\([$`"\\\n])/g, '$1');
/** A word part's static text; every expansion becomes DYN (it could be anything). */
function partText(p: ShNode): string {
  const k = kindOf(p);
  if (k === 'Lit') return unescapeLit(String(p.Value ?? ''));
  if (k === 'SglQuoted') return String(p.Value ?? '');
  if (k === 'DblQuoted')
    return (p.Parts ?? [])
      .map((q) => (kindOf(q) === 'Lit' ? unescapeDq(String(q.Value ?? '')) : DYN))
      .join('');
  return DYN;
}
/** The static text of a whole word — its parts CONCATENATED, so a split like `'x'"["'$(id)]'` or
 *  `"\$"'(id)'` is judged as the one string bash builds from it. */
export function wordText(w: ShNode): string {
  return (w.Parts ?? []).map(partText).join('');
}
/** Text bash re-evaluates as code in some context (`printf -v`, `test -v`, `[[ ]]`, `declare`, `let`,
 *  a subscript, `eval`): a command substitution, `$[`, a backtick, or `NAME[`. An expansion (DYN)
 *  counts as both a `$` and a name character, since its value is unknown. */
const RE_EVALUABLE = /[$\uE000][([]|`|\$\uE000|[A-Za-z_\uE000][A-Za-z0-9_\uE000]*\[/;

function wordShape(w: ShNode): WordShape {
  const parts = w.Parts ?? [];
  const kinds = parts.map((x) => kindOf(x) ?? '?');
  const statik = parts.every(
    (x, i) =>
      kinds[i] === 'Lit' ||
      (kinds[i] === 'SglQuoted' && !x.Dollar) ||
      (kinds[i] === 'DblQuoted' && !x.Dollar && (x.Parts ?? []).every((q) => kindOf(q) === 'Lit')),
  );
  const lit0 = kinds.length === 1 && kinds[0] === 'Lit' ? String(parts[0]!.Value ?? '') : null;
  return {
    plainLit: lit0 !== null && !lit0.includes('\\'),
    onePart:
      kinds.length === 1 && (kinds[0] === 'Lit' || (kinds[0] === 'SglQuoted' && !parts[0]!.Dollar)),
    value: statik ? wordText(w) : null,
    unquotedDyn: kinds.some((k) => k !== 'Lit' && k !== 'SglQuoted' && k !== 'DblQuoted'),
    unquotedGlob: parts.some(
      (x, i) => kinds[i] === 'Lit' && /[*?[{]/.test(String(x.Value ?? '').replace(/\\./g, '')),
    ),
  };
}

export type Parsed = {
  cmds: Cmd[];
  problems: string[];
  fnDefs: { name: string; body: string[]; line: number }[];
  /** `=` assignments (plain, prefix, export/local/declare): its source text, and its value when
   *  fully static (null for an expansion or a bare `local x`). */
  assigns: { name: string; text: string; line: number; value: string | null; end: number }[];
  /** `for NAME in …` loop variables (a binding site the `=` list does not see). */
  loopVars: { name: string; line: number; end: number }[];
  /** Every parameter expansion (`$NAME`, `${NAME…}`, `$1`, `$?`), found by the GENERIC walk — a
   *  read of NAME at byte offset `off` (round 12). */
  reads: { name: string; line: number; off: number }[];
  visited: number;
  total: number;
  /** Per COVERED_KINDS kind: nodes the rule walk reached / nodes the generic walk found. */
  reached: Record<string, number>;
  reachable: Record<string, number>;
};

type Box = { v: string };
type Ctx = {
  kind: Kind;
  must: boolean;
  list: number;
  fn: string | null;
  pipe: number | null;
  andLhs: boolean;
  /** Last statement of a subshell whose status the parent checks. */
  tail: boolean;
  cwd: Box;
};

function errText(e: unknown): string {
  const f = (e as { Error?: () => string } | null)?.Error;
  return typeof f === 'function' ? f.call(e) : String(e);
}

/** Allowed ${…} operators, derived from the parser itself rather than hard-coded enum numbers. */
function probeOp(src: string): number {
  let op = -1;
  syntax.Walk(newParser().Parse(src, 'probe'), (n) => {
    if (n && T(n) === 'ParamExp' && n.Exp) op = n.Exp.Op ?? -1;
    return true;
  });
  return op;
}
const PARAM_OPS_OK = new Set([probeOp('echo ${a:-b}'), probeOp('echo ${a%%b}')]);

/** Op codes derived from the parser itself (never hard-coded enum numbers that could drift across
 *  mvdan-sh versions): the `[[ ]]` operators that evaluate their operands ARITHMETICALLY (`-eq`…`-ge`
 *  run both sides through bash's arithmetic evaluator, assignment and command substitution
 *  included), and `-v`, which evaluates an array subscript in its operand (`[[ -v 'a[$(id)]' ]]`). */
function probeTestOp(src: string, kind: 'BinaryTest' | 'UnaryTest'): number {
  let code = -1;
  syntax.Walk(newParser().Parse(src, 'probe'), (n) => {
    if (n && T(n) === kind && code === -1) code = n.Op ?? -1;
    return true;
  });
  return code;
}
const ARITH_TEST_OPS = new Set(
  ['-eq', '-ne', '-lt', '-le', '-gt', '-ge'].map((op) =>
    probeTestOp(`[[ 1 ${op} 1 ]]`, 'BinaryTest'),
  ),
);
const SUBSCRIPT_TEST_OPS = new Set([probeTestOp('[[ -v x ]]', 'UnaryTest')]);

/** ── THE ARITHMETIC BAN (#1469 round 9) ──────────────────────────────────────────────────────────
 * Rounds 6-8 tried to JUDGE bash's arithmetic contexts (which names, which operators, which array is
 * associative, in which order and scope) and every round found a context or a nesting the judge did
 * not model. The scripts now use none of them, so the rule is a ban, with no arithmetic semantics
 * left to get wrong: any node below is red wherever it sits, found by the GENERIC walk (every field
 * of every node, see genericWalk) — never by a visitor that could skip a field. */
const ARITH_KINDS = new Set([
  'ArithmExp', // $(( )) and $[ ]
  'ArithmCmd', // (( ))
  'LetClause', // let
  'CStyleLoop', // for (( ; ; ))
  'BinaryArithm',
  'UnaryArithm',
  'ParenArithm',
]);
/** Why node `n` (of kind `k`) is banned outright, or undefined. */
function banned(n: ShNode, k: string, sl: (x: ShNode) => string): string | undefined {
  if (ARITH_KINDS.has(k))
    return `arithmetic (${k}) is banned — the scripts use no arithmetic context`;
  if (k === 'ParamExp') {
    if (n.Index) return `array subscript \`${sl(n)}\` is banned — the scripts use no arrays`;
    if (n.Slice)
      return `slice \`${sl(n)}\` is banned (its offset/length is arithmetic) — use cut -c`;
    if (n.Names) return `name-prefix expansion \`${sl(n)}\` (\${!p*}) is banned`;
    if (n.Excl) return `indirect expansion \`${sl(n)}\` (\${!…}) is banned`;
    if (n.Exp && !PARAM_OPS_OK.has(n.Exp.Op ?? -1))
      return `parameter-expansion operator in \`${sl(n)}\` other than :- and %% is banned (:= assigns, @P runs)`;
  }
  if (k === 'Assign') {
    if (n.Index) return `indexed assignment \`${sl(n)}\` is banned — the scripts use no arrays`;
    if (n.Array) return `array assignment \`${sl(n)}\` is banned — the scripts use no arrays`;
  }
  if (k === 'DeclClause') {
    const variant = String(n.Variant?.Value ?? '');
    const flags = (n.Args ?? [])
      .filter((a) => a.Naked && !a.Name)
      .map((a) => (a.Value ? sl(a.Value as ShNode) : ''));
    const shape = [variant, ...flags].join(' ');
    if (shape !== 'export' && shape !== 'local')
      return `${shape}: banned — only bare export and local are allowed (no declare/typeset/readonly, no -a/-A/-i/-n or any flag)`;
  }
  if (k === 'BinaryTest' && ARITH_TEST_OPS.has(n.Op ?? -1))
    return '[[ ]] arithmetic comparison (-eq/-ne/-lt/-le/-gt/-ge) is banned — it evaluates both operands arithmetically';
  if (k === 'UnaryTest' && SUBSCRIPT_TEST_OPS.has(n.Op ?? -1))
    return '[[ -v ]] is banned — it evaluates an array subscript in its operand';
  // ── round 10: no re-evaluable text ──
  if ((k === 'SglQuoted' || k === 'DblQuoted') && n.Dollar)
    return `${k === 'SglQuoted' ? "$'…'" : '$"…"'} quoting \`${sl(n)}\` is banned (escapes can spell any text)`;
  if (k === 'Word' && RE_EVALUABLE.test(wordText(n)))
    return `word \`${sl(n)}\` carries re-evaluable text ($( / $[ / backtick / NAME[) — bash re-runs such text in printf -v, test -v, [[ ]], declare, subscripts`;
  return undefined;
}

/** A node's kind from the wrapper's own `$type` (`mvdan.cc/sh/v3/syntax.*Stmt` → `Stmt`). */
function kindOf(o: unknown): string | undefined {
  const t = (o as { $type?: unknown } | null)?.$type;
  return typeof t === 'string' ? t.replace(/^.*[.*]/, '') : undefined;
}

/** THE GENERIC WALK (#1469 round 9). `syntax.Walk` visits the children the library's visitor knows
 *  about and nothing else — it never descends into `ParamExp.Slice`, which is how round 8 ran a
 *  command substitution nobody scanned. This walk does not know the grammar at all: it reads EVERY
 *  own property of every node wrapper (mvdan-sh's GopherJS wrappers expose each exported Go field as
 *  a property), recursing into anything carrying a `$type` and into every array. A field a visitor
 *  ignores cannot hide a node from it. `visit` returning false skips that node's children. */
export function genericWalk(root: ShNode, visit: (n: ShNode, kind: string) => boolean): void {
  const stack: unknown[] = [root];
  while (stack.length) {
    const o = stack.pop();
    if (Array.isArray(o)) {
      for (let i = o.length - 1; i >= 0; i--) stack.push(o[i]);
      continue;
    }
    const k = kindOf(o);
    if (k === undefined) continue;
    if (!visit(o as ShNode, k)) continue;
    const kids: unknown[] = [];
    for (const key of Reflect.ownKeys(o as object)) {
      if (typeof key !== 'string' || key === '__internal_object__' || key === '$type') continue;
      const v = (o as Record<string, unknown>)[key];
      if (v && typeof v === 'object') kids.push(v);
    }
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

/** Node kinds whose every occurrence the RULE walk must reach, compared by count against the generic
 *  walk — so a construct the rule walk's hand-written dispatch does not descend into is red. */
export const COVERED_KINDS = [
  'Stmt',
  'CallExpr',
  'Redirect',
  'Assign',
  'FuncDecl',
  'DeclClause',
  'CmdSubst',
  'ProcSubst',
] as const;

/** CONSTS' one-reviewed-line rule. */
function constMismatch(name: string, text: string): string | undefined {
  const want = CONSTS[name];
  if (want === undefined || text === want) return undefined;
  return `${name} may only be set as \`${want}\``;
}

/** Redirection targets / sources the scripts may use — every other path is red. */
const OUT_TARGETS = new Set([
  '/dev/null',
  '/tmp/llvm.colons',
  '/etc/apt/keyrings/apt.llvm.org.gpg',
  '/etc/apt/sources.list.d/llvm.list',
  '"$OUT/manifest.json"',
  '"$WS/.prefix"',
]);
const IN_SOURCES = new Set(['/tmp/llvm.asc']);

export function parseScript(src: string, name = 'build.sh'): Parsed {
  const out: Parsed = {
    cmds: [],
    problems: [],
    fnDefs: [],
    assigns: [],
    loopVars: [],
    reads: [],
    visited: 0,
    total: 0,
    reached: {},
    reachable: {},
  };
  let file: ShNode;
  try {
    file = newParser().Parse(src, name);
  } catch (e) {
    out.problems.push(`parse error: ${errText(e)}`);
    return out;
  }
  // mvdan/sh offsets are UTF-8 byte offsets; build.sh has non-ASCII comments.
  const bytes = Buffer.from(src, 'utf8');
  const at = (a: number, b: number) => bytes.subarray(a, b).toString('utf8');
  const sl = (n: ShNode) => at(n.Pos().Offset(), n.End().Offset());
  const bad = (n: ShNode, msg: string) => out.problems.push(`line ${n.Pos().Line()}: ${msg}`);
  let lists = 0;
  let pipes = 0;
  const branch = (k: Kind): Kind => (k === 'top' ? 'branch' : k);

  // How many nodes of each COVERED_KINDS kind the rule walk below reached; compared at the end with
  // the generic walk's count of the same kinds over the whole file.
  const reached: Record<string, number> = {};
  const reach = (k: string) => {
    reached[k] = (reached[k] ?? 0) + 1;
  };

  /** Command/process substitutions inside a word-bearing node, found by the GENERIC walk (so no
   *  field — a slice offset, a subscript, a heredoc body — can hide one). Statements are the rule
   *  walk's own; they are never entered from here. */
  const expansions = (node: ShNode, ctx: Ctx) =>
    genericWalk(node, (n, t) => {
      if (t === 'Stmt') return false;
      if (t === 'CmdSubst' || t === 'ProcSubst') {
        reach(t);
        if (t === 'ProcSubst') bad(n, 'process substitution <( ) / >( ) is not allowed');
        walkList(n.Stmts ?? [], {
          ...ctx,
          kind: 'subst',
          must: false,
          list: ++lists,
          pipe: null,
          andLhs: false,
          tail: false,
          cwd: { v: ctx.cwd.v },
        });
        return false;
      }
      return true;
    });

  const assign = (a: ShNode, ctx: Ctx) => {
    reach('Assign');
    const nm = a.Name ? String(a.Name.Value) : '';
    if (nm)
      out.assigns.push({
        name: nm,
        text: sl(a),
        line: a.Pos().Line(),
        value: a.Value && !a.Array && !a.Index ? wordShape(a.Value as ShNode).value : null,
        end: a.End().Offset(),
      });
    expansions(a, ctx);
  };

  const redirect = (r: ShNode, ctx: Ctx): string => {
    reach('Redirect');
    const text = sl(r);
    const n = r.N ? String(r.N.Value) : '';
    const op = /^(<<<|<<-|<<|<>|<&|>&|&>>|&>|>>|>\||>|<)/.exec(text.slice(n.length))?.[1] ?? '?';
    const word = r.Word ? sl(r.Word) : '';
    expansions(r, ctx);
    if (op === '<<' || op === '<<-' || op === '<<<') return `${n}${op}${word}`;
    if ((op === '>&' || op === '<&') && /^(\d+|-)$/.test(word)) return `${n}${op}${word}`;
    if (op === '<') {
      if (!IN_SOURCES.has(word)) bad(r, `input redirection from a non-reviewed source: <${word}`);
    } else if (op === '<>' || op === '<&') bad(r, `redirection ${op}${word} is not allowed`);
    else if (!OUT_TARGETS.has(word))
      bad(r, `output redirection to a non-reviewed path: ${op}${word}`);
    return `${n}${op}${word}`;
  };

  const emit = (s: ShNode, words: string[], redirs: string[], ctx: Ctx, shapes?: WordShape[]) => {
    out.cmds.push({
      ...(shapes ? { shapes } : {}),
      words,
      redirs,
      line: s.Pos().Line(),
      end: s.End().Offset(),
      kind: ctx.kind,
      list: ctx.list,
      must: ctx.must,
      andLhs: ctx.andLhs,
      pipe: ctx.pipe,
      fn: ctx.fn,
      cwd: ctx.cwd.v,
    });
  };

  const exitsNonZero = (s: ShNode): boolean => {
    const c = s.Cmd;
    if (!c) return false;
    if (T(c) === 'CallExpr') return /^exit [1-9][0-9]*$/.test(sl(c));
    if (T(c) === 'Block') {
      const st = c.Stmts ?? [];
      return st.length > 0 && exitsNonZero(st[st.length - 1]!);
    }
    return false;
  };

  function walkList(stmts: ShNode[], ctx: Ctx): void {
    for (const [i, s] of stmts.entries())
      walkStmt(s, { ...ctx, tail: ctx.tail && i === stmts.length - 1 });
  }

  function walkStmt(s: ShNode, ctx: Ctx): void {
    out.visited++;
    reach('Stmt');
    if (s.Background) bad(s, 'backgrounded command (its failure is lost)');
    if (s.Coprocess) bad(s, 'coproc is not allowed');
    if (s.Negated && ctx.kind !== 'cond') bad(s, '! outside an if condition swallows the failure');
    const redirs = (s.Redirs ?? []).map((r) => redirect(r, ctx));
    const c = s.Cmd;
    if (!c) return;
    const t = T(c);
    if (t === 'CallExpr') {
      reach('CallExpr');
      for (const a of c.Assigns ?? []) assign(a, ctx);
      const args = c.Args ?? [];
      for (const a of args) expansions(a, ctx);
      if (!args.length) return; // assignment only
      const words = args.map(sl);
      const shapes = args.map(wordShape);
      if (words[0] === 'cd') {
        if (ctx.kind !== 'top' && ctx.kind !== 'subst') bad(c, 'cd outside the top-level flow');
        ctx.cwd.v = words.length === 2 ? words[1]!.replace(/^"(.*)"$/, '$1') : '?';
      }
      emit(s, words, redirs, ctx, shapes);
    } else if (t === 'DeclClause') {
      // Its shape (bare export/local, no flag) is judged by the generic ban at the end.
      reach('DeclClause');
      for (const a of c.Args ?? []) assign(a, ctx); // a flag is a Naked Assign with no Name
    } else if (t === 'TestClause') {
      // Its -eq-family and -v operators are judged by the generic ban at the end.
      expansions(c, ctx);
      emit(s, ['[[', sl(c)], redirs, ctx);
    } else if (t === 'BinaryCmd') {
      const op = /^(&&|\|\||\|&|\|)/.exec(
        at(c.X!.End().Offset(), c.Y!.Pos().Offset()).replace(/\\\n/g, '').trim(),
      )?.[1];
      if (op === '&&') {
        walkStmt(c.X!, { ...ctx, must: false, andLhs: true });
        walkStmt(c.Y!, { ...ctx, must: ctx.must && ctx.tail });
      } else if (op === '||') {
        if (!exitsNonZero(c.Y!)) bad(c, '|| that does not end in exit N');
        walkStmt(c.X!, ctx);
        const err: Ctx = { ...ctx, kind: branch(ctx.kind), must: false, list: ++lists, pipe: null };
        const y = c.Y!;
        if (y.Cmd && T(y.Cmd) === 'Block') {
          out.visited++; // the `{ …; exit N; }` statement itself
          reach('Stmt');
          walkList(y.Cmd.Stmts ?? [], { ...err, kind: ctx.kind === 'top' ? 'errpath' : err.kind });
        } else walkStmt(y, { ...err, kind: ctx.kind === 'top' ? 'errpath' : err.kind });
      } else if (op === '|') {
        const id = ctx.pipe ?? ++pipes;
        walkStmt(c.X!, { ...ctx, pipe: id });
        walkStmt(c.Y!, { ...ctx, pipe: id });
      } else {
        bad(c, `operator ${op ?? '?'} is not allowed`);
        walkStmt(c.X!, ctx);
        walkStmt(c.Y!, ctx);
      }
    } else if (t === 'IfClause') {
      let ic: ShNode | null | undefined = c;
      while (ic) {
        const inner: Box = { v: ctx.cwd.v };
        walkList(ic.Cond ?? [], {
          ...ctx,
          kind: 'cond',
          must: false,
          list: ++lists,
          tail: false,
          cwd: inner,
        });
        walkList(ic.Then ?? [], {
          ...ctx,
          kind: branch(ctx.kind),
          must: false,
          list: ++lists,
          tail: false,
          cwd: inner,
        });
        ic = ic.Else;
      }
    } else if (t === 'ForClause') {
      const loop = c.Loop!;
      if (T(loop) !== 'WordIter') {
        bad(c, 'only `for NAME in WORDS` loops are allowed');
      } else {
        if (!FOR_HEADERS.has(`for ${sl(loop)}`))
          bad(c, `loop header not reviewed: for ${sl(loop)}`);
        out.loopVars.push({
          name: String(loop.Name?.Value ?? ''),
          line: c.Pos().Line(),
          end: loop.End().Offset(),
        });
      }
      expansions(loop, ctx);
      walkList(c.Do ?? [], { ...ctx, list: ++lists, tail: false });
    } else if (t === 'CaseClause') {
      if (c.Word) expansions(c.Word, ctx);
      for (const item of c.Items ?? []) {
        for (const p of item.Patterns ?? []) expansions(p, ctx);
        walkList(item.Stmts ?? [], {
          ...ctx,
          kind: branch(ctx.kind),
          must: false,
          list: ++lists,
          tail: false,
          cwd: { v: ctx.cwd.v },
        });
      }
    } else if (t === 'Subshell') {
      walkList(c.Stmts ?? [], { ...ctx, tail: ctx.must, cwd: { v: ctx.cwd.v } });
    } else if (t === 'Block') {
      bad(c, '{ } group outside `|| { …; exit N; }` and function bodies');
      walkList(c.Stmts ?? [], { ...ctx, kind: branch(ctx.kind), must: false, list: ++lists });
    } else if (t === 'FuncDecl') {
      reach('FuncDecl');
      const name = String(c.Name?.Value ?? '');
      if (ctx.kind !== 'top' || ctx.list !== 0)
        bad(c, `function ${name} defined outside the top level`);
      const body = c.Body!;
      out.visited++;
      reach('Stmt');
      const blk = body.Cmd && T(body.Cmd) === 'Block' ? body.Cmd : null;
      if (!blk) bad(c, `function ${name}: body must be a { } block`);
      const stmts = blk?.Stmts ?? [];
      out.fnDefs.push({
        name,
        body: stmts.map((x) => sl(x).replace(/;$/, '')),
        line: c.Pos().Line(),
      });
      walkList(stmts, {
        kind: 'fn',
        must: false,
        list: ++lists,
        fn: name,
        pipe: null,
        andLhs: false,
        tail: false,
        cwd: { v: '?' },
      });
    } else {
      bad(c, `statement kind ${t} is not modeled by the scanner`);
    }
  }

  walkList(file.Stmts ?? [], {
    kind: 'top',
    must: true,
    list: 0,
    fn: null,
    pipe: null,
    andLhs: false,
    tail: false,
    cwd: { v: '?' },
  });
  // The generic walk, over the whole file, independently of the rule walk above: (1) every banned
  // construct is red wherever it sits, and (2) every COVERED_KINDS node it finds must also have been
  // reached by the rule walk — a mismatch means the rule walk's dispatch skipped some field, which is
  // exactly how a slice's command substitution went unscanned in round 8.
  const reachable: Record<string, number> = {};
  genericWalk(file, (n, k) => {
    if ((COVERED_KINDS as readonly string[]).includes(k)) reachable[k] = (reachable[k] ?? 0) + 1;
    const why = banned(n, k, sl);
    if (why) bad(n, why);
    if (k === 'ParamExp')
      out.reads.push({
        name: String(n.Param?.Value ?? ''),
        line: n.Pos().Line(),
        off: n.Pos().Offset(),
      });
    return true;
  });
  out.total = reachable.Stmt ?? 0;
  if (out.visited !== out.total)
    out.problems.push(`walker visited ${out.visited} of ${out.total} statements`);
  for (const k of COVERED_KINDS) {
    const g = reachable[k] ?? 0;
    const r = reached[k] ?? 0;
    if (g !== r) out.problems.push(`coverage: ${k} reachable ${g}, reached by the rule walk ${r}`);
  }
  out.reached = reached;
  out.reachable = reachable;
  return out;
}

// ── policy ──────────────────────────────────────────────────────────────────────────────────────

const unq = (w: string) => w.replace(/^["']|["']$/g, '');
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?\+?=/;

/** Wrappers stripped before classification: option words taking an argument, then positionals. */
const WRAPPERS: Record<string, { arg: string[]; pos: number; bad?: RegExp }> = {
  timeout: { arg: ['-s', '--signal', '-k', '--kill-after'], pos: 1 },
  env: { arg: ['-u', '--unset', '-C', '--chdir'], pos: 0, bad: /^(-S|--split-string|-[a-zA-Z]*S)/ },
  command: { arg: [], pos: 0 },
  nice: { arg: ['-n', '--adjustment'], pos: 0 },
  ionice: { arg: ['-c', '--class', '-n', '--classdata', '-p', '-P', '-u'], pos: 0 },
  stdbuf: { arg: ['-i', '-o', '-e'], pos: 0 },
  nohup: { arg: [], pos: 0 },
  setsid: { arg: [], pos: 0 },
  exec: { arg: ['-a'], pos: 0 },
  sudo: {
    arg: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T'],
    pos: 0,
    bad: /^(-s|-i|-e|--shell|--login|--edit)$/,
  },
  chroot: { arg: [], pos: 1 },
  time: { arg: ['-f', '-o', '--format', '--output'], pos: 0 },
  xargs: {
    arg: ['-a', '-d', '-E', '-e', '-I', '-i', '-L', '-l', '-n', '-P', '-s', '--delimiter'],
    pos: 0,
  },
};

export type Norm = { words: string[]; text: string; wrapped: string[]; bad: string[] };

export function normalize(c: Cmd): Norm {
  let w = [...c.words];
  const wrapped: string[] = [];
  const bad: string[] = [];
  for (;;) {
    const h = w[0] === undefined ? undefined : unq(w[0]).split('/').pop()!;
    const spec = h === undefined ? undefined : WRAPPERS[h];
    if (!spec || !h) break;
    wrapped.push(h);
    w = w.slice(1);
    while (w[0] !== undefined && (w[0].startsWith('-') || (h === 'env' && ASSIGN.test(w[0])))) {
      const o = w.shift()!;
      if (h === 'env' && ASSIGN.test(o)) bad.push(`env assignment ${o}`);
      if (spec.bad?.test(o)) bad.push(`${h} ${o}`);
      if (spec.arg.includes(o)) w.shift();
    }
    w = w.slice(spec.pos);
  }
  if (wrapped.length && !w.length) bad.push(`${wrapped.join(' ')} with no command`);
  if (unq(w[0] ?? '') === 'git') {
    const rest = w.slice(1);
    while (rest[0]?.startsWith('-')) {
      const o = rest.shift()!;
      if (o === '-c' || o.startsWith('--config-env')) bad.push(`git ${o} (config injection)`);
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(o))
        rest.shift();
    }
    w = ['git', ...rest];
  }
  return { words: w, text: w.join(' '), wrapped, bad };
}

/** Names the scripts may assign, export, declare, read into. */
const VARS = new Set(
  (
    'DEBIAN_FRONTEND HOME LC_ALL WS SRC OUT LLVM_MAJOR LLVM_PKG_VERSION LLVM_SIGNER_FPR ALPINE_RELEASE ' +
    'APK_TOOLS_STATIC_VERSION BOOTSTRAP_BUN RUSTUP_VERSION line TARGETS PREFIX UPSTREAM_SHA have_patches ' +
    'name fpr base PATH repo _ apkarch root GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL HEAD_SHA wk ' +
    'BUN_BUILD_PREFETCH_DIR wkshort wkkey headshort wkarch wkurl wkfile bd LD here sha ph IFS'
  ).split(' '),
);
/** Names whose value decides where tools come from or where bytes land: one reviewed line each. */
const CONSTS: Record<string, string> = {
  PATH: 'PATH=$HOME/.cargo/bin:$PATH',
  HOME: 'HOME=/root',
  WS: 'WS=/workspace',
  SRC: 'SRC=$WS/bun',
  OUT: 'OUT=$WS/out',
  BUN_BUILD_PREFETCH_DIR: 'BUN_BUILD_PREFETCH_DIR=/tmp/bun-prefetch',
  LD: 'LD=/opt/linux-sysroot-musl/lib/ld-musl-x86_64.so.1',
  // IFS controls how `read` splits its input; the one reviewed use (below) needs `:` and nothing
  // else may set it — an `IFS=` elsewhere could repurpose a later `read`/`for`/word-split silently.
  IFS: 'IFS=:',
  // ── round 11 (review-1469-r10, HIGH-1): the OPERANDS of the verifiers. The scanner checks a
  // verifier by its exact text (`[ "$fpr" = "${LLVM_SIGNER_FPR// /}" ]`, `test "$(git rev-parse
  // HEAD)" = "$UPSTREAM_SHA"`, the prefetch-cache grep), so the values those texts compare must
  // come from exactly one reviewed derivation each — `fpr="${LLVM_SIGNER_FPR// /}"` (D2) makes the
  // fingerprint check compare the pin with itself while its text stays the reviewed one.
  PREFIX: 'PREFIX="$(bash "$WS/prefix.sh")"',
  UPSTREAM_SHA: 'UPSTREAM_SHA="${PREFIX%%-*}"',
  fpr: `fpr="$(awk -F: '/^fpr:/ && !n++ {print $10}' /tmp/llvm.colons)"`,
  HEAD_SHA: 'HEAD_SHA="$(git rev-parse HEAD)"',
  headshort: `headshort="$(printf '%s' "$HEAD_SHA" | cut -c1-9)"`,
  wk: `wk="$(grep -oE 'WEBKIT_VERSION = "[0-9a-f]{40}"' scripts/build/deps/webkit.ts | grep -oE '[0-9a-f]{40}')"`,
  wkshort: `wkshort="$(printf '%s' "$wk" | cut -c1-16)"`,
  wkurl:
    'wkurl="https://github.com/oven-sh/WebKit/releases/download/autobuild-$wk/bun-webkit-linux-$wkarch-musl-lto.tar.gz"',
  wkfile: 'wkfile="bun-webkit-linux-$wkarch-musl-lto-$wkshort.tar.gz"',
  wkkey: `wkkey="$(printf '%s' "$wkurl" | sha256sum | cut -c1-32)"`,
};
/** Pins committed in build.sh itself: their value must be STATIC text (no expansion, no command
 *  substitution) — the pin is what the script says, never something it computes or downloads. The
 *  value is not duplicated here (a bump edits build.sh only); the single-site rule keeps it bound
 *  once, so `LLVM_SIGNER_FPR="$fpr"` after the key download (D3) is red twice over. */
const STATIC_PINS = new Set([
  'LLVM_MAJOR',
  'LLVM_PKG_VERSION',
  'LLVM_SIGNER_FPR',
  'ALPINE_RELEASE',
  'APK_TOOLS_STATIC_VERSION',
  'BOOTSTRAP_BUN',
  'RUSTUP_VERSION',
]);
/** THE SINGLE-ASSIGNMENT-SITE RULE (round 11, review-1469-r10 HIGH-1). Every name bound anywhere in
 *  a script — by `=` (plain, prefix, export, local), `for NAME in`, `read`, `mapfile`/`readarray`,
 *  `printf -v`, `getopts`, `wait -p` — has exactly ONE binding site, so no check input can be
 *  rebound after (or before) the check that reads it. The binding sites are FOUND by scanning every
 *  Assign node, every loop header and every command, never listed per name. The exceptions below
 *  are the only multi-site names, each with its exact sites (a third site, or a changed one, is red):
 *    - `line`: pin()'s `local line` declaration plus its one assignment. pin()'s body is pinned
 *      verbatim (PIN_BODY), so neither site can move or change; `local` scopes it to pin().
 *    - `have_patches`: a flag, defaulted to `no` and set to `yes` inside the patch-lint loop. It only
 *      decides whether `git am` runs; it is no verifier's operand (the patch set is already in
 *      PREFIX via prefix.sh's hash, and HEAD_SHA is re-derived from the tree after `git am`).
 *    - `wkarch`: one site per arm of the target `case` (x64 → amd64, aarch64 → arm64). The arms are
 *      exclusive, so each loop iteration binds it once; its value only names the WebKit tarball,
 *      whose bytes pin() checks against fetch-pins.sha256 by that name. */
const MULTI_SITE_OK: Record<string, string[]> = {
  line: ['line', 'line="$(grep -E "^[0-9a-f]{64}  $1\\$" "$WS/fetch-pins.sha256")"'],
  have_patches: ['have_patches=no', 'have_patches=yes'],
  wkarch: ['wkarch=amd64', 'wkarch=arm64'],
};
/** Rule 14: the names build.sh must bind itself — the verifiers' operands and the committed pins. */
const PINNED_NAMES = [...Object.keys(CONSTS), ...STATIC_PINS];
/** Rule 15: the ONLY names build.sh may read from its environment, each with why that is safe. The
 *  two cloudbuild.yaml sets are pinned there too (its build step's `env` is asserted exactly), so the
 *  executor supplies these and nothing else. */
export const ENV_READS: Record<string, string> = {
  BUN_BASE_TARGETS:
    'cloudbuild.yaml build step env (from _TARGETS); only selects targets — the case rejects anything but x64/aarch64',
  BUILD_ID:
    "cloudbuild.yaml build step env (Cloud Build's own id); written into manifest.json only",
  PATH: "the digest-pinned image's PATH, read once by the reviewed `export PATH=$HOME/.cargo/bin:$PATH` (CONSTS)",
};
/** Bash's special parameters (`$0`–`$9`, `${10}`, `$?`, `$#`, `$@`, `$*`, `$$`, `$!`, `$-`). */
const BASH_SPECIAL = /^([0-9]+|[?#@*$!-])$/;
/** (L2) Names bash binds itself, with no `=` rule 13 could count: `BASH_REMATCH` (`[[ =~ ]]`), `PWD`
 *  and `OLDPWD` (`cd`), `_` (the last argument). None is a verifier operand; none is read today. */
const BASH_IMPLICIT = new Set(['BASH_REMATCH', 'PWD', 'OLDPWD', '_']);
/** Builtins that bind a variable NAMED BY AN ARGUMENT (not by `=`), with the options of each that
 *  take a value. `bind` is the option whose value is the bound name; `pos` says which positionals
 *  are names ('all' for read, the first for mapfile, the second for getopts, none otherwise). Any
 *  of them outside the reviewed shapes is red elsewhere too (READ_EXACT, rule 11, the allowlist);
 *  this table exists so their targets are COUNTED, whatever shape lets them through. */
const ARG_BINDERS: Record<
  string,
  { valued: string; bind?: string; pos: 'all' | 'first' | 'second' | 'none'; dflt?: string }
> = {
  read: { valued: 'adinNptu', bind: 'a', pos: 'all', dflt: 'REPLY' },
  mapfile: { valued: 'dnOsuCc', pos: 'first', dflt: 'MAPFILE' },
  readarray: { valued: 'dnOsuCc', pos: 'first', dflt: 'MAPFILE' },
  printf: { valued: 'v', bind: 'v', pos: 'none' },
  getopts: { valued: '', pos: 'second', dflt: 'OPTARG' },
  wait: { valued: 'p', bind: 'p', pos: 'none' },
};
/** The names a command binds through its arguments (see ARG_BINDERS). A name that is not a static
 *  identifier is returned as-is and reported by the caller. */
export function argBinds(words: string[]): string[] {
  const b = ARG_BINDERS[words[0] ?? ''];
  if (!b) return [];
  const names: string[] = [];
  const pos: string[] = [];
  let opts = true;
  for (let i = 1; i < words.length; i++) {
    const w = unq(words[i]!);
    if (opts && w === '--') {
      opts = false;
      continue;
    }
    if (opts && w.startsWith('-') && w.length > 1 && words[0] !== 'printf') {
      for (let k = 1; k < w.length; k++) {
        if (!b.valued.includes(w[k]!)) continue;
        const val = k + 1 < w.length ? w.slice(k + 1) : unq(words[++i] ?? '');
        if (w[k] === b.bind) names.push(val);
        break;
      }
      continue;
    }
    if (words[0] === 'printf') {
      // printf takes options only before its format; `-v NAME` / `-vNAME` binds NAME.
      if (opts && w.startsWith('-v')) {
        names.push(w.length > 2 ? w.slice(2) : unq(words[++i] ?? ''));
        continue;
      }
      break;
    }
    opts = false;
    pos.push(w);
  }
  if (b.pos === 'all') names.push(...(pos.length ? pos : [b.dflt!]));
  else if (b.pos === 'first') names.push(pos[0] ?? b.dflt!);
  else if (b.pos === 'second') names.push(pos[1] ?? b.dflt!);
  return names;
}
/** `read`'s only reviewed shape — the sysroot-pair unpacking loop. Any other `read` is red: this
 *  is the one binder in the script (besides the `=`/`export`/`local`/`declare` path already checked
 *  above) that can name a variable, so it gets its own fixed allowlist rather than a VARS lookup —
 *  VARS also contains PATH/HOME/WS/… (legal on the LEFT of `=`), which `read` must never touch. */
const READ_EXACT = new Set(['read -r _ apkarch root']);
/** Loop headers, exactly (the loop variable and the word list). */
const FOR_HEADERS = new Set([
  'for p in "$WS"/patches/*.patch',
  'for p in *.patch',
  // the manifest's patch list (its own name: the single-site rule counts every loop variable)
  'for pf in "$WS"/patches/*.patch',
  'for t in clang clang++ ld.lld llvm-ar llvm-ranlib llvm-strip llvm-objcopy',
  'for pair in x64:x86_64:/opt/linux-sysroot-musl aarch64:aarch64:/opt/linux-sysroot-musl-arm64',
  'for arch in $TARGETS',
  'for a in $TARGETS',
]);

const APT_ALLOWED = new Set(
  'curl wget ca-certificates lsb-release gnupg cmake git golang libtool ninja-build pkg-config ruby-full xz-utils nasm unzip python3 build-essential libicu-dev perl zstd file'.split(
    ' ',
  ),
);
const APT_LLVM =
  /^(clang|lld|llvm|libclang-rt|libclang-common)-\$LLVM_MAJOR(-dev)?="\$LLVM_PKG_VERSION"$/;

/** Heads whose arguments can neither fetch, execute, nor write a file: any arguments allowed. */
const FREE =
  /^(echo|printf|grep|cut|tail|cat|mkdir|rm|test|\[|\[\[|cd|basename|dirname|pwd|date|lsb_release|sha256sum|file|read|pin|lap)( |$)/;
/** Exact commands: interpreters, exec-capable and file-writing tools only in these shapes. */
const EXACT = new Set([
  'set -euo pipefail',
  'shopt -s nullglob',
  'exit 1',
  `awk -F: '/^fpr:/ && !n++ {print $10}' /tmp/llvm.colons`,
  `awk '!/^#/ && NF { print $1; exit }' "$here/UPSTREAM_SHA"`,
  `sed 's/,$//'`,
  'tar -xzi -f /tmp/apk-tools-static.apk -C /tmp/apk sbin/apk.static',
  'gpg --show-keys --with-colons /tmp/llvm.asc',
  'gpg --dearmor',
  '"$LD" --library-path /opt/linux-sysroot-musl/usr/lib:/opt/linux-sysroot-musl/lib "$OUT/bun-linux-x64-musl" --revision',
  'bash "$WS/prefix.sh"',
  'git init -q "$SRC"',
  'git remote add origin https://github.com/oven-sh/bun.git',
  'git checkout -q FETCH_HEAD',
  'git rev-parse HEAD',
  'git am --committer-date-is-author-date "$WS"/patches/*.patch',
  'ln -sf /usr/bin/$t-$LLVM_MAJOR /usr/local/bin/$t',
  'unzip -q bun-linux-x64.zip',
  'install -m755 bun-linux-x64/bun /usr/local/bin/bun',
  'chmod +x /tmp/rustup-init',
  'cp "/tmp/wk/$wkfile" "$BUN_BUILD_PREFETCH_DIR/by-url/$wkkey"',
  'tee "/tmp/build-$arch.log"',
  'install -m755 "$bd/bun" "$OUT/bun-linux-$arch-musl"',
  'tee "$OUT/bun-linux-x64-musl.revision"',
]);
/** Network-capable commands, in the only shapes allowed. */
export const NET_EXACT = new Set([
  'apt-get update -qq',
  'wget -qO /tmp/llvm.asc https://apt.llvm.org/llvm-snapshot.gpg.key',
  'git fetch -q --depth 1 origin "$UPSTREAM_SHA"',
  '/tmp/rustup-init -y --profile minimal --default-toolchain none --no-modify-path',
  'rustup toolchain install',
  'rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl',
  '/tmp/apk/sbin/apk.static --arch "$apkarch" --root "$root" --repository "$repo" --keys-dir "$WS/keys/$apkarch" --no-cache --initdb add musl-dev libc-dev linux-headers g++ libstdc++-dev',
  'bun install --frozen-lockfile',
  'bun scripts/build.ts --profile=release --os=linux --arch="$arch" --abi=musl --canary=off --build-dir="$bd"',
]);
export const CONSUMED =
  'grep -qF "using prefetch cache: $BUN_BUILD_PREFETCH_DIR/by-url/$wkkey" "/tmp/build-$arch.log"';
const SHASUMS_CHECK = `grep -qxF "$(grep -E '  bun-linux-x64\\.zip$' "$WS/fetch-pins.sha256")" SHASUMS256.txt`;
const BUILD_TEE = 'tee "/tmp/build-$arch.log"';
/** Commands allowed to touch apt's configuration (the signed-by LLVM source and its keyring). */
const APT_CONF_OK = new Set([
  'mkdir -p /etc/apt/keyrings',
  'gpg --dearmor </tmp/llvm.asc >/etc/apt/keyrings/apt.llvm.org.gpg',
  'echo "deb [signed-by=/etc/apt/keyrings/apt.llvm.org.gpg] http://apt.llvm.org/$(lsb_release -cs)/ llvm-toolchain-$(lsb_release -cs)-$LLVM_MAJOR main" >/etc/apt/sources.list.d/llvm.list',
]);
/** Trust bypasses and fetch-redirecting configuration, anywhere in the (comment-free) text. */
const TRUST_BYPASS =
  /--allow-untrusted|allow-unauthenticated|allow-insecure-repositories|AllowInsecureRepositories|AllowDowngradeToInsecureRepositories|AllowUnauthenticated|trusted=yes|apt-key|trusted\.gpg\.d|GIT_SSL_NO_VERIFY|sslVerify|NODE_TLS_REJECT_UNAUTHORIZED|\/dev\/(tcp|udp)\b|insteadOf|\.gitconfig|GIT_CONFIG|[a-z]+_proxy\b|SSL_CERT_|CURL_CA_BUNDLE|CURL_HOME|\.curlrc|\.netrc|\.wgetrc|WGETRC|GIT_SSH|GIT_ASKPASS|extraheader/i;

const isNet = (n: Norm) => NET_EXACT.has(n.text) || /^(curl|apt-get) /.test(n.text);
const LITERAL_HEAD = /^(\[|\[\[|[A-Za-z0-9_./+:-]+)$/;

/** curl in the allowed shape: -fsSL…, https only, one URL, one output file (its dir + name). */
function curlShape(
  words: string[],
  httpsVars: Set<string>,
  cwd: string,
): { dir: string; file: string } | { bad: string } {
  const args = words.slice(1);
  let url: string | undefined;
  let out: string | undefined;
  let O = false;
  // curl pairs each output option with the URL that precedes it in argv order and writes to the
  // FIRST one it sees; a naive last-one-wins scan (the #1469 F1 bug) disagrees with that and can be
  // satisfied by a build.sh that writes unverified bytes to the first path while `pin` re-checks an
  // already-verified file named by a second, decoy output option. So a second output option of ANY
  // spelling (-o, -fsSLo, -fsSLO, …) is red here — the rule decides, not a downstream count.
  let outputOptions = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-fsSL' || a === '--tlsv1.2') continue;
    if (a === '-fsSLO') {
      outputOptions++;
      O = true;
    } else if (a === '--proto' && args[i + 1] === "'=https'") i++;
    else if (a === '-o' || a === '-fsSLo') {
      outputOptions++;
      out = args[++i];
    } else if (a.startsWith('-')) return { bad: `curl option ${a} not allowed` };
    else if (url) return { bad: 'curl with more than one URL' };
    else url = a;
    if (outputOptions > 1)
      return { bad: 'curl with more than one output option (-o/-O/-fsSLo/-fsSLO)' };
  }
  if (!url) return { bad: 'curl without a URL' };
  const u = unq(url);
  const v = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(u);
  if (!(u.startsWith('https://') || (v && httpsVars.has(v[1]!))))
    return { bad: `curl URL is not https: ${url}` };
  if (O === !!out) return { bad: 'curl must write exactly one named file (-O xor -o)' };
  const path = O ? u.split('/').pop()! : unq(out!);
  const slash = path.lastIndexOf('/');
  return slash < 0
    ? { dir: cwd, file: path }
    : { dir: path.startsWith('/') ? path.slice(0, slash) : '?', file: path.slice(slash + 1) };
}

/** `[`/`test` operators allowed, as PLAIN UNQUOTED words only. None evaluates its operand: no
 *  -eq/-ne/-lt/-le/-gt/-ge (arithmetic) and no -v (subscript). */
const TEST_UNARY_OK = new Set(['-n', '-z', '-e', '-f', '-d', '-x', '-s']);
const TEST_BINARY_OK = new Set(['=', '!=']);

/** Rule 11 — option/operator words judged by their PARSED shape. `printf -v NAME[…]` and
 *  `test -v NAME[…]` evaluate the subscript ARITHMETICALLY (command substitution included), and a
 *  quoted or expanded `-v` (`printf "-v"`, `printf -""v`, `[ "$o" 'x[…]' ]`) is the same `-v` to
 *  bash — so the rule never looks at spelling: a word that is not the one reviewed static shape in
 *  an option/operator position is red. */
export function optionWordProblems(c: Cmd, n: Norm): string[] {
  const head = n.words[0] ?? '';
  if (head !== 'printf' && head !== 'test' && head !== '[') return [];
  if (n.wrapped.length) return [`${head} under a wrapper (${n.wrapped.join(' ')}) is not allowed`];
  const sh = c.shapes;
  if (!sh || sh.length !== c.words.length || !sh[0]!.plainLit)
    return [`${head}: its words were not parsed as plain words`];
  if (head === 'printf') {
    const f = sh[1];
    if (!f) return ['printf without a format'];
    if (!f.onePart || f.value === null)
      return ['printf format must be ONE static literal part (no quoting splice, no expansion)'];
    if (f.value.startsWith('-'))
      return [`printf format ${JSON.stringify(f.value)} is an option word (printf -v assigns)`];
    return [];
  }
  let ops = sh.slice(1);
  let words = c.words.slice(1);
  if (head === '[') {
    const last = ops[ops.length - 1];
    if (!last?.plainLit || words[words.length - 1] !== ']') return ['[ without a plain closing ]'];
    ops = ops.slice(0, -1);
    words = words.slice(0, -1);
  }
  const out: string[] = [];
  ops.forEach((o, i) => {
    if (o.unquotedDyn)
      out.push(`${head} operand ${words[i]} is an unquoted expansion (it can split)`);
    if (o.unquotedGlob) out.push(`${head} operand ${words[i]} can glob/brace-expand`);
  });
  const lit = (i: number, set: Set<string>) => ops[i]!.plainLit && set.has(words[i]!);
  if (ops.length === 1) return out;
  if (ops.length === 2 && lit(0, TEST_UNARY_OK)) return out;
  if (ops.length === 3 && lit(1, TEST_BINARY_OK)) return out;
  out.push(
    `${head} is not one of the reviewed shapes (X | OP X with OP in ${[...TEST_UNARY_OK].join(' ')} | X OP Y with OP in = !=), each OP a plain unquoted word — got: ${words.join(' ')}`,
  );
  return out;
}

export type Unpinned = { id: string; match: string | null; calls?: number };

export function scanBuildScript(
  script: string,
  unpinned: Unpinned[],
  pins: string[] = [],
  opts: { prefix?: boolean } = {},
): string[] {
  const p = parseScript(script, opts.prefix ? 'prefix.sh' : 'build.sh');
  const v = [...p.problems];
  if (v.some((x) => x.startsWith('parse error'))) return v;
  const cmds = p.cmds;
  const code = script
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
  if (
    !cmds.some((c) => c.kind === 'top' && c.list === 0 && c.words.join(' ') === 'set -euo pipefail')
  )
    v.push('set -euo pipefail missing from the top level');
  const tb = TRUST_BYPASS.exec(code);
  if (tb) v.push(`trust bypass / fetch redirection: ${tb[0]}`);

  // ── assignments ──
  const seen: Record<string, number> = {};
  for (const a of p.assigns) {
    if (!VARS.has(a.name)) v.push(`line ${a.line}: assigns unknown variable ${a.name}`);
    if (CONSTS[a.name] !== undefined) {
      seen[a.name] = (seen[a.name] ?? 0) + 1;
      const mism = constMismatch(a.name, a.text);
      if (mism) v.push(`line ${a.line}: ${mism}`);
      if (seen[a.name]! > 1) v.push(`line ${a.line}: ${a.name} assigned more than once`);
    }
    if (STATIC_PINS.has(a.name) && a.value === null)
      v.push(`line ${a.line}: pin ${a.name} must be static text, got \`${a.text}\``);
  }
  // ── the single-assignment-site rule (see MULTI_SITE_OK) ──
  const sites = new Map<string, { line: number; text: string; end: number }[]>();
  const site = (name: string, line: number, text: string, end: number) =>
    sites.set(name, [...(sites.get(name) ?? []), { line, text, end }]);
  for (const a of p.assigns) site(a.name, a.line, a.text, a.end);
  for (const l of p.loopVars) site(l.name, l.line, `for ${l.name}`, l.end);
  cmds.forEach((c) => {
    const w = normalize(c).words;
    for (const name of argBinds(w)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        v.push(`line ${c.line}: ${w[0]} binds a name that is not a static identifier (${name})`);
      site(name, c.line, `${w[0]} → ${name}`, c.end ?? Number.POSITIVE_INFINITY);
    }
  });
  // ── rule 14 (round 12): PRESENCE — every pinned name is bound in build.sh (the rules above judge
  // the sites that exist; this one requires the site to exist). A pinned name with no site is read
  // from the executor's environment: one `env:` line in cloudbuild.yaml would then choose the
  // commit, the fingerprint, the workspace root, … while every verifier still ran as reviewed.
  if (!opts.prefix)
    for (const name of PINNED_NAMES)
      if (!sites.has(name))
        v.push(
          `${name} is never bound — a pinned name must be bound exactly once in build.sh, never supplied by the environment`,
        );
  // ── rule 15 (round 12): PROVENANCE OF EVERY READ — a name the script reads is bound in the script
  // BEFORE the read, or it is a bash special parameter / implicit binder, or it is on the reviewed
  // environment allowlist (build.sh only; prefix.sh reads nothing from the environment).
  const envOk = opts.prefix ? new Set<string>() : new Set(Object.keys(ENV_READS));
  const firstBind = (name: string) => Math.min(...(sites.get(name) ?? []).map((x) => x.end));
  for (const r of p.reads) {
    if (BASH_SPECIAL.test(r.name) || BASH_IMPLICIT.has(r.name) || envOk.has(r.name)) continue;
    if (!sites.has(r.name))
      v.push(
        `line ${r.line}: reads $${r.name}, which the script never binds and the reviewed environment allowlist does not name — its value would come from the executor's environment`,
      );
    else if (r.off < firstBind(r.name))
      v.push(
        `line ${r.line}: reads $${r.name} before its first binding site (line ${Math.min(...sites.get(r.name)!.map((x) => x.line))}) — that read sees the executor's environment`,
      );
  }
  for (const [name, at] of sites) {
    if (at.length === 1) continue;
    const ok = MULTI_SITE_OK[name];
    if (ok && JSON.stringify(at.map((s) => s.text)) === JSON.stringify(ok)) continue;
    v.push(
      `${name} has ${at.length} assignment sites (lines ${at.map((s) => s.line).join(', ')}) — every name is bound exactly once, so no check input can be rebound`,
    );
  }
  const httpsVars = new Set<string>();
  const nonHttps = new Set<string>();
  for (const a of p.assigns)
    (/^[A-Za-z_][A-Za-z0-9_]*="?https:\/\//.test(a.text) ? httpsVars : nonHttps).add(a.name);
  for (const n of nonHttps) httpsVars.delete(n);

  // ── functions ──
  if (opts.prefix && p.fnDefs.length)
    v.push(`prefix.sh defines a function (${p.fnDefs.map((f) => f.name).join(', ')})`);
  if (!opts.prefix) {
    for (const f of p.fnDefs)
      if (f.name !== 'pin' && f.name !== 'lap')
        v.push(`line ${f.line}: function ${f.name}() — only pin() and lap() may be defined`);
    for (const [name, body] of [
      ['pin', PIN_BODY],
      ['lap', LAP_BODY],
    ] as const) {
      const defs = p.fnDefs.filter((f) => f.name === name);
      if (defs.length !== 1) v.push(`${name}() must be defined exactly once`);
      else if (JSON.stringify(defs[0]!.body) !== JSON.stringify(body))
        v.push(`${name}() body differs from the reviewed one: ${JSON.stringify(defs[0]!.body)}`);
    }
  }

  const norms = cmds.map(normalize);
  const counts = new Map<string, number>();
  const effective = (d: Cmd, net: Cmd) =>
    d.must && d.kind === 'top' && d.list === net.list && !d.andLhs;

  cmds.forEach((c, i) => {
    const n = norms[i]!;
    const at = `line ${c.line}: ${n.text.slice(0, 70)}`;
    v.push(...n.bad.map((b) => `${at}: ${b}`));
    const head = n.words[0] ?? '';
    const net = isNet(n);

    if (!LITERAL_HEAD.test(head) && !EXACT.has(n.text))
      v.push(`${at}: command name is not a literal word (${head})`);
    if (c.kind === 'cond' && !/^(\[|\[\[|test)$/.test(head))
      v.push(
        `${at}: only [ / [[ / test may be an if condition (anything else has its failure swallowed)`,
      );
    if (c.andLhs && (/^(pin|sha256sum|grep|test|\[|\[\[)$/.test(head) || net))
      v.push(`${at}: a check or fetch before && (its failure does not stop the script)`);
    v.push(...optionWordProblems(c, n).map((b) => `${at}: ${b}`));
    // `read` is checked against its own fixed shape, not VARS: VARS also allows PATH/HOME/WS/… on
    // the left of `=` (the CONSTS one-line check covers that), and a `read` into one of those names
    // — `read -r PATH <<<…`, `read -r HOME <<<…`, `read -r WS <<<…` — bypassed that check entirely
    // (#1469 F2) because it was never an `=` assignment. Only the one reviewed `read` may run.
    if (head === 'read' && !READ_EXACT.has(n.text))
      v.push(`${at}: read is only allowed in the reviewed shape (${[...READ_EXACT].join(', ')})`);

    const conf = [...c.words, ...c.redirs].join(' ');
    if (/\/etc\/apt|sources\.list|apt\.conf|preferences\.d/.test(conf) && !APT_CONF_OK.has(conf))
      v.push(`${at}: writes apt configuration`);

    if (net && n.wrapped.includes('xargs')) v.push(`${at}: network command fed by xargs`);
    if (!net) {
      if (!FREE.test(n.text) && !EXACT.has(n.text))
        v.push(`${at}: command not in the allowlist (head ${head})`);
      return;
    }
    // ── network command ──
    if (opts.prefix) v.push(`${at}: prefix.sh may not run a network command`);
    if (c.kind !== 'top' || c.andLhs)
      v.push(`${at}: network command outside the script's top-level flow (${c.kind})`);
    if (head === 'apt-get' && !NET_EXACT.has(n.text)) {
      const m = /^apt-get install -y -qq( --no-install-recommends)? (.+)$/.exec(n.text);
      if (!m) v.push(`${at}: apt-get in a shape that is not allowed`);
      else
        for (const t of m[2]!.split(' '))
          if (!APT_ALLOWED.has(t) && !APT_LLVM.test(t))
            v.push(`${at}: apt package outside the pinned set: ${t}`);
    }
    let out: { dir: string; file: string } | undefined;
    if (head === 'curl') {
      const s = curlShape(n.words, httpsVars, c.cwd);
      if ('bad' in s) v.push(`${at}: ${s.bad}`);
      else out = s;
    }
    const hits = unpinned.filter((e) => e.match && new RegExp(e.match).test(n.text));
    if (hits.length > 1) v.push(`${at}: matched by more than one unpinned entry`);
    for (const e of hits) counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
    if (hits.length) return;

    let j = i + 1;
    while (j < cmds.length && !isNet(norms[j]!)) j++;
    const region = cmds.slice(i + 1, j).map((d, k) => ({ d, m: norms[i + 1 + k]! }));
    const has = (text: string) => region.some(({ d, m }) => effective(d, c) && m.text === text);
    if (head === 'curl' && out) {
      if (out.file === 'SHASUMS256.txt') {
        if (!has(SHASUMS_CHECK)) v.push(`${at}: SHASUMS cross-check missing after the fetch`);
      } else {
        const file = out.file;
        const pinAt = region.findIndex(
          ({ d, m }) =>
            effective(d, c) &&
            m.words[0] === 'pin' &&
            m.words.length === 2 &&
            unq(m.words[1]!) === file,
        );
        if (pinAt < 0)
          v.push(`${at}: fetched ${file} is not verified with pin before the next fetch`);
        else {
          const pc = region[pinAt]!.d;
          if (out.dir === '?' || pc.cwd !== out.dir)
            v.push(`${at}: pin ${file} runs in ${pc.cwd}, but the fetch wrote to ${out.dir}`);
        }
        for (const { d, m } of region.slice(0, Math.max(pinAt, 0)))
          if (m.words[0] !== 'cd' && [...d.words, ...d.redirs].join(' ').includes(file))
            v.push(`${at}: ${file} is used before it is pinned`);
        if (
          !file.includes('$') &&
          pins.length &&
          pins.filter((l) => l.endsWith(`  ${file}`)).length !== 1
        )
          v.push(`${at}: ${file} needs exactly one line in fetch-pins.sha256`);
      }
    } else if (head === 'wget') {
      if (!has('[ "$fpr" = "${LLVM_SIGNER_FPR// /}" ]'))
        v.push(`${at}: apt.llvm.org key fingerprint check missing after the fetch`);
    } else if (head === 'git') {
      if (!has('test "$(git rev-parse HEAD)" = "$UPSTREAM_SHA"'))
        v.push(`${at}: rev-parse == UPSTREAM_SHA check missing after the fetch`);
    } else if (n.text.startsWith('bun scripts/build.ts')) {
      if (!has(CONSUMED))
        v.push(`${at}: no proof the build consumed the pinned WebKit (prefetch-cache log check)`);
      const inPipe = cmds.some(
        (d, k) => c.pipe !== null && d.pipe === c.pipe && k > i && norms[k]!.text === BUILD_TEE,
      );
      if (!inPipe) v.push(`${at}: the build log is not tee'd inside the build's own pipeline`);
    } else if (head !== 'curl')
      v.push(`${at}: network command neither pinned nor listed in unpinned-fetches.json`);
  });

  for (const e of unpinned) {
    if (!e.match) continue;
    const got = counts.get(e.id) ?? 0;
    if (got !== (e.calls ?? 1))
      v.push(`unpinned entry ${e.id} matches ${got} call(s), declared ${e.calls ?? 1}`);
  }
  return v;
}

/** pin() exactly as reviewed: select one line, require exactly one, and end on sha256sum -c. */
export const PIN_BODY = [
  'local line',
  'line="$(grep -E "^[0-9a-f]{64}  $1\\$" "$WS/fetch-pins.sha256")"',
  `[ "$(printf '%s\\n' "$line" | grep -c .)" = 1 ] || { echo "fetch-pins.sha256: need exactly one line for $1" >&2; exit 1; }`,
  `printf '%s\\n' "$line" | sha256sum -c -`,
];
export const LAP_BODY = ['echo "### LAP $1 at $(date -u +%T)"'];

// ── cloudbuild.yaml: the executor config, pinned EXACTLY (round 12, review-1469-r11 HIGH-1) ──────
//
// build.sh's guarantees hold only for the build.sh the executor actually runs, in the environment it
// actually gets. cloudbuild.yaml decides both: a build-step `env` entry can export a bash function
// that replaces `sha256sum` (BASH_FUNC_sha256sum%%) or source a file first (BASH_ENV), `args` can run
// another script, an extra step can swap the binary after build.sh verified it, and `options.env`
// reaches every step. So the file is parsed as YAML and compared with the reviewed config field by
// field — every reviewed key must EXIST with the reviewed value and no other key may exist — plus a
// whole-document deep-equality backstop, so a shape no field rule models is still red. Changing the
// executor config means changing REVIEWED_CLOUDBUILD in the same PR.

const UPLOAD_SCRIPT = [
  'cd /workspace/out',
  'for f in bun-linux-*-musl bun-source.cdx.json bun-artifacts.cdx.json manifest.json; do sha256sum "$$f" > "$$f.sha256"; done',
  'cat bun-linux-*-musl.sha256 bun-source.cdx.json.sha256 bun-artifacts.cdx.json.sha256 manifest.json.sha256 > SHA256SUMS',
  'cat SHA256SUMS',
  'dest="gs://gsw-mcp-bun-base/$(cat /workspace/.prefix)/$BUILD_ID/"',
  'gcloud storage cp /workspace/out/* "$$dest"',
  'echo "uploaded to $$dest"',
  '',
].join('\n');
const SYFT =
  'anchore/syft:v1.52.0@sha256:500e2d872ac019436926e8322b4fc1f39441d94d21f6f4046c6ff29b30e8cb02';

/** The reviewed Cloud Build config, as the YAML parser yields it. */
export const REVIEWED_CLOUDBUILD = {
  serviceAccount: 'projects/gsw-mcp/serviceAccounts/bun-base-build@gsw-mcp.iam.gserviceaccount.com',
  options: { machineType: 'E2_HIGHCPU_32', diskSizeGb: 300, logging: 'CLOUD_LOGGING_ONLY' },
  timeout: '7200s',
  substitutions: { _TARGETS: 'x64 aarch64' },
  steps: [
    {
      id: 'build',
      name: 'ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3',
      entrypoint: 'bash',
      args: ['/workspace/build.sh'],
      // Exactly the names build.sh may read from its environment (ENV_READS, minus the image's PATH).
      env: ['BUILD_ID=$BUILD_ID', 'BUN_BASE_TARGETS=$_TARGETS'],
    },
    {
      id: 'sbom',
      name: SYFT,
      args: [
        'scan',
        'dir:/workspace/bun',
        '--exclude',
        './build',
        '-o',
        'cyclonedx-json=/workspace/out/bun-source.cdx.json',
      ],
    },
    {
      id: 'sbom-artifacts',
      name: SYFT,
      env: ['SYFT_FILE_METADATA_SELECTION=all', 'SYFT_FILE_METADATA_DIGESTS=sha256'],
      args: [
        'scan',
        'dir:/workspace/out',
        '--exclude',
        './*.json',
        '--exclude',
        './*.revision',
        '-o',
        'cyclonedx-json=/workspace/out/bun-artifacts.cdx.json',
      ],
    },
    {
      id: 'digests-and-upload',
      name: 'gcr.io/google.com/cloudsdktool/cloud-sdk:slim@sha256:cfca8415b7ce1abccf4c7a1a9c78b4da2c3718ac668806480a4471cb052e1ca9',
      entrypoint: 'bash',
      args: ['-euo', 'pipefail', '-c', UPLOAD_SCRIPT],
    },
  ],
} as const;

const show = (x: unknown) => JSON.stringify(x);
const isObj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);

/** One mapping, key by key: every reviewed key present and equal, and no other key. */
function sameMap(where: string, got: unknown, want: Record<string, unknown>, out: string[]) {
  if (!isObj(got)) {
    out.push(`${where} is not a mapping (got ${show(got)})`);
    return;
  }
  for (const k of Object.keys(got))
    if (!(k in want))
      out.push(
        `${where}.${k} is not reviewed${/env/i.test(k) ? ' (an executor-wide environment reaches every step)' : ''}`,
      );
  for (const [k, w] of Object.entries(want)) {
    if (!(k in got)) out.push(`${where}.${k} is missing (reviewed ${show(w)})`);
    else if (!isDeepStrictEqual(got[k], w))
      out.push(`${where}.${k} differs: got ${show(got[k])}, reviewed ${show(w)}`);
  }
}

/** Every problem with a cloudbuild.yaml text against REVIEWED_CLOUDBUILD; [] means exactly reviewed. */
export function scanCloudbuild(text: string): string[] {
  const doc = parseDocument(text, { uniqueKeys: true, merge: false });
  if (doc.errors.length || doc.warnings.length)
    return [...doc.errors, ...doc.warnings].map((e) => `cloudbuild.yaml YAML error: ${e.message}`);
  let y: unknown;
  try {
    // No aliases at all: every value the executor sees is spelled where it is used.
    y = doc.toJS({ maxAliasCount: 0 });
  } catch (e) {
    return [`cloudbuild.yaml YAML error: ${(e as Error).message}`];
  }
  if (!isObj(y)) return [`cloudbuild.yaml is not a mapping (got ${show(y)})`];
  const out: string[] = [];
  const want = REVIEWED_CLOUDBUILD as unknown as Record<string, unknown>;
  const top = Object.keys(y).sort();
  const wantTop = Object.keys(want).sort();
  if (show(top) !== show(wantTop))
    out.push(
      `top-level keys ${show(top)} differ from the reviewed ${show(wantTop)} (availableSecrets, secrets, artifacts, … are red)`,
    );
  for (const k of ['serviceAccount', 'timeout'])
    if (!isDeepStrictEqual(y[k], want[k]))
      out.push(`${k} differs: got ${show(y[k])}, reviewed ${show(want[k])}`);
  sameMap('options', y.options, REVIEWED_CLOUDBUILD.options, out);
  sameMap('substitutions', y.substitutions, REVIEWED_CLOUDBUILD.substitutions, out);

  if (!Array.isArray(y.steps)) out.push(`steps is not a list (got ${show(y.steps)})`);
  const steps = Array.isArray(y.steps) ? (y.steps as unknown[]) : [];
  const ids = steps.map((s) => (isObj(s) ? s.id : undefined));
  const wantIds = REVIEWED_CLOUDBUILD.steps.map((s) => s.id);
  if (show(ids) !== show(wantIds))
    out.push(
      `step ids ${show(ids)} differ from the reviewed ${show(wantIds)} (count and order are pinned)`,
    );
  for (const w of REVIEWED_CLOUDBUILD.steps) {
    const at = steps.filter((s) => isObj(s) && s.id === w.id);
    if (at.length !== 1) continue; // the step-id rule reports it
    const got = at[0] as Record<string, unknown>;
    const wm = w as unknown as Record<string, unknown>;
    for (const k of Object.keys(got))
      if (!(k in wm))
        out.push(`step ${w.id}: ${k} is not reviewed (secretEnv, volumes, dir, … are red)`);
    for (const [k, v] of Object.entries(wm)) {
      if (k === 'env') continue;
      if (!isDeepStrictEqual(got[k], v))
        out.push(`step ${w.id}: ${k} differs: got ${show(got[k])}, reviewed ${show(v)}`);
    }
    // env has its own rule, naming the entries: it reaches bash before build.sh runs a line
    // (BASH_FUNC_<name>%% exports a function over a verifier, BASH_ENV sources a file first).
    const wantEnv = (wm.env ?? []) as readonly string[];
    const gotEnv = got.env === undefined ? [] : got.env;
    if (!Array.isArray(gotEnv)) {
      out.push(`step ${w.id}: env is not a list (got ${show(gotEnv)})`);
      continue;
    }
    const extra = gotEnv.filter((e) => !wantEnv.includes(e as string));
    const missing = wantEnv.filter((e) => !gotEnv.includes(e));
    if (extra.length) out.push(`step ${w.id}: env entries not reviewed: ${show(extra)}`);
    if (missing.length) out.push(`step ${w.id}: env entries missing: ${show(missing)}`);
    if (!extra.length && !missing.length && !isDeepStrictEqual(gotEnv, wantEnv))
      out.push(`step ${w.id}: env differs: got ${show(gotEnv)}, reviewed ${show(wantEnv)}`);
  }
  // Backstop: whatever no field rule above models is still a difference.
  if (!isDeepStrictEqual(y, JSON.parse(show(REVIEWED_CLOUDBUILD))))
    out.push('cloudbuild.yaml differs from REVIEWED_CLOUDBUILD (whole-document comparison)');
  return out;
}
