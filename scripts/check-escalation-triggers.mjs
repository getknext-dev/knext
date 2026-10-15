#!/usr/bin/env node
/**
 * Detect the MECHANICALLY DETECTABLE escalation triggers from
 * `.claude/rules/workflow.md`, so a trigger-class change cannot reach `main` on
 * an agent's self-report.
 *
 * WHY THIS EXISTS. The sprint model moved the architect + system-designer gates
 * from per-PR to per-sprint, and pulled them back only on five triggers. The rules
 * file is explicit that three of those are detectable and that leaving them to
 * self-reporting is the failure mode to watch:
 *
 *   "Three of these are mechanically detectable, so detect them rather than
 *    relying on someone to self-report against their own interest."
 *
 * It was never implemented. On 2026-08-11 a breaking CRD + CLI change (#715)
 * merged with no design gate and no per-PR review; the retroactive review found
 * two HIGH defects, one of them in a safety control. Nothing flagged it as
 * trigger-class because nothing was looking.
 *
 * WHAT IT DOES NOT DO. It does not decide whether the change is correct, and it
 * does not block one. It asserts that a trigger-class change was ACKNOWLEDGED —
 * that someone summoned the gate the rules require. The remaining two triggers (a
 * discovered fact that invalidates the sprint plan; a hard-rule contradiction that
 * touches no tracked path) are judgement and stay unenforced, by the rules' own
 * admission. This closes three of five, not five of five.
 *
 * Usage:
 *   node scripts/check-escalation-triggers.mjs --base <ref> [--head <ref>]
 *                                              [--labels "a,b"] [--body "<text>"] [--json]
 *
 * Exit 0 = no trigger, or triggered and acknowledged. Exit 1 = triggered, unacknowledged.
 *
 * ACKNOWLEDGEMENT, not gate-clear (workflow.md amendment, 2026-09-22): a trigger-class
 * PR no longer needs a design gate to sign off before merge — it needs a human/agent to
 * have CONSCIOUSLY NOTED the trigger, so sprint close can collect it as a tech-debt
 * backlog item. Any of the following counts:
 *   - the `trigger:acknowledged` label (or, backward compatible, the older
 *     `design-gate:cleared` label from when this WAS a gate);
 *   - a line in the PR body matching `Escalation trigger acknowledged: <...>` — this
 *     also records WHICH trigger and WHY inline, where sprint close can read it without
 *     needing GitHub timeline/label history.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { posix } from 'node:path';

/** The label that records "a human/agent consciously noted this trigger". */
export const ACK_LABEL = 'trigger:acknowledged';

/** Kept for backward compatibility: this repo used `design-gate:cleared` while the
 * check still required a gate sign-off. Still accepted as an acknowledgement. */
export const LEGACY_ACK_LABEL = 'design-gate:cleared';

/**
 * A PR-body line that records the acknowledgement inline, e.g.:
 *   "Escalation trigger acknowledged: CLI surface — adds a flag, no behaviour change."
 * Case-insensitive; tolerates leading/trailing whitespace.
 */
export const ACK_BODY_PATTERN = /Escalation trigger acknowledged:/i;

/**
 * Path rules, verbatim from workflow.md's list, with two deliberate refinements
 * noted on each. A guard that cries wolf gets worked around — this repo has
 * measured that — so precision here is not fussiness, it is what keeps the guard
 * trusted enough to be obeyed.
 */
const SUPPLY_CHAIN_WHY =
  'changes the supply chain — a security invariant (security.md): credentials, scan allowlists, SBOM/audit, or what a credential-bearing workflow runs';

export const TRIGGERS = [
  {
    id: 'adr',
    label: 'an ADR',
    // REFINEMENT: only a MODIFIED or DELETED ADR triggers. Adding a new ADR is the
    // OUTPUT of an escalation, not a reason to demand one — firing on it would tax
    // the exact behaviour the rules are trying to encourage. `docs/adr/gates/` is
    // measurement DATA, updated whenever someone runs a benchmark, and is excluded
    // for the same reason.
    match: (p, status) =>
      p.startsWith('docs/adr/') && !p.startsWith('docs/adr/gates/') && status !== 'A',
    why: 'changes or removes an existing ADR — workflow.md: a change that contradicts or would require amending an ADR',
  },
  {
    id: 'crd',
    label: 'a CRD type',
    // SCANNED, not enumerated (#2388): every `*_types.go` under any `api/` tree. It
    // used to name `nextapp_types.go` alone, so a second API group (platform) and any
    // NEW types file — the Z8 case — changed a CRD without firing. Adding counts too:
    // a new CRD is new operator/CLI compatibility surface.
    match: (p) => CRD_TYPES.test(p),
    why: 'changes a CRD type, which is the operator/CLI compatibility surface (upgrade order is load-bearing: operator/CRD first, then CLI)',
  },
  {
    id: 'config-schema',
    label: 'the knext.config.ts schema',
    match: (p) => p === 'packages/kn-next/src/config.ts',
    why: 'changes the public config schema every consuming app is written against',
  },
  {
    id: 'cli-surface',
    label: 'the CLI surface',
    // Every package's CLI, not only core's (#2388): `@getknext/grpc` and
    // `@getknext/ffi` ship their own verbs from `src/cli.ts`.
    match: (p) => CLI_SURFACE.test(p) && !isTestPath(p),
    why: 'changes a CLI, which is a published entry point (`knext` and its package verbs)',
  },
  {
    id: 'crates',
    label: 'the Rust crates',
    // Everything under the root `crates/` (#2388): source, Cargo.lock, deny.toml and
    // the toolchain pin are all both public FFI surface and supply chain.
    match: (p) => p.startsWith('crates/'),
    why: 'changes the Rust crates — FFI surface and the cargo supply chain (lockfile, deny policy, toolchain pin)',
  },
  {
    id: 'supply-chain',
    label: 'the supply chain',
    // The path-only half of the supply-chain trigger (#2388). The content half —
    // credential-bearing workflows and what they run — is in `classifyContent`.
    match: (p) => isStaticSupplyChainPath(p),
    why: SUPPLY_CHAIN_WHY,
  },
];

/** Any `*_types.go` under an `api/` directory, at any depth. */
const CRD_TYPES = /(^|\/)api\/(.+\/)?[^/]+_types\.go$/;

/** `packages/<pkg>/src/cli.ts` or anything under `packages/<pkg>/src/cli/`. */
const CLI_SURFACE = /^packages\/[^/]+\/src\/(cli\.[cm]?[jt]s|cli\/.+)$/;

function isTestPath(p) {
  return /(^|\/)__tests__\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
}

/** Supply-chain paths that need no content to recognise. */
export function isStaticSupplyChainPath(p) {
  if (p.startsWith('security/')) return true;
  if (p === 'scripts/audit-published.mjs') return true;
  // `packages/ffi/src/supply-chain.ts` today; any package's supply-chain module.
  return /^packages\/[^/]+\/src\/(.+\/)?supply-chain\.[cm]?[jt]s$/.test(p) && !isTestPath(p);
}

/**
 * Secrets that do NOT make a workflow credential-bearing for this check. Kept to a
 * named, justified minimum — everything else that is a `secrets.*` reference fires:
 *   - GITHUB_TOKEN: per-run, repo-scoped, and in every workflow; its scope is the
 *     `permissions:` block, which `release-action-pins.test.ts` already polices.
 *   - CODECOV_TOKEN: an upload-only coverage token referenced by `ci.yml`. Counting it
 *     would make every `ci.yml` edit (8% of commits, measured) trigger-class — a guard
 *     that cries wolf. Adding any OTHER secret to `ci.yml` still fires.
 */
export const LOW_PRIVILEGE_SECRETS = new Set(['GITHUB_TOKEN', 'CODECOV_TOKEN']);

/**
 * Does this workflow put a credential in scope? Scanned as text, so it cannot be
 * defeated by a YAML shape the scanner does not model: any `secrets.<NAME>` other than
 * the low-privilege set, any `secrets[...]` index expression (name unknowable → fail
 * closed), `toJSON(secrets)` (every secret, serialised), `id-token: write` (OIDC
 * federation / keyless signing), or a write grant that can publish or push —
 * `permissions: write-all`, or `packages`/`contents`/`attestations: write` at
 * workflow or job level (#2388 round 2).
 */
export function workflowHoldsCredential(text) {
  if (/id-token\s*:\s*['"]?write/.test(text)) return true;
  if (/permissions\s*:\s*['"]?write-all/.test(text)) return true;
  if (/(?:^|[\s{,])(?:packages|contents|attestations)\s*:\s*['"]?write\b/m.test(text)) return true;
  if (/toJSON\s*\(\s*secrets\s*\)/i.test(text)) return true;
  if (/secrets\s*\[/.test(text)) return true;
  for (const m of text.matchAll(/secrets\.([A-Za-z0-9_-]+)/g)) {
    if (!LOW_PRIVILEGE_SECRETS.has(m[1])) return true;
  }
  return false;
}

/**
 * Repo paths a workflow mentions under `scripts/` or `.github/actions/` — what it
 * runs. Comment mentions count too (conservative); trailing prose punctuation is
 * stripped so `scripts/a.mjs.` at the end of a sentence still resolves.
 */
export function referencedPaths(text) {
  const out = [];
  for (const m of text.matchAll(
    /(?:^|[^A-Za-z0-9_./-])(?:\.\/)?((?:scripts|\.github\/actions)\/[A-Za-z0-9_./-]+)/g,
  )) {
    const p = m[1].replace(/[.,;:]+$/, '');
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** Commands whose next argument is a script that then runs (#2388 round 4). */
const SCRIPT_RUNNERS = 'bash|sh|zsh|dash|node|nodejs|bun|deno|tsx|ts-node|python3?|source|\\.';
/** Shell command position: line start (a YAML `- ` / `run:` lead-in), after `;&|(`, or a keyword; env assignments skipped. */
const CMD_POS =
  '(?:^[ \\t]*(?:-[ \\t]+)?(?:run:[ \\t]*)?|[;&|(][ \\t]*|\\b(?:then|do|else|exec|time|env)[ \\t]+)(?:[A-Za-z_]\\w*=\\S*[ \\t]+)*';
const RUNNER_ARG = new RegExp(`(?:^|[\\s;&|(\`])(?:${SCRIPT_RUNNERS})[ \\t]+([^\\n;&|]*)`, 'gm');
const CMD_PATH = new RegExp(`${CMD_POS}((?:\\.\\/|[A-Za-z0-9_][\\w.-]*\\/)[^\\s;&|)'"\`]+)`, 'gm');

/**
 * Repo-relative paths a workflow, local action or shell script INVOKES (#2388
 * round 4) — wherever they live, not only under `scripts/`: the argument after an
 * interpreter, `source` or `.` (flags skipped), and a `./x` or `dir/x` path in
 * command position (`run: hack/x.sh`, `&& ./tools/y`). A relative path resolves
 * against the repo root, every `working-directory:` and literal `cd` target in the
 * file and — for a file that is not a workflow — its own directory and ancestors.
 * Only a path that EXISTS is returned (`exists` reads head, then base, so a deleted
 * script is still followed); `bun build`, `./out/bun-linux-x64` and prose drop out.
 *
 * Unlike a path a module merely NAMES (`addReferenced`, which stays scoped so a
 * script that reads `package.json` adds no edge), an invocation is an edge wherever
 * it lives — it is what runs with the credential in scope.
 */
export function invokedPaths(text, file, exists) {
  // A full-line `#` comment invokes nothing (its prose parens would read as subshells);
  // a `\` continuation joins its line, so a wrapped argument is not a command.
  const norm = text
    .replace(/^[ \t]*#.*$/gm, '')
    .replace(/\\\r?\n/g, ' ')
    .replace(/\$\{\{\s*github\.(?:workspace|action_path)\s*\}\}\//g, '')
    .replace(/\$\{?(?:GITHUB_WORKSPACE|GITHUB_ACTION_PATH)\}?\//g, '');
  const bases = new Set(['']);
  for (const m of norm.matchAll(/working-directory\s*:\s*['"]?([^\s'"#]+)/g)) bases.add(m[1]);
  for (const m of norm.matchAll(/(?:^|[\s;&|(])cd[ \t]+['"]?([\w.][\w./-]*)/gm)) bases.add(m[1]);
  if (!WORKFLOW.test(file)) {
    for (let d = posix.dirname(file); d !== '.' && d !== '/'; d = posix.dirname(d)) bases.add(d);
  }
  const clean = (c) => c.replace(/^["'(]+/, '').replace(/[.,;:)"'`]+$/, '');
  const resolveAll = (c) => {
    if (!c || c.startsWith('/') || /[$*?{}<>~\\]/.test(c)) return [];
    return [...bases]
      .map((base) => posix.normalize(posix.join(base, c)))
      .filter((p) => !p.startsWith('..') && !p.startsWith('/') && exists(p));
  };
  // Per command, the alternatives in order: after an interpreter, its non-flag
  // arguments (`bash -o pipefail x.sh` — a flag's value is not the script), of which
  // only the FIRST that exists is taken, so `node x.mjs package.json` adds no data file.
  const commands = [
    ...[...norm.matchAll(RUNNER_ARG)].map((m) =>
      m[1].split(/[ \t]+/).filter((t) => t && !t.startsWith('-')),
    ),
    ...[...norm.matchAll(CMD_PATH)].map((m) => [m[1]]),
  ];
  const out = [];
  for (const alternatives of commands) {
    for (const c of alternatives) {
      const hits = resolveAll(clean(c));
      if (hits.length === 0) continue;
      for (const p of hits) if (!out.includes(p)) out.push(p);
      break;
    }
  }
  return out;
}

/** Files whose imports are followed, and the extensions a bare relative specifier may omit. */
const MODULE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const RESOLVE_EXTS = ['.mjs', '.js', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.json'];

/** `import … from '…'`, side-effect `import '…'`, and `export … from '…'`. */
const STATIC_IMPORT = /\b(?:import|export)\s+(?:[\w*{}\s,$]+?\s+from\s+)?(['"])([^'"\n]+)\1/g;
/** `import(…)` and `require(…)` — the argument is inspected separately. */
const CALL_IMPORT = /\b(import|require)\s*\(/g;
const LITERAL_ARG = /^\s*(?:(['"])([^'"\n]*)\1|`([^`$]*)`)\s*[,)]/;

/**
 * Blank the COMMENTS of a JS/TS source, token-aware (#2388 round 3), keeping every
 * other character at its offset (newlines survive, so positions line up). With
 * `blankStrings`, string and template-literal CONTENTS are blanked too, so a call
 * named inside a message (`'spawnSync(x) failed'`) is not read as a call.
 *
 * Why token-aware: the round-2 version blanked whole lines that START with a
 * comment, so `/* c *\/ import './x.mjs'` hid a real import. Strings are scanned
 * as strings (a `'/*'` opens nothing), and a regex literal is recognised where an
 * expression may start, so `/^https?:\/\//` does not read as a line comment and
 * swallow the code after it. The bias is deliberate: when the scanner is unsure,
 * it treats text as CODE — scanning more is the fail-closed direction.
 */
export function stripComments(source, { blankStrings = false } = {}) {
  const n = source.length;
  const out = [];
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const keep = (s) => (blankStrings ? blank(s) : s);
  let i = 0;
  let last = ''; // the last significant code token's final char, or a keyword
  // Each frame is a template literal awaiting its `${…}` close: the brace depth at entry.
  const templates = [];
  let depth = 0;

  const scanString = (q) => {
    let j = i + 1;
    while (j < n && source[j] !== q && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
    const end = Math.min(j + 1, n);
    out.push(q, keep(source.slice(i + 1, end - 1)), source[end - 1] === q ? q : '');
    i = end;
    last = q;
  };
  // Scan template text from i (just past a backtick or a `}` that closes `${`).
  const scanTemplateText = () => {
    let j = i;
    while (j < n && source[j] !== '`' && !(source[j] === '$' && source[j + 1] === '{')) {
      j += source[j] === '\\' ? 2 : 1;
    }
    out.push(keep(source.slice(i, Math.min(j, n))));
    if (j >= n) {
      i = n;
    } else if (source[j] === '`') {
      out.push('`');
      i = j + 1;
      last = '`';
    } else {
      out.push('${');
      templates.push(depth);
      depth += 1;
      i = j + 2;
      last = '{';
    }
  };
  const regexMayStart = () => {
    if (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last)) return true;
    return /^(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)$/.test(last);
  };
  const scanRegex = () => {
    let j = i + 1;
    let inClass = false;
    while (j < n && source[j] !== '\n') {
      const c = source[j];
      if (c === '/' && !inClass) break;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      j += c === '\\' ? 2 : 1;
    }
    if (j >= n || source[j] !== '/') return false; // not a regex: treat `/` as code
    j += 1;
    while (j < n && /[a-z]/i.test(source[j])) j += 1;
    out.push(source.slice(i, j));
    i = j;
    last = ')'; // a regex is a value: a following `/` divides
    return true;
  };

  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === '/' && d === '/') {
      let j = source.indexOf('\n', i);
      if (j === -1) j = n;
      out.push(blank(source.slice(i, j)));
      i = j;
    } else if (c === '/' && d === '*') {
      const k = source.indexOf('*/', i + 2);
      const j = k === -1 ? n : k + 2;
      out.push(blank(source.slice(i, j)));
      i = j;
    } else if (c === '"' || c === "'") {
      scanString(c);
    } else if (c === '`') {
      out.push('`');
      i += 1;
      scanTemplateText();
    } else if (c === '/' && regexMayStart() && scanRegex()) {
      // consumed
    } else if (c === '}' && templates.length > 0 && templates[templates.length - 1] === depth - 1) {
      templates.pop();
      depth -= 1;
      out.push('}');
      i += 1;
      scanTemplateText();
    } else {
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      if (/[A-Za-z0-9_$]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j += 1;
        last = source.slice(i, j);
        out.push(last);
        i = j;
        continue;
      }
      if (!/\s/.test(c)) last = c;
      out.push(c);
      i += 1;
    }
  }
  return out.join('');
}

/**
 * The module edges of one source file (#2388 rounds 2–3):
 *   - `specs`: every import/require/`import()` specifier;
 *   - `nonLiteral`: each `import(…)`/`require(…)` whose argument is NOT a literal;
 *   - `paths`: repo paths the module NAMES — a literal `'scripts/x.mjs'`, string
 *     segments (`join(ROOT, 'scripts', 'x.mjs')`, `join(__dirname, 'x.mjs')`), or
 *     `new URL('./x.mjs', import.meta.url)` — because a module that SPAWNS a script
 *     imports nothing, and the round-2 closure therefore never saw it;
 *   - `gaps`: edges that exist but cannot be resolved — `createRequire`, and any
 *     child-process call whose command/script is not resolvable to a literal.
 * `context` gives the cross-module resolver (an imported runner factory) a reader.
 *
 * Comments are stripped token-aware first (`stripComments`): the real release path
 * documents `import()` in JSDoc, and a script named only in a comment runs nothing.
 */
export function moduleEdges(source, context = {}) {
  const file = context.file ?? '';
  const text = stripComments(source);
  const code = stripComments(source, { blankStrings: true });
  const specs = [];
  const nonLiteral = [];
  for (const m of text.matchAll(STATIC_IMPORT)) specs.push(m[2]);
  for (const m of text.matchAll(CALL_IMPORT)) {
    const rest = text.slice(m.index + m[0].length);
    const lit = LITERAL_ARG.exec(rest);
    if (lit) specs.push(lit[2] ?? lit[3]);
    else nonLiteral.push(`${m[1]}(${rest.slice(0, 40).split('\n')[0].trim()}`);
  }

  const ctx = { file, text, code, read: context.read ?? (() => null), depth: 0 };
  const paths = [...referencedPaths(text)];
  const addPath = (p) => {
    if (p && !paths.includes(p)) paths.push(p);
  };
  for (const m of code.matchAll(/\b(?:join|resolve)\s*\(|\bnew\s+URL\s*\(/g)) {
    const v = resolveValue(ctx, exprAt(ctx, m.index), m.index, 0);
    if (v?.t === 'path') addPath(v.path);
  }

  const gaps = [];
  if (/\bcreateRequire\b/.test(text)) {
    gaps.push('createRequire (a require() whose specifiers cannot be read statically)');
  }
  for (const call of childProcessCalls(ctx)) {
    const why = spawnGap(ctx, call, 0);
    if (why) gaps.push(`${call.name}(…) at line ${lineOf(text, call.index)} — ${why}`);
  }
  return { specs, nonLiteral, paths, gaps };
}

// ── child-process resolution (#2388 round 3) ─────────────────────────────────

const CP_MODULE = `['"](?:node:)?child_process['"]`;
const CP_FUNCS = new Set([
  'execFileSync',
  'execFile',
  'spawnSync',
  'spawn',
  'execSync',
  'exec',
  'fork',
]);
/** Commands whose first positional argument is a SCRIPT that then runs. */
const INTERPRETERS = /^(?:node|nodejs|bun|deno|tsx|ts-node|sh|bash|zsh|dash|python3?)$/;
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Every child-process call in a module, by local name: named imports (aliases
 * included), destructured `require`/`import()`, a namespace or default binding
 * (`cp.spawnSync`), the unambiguous names anywhere (`execFileSync`, `spawnSync`,
 * `execSync`, `execFile`, and `.spawn`/`spawn`), and `Bun.spawn`. Found in
 * string-blanked code, so a message that NAMES a call is not one.
 */
function childProcessCalls(ctx) {
  const { text, code } = ctx;
  const local = new Map(); // local name → child_process export
  const ns = new Set();
  for (const m of text.matchAll(
    new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*${CP_MODULE}`, 'g'),
  )) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (CP_FUNCS.has(orig)) local.set(alias ?? orig, orig);
    }
  }
  for (const m of text.matchAll(
    new RegExp(
      String.raw`\{([^}]*)\}\s*=\s*(?:await\s+)?(?:require|import)\s*\(\s*${CP_MODULE}\s*\)`,
      'g',
    ),
  )) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.trim().split(/\s*:\s*/);
      if (CP_FUNCS.has(orig)) local.set(alias ?? orig, orig);
    }
  }
  for (const m of text.matchAll(
    new RegExp(
      String.raw`import\s+(?:\*\s+as\s+)?([\w$]+)\s+from\s*${CP_MODULE}|([\w$]+)\s*=\s*(?:await\s+)?(?:require|import)\s*\(\s*${CP_MODULE}\s*\)`,
      'g',
    ),
  )) {
    ns.add(m[1] ?? m[2]);
  }
  for (const name of ['execFileSync', 'execFile', 'spawnSync', 'spawn', 'execSync']) {
    if (!local.has(name)) local.set(name, name);
  }

  const calls = new Map();
  for (const m of code.matchAll(
    /(?<![\w$])([\w$]+)\s*\.\s*([\w$]+)\s*\(|(?<![\w$.])([\w$]+)\s*\(/g,
  )) {
    const open = m.index + m[0].length - 1;
    let name = null;
    let kind = null;
    if (m[3] !== undefined) {
      if (local.has(m[3])) name = local.get(m[3]);
    } else if (m[1] === 'Bun' && /^spawn(?:Sync)?$/.test(m[2])) {
      name = `Bun.${m[2]}`;
      kind = 'bun';
    } else if (ns.has(m[1]) && CP_FUNCS.has(m[2])) {
      name = m[2];
    } else if (/^(?:execFileSync|execFile|spawnSync|spawn|execSync)$/.test(m[2])) {
      name = m[2];
    }
    if (name === null || calls.has(open)) continue;
    // A declaration (`function spawn(`) or a method definition is not a call.
    if (/\bfunction\s*\*?\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue;
    kind ??= name === 'fork' ? 'fork' : /^exec(?:Sync)?$/.test(name) ? 'shell' : 'file';
    calls.set(open, { name, kind, index: m.index, open });
  }
  return [...calls.values()];
}

/**
 * Why a child-process call cannot be resolved, or null when it can. "Resolved"
 * means: the command is a literal (or `process.execPath`), and — when it is an
 * interpreter — its first positional argument, the script, is a literal path.
 * A non-interpreter literal command (`git`, `npm`, `tar`) runs no repo script.
 */
function spawnGap(ctx, call, depth) {
  if (depth > 4) return 'resolution too deep';
  const { args } = splitCall(ctx.text, call.open);
  const at = call.index;
  const fail = (what) => paramRetry(ctx, call, depth, what);
  if (call.kind === 'shell') {
    const v = resolveValue(ctx, args[0] ?? '', at, 0);
    return isStr(v) ? null : fail('the shell command is not a literal');
  }
  if (call.kind === 'fork') {
    return isPathLike(resolveValue(ctx, args[0] ?? '', at, 0))
      ? null
      : fail('the forked module is not a literal path');
  }
  let command;
  let rest;
  if (call.kind === 'bun') {
    const v = resolveValue(ctx, args[0] ?? '', at, 0);
    if (v?.t !== 'arr') return fail('the command array is not a literal');
    rest = elements(v);
    const first = rest.next().value;
    if (!first) return fail('the command array is not a literal');
    command = commandValue(first.ctx, first.expr, first.at, 0);
  } else {
    command = commandValue(ctx, args[0] ?? '', at, 0);
    const v = args[1] === undefined ? { t: 'arr', items: [] } : resolveValue(ctx, args[1], at, 0);
    if (v?.t === 'arr') rest = elements(v);
  }
  const alts = command?.t === 'alt' ? command.alts : [command];
  if (alts.some((a) => a === null || (a.t !== 'str' && a.t !== 'exec'))) {
    return fail('the command is not a literal');
  }
  const interp = alts.some(
    (a) => a.t === 'exec' || a.vals.some((v) => INTERPRETERS.test(posix.basename(v))),
  );
  if (!interp) return null;
  if (rest === undefined) return fail('the interpreter arguments are not a literal array');
  // Only up to the SCRIPT position: later arguments (`...runArgs(spec)`) are data.
  for (const e of rest) {
    if (e === null) return fail('the interpreter arguments spread a non-literal');
    const v = resolveValue(e.ctx, e.expr, e.at, 0);
    if (v?.t === 'str' && v.vals.every((x) => x.startsWith('-'))) continue; // a flag
    return isPathLike(v) ? null : fail('the script argument is not a literal path');
  }
  return null; // `node --version`: no script at all
}

/**
 * Retry a call inside a same-file, NON-exported wrapper (`function run(cmd, args)`)
 * once per call site, with the wrapper's parameters substituted by each call's
 * arguments. Exported, passed-as-a-value, or uncalled wrappers stay a gap: their
 * callers are not all visible here.
 */
function paramRetry(ctx, call, depth, why) {
  const fn = enclosingFunction(ctx, call.index);
  if (!fn || fn.params.length === 0 || fn.exported) return why;
  const { args } = splitCall(ctx.text, call.open);
  const uses = args.join(',');
  const used = fn.params.filter((p) => new RegExp(String.raw`(?<![\w$.])${p}(?![\w$])`).test(uses));
  if (used.length === 0) return why;
  const sites = [];
  for (const m of ctx.code.matchAll(new RegExp(String.raw`(?<![\w$.])${fn.name}(?![\w$])`, 'g'))) {
    if (m.index === fn.nameIndex) continue;
    const after = ctx.code.slice(m.index + fn.name.length);
    const paren = /^\s*\(/.exec(after);
    if (!paren) return `${why} (wrapper ${fn.name} escapes as a value)`;
    sites.push(m.index + fn.name.length + paren[0].length - 1);
  }
  if (sites.length === 0) return why;
  for (const open of sites) {
    const siteArgs = splitCall(ctx.text, open).args;
    let callText = ctx.text.slice(call.open + 1, splitCall(ctx.text, call.open).end);
    fn.params.forEach((p, k) => {
      callText = callText.replace(
        new RegExp(String.raw`(?<![\w$.])${p}(?![\w$])`, 'g'),
        `(${siteArgs[k] ?? 'undefined'})`,
      );
    });
    // Re-run the call as if written at the call site.
    const synth = `${call.name}(${callText})`;
    const text = ctx.text.slice(0, open) + synth + ctx.text.slice(open);
    const code = stripComments(text, { blankStrings: true });
    const sub = { ...ctx, text, code, fns: undefined };
    const g = spawnGap(sub, { ...call, index: open, open: open + call.name.length }, depth + 1);
    if (g) return `${g} (via ${fn.name}() at line ${lineOf(ctx.text, open)})`;
  }
  return null;
}

/**
 * A COMMAND value. Beyond `resolveValue`, one narrow shape resolves: an invoker
 * OVERRIDE with a literal default — `process.env.X ?? 'bun'` / `|| 'bun'`, or a
 * same-file argv flag parser `flag('bun', <default>)` — resolves to its default.
 * `scripts/bun-test.mjs` picks its binary this way. Command position only: a
 * non-literal SCRIPT argument (`node [process.argv[2]]`) stays a gap.
 *
 * Residual, stated rather than hidden: the override can name any binary. Whoever
 * sets it — a workflow `env:`, a `--bun=` argument — is itself scanned for
 * literal `scripts/` paths, so a repo script named literally there is still an
 * edge; a COMPUTED override value set by another module is not seen.
 */
function commandValue(ctx, rawExpr, at, depth) {
  const direct = resolveValue(ctx, rawExpr, at, depth);
  if (direct !== null || depth > 6) return direct;
  const e = rawExpr.trim();
  const fallback = /^process\.env\.[\w$]+\s*(?:\?\?|\|\|)\s*([\s\S]+)$/.exec(e);
  if (fallback) return commandValue(ctx, fallback[1], at, depth + 1);
  if (/^[\w$]+$/.test(e)) {
    const bindings = [];
    for (const m of ctx.code.matchAll(
      new RegExp(String.raw`\b(?:const|let|var)\s+${escapeRe(e)}\s*=(?!=)`, 'g'),
    )) {
      bindings.push(exprAfter(ctx, m.index + m[0].length));
    }
    if (bindings.length !== 1) return null;
    return commandValue(ctx, bindings[0], at, depth + 1);
  }
  const call = /^([\w$]+)\s*\(/.exec(e);
  if (call && matchingClose(e, call[0].length - 1) === e.length - 1) {
    const args = splitTop(e.slice(call[0].length, -1));
    const fn = findFunction(ctx, call[1]);
    if (!fn || args.length !== 2 || fn.params.length !== 2) return null;
    const body = ctx.code.slice(fn.bodyStart, fn.bodyEnd + 1);
    const readsArgv = /\bargv\b/.test(body);
    const returnsDefault = new RegExp(
      String.raw`(?<![\w$.])${escapeRe(fn.params[1])}(?![\w$])`,
    ).test(body);
    if (readsArgv && returnsDefault) return commandValue(ctx, args[1], at, depth + 1);
  }
  return null;
}

const isStr = (v) => v?.t === 'str' || (v?.t === 'alt' && v.alts.every(isStr));
const isPathLike = (v) =>
  v?.t === 'str' || v?.t === 'path' || (v?.t === 'alt' && v.alts.every(isPathLike));

/**
 * The elements of an array value, lazily, with `...spread`s inlined. Yields null
 * (and stops) at a spread that is not a literal array — lazily, so a caller that
 * needs only the first elements never resolves the rest.
 */
function* elements(arr, depth = 0) {
  for (const item of arr.items) {
    const e = item.expr.trim();
    if (e.startsWith('...')) {
      const v = depth > 4 ? null : resolveValue(item.ctx, e.slice(3), item.at, 0);
      if (v?.t !== 'arr') {
        yield null;
        return;
      }
      yield* elements(v, depth + 1);
    } else if (e !== '') {
      yield item;
    }
  }
}

/**
 * Resolve an expression to a value: `{t:'str', vals}`, `{t:'exec'}`
 * (`process.execPath`), `{t:'path', path}` (repo-relative), `{t:'arr', items}`,
 * `{t:'alt', alts}` (a ternary) — or null when it is not statically knowable.
 */
function resolveValue(ctx, rawExpr, at, depth) {
  if (depth > 8) return null;
  let e = rawExpr.trim().replace(/\s+as\s+const$/, '');
  while (e.startsWith('(') && matchingClose(e, 0) === e.length - 1) e = e.slice(1, -1).trim();
  if (e === '') return null;
  const lit = /^(['"])((?:\\.|(?!\1)[^\\\n])*)\1$/.exec(e) ?? /^`([^`$\\]*)`$/.exec(e);
  if (lit) return { t: 'str', vals: [lit[2] ?? lit[1]] };
  if (e === 'process.execPath') return { t: 'exec' };
  if (e === 'import.meta.url') return { t: 'path', path: ctx.file };
  if (e === '__dirname' || e === 'import.meta.dirname') {
    return { t: 'path', path: posix.dirname(ctx.file) };
  }
  const tern = splitTernary(e);
  if (tern) {
    const alts = [
      resolveValue(ctx, tern[1], at, depth + 1),
      resolveValue(ctx, tern[2], at, depth + 1),
    ];
    return alts.some((a) => a === null) ? null : { t: 'alt', alts };
  }
  if (e.startsWith('[') && matchingClose(e, 0) === e.length - 1) {
    return { t: 'arr', items: splitTop(e.slice(1, -1)).map((x) => ({ ctx, expr: x, at })) };
  }
  const call = /^(new\s+URL|(?:[\w$]+\.)?[\w$]+)\s*\(/.exec(e);
  if (call && matchingClose(e, call[0].length - 1) === e.length - 1) {
    const callee = call[1].replace(/\s+/g, ' ');
    const args = splitTop(e.slice(call[0].length, -1));
    return resolveCall(ctx, callee, args, at, depth);
  }
  const pathname = /^(.+)\.(?:pathname|href)$/.exec(e);
  if (pathname) return resolveValue(ctx, pathname[1], at, depth + 1);
  if (/^[\w$]+$/.test(e)) return resolveIdentifier(ctx, e, at, depth);
  const member = /^([\w$]+)\.([\w$]+)$/.exec(e);
  if (member) return resolveMember(ctx, member[1], member[2], at, depth);
  return null;
}

function resolveCall(ctx, callee, args, at, depth) {
  const r = (x) => resolveValue(ctx, x, at, depth + 1);
  if (/^(?:fileURLToPath|url\.fileURLToPath|String)$/.test(callee) && args.length === 1) {
    return r(args[0]);
  }
  if (/^(?:path\.|posix\.)?dirname$/.test(callee) && args.length === 1) {
    const v = r(args[0]);
    return v?.t === 'path' ? { t: 'path', path: posix.dirname(v.path) } : null;
  }
  if (callee === 'new URL') {
    // Only a URL relative to THIS module is a repo path.
    if (args.length !== 2 || args[1].trim() !== 'import.meta.url') return null;
    const spec = r(args[0]);
    if (spec?.t !== 'str' || spec.vals.length !== 1) return null;
    return repoPath(posix.join(posix.dirname(ctx.file), spec.vals[0]));
  }
  if (/^(?:path\.|posix\.)?(?:join|resolve)$/.test(callee) && args.length > 0) {
    const segs = [];
    for (const a of args.slice(1)) {
      const v = r(a);
      if (v?.t !== 'str' || v.vals.length !== 1) return null;
      segs.push(v.vals[0]);
    }
    const base = r(args[0]);
    if (base?.t === 'path') return repoPath(posix.join(base.path, ...segs));
    if (base?.t === 'str' && base.vals.length === 1)
      return repoPath(posix.join(base.vals[0], ...segs));
    // An unknown base (`REPO_ROOT`) is the repo root only when the segments say so.
    if (segs.length > 0 && /^(?:scripts|\.github)(?:\/|$)/.test(segs[0])) {
      return repoPath(posix.join(...segs));
    }
    return null;
  }
  return null;
}

function repoPath(p) {
  const n = posix.normalize(p);
  return n.startsWith('../') || n.startsWith('/') ? null : { t: 'path', path: n };
}

/** A same-file `const|let|var NAME = …` (every binding must resolve), else a wrapper parameter. */
function resolveIdentifier(ctx, name, at, depth) {
  const bindings = [];
  for (const m of ctx.code.matchAll(
    new RegExp(String.raw`\b(?:const|let|var)\s+${escapeRe(name)}\s*=(?!=)`, 'g'),
  )) {
    bindings.push(exprAfter(ctx, m.index + m[0].length));
  }
  if (bindings.length === 0) return null;
  const vals = bindings.map((b) => resolveValue(ctx, b, at, depth + 1));
  if (vals.some((v) => v === null)) return null;
  return vals.length === 1 ? vals[0] : { t: 'alt', alts: vals };
}

/**
 * `X.prop` where `const X = F(…)` and F — same file, or a relative named import —
 * returns object literals: the property's value in every one of them.
 */
function resolveMember(ctx, obj, prop, _at, depth) {
  const factories = [];
  for (const m of ctx.code.matchAll(
    new RegExp(
      String.raw`\b(?:const|let|var)\s+${escapeRe(obj)}\s*=\s*(?:await\s+)?([\w$]+)\s*\(`,
      'g',
    ),
  )) {
    if (!factories.includes(m[1])) factories.push(m[1]);
  }
  if (factories.length !== 1) return null;
  const target = locateFunction(ctx, factories[0]);
  if (!target) return null;
  const returns = returnedObjects(target.ctx, target.fn);
  if (returns.length === 0) return null;
  const alts = [];
  for (const r of returns) {
    const props = new Map();
    for (const part of splitTop(r.body)) {
      const kv = /^\s*(?:['"]?)([\w$]+)(?:['"]?)\s*(?::([\s\S]*))?$/.exec(part);
      if (kv) props.set(kv[1], kv[2] ?? kv[1]);
    }
    if (!props.has(prop)) return null;
    const v = resolveValue(target.ctx, props.get(prop), r.at, depth + 1);
    if (v === null) return null;
    alts.push(v);
  }
  return alts.length === 1 ? alts[0] : { t: 'alt', alts };
}

/** Find function NAME in this module, or in the relative module it is imported from. */
function locateFunction(ctx, name) {
  const here = findFunction(ctx, name);
  if (here) return { ctx, fn: here };
  for (const m of ctx.text.matchAll(/import\s*\{([^}]*)\}\s*from\s*(['"])(\.{1,2}\/[^'"]+)\2/g)) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if ((alias ?? orig) !== name) continue;
      const file = resolveRelative(ctx.file, m[3], (p) => ctx.read(p) !== null);
      const source = file === null ? null : ctx.read(file);
      if (source === null) return null;
      const other = {
        file,
        text: stripComments(source),
        code: stripComments(source, { blankStrings: true }),
        read: ctx.read,
      };
      const fn = findFunction(other, orig);
      return fn ? { ctx: other, fn } : null;
    }
  }
  return null;
}

/** Every top-level `return { … }` (or `=> ({ … })`) object body of a function. */
function returnedObjects(ctx, fn) {
  const body = ctx.code.slice(fn.bodyStart, fn.bodyEnd + 1);
  const objectAt = (open) => {
    const close = matchingClose(ctx.text, open);
    return close === -1 ? null : { body: ctx.text.slice(open + 1, close), at: open };
  };
  // An arrow with an expression body: `=> ({ … })`.
  const arrow = /^\(\s*\{/.exec(body);
  if (arrow) {
    const o = objectAt(fn.bodyStart + arrow[0].length - 1);
    return o ? [o] : [];
  }
  const out = [];
  for (const m of body.matchAll(/\breturn\b(\s*\(?\s*\{)?/g)) {
    // A `return` that is not an object literal makes the property unknowable.
    if (m[1] === undefined) return [];
    const o = objectAt(fn.bodyStart + m.index + m[0].length - 1);
    if (!o) return [];
    out.push(o);
  }
  return out;
}

/** Functions declared in a module: `function NAME(…) {` and `const NAME = (…) => …`. */
function functionsIn(ctx) {
  if (ctx.fns) return ctx.fns;
  const fns = [];
  const re =
    /(\bexport\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(|(\bexport\s+)?\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(\(|[\w$]+\s*=>)/g;
  for (const m of ctx.code.matchAll(re)) {
    const name = m[2] ?? m[4];
    const nameIndex = m.index + m[0].indexOf(name, m[0].search(/function|const|let|var/));
    let params;
    let after;
    if (m[2] !== undefined || m[5] === '(') {
      const open = m.index + m[0].length - 1;
      const close = matchingClose(ctx.code, open);
      if (close === -1) continue;
      params = splitTop(ctx.code.slice(open + 1, close));
      after = close + 1;
      if (m[4] !== undefined && !/^\s*=>/.test(ctx.code.slice(after))) continue; // not an arrow
    } else {
      params = [m[5].replace(/\s*=>$/, '')];
      after = m.index + m[0].length - 2;
    }
    const brace = ctx.code.slice(after).search(/\S/);
    const bodyOpen = after + brace + (ctx.code.slice(after + brace).startsWith('=>') ? 2 : 0);
    const bodyStartChar = ctx.code.slice(bodyOpen).search(/\S/) + bodyOpen;
    let bodyEnd;
    if (ctx.code[bodyStartChar] === '{' || ctx.code[bodyStartChar] === '(') {
      bodyEnd = matchingClose(ctx.code, bodyStartChar);
    } else {
      const nl = ctx.code.indexOf('\n', bodyStartChar);
      bodyEnd = nl === -1 ? ctx.code.length : nl;
    }
    if (bodyEnd === -1) continue;
    const exported =
      m[1] !== undefined ||
      m[3] !== undefined ||
      new RegExp(String.raw`\bexport\s*\{[^}]*(?<![\w$])${escapeRe(name)}(?![\w$])`).test(
        ctx.code,
      ) ||
      new RegExp(String.raw`\bexport\s+default\s+${escapeRe(name)}\b`).test(ctx.code);
    fns.push({
      name,
      nameIndex,
      exported,
      // A destructured or defaulted parameter is not mapped: `{a}` / `a = 1` stay opaque.
      params: params.map((p) => p.trim()).map((p) => (/^[\w$]+$/.test(p) ? p : '\0')),
      bodyStart: bodyStartChar,
      bodyEnd,
    });
  }
  ctx.fns = fns;
  return fns;
}

function findFunction(ctx, name) {
  const all = functionsIn(ctx).filter((f) => f.name === name);
  return all.length === 1 ? all[0] : null;
}

/** The innermost named function whose body contains `index`. */
function enclosingFunction(ctx, index) {
  let best = null;
  for (const f of functionsIn(ctx)) {
    if (f.bodyStart <= index && index <= f.bodyEnd && (!best || f.bodyStart > best.bodyStart)) {
      best = f;
    }
  }
  return best;
}

const escapeRe = (s) => s.replace(/[$]/g, '\\$');

/** `cond ? a : b` at the top level of an expression → [cond, a, b], else null. */
function splitTernary(e) {
  const q = topLevelIndex(e, '?');
  if (q === -1 || e[q + 1] === '.' || e[q + 1] === '?') return null;
  const rest = e.slice(q + 1);
  const c = topLevelIndex(rest, ':');
  if (c === -1) return null;
  return [e.slice(0, q), rest.slice(0, c), rest.slice(c + 1)];
}

/** Index of the first `ch` at bracket depth 0, outside strings; -1 if none. */
function topLevelIndex(s, ch) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(s, i);
    } else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

function skipString(s, i) {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) j += s[j] === '\\' ? 2 : 1;
  return j;
}

/** Index of the bracket closing the one at `open`, skipping strings; -1 if unbalanced. */
function matchingClose(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') i = skipString(s, i);
    else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on top-level commas. */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') i = skipString(s, i);
    else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  const tail = s.slice(start);
  if (tail.trim() !== '') out.push(tail);
  return out.map((x) => x.trim());
}

/** The arguments of the call whose `(` is at `open`. */
function splitCall(text, open) {
  const close = matchingClose(text, open);
  const end = close === -1 ? text.length : close;
  return { args: splitTop(text.slice(open + 1, end)), end };
}

/** The whole expression starting at `index` (a call such as `join(…)` or `new URL(…)`). */
function exprAt(ctx, index) {
  const open = ctx.code.indexOf('(', index);
  const close = matchingClose(ctx.text, open);
  return close === -1 ? '' : ctx.text.slice(index, close + 1);
}

/** The initializer after `=`: up to a top-level `;` or a statement-ending newline. */
function exprAfter(ctx, start) {
  const s = ctx.text;
  let depth = 0;
  let i = start;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') i = skipString(s, i);
    else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && (c === ';' || c === ',')) break;
    else if (depth === 0 && c === '\n') {
      const next = s.slice(i + 1).match(/^\s*(\S)/);
      if (!next || !/[.?:+\-*/|&]/.test(next[1])) break;
    }
  }
  return s.slice(start, i);
}

/**
 * Shell `source`/`.` of a NON-literal path (`. "$(dirname "$0")/lib/x.sh"`,
 * `source "$DIR/…"`): the sourced file cannot be named, so it is a gap. A literal
 * path is already followed by `referencedPaths`.
 */
export function shellSourceGaps(text) {
  const gaps = [];
  for (const m of text.matchAll(
    /(?:^|[;&|(]|\bthen\b|\bdo\b|\belse\b|run:)[ \t]*(?:\.|source)[ \t]+([^\s;&|)]+)/gm,
  )) {
    if (/[$`]/.test(m[1])) gaps.push(`non-literal shell source ${m[1]}`);
  }
  return gaps;
}

/** Resolve a relative specifier against the importing file; null when nothing matches. */
function resolveRelative(fromFile, spec, exists) {
  const target = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  if (target.startsWith('../')) return null;
  const candidates = [
    target,
    ...RESOLVE_EXTS.map((e) => `${target}${e}`),
    ...RESOLVE_EXTS.map((e) => `${target}/index${e}`),
  ];
  if (/\.[cm]?js$/.test(target)) candidates.push(target.replace(/js$/, 'ts'));
  return candidates.find(exists) ?? null;
}

/**
 * Everything a credential-bearing workflow can execute, transitively (#2388 round 2):
 * the scripts and local actions it names, every file inside those actions, what any
 * non-module file among them (a shell script, an `action.yml`) names in turn, and
 * every static relative import of every module reached — and (round 3) every script
 * a module NAMES or spawns (`moduleEdges().paths`). Files are read from the head
 * tree, falling back to the base tree, so a deleted import target is still followed.
 *
 * `gaps` lists every edge that could not be followed — a non-literal `import()` /
 * `require()`, a relative specifier that resolves to nothing, `createRequire`, a
 * child-process call whose script is not a literal path, or a shell `source` of a
 * non-literal path. A non-empty `gaps` means the closure is INCOMPLETE and the
 * caller must fail closed.
 */
export function releaseClosure(seeds, read, listUnder) {
  const closure = new Set();
  const gaps = [];
  const queue = [];
  const add = (p) => {
    if (closure.has(p)) return;
    closure.add(p);
    queue.push(p);
  };
  const addNamed = (p) => {
    if (read(p) !== null) add(p);
    else for (const f of listUnder(`${p}/`)) add(f); // a local action directory
  };
  // A path a MODULE names is an edge only inside the closure's scope — `scripts/` and
  // `.github/actions/`, the same scope `referencedPaths` reads — so a release script
  // that READS `package.json` or `bun.lock` does not make every lockfile bump fire.
  // A file is an edge; a directory is not (`join(ROOT, 'scripts')` must not pull in
  // every script), except a local action directory.
  const addReferenced = (p) => {
    if (!/^(?:scripts|\.github\/actions)\//.test(p)) return;
    if (read(p) !== null) add(p);
    else if (/^\.github\/actions\/[^/]+\/?$/.test(p)) addNamed(p.replace(/\/$/, ''));
  };
  for (const s of seeds) addNamed(s);
  while (queue.length > 0) {
    const file = queue.shift();
    const text = read(file);
    if (text === null) continue;
    if (MODULE_FILE.test(file)) {
      const edges = moduleEdges(text, { file, read });
      const { specs, nonLiteral } = edges;
      for (const n of nonLiteral) gaps.push(`${file}: non-literal ${n}`);
      for (const g of edges.gaps) gaps.push(`${file}: ${g}`);
      for (const p of edges.paths) addReferenced(p);
      for (const spec of specs) {
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue; // bare / node: builtin
        const target = resolveRelative(file, spec, (p) => read(p) !== null);
        if (target === null) gaps.push(`${file}: unresolvable import '${spec}'`);
        else add(target);
      }
    } else if (!file.endsWith('.json')) {
      for (const p of referencedPaths(text)) addNamed(p);
      // Round 4: what this action / shell script INVOKES is an edge wherever it lives.
      for (const p of invokedPaths(text, file, (q) => read(q) !== null)) add(p);
      for (const g of shellSourceGaps(text)) gaps.push(`${file}: ${g}`);
    }
  }
  return { closure, gaps };
}
const PACKAGE_MANIFEST = /^packages\/[^/]+\/package\.json$/;

/** What an unfollowable edge could reach: any module or JSON, or anything a script dir holds. */
const couldBeOnPath = (p) =>
  MODULE_FILE.test(p) ||
  p.endsWith('.json') ||
  p.startsWith('scripts/') ||
  p.startsWith('.github/actions/') ||
  /\.(?:sh|bash|py)$/.test(p); // round 4: an invoked script can live anywhere

/**
 * The release path of a repo (#2388): the scripts and local actions every
 * credential-bearing workflow on the head side names (`runByCredential`), and
 * their transitive closure with its gaps (`releaseClosure`). Files are read from
 * head, falling back to base. Exported so the test can assert the REAL tree's
 * closure has no gaps — a gap there would fire the fallback on every module PR.
 */
export function releasePathClosure(repo) {
  const credentialWorkflows = repo
    .listHead('.github/workflows/')
    .filter((p) => WORKFLOW.test(p))
    .map((p) => ({ path: p, text: repo.show('head', p) }))
    .filter(({ text }) => text !== null && workflowHoldsCredential(text));
  const cache = new Map();
  const read = (p) => {
    if (!cache.has(p)) cache.set(p, repo.show('head', p) ?? repo.show('base', p));
    return cache.get(p);
  };
  const exists = (p) => read(p) !== null;
  // Round 4: a script the workflow INVOKES is an edge wherever it lives, not only
  // under scripts/ or .github/actions/ (which is all `referencedPaths` reads).
  const runByCredential = new Set(
    credentialWorkflows.flatMap(({ path, text }) => [
      ...referencedPaths(text),
      ...invokedPaths(text, path, exists),
    ]),
  );
  const { closure, gaps } = releaseClosure(runByCredential, read, (prefix) =>
    repo.listHead(prefix),
  );
  return { runByCredential, closure, gaps };
}

/**
 * The content-dependent triggers (#2388): every package's public manifest surface,
 * credential-bearing workflows, and the scripts/local actions those workflows run.
 *
 * `repo.show(side, path)` returns the file text on `'base'`/`'head'`, or null when the
 * file is absent on that side. `repo.listHead(prefix)` lists head paths under a prefix.
 * Pure given the reader — the tests drive it with a fake.
 */
export function classifyContent(changes, repo) {
  const fired = [];

  const manifestHits = [];
  let unparseable = false;
  for (const c of changes.filter((x) => PACKAGE_MANIFEST.test(x.path))) {
    const before = parseManifest(repo.show('base', c.path));
    const after = parseManifest(repo.show('head', c.path));
    if (before === UNPARSEABLE || after === UNPARSEABLE) {
      // Fail closed: a manifest we cannot read cannot be proven surface-neutral.
      unparseable = true;
      manifestHits.push(c.path);
    } else if (publicSurfaceChanged(before, after)) {
      manifestHits.push(c.path);
    }
  }
  if (manifestHits.length > 0) {
    fired.push({
      id: 'public-api',
      label: 'the published package surface',
      why:
        `changes ${PUBLIC_MANIFEST_KEYS.join('/')} in a package manifest — what consumers can import or run` +
        (unparseable ? ' (a manifest is UNPARSEABLE, so it cannot be proven unchanged)' : ''),
      paths: manifestHits,
    });
  }

  const { runByCredential, closure, gaps } = releasePathClosure(repo);
  const runs = (p) =>
    runByCredential.has(p) ||
    closure.has(p) ||
    [...runByCredential].some((r) => r.startsWith('.github/actions/') && p.startsWith(`${r}/`));

  const supplyHits = [];
  let unprovable = false;
  for (const c of changes) {
    if (supplyHits.includes(c.path)) continue;
    if (WORKFLOW.test(c.path)) {
      const sides = [repo.show('base', c.path), repo.show('head', c.path)];
      if (sides.some((t) => t !== null && workflowHoldsCredential(t))) supplyHits.push(c.path);
    } else if (runs(c.path)) {
      supplyHits.push(c.path);
    } else if (gaps.length > 0 && couldBeOnPath(c.path)) {
      // Fail closed: with an edge we could not follow, no changed module — nor any
      // script or action file, since a non-literal shell `source` can name one —
      // can be proven OFF the release path.
      unprovable = true;
      supplyHits.push(c.path);
    }
  }
  if (supplyHits.length > 0) {
    fired.push({
      id: 'supply-chain',
      label: 'the supply chain',
      why:
        SUPPLY_CHAIN_WHY +
        (unprovable
          ? ` (the release-path import closure is INCOMPLETE — ${gaps.join('; ')} — so a changed module cannot be proven off it)`
          : ''),
      paths: supplyHits,
    });
  }

  return fired;
}

const UNPARSEABLE = Symbol('unparseable');
function parseManifest(text) {
  if (text === null) return null; // absent on that side is a legitimate answer
  try {
    return JSON.parse(text);
  } catch {
    return UNPARSEABLE;
  }
}

/** Merge content-derived triggers into path-derived ones, one entry per id. */
export function mergeFired(a, b) {
  const out = a.map((f) => ({ ...f, paths: [...f.paths] }));
  for (const f of b) {
    const existing = out.find((x) => x.id === f.id);
    if (!existing) out.push({ ...f, paths: [...f.paths] });
    else for (const p of f.paths) if (!existing.paths.includes(p)) existing.paths.push(p);
  }
  return out;
}

/** Every status letter `git diff --name-status` can emit. */
const GIT_STATUSES = new Set(['A', 'B', 'C', 'D', 'M', 'R', 'T', 'U', 'X']);

/**
 * Parse `git diff --name-status` output into {status, path} records — either the
 * NUL-separated `-z` form (what the CLI uses, so non-ASCII paths are never C-quoted)
 * or the tab/newline form. Unknown input THROWS (#2388): a record this parser does
 * not understand must fail the check, not be silently classified as "nothing to see".
 *
 * A rename or copy yields TWO records, destination then source (#2388 round 2):
 * moving a file OUT of a trigger-class path changes that surface as surely as
 * editing it does.
 */
export function parseNameStatus(text) {
  const records = [];
  if (text.includes('\0')) {
    const tokens = text.split('\0');
    while (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();
    for (let i = 0; i < tokens.length; ) {
      const status = tokens[i++];
      const n = pathCount(status);
      records.push([status, tokens.slice(i, i + n)]);
      i += n;
    }
  } else {
    for (const l of text.split('\n').map((x) => x.trim())) {
      if (!l) continue;
      const [status, ...rest] = l.split('\t');
      records.push([status, rest]);
    }
  }
  return records.flatMap(([status, paths]) => {
    const n = pathCount(status);
    if (paths.length < n || paths.some((p) => !p)) {
      throw new Error(`name-status record has no path: ${[status, ...paths].join(' ')}`);
    }
    return paths
      .slice(0, n)
      .reverse()
      .map((path) => ({ status: status[0], path }));
  });
}

/** How many paths a status letter carries: two for a rename/copy, else one. */
function pathCount(status) {
  if (!status || !GIT_STATUSES.has(status[0])) {
    throw new Error(`unknown git name-status "${status}"`);
  }
  return status[0] === 'R' || status[0] === 'C' ? 2 : 1;
}

/**
 * Did the PUBLIC surface of a package manifest change?
 *
 * package.json is edited constantly — version bumps, dependency updates, script
 * tweaks — so treating any change to it as a trigger would fire on almost every
 * PR and train everyone to reach for the ack label reflexively. Only the keys that
 * define what consumers can import are compared.
 */
export const PUBLIC_MANIFEST_KEYS = ['exports', 'bin', 'files', 'main', 'types', 'typesVersions'];

export function publicSurfaceChanged(before, after) {
  const pick = (o) =>
    JSON.stringify(Object.fromEntries(PUBLIC_MANIFEST_KEYS.map((k) => [k, o?.[k] ?? null])));
  return pick(before) !== pick(after);
}

/** Classify changed files into fired triggers. Pure — the tests drive this directly. */
export function classify(changes) {
  const fired = [];
  for (const t of TRIGGERS) {
    const hits = changes.filter((c) => t.match(c.path, c.status)).map((c) => c.path);
    if (hits.length > 0) fired.push({ id: t.id, label: t.label, why: t.why, paths: hits });
  }
  return fired;
}

export function isAcknowledged(labels, body) {
  const labelHit = labels.some((l) => {
    const normalized = l.trim().toLowerCase();
    return normalized === ACK_LABEL || normalized === LEGACY_ACK_LABEL;
  });
  if (labelHit) return true;
  return typeof body === 'string' && ACK_BODY_PATTERN.test(body);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

/**
 * A repo reader over two refs. Absence is decided by `cat-file -e` — a legitimate
 * answer — and anything else that fails to read THROWS, so a git error cannot be
 * mistaken for "file absent, nothing changed" (#2388: fail rather than pass).
 */
function gitReader(baseRef, headRef) {
  const refs = { base: baseRef, head: headRef };
  return {
    show(side, path) {
      // `cat-file -t`, not `-e`: `-e` also succeeds for a TREE, which made a local
      // action directory read as a "file" whose action.yml was never opened.
      let type;
      try {
        type = execFileSync('git', ['cat-file', '-t', `${refs[side]}:${path}`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        return null;
      }
      if (type !== 'blob') return null;
      return git(['show', `${refs[side]}:${path}`]);
    },
    listHead(prefix) {
      return git(['ls-tree', '-r', '-z', '--name-only', headRef, '--', prefix])
        .split('\0')
        .filter(Boolean);
    },
  };
}

/**
 * Append the detected triggers to the job summary so sprint close can collect them
 * without re-deriving the diff. Best-effort: `GITHUB_STEP_SUMMARY` is unset outside
 * Actions (e.g. running this script locally), and a missing/unwritable path must not
 * fail the check it is only decorating.
 */
function writeJobSummary(fired, acked) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath || fired.length === 0) return;
  try {
    const lines = [
      '## Escalation triggers acknowledged',
      '',
      `Acknowledgement: ${acked ? 'yes' : 'no'}`,
      '',
      ...fired.flatMap((f) => [
        `- **${f.label}** — ${f.why}`,
        ...f.paths.map((p) => `  - \`${p}\``),
      ]),
      '',
    ];
    appendFileSync(summaryPath, `${lines.join('\n')}\n`);
  } catch {
    // Decoration, not the gate — never fail the check over a summary write.
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = arg('base');
  const head = arg('head', 'HEAD');
  if (!base) {
    console.error(
      'usage: check-escalation-triggers.mjs --base <ref> [--head <ref>] [--labels a,b]',
    );
    process.exit(2);
  }

  // `-z`: NUL-separated and never C-quoted, so a non-ASCII path is classified as itself.
  const changes = parseNameStatus(git(['diff', '-z', '--name-status', `${base}...${head}`]));
  // The diff is three-dot (against the merge base), so the "before" side of a
  // content comparison is the merge base too, not the tip of `base`.
  const mergeBase = git(['merge-base', base, head]).trim();
  // The public-API and credential-workflow triggers need content, not just a path.
  const fired = mergeFired(classify(changes), classifyContent(changes, gitReader(mergeBase, head)));

  const labels = (arg('labels', '') || '').split(',').filter(Boolean);
  const body = arg('body', '') || '';
  const acked = isAcknowledged(labels, body);

  // `--json` prints JSON and NOTHING else, so a caller can parse stdout directly.
  // It used to print the JSON *and* the human report, which made stdout unparseable —
  // and the first attempt to measure this guard's false-positive rate against 40
  // commits silently returned "fired on 0 of 40" because every parse threw and was
  // swallowed. A measurement that cannot fail loudly is worth nothing.
  if (process.argv.includes('--json')) {
    writeJobSummary(fired, acked);
    console.log(JSON.stringify({ fired, acked, ackLabel: ACK_LABEL }, null, 2));
    process.exit(fired.length > 0 && !acked ? 1 : 0);
  }

  if (fired.length === 0) {
    console.log('No mechanically-detectable escalation trigger in this diff.');
    process.exit(0);
  }

  console.log(`Escalation trigger(s) detected (${fired.length}):\n`);
  for (const f of fired) {
    console.log(`  • ${f.label} — ${f.why}`);
    for (const p of f.paths.slice(0, 8)) console.log(`      ${p}`);
    if (f.paths.length > 8) console.log(`      …and ${f.paths.length - 8} more`);
  }

  if (acked) {
    writeJobSummary(fired, acked);
    console.log(
      `\nAcknowledged (\`${ACK_LABEL}\` label, \`${LEGACY_ACK_LABEL}\` label, or a` +
        `\n"Escalation trigger acknowledged: ..." line in the PR body). Passing — logged to` +
        `\nthe job summary for sprint close to collect.`,
    );
    process.exit(0);
  }

  console.error(
    `\nThis PR touches a trigger-class surface and is NOT acknowledged.\n` +
      `\n.claude/rules/workflow.md (2026-09-22 amendment) does not require a design-gate` +
      `\nsign-off per PR for this — it requires that the trigger was CONSCIOUSLY NOTED, so` +
      `\nsprint close can pick it up as tech debt. Acknowledge by either:` +
      `\n  - adding the \`${ACK_LABEL}\` label, or` +
      `\n  - adding a line to the PR body: "Escalation trigger acknowledged: <trigger> — <reason>"` +
      `\n\nThis check does not judge the change and does not require a gate to clear it — it` +
      `\nasserts the trigger was not skipped by default. If it fired on something genuinely` +
      `\nroutine, say so on the PR and narrow the rule; a guard that cries wolf gets worked` +
      `\naround, which is worse than no guard.`,
  );
  process.exit(1);
}
