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
 *  9. every Stmt node in the file is visited by the walker (checked against an independent count).
 */
import sh, { type ShNode } from 'mvdan-sh';

const { syntax } = sh;
const T = (n: ShNode) => syntax.NodeType(n);
const newParser = () => syntax.NewParser(syntax.Variant(syntax.LangBash));

/** Where a command sits. Only 'top' (the script's own flow, loops and subshells included) may fetch. */
export type Kind = 'top' | 'branch' | 'cond' | 'fn' | 'subst' | 'errpath';

export type Cmd = {
  words: string[];
  redirs: string[];
  line: number;
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
};

export type Parsed = {
  cmds: Cmd[];
  problems: string[];
  fnDefs: { name: string; body: string[]; line: number }[];
  assigns: { name: string; text: string; line: number }[];
  visited: number;
  total: number;
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
const ARITH_OK = new Set(['$(($(date +%s) - T0))']);

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
  const out: Parsed = { cmds: [], problems: [], fnDefs: [], assigns: [], visited: 0, total: 0 };
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

  const expansions = (node: ShNode, ctx: Ctx) =>
    syntax.Walk(node, (n) => {
      if (!n) return true;
      const t = T(n);
      if (t === 'Stmt') return false; // structural statements are the walker's, never counted twice
      if (t === 'CmdSubst' || t === 'ProcSubst') {
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
      if (t === 'ParamExp') {
        if (n.Excl) bad(n, 'indirect expansion ${!…} is not allowed');
        if (n.Exp && !PARAM_OPS_OK.has(n.Exp.Op ?? -1))
          bad(n, 'parameter-expansion operator other than :- and %% (e.g. := assigns, @P runs)');
      }
      if (t === 'ArithmExp' && !ARITH_OK.has(sl(n))) bad(n, `arithmetic expansion ${sl(n)}`);
      return true;
    });

  const assign = (a: ShNode, ctx: Ctx) => {
    const nm = a.Name ? String(a.Name.Value) : '';
    if (nm) out.assigns.push({ name: nm, text: sl(a), line: a.Pos().Line() });
    expansions(a, ctx);
  };

  const redirect = (r: ShNode, ctx: Ctx): string => {
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

  const emit = (s: ShNode, words: string[], redirs: string[], ctx: Ctx) => {
    out.cmds.push({
      words,
      redirs,
      line: s.Pos().Line(),
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
    if (s.Background) bad(s, 'backgrounded command (its failure is lost)');
    if (s.Coprocess) bad(s, 'coproc is not allowed');
    if (s.Negated && ctx.kind !== 'cond') bad(s, '! outside an if condition swallows the failure');
    const redirs = (s.Redirs ?? []).map((r) => redirect(r, ctx));
    const c = s.Cmd;
    if (!c) return;
    const t = T(c);
    if (t === 'CallExpr') {
      for (const a of c.Assigns ?? []) assign(a, ctx);
      const args = c.Args ?? [];
      for (const a of args) expansions(a, ctx);
      if (!args.length) return; // assignment only
      const words = args.map(sl);
      if (words[0] === 'cd') {
        if (ctx.kind !== 'top' && ctx.kind !== 'subst') bad(c, 'cd outside the top-level flow');
        ctx.cwd.v = words.length === 2 ? words[1]!.replace(/^"(.*)"$/, '$1') : '?';
      }
      emit(s, words, redirs, ctx);
    } else if (t === 'DeclClause') {
      const variant = String(c.Variant?.Value ?? '');
      const flags: string[] = [];
      for (const a of c.Args ?? []) {
        if (a.Naked && !a.Name) flags.push(a.Value ? sl(a.Value as ShNode) : '');
        else assign(a, ctx);
      }
      const shape = [variant, ...flags].join(' ');
      if (!['export', 'local', 'declare -A'].includes(shape))
        bad(c, `${shape}: only export, local and declare -A are allowed`);
      expansions(c, ctx);
    } else if (t === 'TestClause') {
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
      if (T(loop) !== 'WordIter') bad(c, 'only `for NAME in WORDS` loops are allowed');
      else if (!FOR_HEADERS.has(`for ${sl(loop)}`))
        bad(c, `loop header not reviewed: for ${sl(loop)}`);
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
      const name = String(c.Name?.Value ?? '');
      if (ctx.kind !== 'top' || ctx.list !== 0)
        bad(c, `function ${name} defined outside the top level`);
      const body = c.Body!;
      out.visited++;
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
  syntax.Walk(file, (n) => {
    if (n && T(n) === 'Stmt') out.total++;
    return true;
  });
  if (out.visited !== out.total)
    out.problems.push(`walker visited ${out.visited} of ${out.total} statements`);
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
    'APK_TOOLS_STATIC_VERSION BOOTSTRAP_BUN RUSTUP_VERSION line TARGETS T0 PREFIX UPSTREAM_SHA PATCHES ' +
    'name fpr base PATH repo _ apkarch root GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL HEAD_SHA wk ' +
    'BUN_BUILD_PREFETCH_DIR WK_KEY wkarch wkurl wkfile bd LD here sha patches ph IFS'
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
};
/** `read`'s only reviewed shape — the sysroot-pair unpacking loop. Any other `read` is red: this
 *  is the one binder in the script (besides the `=`/`export`/`local`/`declare` path already checked
 *  above) that can name a variable, so it gets its own fixed allowlist rather than a VARS lookup —
 *  VARS also contains PATH/HOME/WS/… (legal on the LEFT of `=`), which `read` must never touch. */
const READ_EXACT = new Set(['read -r _ apkarch root']);
/** Loop headers, exactly (the loop variable and the word list). */
const FOR_HEADERS = new Set([
  'for p in "${PATCHES[@]}"',
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
  'git am --committer-date-is-author-date "${PATCHES[@]}"',
  'ln -sf /usr/bin/$t-$LLVM_MAJOR /usr/local/bin/$t',
  'unzip -q bun-linux-x64.zip',
  'install -m755 bun-linux-x64/bun /usr/local/bin/bun',
  'chmod +x /tmp/rustup-init',
  'cp "/tmp/wk/$wkfile" "$BUN_BUILD_PREFETCH_DIR/by-url/${WK_KEY[$arch]}"',
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
  'grep -qF "using prefetch cache: $BUN_BUILD_PREFETCH_DIR/by-url/${WK_KEY[$arch]}" "/tmp/build-$arch.log"';
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
    const want = CONSTS[a.name];
    if (want !== undefined) {
      seen[a.name] = (seen[a.name] ?? 0) + 1;
      if (a.text !== want) v.push(`line ${a.line}: ${a.name} may only be set as \`${want}\``);
      if (seen[a.name]! > 1) v.push(`line ${a.line}: ${a.name} assigned more than once`);
    }
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
    if (head === 'printf' && n.words.some((w) => /^-[a-zA-Z]*v/.test(w)))
      v.push(`${at}: printf -v assigns a variable`);
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
export const LAP_BODY = ['echo "### LAP $1 t=$(($(date +%s) - T0))s"'];
