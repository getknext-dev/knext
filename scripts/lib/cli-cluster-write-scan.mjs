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
  splitTopLevel,
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
 */

/**
 * `apply` / `create` / `replace` of a manifest: the kind is in the file, so each
 * site is justified here, by file and verb. A server-side dry-run is not a write
 * and needs no entry.
 */
export const MANIFEST_WRITES = [
  {
    file: 'packages/kn-next/src/cli/deploy.ts',
    verb: 'apply',
    kinds: ['NextApp'],
    reason: 'knext deploy applies the NextApp CR the operator reconciles (ADR-0001).',
  },
  {
    file: 'packages/kn-next/src/cli/preview.ts',
    verb: 'apply',
    kinds: ['NextApp'],
    reason: 'knext preview applies a per-branch NextApp CR (ADR-0001).',
  },
  {
    file: 'packages/grpc/src/deploy-function.ts',
    verb: 'apply',
    kinds: ['BackendService'],
    reason:
      'knext deploy function applies the BackendService CR the operator reconciles (ADR-0052 D3).',
  },
  {
    file: 'packages/kn-next/src/cli/loadtest.ts',
    verb: 'apply',
    kinds: ['ConfigMap', 'Job'],
    reason:
      'knext loadtest applies an ephemeral k6 ConfigMap and Job: test tooling that holds no app ' +
      'state, a pre-existing exception to "NextApp only", pinned in KIND_EXCEPTIONS.',
  },
  {
    file: 'packages/kn-next/src/cli/ci/ci-preflight.ts',
    verb: 'create',
    kinds: ['SelfSubjectAccessReview', 'SelfSubjectRulesReview'],
    reason:
      'creates an access review to ask the apiserver what the credential may do; the review is ' +
      'answered and never stored.',
  },
];

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
    (f) => f === '-f' || f === '--filename' || f === '--raw' || f.startsWith('--filename='),
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

  // Everything else writes by resource: the first non-flag argument names it.
  const firstNonFlag = rest.find((e) => !lit(e)?.startsWith('-'));
  const resource = lit(firstNonFlag);
  if (resource === undefined) {
    push('unparseable-kubectl', line, `kubectl ${verb}: no literal resource to read`);
    return;
  }
  if (dryRun) return;
  writes.push({ verb, resource: normResource(resource), file, line });
  if (!ALLOWED_RESOURCES.has(normResource(resource))) {
    push(
      'foreign-write-kind',
      line,
      `kubectl ${verb} ${resource}: the CLI writes only NextApp and BackendService`,
    );
  }
}

/** `kind:` values the source can emit (object literals, YAML text, *_KIND constants). */
function kindsIn(src) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const t = text.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    for (const m of text.matchAll(/(?<![\w.])kind\s*:\s*["']([A-Z][A-Za-z0-9]*)["']/g))
      out.push([m[1], i + 1]);
    const yaml = /^\s*(?:-\s+)?["']?\s*(?:-\s+)?kind:\s*([A-Z][A-Za-z0-9]*)\s*["',]*\s*$/.exec(
      text,
    );
    if (yaml) out.push([yaml[1], i + 1]);
    for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]*KIND\s*=\s*["']([A-Z][A-Za-z0-9]*)["']/g))
      out.push([m[1], i + 1]);
  }
  return out;
}

/**
 * Scan one source file.
 *
 * @param {string} src
 * @param {{ file: string, allow?: typeof MANIFEST_WRITES, kindExceptions?: Record<string,string[]> }} opts
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

  const seen = new Set();
  const handle = (elems, index) => {
    const line = lineOf(src, index);
    kubectlArgvCount++;
    analyse(elems, { file, line, push, writes, manifestSites });
  };

  // (a) arrays whose first element is the literal "kubectl".
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== '[') continue;
    // an index access (`argv[0]`, `x[i]`) is not an array literal
    if (isIndexAccess(b, i)) continue;
    const close = matchClose(b, i);
    const elems = splitTopLevel(b, i + 1, close).map((r) => classify(p, r));
    if (elems[0]?.type === 'string' && elems[0].value === 'kubectl') {
      seen.add(i);
      handle(elems, i);
    }
  }

  // (b) a spawn of the literal program "kubectl" with an array of arguments.
  const fileStyle = /(?<![\w$.])(execFileSync|execFile|spawnSync|spawn)\s*\(/g;
  for (let m = fileStyle.exec(b); m; m = fileStyle.exec(b)) {
    const open = m.index + m[0].length - 1;
    const args = callArgs(p, open);
    if (lit(args[0]) !== 'kubectl' || !args[1]) continue;
    if (args[1].type === 'array') {
      handle([args[0], ...args[1].elems], m.index);
    }
    // A computed argument list is the wrapper pattern (kubectl-capture.ts): its
    // callers hand it a literal array starting "kubectl", read in (a).
  }

  // Manifest writes must be justified by file + verb.
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
  }

  // Every kind the file can emit.
  const kinds = [];
  const permitted = new Set([...ALLOWED_KINDS, ...(kindExceptions[file] ?? [])]);
  for (const [kind, line] of kindsIn(src)) {
    kinds.push(kind);
    if (!permitted.has(kind))
      push(
        'foreign-kind',
        line,
        `kind: ${kind} is not NextApp or BackendService and ${file} is not pinned to emit it`,
      );
  }

  const unusedAllow = mine.filter((e) => e.used === 0).map((e) => ({ file: e.file, verb: e.verb }));
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
