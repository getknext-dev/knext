/**
 * Parity between the two orchestrations of the SAME fail-closed preflight
 * rules (#1588 review, finding 3):
 *
 *   - `packages/kn-next-action/preflight.mjs` — what the GitHub Action runs.
 *   - `runCiPreflight` (`packages/kn-next/src/cli/ci/ci-preflight.ts`) — what
 *     `kn-next ci-preflight` runs, and what `init-ci --provider gitlab`'s
 *     generated pipeline invokes through the published CLI.
 *
 * These are two independent ports of the same logic (`ci-preflight.ts`'s own
 * header records why they were not consolidated into one call this round:
 * `preflight.mjs`'s existing test suites inject fixture classifiers through a
 * fake `@getknext/core`, a technique a `runCiPreflight`-based rewrite would
 * break because the real classifiers are bundled statically into its dist
 * file rather than dynamically loaded). Until they are one copy, THIS test is
 * what keeps them from silently drifting apart: it feeds both the exact same
 * fake-kubectl fixture and asserts identical verdicts.
 *
 * Deliberately out of scope here: `preflight.mjs` never runs the ADR-0061
 * kubeconfig-safety (exec/auth-provider) refusal at all — that is a SEPARATE
 * action step, `kubeconfig-check.mjs`. `runCiPreflight` folds it in. So every
 * fixture below uses a plain bearer-token kubeconfig, which never trips that
 * branch on either side — this test compares the rules-review + hazard
 * spot-check behaviour the two orchestrations actually share.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCiPreflight } from '../packages/kn-next/src/cli/ci/ci-preflight';
import { CI_ROLE_RULES } from '../packages/kn-next/src/cli/ci/credential-scope';

// Same budget as the sibling hazard-probe suites: ~40 access reviews, one
// fake-kubectl process each, per scenario.
setDefaultTimeout(30_000);

const REPO_ROOT = resolve(import.meta.dirname, '..');
const PREFLIGHT_MJS = join(REPO_ROOT, 'packages/kn-next-action/preflight.mjs');
const CORE_SRC = join(REPO_ROOT, 'packages/kn-next/src/cli/ci');
const NS = 'acme';

const TOKEN_KUBECONFIG = [
  'apiVersion: v1',
  'kind: Config',
  'users:',
  '  - name: knext-deployer',
  '    user:',
  '      token: abc',
  'contexts: []',
  '',
].join('\n');

const made: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An app dir whose `@getknext/core` re-exports the REAL, shipped classifiers
 * from source — the same technique `kn-next-action-preflight-hazard-and-
 * kubeconfig.test.ts` uses, so `preflight.mjs` runs with the exact rules
 * `runCiPreflight` also imports directly. */
function appWithRealCore(): string {
  const app = tempDir('knext-preflight-parity-app-');
  writeFileSync(join(app, 'package.json'), '{"name":"app","private":true}\n');
  const core = join(app, 'node_modules/@getknext/core');
  mkdirSync(core, { recursive: true });
  writeFileSync(
    join(core, 'package.json'),
    JSON.stringify({
      name: '@getknext/core',
      type: 'module',
      exports: {
        './internal/credential-scope': './scope.js',
        './internal/kubeconfig-safety': './kubeconfig-safety.js',
      },
    }),
  );
  writeFileSync(
    join(core, 'scope.js'),
    [
      `export { classifyCredentialScope, hazardProbes } from ${JSON.stringify(join(CORE_SRC, 'credential-scope.ts'))};`,
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(core, 'kubeconfig-safety.js'),
    `export { classifyKubeconfigSafety } from ${JSON.stringify(join(CORE_SRC, 'kubeconfig-safety.ts'))};\n`,
  );
  return app;
}

type Mode = 'normal' | 'nostatus' | 'allowed_string' | 'evalerr' | 'nonjson' | 'error';

/** One fake-kubectl BEHAVIOUR, materialised two ways below: as an in-process
 * `kubectlRaw` callback for `runCiPreflight`, and as an actual executable on
 * PATH for `preflight.mjs`. Mirrors `FAKE_KUBECTL_JS` in
 * `kn-next-action-preflight-hazard-and-kubeconfig.test.ts`: the rules review
 * answers with exactly `grants`, complete (not `incomplete`); the hazard
 * access reviews answer per `grants`, EXCEPT when `mode` forces a
 * non-completing reply. */
function kubectlRawFor(grants: string[], mode: Mode): (rawPath: string, body: string) => string {
  return (_rawPath, body) => {
    const parsed = JSON.parse(body) as {
      kind: string;
      spec: {
        namespace?: string;
        resourceAttributes?: Record<string, unknown>;
      };
    };
    if (parsed.kind === 'SelfSubjectRulesReview') {
      return JSON.stringify({
        status: {
          incomplete: false,
          resourceRules: CI_ROLE_RULES.map((r) => ({
            apiGroups: r.apiGroups,
            resources: r.resources,
            verbs: r.verbs,
          })),
        },
      });
    }
    if (mode === 'error') throw new Error('connection refused');
    if (mode === 'nostatus') return '{}';
    if (mode === 'allowed_string') return JSON.stringify({ status: { allowed: 'true' } });
    if (mode === 'evalerr')
      return JSON.stringify({
        status: { allowed: false, evaluationError: 'webhook timeout' },
      });
    if (mode === 'nonjson') return '<html>502 bad gateway</html>';
    const a = parsed.spec.resourceAttributes as {
      group: string;
      resource: string;
      subresource?: string;
      verb: string;
      namespace?: string;
    };
    const res = a.subresource ? `${a.resource}/${a.subresource}` : a.resource;
    const match = (g: string, v: string) => g === '*' || g === v;
    const allowed = grants.some((g) => {
      const [group, resource, verb, ns] = g.split('|');
      return (
        match(group ?? '', a.group) &&
        match(resource ?? '', res) &&
        match(verb ?? '', a.verb) &&
        (ns === '*' || (a.namespace !== undefined && a.namespace === ns))
      );
    });
    return JSON.stringify({ status: { allowed } });
  };
}

/** The exact-same behaviour as `kubectlRawFor`, as a fake `kubectl` binary
 * `preflight.mjs` shells out to via `execFileSync`. */
const FAKE_KUBECTL_JS = `
import { readFileSync } from 'node:fs';
const body = JSON.parse(readFileSync(0, 'utf8'));
const mode = process.env.SSAR_MODE || 'normal';
if (body.kind === 'SelfSubjectRulesReview') {
  process.stdout.write(JSON.stringify({ status: { incomplete: false, resourceRules: (${JSON.stringify(CI_ROLE_RULES)}).map((r) => ({ apiGroups: r.apiGroups, resources: r.resources, verbs: r.verbs })) } }));
  process.exit(0);
}
if (mode === 'error') { process.stderr.write('connection refused\\n'); process.exit(1); }
if (mode === 'nostatus') { process.stdout.write('{}'); process.exit(0); }
if (mode === 'allowed_string') { process.stdout.write(JSON.stringify({ status: { allowed: 'true' } })); process.exit(0); }
if (mode === 'evalerr') { process.stdout.write(JSON.stringify({ status: { allowed: false, evaluationError: 'webhook timeout' } })); process.exit(0); }
if (mode === 'nonjson') { process.stdout.write('<html>502 bad gateway</html>'); process.exit(0); }
const a = body.spec.resourceAttributes;
const res = a.subresource ? a.resource + '/' + a.subresource : a.resource;
const m = (g, v) => g === '*' || g === v;
const allowed = (process.env.GRANTS || '').split(',').filter(Boolean).some((s) => {
  const [g, r, v, ns] = s.split('|');
  return m(g, a.group) && m(r, res) && m(v, a.verb) && (ns === '*' || (a.namespace !== undefined && a.namespace === ns));
});
process.stdout.write(JSON.stringify({ status: { allowed } }));
`;

function fakeKubectlBin(): string {
  const dir = tempDir('knext-preflight-parity-bin-');
  writeFileSync(join(dir, 'fake-kubectl.mjs'), FAKE_KUBECTL_JS);
  const bin = join(dir, 'kubectl');
  writeFileSync(
    bin,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, 'fake-kubectl.mjs'))} "$@"\n`,
  );
  chmodSync(bin, 0o755);
  return dir;
}

const ROLE_GRANTS = CI_ROLE_RULES.flatMap((r) =>
  r.verbs.map((v) => `${r.apiGroups[0]}|${r.resources[0]}|${v}|${NS}`),
);

function runPreflightMjs(grants: string[], mode: Mode): { ok: boolean; status: number | null } {
  const bin = fakeKubectlBin();
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.KUBECONFIG;
  const r = spawnSync(process.execPath, [PREFLIGHT_MJS, '--namespace', NS], {
    cwd: appWithRealCore(),
    encoding: 'utf8',
    env: {
      ...env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GRANTS: grants.join(','),
      SSAR_MODE: mode,
    },
  });
  return { ok: r.status === 0, status: r.status };
}

function runTsPreflight(grants: string[], mode: Mode): { ok: boolean } {
  const result = runCiPreflight({
    namespace: NS,
    kubeconfigPath: '/fake/kubeconfig',
    readFile: () => TOKEN_KUBECONFIG,
    kubectlRaw: kubectlRawFor(grants, mode),
  });
  return { ok: result.ok };
}

describe('preflight.mjs and runCiPreflight agree on identical fixtures (#1588, finding 3)', () => {
  const cases: Array<[string, string[], Mode]> = [
    ['a correctly-scoped credential passes on both', ROLE_GRANTS, 'normal'],
    [
      'a credential broader than the Role refuses on both',
      [...ROLE_GRANTS, '*|secrets|list|acme'],
      'normal',
    ],
    ['a missing/empty status refuses on both', ROLE_GRANTS, 'nostatus'],
    ['a non-boolean `allowed` (the string "true") refuses on both', ROLE_GRANTS, 'allowed_string'],
    ['an evaluationError on the hazard probe refuses on both', ROLE_GRANTS, 'evalerr'],
    ['a non-JSON reply refuses on both', ROLE_GRANTS, 'nonjson'],
    ['the hazard probe call itself failing (e.g. a 403) refuses on both', ROLE_GRANTS, 'error'],
  ];

  for (const [label, grants, mode] of cases) {
    it(label, () => {
      const mjs = runPreflightMjs(grants, mode);
      const ts = runTsPreflight(grants, mode);
      expect(ts.ok).toBe(mjs.ok);
    });
  }
});
