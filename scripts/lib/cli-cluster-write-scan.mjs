/**
 * The cluster-write scan: the CLI writes only `NextApp` and `BackendService`
 * (ADR-0001 as amended by ADR-0052 D3; CLAUDE.md section 4).
 *
 * Scope: every non-test source file under `packages/kn-next/src/cli/`,
 * `packages/kn-next/src/generators/` and `packages/grpc/` (the same tree as
 * `cli-spawn-scan.mjs`, plus the generators the CLI renders manifests from).
 *
 * What it reads:
 *   - every `kubectl` argv LITERAL: an array whose first element is "kubectl",
 *     or a spawn of the literal program "kubectl" with an array of arguments;
 *   - every `kind:` the sources can emit.
 *
 * Rules (each FAILS rather than passes on what it cannot read):
 *   unparseable-kubectl     the verb is computed, follows a flag, or a write
 *                           verb has no readable resource.
 *   foreign-write-kind      a write verb (patch, delete, label, ...) whose
 *                           resource is not nextapp/backendservice.
 *   unlisted-manifest-write an apply/create/replace of a manifest from a file
 *                           that is not on {@link MANIFEST_WRITES}: the kind
 *                           travels in the manifest, so each such site is
 *                           justified once, by file and verb.
 *   apply-not-strict        a `kubectl apply` (including the server-side
 *                           dry-run preflight) without `--validate=strict`.
 *   foreign-kind            a `kind:` outside {@link ALLOWED_KINDS} that the
 *                           file is not pinned to emit in {@link KIND_EXCEPTIONS}.
 *
 * A server-side dry-run apply stores nothing, so it is not a write; it must
 * still carry the strict flag, because it is the preflight.
 *
 * The test is `tests/cli-cluster-write-kinds.test.ts`; the mutation proof is
 * `scripts/mutation-prove-2053-cli-cluster-write-surface.mjs`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  callArgs,
  classify,
  isIndexAccess,
  lineOf,
  matchClose,
  prepare,
  progName,
  splitTopLevel,
  wrappedArgvs,
} from './ts-call-scan.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const WRITE_SCOPE_DIRS = [
  'packages/kn-next/src/cli',
  'packages/kn-next/src/generators',
  'packages/grpc',
];

const EXCLUDED_SEGMENTS = new Set([
  '__tests__',
  'node_modules',
  'dist',
  'fixtures',
  'testdata',
  'proto',
  'templates',
]);

/** The only kinds the CLI creates, patches or deletes as application state. */
export const ALLOWED_KINDS = new Set(['NextApp', 'BackendService']);

/** Resource names (as typed to kubectl) for the allowed kinds. */
const ALLOWED_RESOURCES = new Set([
  'nextapp',
  'nextapps',
  'backendservice',
  'backendservices',
  'bsvc',
]);

/**
 * Other kinds that appear in the sources, pinned PER FILE with the reason. A new
 * entry is a deliberate edit of this guard (the test pins the set).
 */
export const KIND_EXCEPTIONS = {
  'packages/kn-next/src/generators/loadtest-job.ts': ['ConfigMap', 'Job'],
  'packages/kn-next/src/cli/ci/ci-preflight.ts': [
    'SelfSubjectAccessReview',
    'SelfSubjectRulesReview',
  ],
  'packages/kn-next/src/cli/ci/init-ci.ts': ['Role', 'RoleBinding', 'ServiceAccount'],
  'packages/kn-next/src/cli/ci/credential-scope.ts': ['Role'],
};

/**
 * A kind the scan cannot read is a violation, unless the file is listed here with
 * the exact number of such places and why they are not Kubernetes kinds. A count
 * that changes (up or down) reds.
 */
export const KIND_UNREADABLE_WAIVERS = {
  'packages/grpc/src/glue-plugin.ts': {
    count: 1,
    reason:
      'writes TypeScript for the generated client; the `kind` it emits is the RPC kind ' +
      '(unary/stream), not a Kubernetes kind.',
  },
};

/**
 * Why each exception is not an app-state write:
 *   loadtest-job.ts   `knext loadtest` applies an ephemeral k6 ConfigMap + Job:
 *                     test tooling that holds no app state. A real exception to
 *                     "NextApp only" that predates this guard.
 *   ci-preflight.ts   creates a SelfSubject*Review to ask the apiserver "may I?";
 *                     the object is never stored.
 *   init-ci.ts        WRITES RBAC YAML to disk for the user to review and apply
 *                     themselves; the CLI holds no kubectl call for it.
 *   credential-scope.ts  renders the same RBAC Role text (for init-ci and the CI
 *                     credential check); it is text, never applied by the CLI.
 */

/**
 * `apply` / `create` / `replace` of a manifest: the kind is in the file, so each
 * site is justified here, by file and verb. A server-side dry-run is not a write
 * and needs no entry.
 *
 * `count` is how many such sites the file has (default 1): one more reds, one
 * fewer is stale. `kinds` is what the manifest may carry, compared with what the
 * `kindSources` files can emit.
 *
 * @typedef {{
 *   file: string,
 *   verb: string,
 *   count?: number,
 *   kinds: string[],
 *   kindSources?: string[],
 *   reason: string,
 * }} ManifestWrite
 */

/** @type {ManifestWrite[]} */
export const MANIFEST_WRITES = [
  {
    file: 'packages/kn-next/src/cli/deploy.ts',
    verb: 'apply',
    count: 1,
    kinds: ['NextApp'],
    kindSources: ['packages/kn-next/src/cli/cr-builder.ts'],
    reason: 'knext deploy applies the NextApp CR the operator reconciles (ADR-0001).',
  },
  {
    file: 'packages/kn-next/src/cli/preview.ts',
    verb: 'apply',
    count: 1,
    kinds: ['NextApp'],
    kindSources: ['packages/kn-next/src/cli/cr-builder.ts'],
    reason: 'knext preview applies a per-branch NextApp CR (ADR-0001).',
  },
  {
    file: 'packages/kn-next/src/cli/grpc-dispatch.ts',
    verb: 'apply',
    count: 1,
    kinds: ['BackendService'],
    kindSources: ['packages/grpc/src/backend-service.ts'],
    reason:
      'knext deploy function: core applies the BackendService CR @getknext/grpc built, after the ' +
      'strict dry-run preflight; the package itself can run no program (ADR-0052 D3).',
  },
  {
    file: 'packages/kn-next/src/cli/loadtest.ts',
    verb: 'apply',
    count: 1,
    kinds: ['ConfigMap', 'Job'],
    kindSources: ['packages/kn-next/src/generators/loadtest-job.ts'],
    reason:
      'knext loadtest applies an ephemeral k6 ConfigMap and Job: test tooling that holds no app ' +
      'state, a pre-existing exception to "NextApp only", pinned in KIND_EXCEPTIONS.',
  },
  {
    file: 'packages/kn-next/src/cli/ci/ci-preflight.ts',
    verb: 'create',
    count: 2,
    kinds: ['SelfSubjectAccessReview', 'SelfSubjectRulesReview'],
    kindSources: ['packages/kn-next/src/cli/ci/ci-preflight.ts'],
    reason:
      'creates an access review to ask the apiserver what the credential may do (once with ' +
      '--raw, once in the older-kubectl fallback); the review is answered and never stored.',
  },
];

/**
 * Compare each entry's DECLARED kinds with what the source files that build its
 * manifest can emit. A kind emitted but not declared is an undeclared write; a
 * kind declared but never emitted means the entry no longer describes the code.
 * An entry that names no source cannot be compared, so it fails.
 *
 * @param {Array<Partial<ManifestWrite> & {file: string, verb: string, kinds: string[]}>} entries
 * @param {(file: string) => string[]} kindsOf kinds a repo-relative file can emit
 */
export function checkManifestKinds(entries, kindsOf) {
  const out = [];
  for (const e of entries) {
    const at = { file: e.file, line: 0 };
    if (!e.kindSources || e.kindSources.length === 0) {
      out.push({
        rule: 'undeclared-kind-source',
        ...at,
        detail: `${e.verb} entry names no kindSources, so what it applies cannot be compared`,
      });
      continue;
    }
    const found = new Set(e.kindSources.flatMap((f) => kindsOf(f)));
    const declared = new Set(e.kinds);
    for (const k of found) {
      if (!declared.has(k)) {
        out.push({
          rule: 'undeclared-kind',
          ...at,
          detail: `${e.kindSources.join(', ')} can emit ${k}, which the ${e.verb} entry does not declare`,
        });
      }
    }
    for (const k of declared) {
      if (!found.has(k)) {
        out.push({
          rule: 'declared-kind-not-emitted',
          ...at,
          detail: `the ${e.verb} entry declares ${k}, which ${e.kindSources.join(', ')} never emits`,
        });
      }
    }
  }
  return out;
}

const READ_VERBS = new Set([
  'get',
  'describe',
  'logs',
  'version',
  'api-resources',
  'api-versions',
  'explain',
  'top',
  'diff',
  'cluster-info',
  'config',
  'events',
  'wait',
  'auth',
  'options',
]);
const MANIFEST_VERBS = new Set(['apply', 'create', 'replace']);

const normResource = (r) => r.toLowerCase().replace(/\.apps\.kn-next\.dev$/, '');

const lit = (e) => (e?.type === 'string' ? e.value : undefined);

const isKubectl = (e) => e?.type === 'string' && progName(e.value) === 'kubectl';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SHELL_CALLS = new Set(['exec', 'execSync', 'execaCommand', 'execaCommandSync']);
const FILE_CALLS = new Set([
  'execFileSync',
  'execFile',
  'spawnSync',
  'spawn',
  'execa',
  'execaSync',
]);

/** kubectl flags that take a value, so the value is not mistaken for the resource. */
const VALUE_FLAGS = new Set([
  '-n',
  '--namespace',
  '-l',
  '--selector',
  '-o',
  '--output',
  '-f',
  '--filename',
  '-k',
  '--kustomize',
  '-p',
  '--patch',
  '--patch-file',
  '--type',
  '--context',
  '--cluster',
  '--user',
  '--kubeconfig',
  '--field-selector',
  '-c',
  '--container',
  '-L',
  '--as',
  '--token',
  '--subresource',
  '--field-manager',
  '--request-timeout',
  '-s',
  '--server',
]);
/** kubectl flags known to take no value. An unknown bare flag makes the resource unreadable. */
const BOOL_FLAGS = new Set([
  '--ignore-not-found',
  '--overwrite',
  '--all',
  '-A',
  '--all-namespaces',
  '--wait',
  '--force',
  '-R',
  '--recursive',
  '--local',
  '--now',
  '--dry-run',
  '--server-side',
  '--raw',
  '--list',
  '--show-managed-fields',
  '--no-headers',
  '-w',
  '--watch',
]);

/**
 * The resource a write verb names: the first positional argument, after skipping
 * flags and the values of flags that take one. `{ problem }` when it cannot be
 * read - a computed element, or a flag this scan does not know the shape of.
 */
function firstResource(rest) {
  for (let i = 0; i < rest.length; i++) {
    const e = rest[i];
    if (e.type !== 'string') return { problem: `the resource is computed (${e.text})` };
    const v = e.value;
    if (v.startsWith('-')) {
      if (v.includes('=')) continue;
      if (VALUE_FLAGS.has(v)) {
        i++;
        continue;
      }
      if (BOOL_FLAGS.has(v)) continue;
      return { problem: `the flag ${v} is not one this scan knows the shape of` };
    }
    return { resource: v };
  }
  return { problem: 'no resource to read' };
}

/** Analyse one kubectl argv (classified elements, element 0 is "kubectl"). */
function analyse(elems, ctx) {
  const { file, line, push, writes } = ctx;
  const verbEl = elems[1];
  const verb = lit(verbEl);
  if (verb === undefined || verb.startsWith('-')) {
    push(
      'unparseable-kubectl',
      line,
      `kubectl ${verbEl?.text ?? '(nothing)'}: the verb is not a literal that comes first`,
    );
    return;
  }
  const rest = elems.slice(2);
  const flags = rest.filter((e) => lit(e)?.startsWith('-')).map((e) => lit(e));
  const hasFile = flags.some(
    (f) =>
      f === '-f' ||
      f === '--filename' ||
      f === '-k' ||
      f === '--kustomize' ||
      f === '--raw' ||
      f.startsWith('--filename='),
  );
  const dryRun = flags.some((f) => f === '--dry-run=server' || f === '--dry-run=client');

  if (verb === 'apply' && !flags.includes('--validate=strict')) {
    push('apply-not-strict', line, 'kubectl apply must pass --validate=strict explicitly');
  }
  if (READ_VERBS.has(verb)) return;

  if (MANIFEST_VERBS.has(verb) && hasFile) {
    if (dryRun) return; // stores nothing; strictness already checked above
    writes.push({ verb, resource: undefined, file, line });
    ctx.manifestSites.push({ verb, line });
    return;
  }

  // Everything else writes by resource: the first positional argument names it.
  const { resource, problem } = firstResource(rest);
  if (resource === undefined) {
    push('unparseable-kubectl', line, `kubectl ${verb}: ${problem}`);
    return;
  }
  if (dryRun) return;
  // `nextapp,secret` lists kinds; `secret/foo` is kind/name. Every kind must be allowed.
  const kinds = resource.split(',').map((x) => normResource(x.split('/')[0]));
  writes.push({ verb, resource: kinds.join(','), file, line });
  if (!kinds.every((k) => ALLOWED_RESOURCES.has(k))) {
    push(
      'foreign-write-kind',
      line,
      `kubectl ${verb} ${resource}: the CLI writes only NextApp and BackendService`,
    );
  }
}

/**
 * A shell command line, read as kubectl invocations. Every segment (split on
 * `&&`, `||`, `;`, `|`, newlines, `$(`) whose first word is kubectl is analysed
 * like an argv; kubectl appearing anywhere else (behind `env`, `xargs`, `sudo`)
 * cannot be read and FAILS.
 */
function analyseShell(command, index, ctx) {
  if (!/\bkubectl(?:\.exe)?\b/.test(command)) return;
  const segments = command.split(/&&|\|\||[;&|\n`()]|\$\(/);
  let heads = 0;
  let mentions = 0;
  for (const seg of segments) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    while (words.length > 0 && /^[A-Za-z_]\w*=/.test(words[0])) words.shift();
    mentions += words.filter((w) => progName(w.replace(/^["']|["']$/g, '')) === 'kubectl').length;
    if (words.length === 0 || progName(words[0].replace(/^["']|["']$/g, '')) !== 'kubectl')
      continue;
    heads++;
    const elems = words.map((w) =>
      /[$`]/.test(w)
        ? { type: 'dynamic', text: w }
        : { type: 'string', value: w.replace(/^["']|["']$/g, ''), text: w },
    );
    ctx.count();
    analyse(elems, { ...ctx, line: lineOf(ctx.src, index) });
  }
  if (mentions > heads) {
    ctx.push(
      'unparseable-kubectl',
      lineOf(ctx.src, index),
      'kubectl appears in a shell string where it is not the first word, so it cannot be read',
    );
  }
}

/** The shell command element of `sh -c <cmd>` given as classified argv elements, or undefined. */
function shellCommandOf(elems) {
  const head = elems[0];
  if (head?.type !== 'string' || !SHELLS.has(progName(head.value))) return undefined;
  const i = elems.findIndex((e, k) => k > 0 && e.type === 'string' && /^-\w*c\w*$/.test(e.value));
  return i === -1 ? undefined : (elems[i + 1] ?? { type: 'dynamic', text: '(nothing)' });
}

const TYPE_WORDS = new Set([
  'string',
  'number',
  'boolean',
  'unknown',
  'any',
  'never',
  'object',
  'bigint',
  'symbol',
  'void',
]);

/**
 * The kinds a source file can emit, and the places it writes a kind it cannot
 * read. Exported because `checkManifestKinds` reads the kind SOURCES through it.
 *
 * Read: a property `kind: 'X'` (bare, "quoted" or computed `['kind']`), an
 * assignment `m.kind = 'X'`, a value that is a string literal, a no-hole
 * template, or a constant bound to one in the same file, YAML text (`kind: X`),
 * and `*_KIND = 'X'` constants. Unreadable (it FAILS): a template with a hole, or
 * an identifier / member / call that is not a known constant. Not read: a lower
 * -case value (a discriminator, not a Kubernetes kind), a type annotation
 * (`readonly kind: T;`, or a line starting `type`/`interface`), a comparison.
 *
 * @param {string} src
 * @returns {Array<{kind?: string, line: number, unreadable?: boolean}>}
 */
export function kindsOfSource(src) {
  const { consts } = prepare(src);
  const out = [];
  const lines = src.split('\n');
  const KEY = String.raw`(?:["']kind["']|\[\s*["'\x60]kind["'\x60]\s*\]|(?<![\w$])kind)`;
  const prop = new RegExp(`${KEY}\\s*:\\s*(.*)$`);
  const assign = /(?:\??\.\s*kind|\[\s*["'\x60]kind["'\x60]\s*\])\s*=(?!=)\s*(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const t = text.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    if (/^(?:export\s+)?(?:declare\s+)?(?:type|interface)\b/.test(t)) continue;

    // The value after a `kind:` key or a `.kind =` assignment.
    const value = (rest, isAssign) => {
      const v = rest.trim();
      const lit = /^(["'`])([A-Za-z][A-Za-z0-9]*)\1/.exec(v);
      if (lit) {
        if (/^[A-Z]/.test(lit[2])) out.push({ kind: lit[2], line: i + 1 });
        return;
      }
      if (/^`/.test(v)) {
        if (/^`[^`]*\$\{/.test(v)) out.push({ kind: undefined, line: i + 1, unreadable: true });
        return;
      }
      const id = /^([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*(.?)/.exec(v);
      if (!id) return;
      const name = id[1].replace(/\s+/g, '');
      if (consts.has(name)) {
        const c = consts.get(name);
        if (/^[A-Z]/.test(c)) out.push({ kind: c, line: i + 1 });
        return;
      }
      if (['true', 'false', 'null', 'undefined', 'typeof', 'new'].includes(name)) return;
      // An identifier property value is unreadable in an object literal, but the
      // same text ending a statement is a type member (`kind: Foo;`).
      // The same text ending the line, or the template, is YAML (`kind: Job`) read below.
      if (!isAssign && TYPE_WORDS.has(name)) return; // a typed parameter: (kind: string)
      if (!isAssign && [';', '|', '', '`', '\\', '"', "'"].includes(id[2])) return;
      out.push({ kind: undefined, line: i + 1, unreadable: true });
    };
    const p1 = prop.exec(text);
    // `readonly kind: T` is a type member, not a value.
    if (p1 && !/\breadonly\s+(?:["']?kind["']?)\s*:/.test(text)) value(p1[1], false);
    const a1 = assign.exec(text);
    if (a1) value(a1[1], true);

    const yaml =
      /^\s*(?:-\s+)?["'`]?\s*(?:-\s+)?kind:\s*([A-Z][A-Za-z0-9]*)\s*(?:\\n)?["',`;+\s]*$/.exec(
        text,
      );
    if (yaml) out.push({ kind: yaml[1], line: i + 1 });
    for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]*KIND\s*=\s*["'`]([A-Z][A-Za-z0-9]*)["'`]/g))
      out.push({ kind: m[1], line: i + 1 });
  }
  return out;
}

/**
 * Scan one source file.
 *
 * @param {string} src
 * @param {{ file: string, allow?: Array<Partial<ManifestWrite> & {file: string, verb: string}>, kindExceptions?: Record<string,string[]> }} opts
 */
export function scanClusterWriteSource(
  src,
  { file, allow = MANIFEST_WRITES, kindExceptions = KIND_EXCEPTIONS },
) {
  const p = prepare(src);
  const { b } = p;
  const violations = [];
  const writes = [];
  const manifestSites = [];
  const push = (rule, line, detail) => violations.push({ rule, file, line, detail });
  let kubectlArgvCount = 0;
  const base = { file, push, writes, manifestSites, src, count: () => kubectlArgvCount++ };

  const handle = (elems, index) => {
    kubectlArgvCount++;
    analyse(elems, { ...base, line: lineOf(src, index) });
  };
  const shell = (cmdEl, index) => {
    if (cmdEl.type === 'string') analyseShell(cmdEl.value, index, base);
    else if (cmdEl.type === 'template' && /\bkubectl\b/.test(cmdEl.text)) {
      push(
        'unparseable-kubectl',
        lineOf(src, index),
        'a shell string with a hole that mentions kubectl',
      );
    } else if (cmdEl.type !== 'string' && cmdEl.type !== 'template') {
      push(
        'unparseable-kubectl',
        lineOf(src, index),
        `a shell -c command the scan cannot read (${cmdEl.text}); it might run kubectl`,
      );
    }
  };

  // An argv, read as kubectl or as a shell: directly, or behind a wrapper program
  // (`env`, `sudo`, `xargs`...), whose reading is shared with the spawn scan.
  const inspect = (elems, index) => {
    const cands = [elems, ...wrappedArgvs(elems)];
    const kubectl = cands.find((c) => isKubectl(c[0]));
    if (kubectl) {
      handle(kubectl, index);
      return;
    }
    for (const c of cands) {
      const cmd = shellCommandOf(c);
      if (cmd) {
        shell(cmd, index);
        return;
      }
    }
  };

  // (a) arrays whose first element is kubectl (by name, by path, or via a constant),
  //     and arrays that are `sh -c <command>`.
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== '[') continue;
    // an index access (`argv[0]`, `x[i]`) is not an array literal
    if (isIndexAccess(b, i)) continue;
    const close = matchClose(b, i);
    const elems = splitTopLevel(b, i + 1, close).map((r) => classify(p, r));
    inspect(elems, i);
  }

  // (b) a spawn of the program kubectl (or a shell) with an array of arguments, and
  //     a shell string handed to exec/execSync.
  const callRe = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  for (let m = callRe.exec(b); m; m = callRe.exec(b)) {
    const name = m[1];
    const isFile = FILE_CALLS.has(name);
    const isShell = SHELL_CALLS.has(name);
    if (!isFile && !isShell) continue;
    if (/\bfunction\s*\*?\s*$/.test(b.slice(Math.max(0, m.index - 12), m.index))) continue;
    const args = callArgs(p, m.index + m[0].length - 1);
    if (isShell && args[0]) {
      // Only a literal command is read here. A computed one handed to exec/execSync
      // is the spawn scan's to refuse (unparseable-spawn); an array is read in (a).
      if (args[0].type === 'string' || args[0].type === 'template') shell(args[0], m.index);
    } else if (isFile && args[0] && args[1]?.type === 'array') {
      inspect([args[0], ...args[1].elems], m.index);
    }
    // A computed argument list is the wrapper pattern (kubectl-capture.ts): its
    // callers hand it a literal array starting "kubectl", read in (a).
  }

  // Manifest writes must be justified by file + verb, and COUNTED: the entry says
  // how many sites there are, so a second apply in the same file reds.
  const mine = allow.filter((e) => e.file === file).map((e) => ({ ...e, used: 0 }));
  for (const site of manifestSites) {
    const entry = mine.find((e) => e.verb === site.verb);
    if (!entry) {
      push(
        'unlisted-manifest-write',
        site.line,
        `kubectl ${site.verb} of a manifest from ${file}: add a justified entry to MANIFEST_WRITES or remove it`,
      );
      continue;
    }
    entry.used += 1;
    if (entry.used > (entry.count ?? 1)) {
      push(
        'unlisted-manifest-write',
        site.line,
        `an extra kubectl ${site.verb} in ${file}: the table counts ${entry.count ?? 1}`,
      );
    }
  }

  // Every kind the file can emit.
  const kinds = [];
  const permitted = new Set([...ALLOWED_KINDS, ...(kindExceptions[file] ?? [])]);
  const waiver = KIND_UNREADABLE_WAIVERS[file];
  let unreadableSeen = 0;
  for (const { kind, line, unreadable } of kindsOfSource(src)) {
    if (unreadable) {
      unreadableSeen += 1;
      if (waiver && unreadableSeen <= waiver.count) continue;
      push('unparseable-kind', line, 'a kind that cannot be read (a hole, an unknown identifier)');
      continue;
    }
    kinds.push(kind);
    if (!permitted.has(kind))
      push(
        'foreign-kind',
        line,
        `kind: ${kind} is not NextApp or BackendService and ${file} is not pinned to emit it`,
      );
  }

  if (waiver && unreadableSeen < waiver.count) {
    push(
      'unparseable-kind',
      0,
      `the waiver for ${file} expects ${waiver.count} unreadable kind(s), found ${unreadableSeen}`,
    );
  }

  const unusedAllow = mine
    .filter((e) => e.used < (e.count ?? 1))
    .map((e) => ({ file: e.file, verb: e.verb, unused: (e.count ?? 1) - e.used }));
  return { violations, writes, kinds, unusedAllow, kubectlArgvCount };
}

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    if (EXCLUDED_SEGMENTS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(?:[cm]?[jt]s|tsx)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) out.push(full);
  }
}

/** Repo-relative paths of every file in scope. */
export function writeScopeFiles(root = REPO_ROOT) {
  const files = [];
  for (const d of WRITE_SCOPE_DIRS) walk(join(root, d), files);
  return files.map((f) => relative(root, f).split('\\').join('/'));
}

/** Scan every file in scope. */
export function scanClusterWriteTree(
  root = REPO_ROOT,
  allow = MANIFEST_WRITES,
  kindExceptions = KIND_EXCEPTIONS,
) {
  const files = writeScopeFiles(root);
  const violations = [];
  const writes = [];
  const kinds = new Set();
  const unusedAllow = [];
  let kubectlArgvCount = 0;
  for (const file of files) {
    const r = scanClusterWriteSource(readFileSync(join(root, file), 'utf8'), {
      file,
      allow,
      kindExceptions,
    });
    violations.push(...r.violations);
    writes.push(...r.writes);
    for (const k of r.kinds) kinds.add(k);
    unusedAllow.push(...r.unusedAllow);
    kubectlArgvCount += r.kubectlArgvCount;
  }
  // A table entry for a file outside the scope can never match: stale.
  for (const e of allow) {
    if (!files.includes(e.file)) unusedAllow.push({ file: e.file, verb: e.verb });
  }
  // And each entry's declared kinds must equal what its source files can emit.
  violations.push(
    ...checkManifestKinds(allow, (f) => {
      try {
        return kindsOfSource(readFileSync(join(root, f), 'utf8'))
          .filter((x) => x.kind !== undefined)
          .map((x) => x.kind);
      } catch {
        return [];
      }
    }),
  );
  // A table entry may only name kinds that are allowed or pinned somewhere.
  const pinned = new Set([...ALLOWED_KINDS, ...Object.values(kindExceptions).flat()]);
  for (const e of allow) {
    for (const k of e.kinds) {
      if (!pinned.has(k)) {
        violations.push({
          rule: 'foreign-kind',
          file: e.file,
          line: 0,
          detail: `MANIFEST_WRITES names ${k}, which is neither allowed nor a pinned exception`,
        });
      }
    }
  }
  return { violations, writes, kinds: [...kinds].sort(), unusedAllow, kubectlArgvCount, files };
}
