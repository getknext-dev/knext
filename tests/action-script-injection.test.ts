/**
 * #2531 — a published composite action must never paste a `${{ }}` expression into
 * a script body.
 *
 * GitHub substitutes `${{ inputs.tag }}` as plain text BEFORE bash parses the
 * script, so a consumer who wires a pull-request-derived value into an input
 * (`tag: ${{ github.head_ref }}` — a branch name can be `x";curl …;#`) runs it
 * inside the deploy step, with the decoded kubeconfig on disk and the registry
 * token in env. The consumer's workflow looks safe: it only passes a value to an
 * input. The action is what makes it exploitable.
 *
 * Four halves, deliberately:
 *   1. the SCAN (`scripts/lib/action-script-injection-scan.mjs`) classifies
 *      expressions correctly — proved on fixtures, so a scanner that stops seeing
 *      one of them cannot hide behind a repo that happens to be clean;
 *   2. every `action.yml` the repo tracks is clean — discovered, not listed;
 *   3. BEHAVIOUR: the real Deploy step of each action is executed under bash with
 *      hostile input values. Nothing runs, and the values that pass validation
 *      reach the CLI as literal argv entries;
 *   4. the CLI the action runs is pinned, and the two actions agree on the pin.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  discoverActionFiles,
  discoverWorkflowFiles,
  scanActionFile,
  scanActionText,
  scanWorkflowFile,
  scanWorkflowText,
} from '../scripts/lib/action-script-injection-scan.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACTION = 'packages/kn-next-action/action.yml';
const ROOT_ACTION = 'action.yml';
const MIRROR_ACTION = '.github/actions/docker-hub-mirror/action.yml';

// ── 1. the scan classifies expressions ────────────────────────────────────────

/** A one-step composite action whose `run:` is `body`. */
const composite = (body: string, extra = '') =>
  [
    'name: t',
    'description: t',
    'runs:',
    '  using: composite',
    '  steps:',
    '    - shell: bash',
    extra,
    '      run: |',
    ...body.split('\n').map((l) => `        ${l}`),
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');

describe('the scan — expressions in a run: body (#2531)', () => {
  const HOSTILE = [
    'inputs.tag',
    "inputs['tag']",
    'github.event.pull_request.title',
    'github.event.head_commit.message',
    'github.head_ref',
    'github.base_ref',
    'github.ref_name',
    'github.actor',
    'steps.build.outputs.name',
    'needs.a.outputs.b',
    'env.TAG',
    'secrets.KUBECONFIG_B64',
    'matrix.os',
    'vars.X',
    "format('{0}', inputs.tag)",
    'toJSON(inputs)',
    "inputs.tag || 'latest'",
    'github.action_path || inputs.tag',
  ];

  for (const expr of HOSTILE) {
    it(`flags \${{ ${expr} }}`, () => {
      const findings = scanActionText(composite(`echo "\${{ ${expr} }}"`), 'a.yml');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.expression).toBe(expr);
    });
  }

  it('flags an expression in the inline form, not just a block scalar', () => {
    const text = [
      'name: t',
      'runs:',
      '  using: composite',
      '  steps:',
      '    - shell: bash',
      '      run: echo ${{ inputs.tag }}',
      '',
    ].join('\n');
    expect(scanActionText(text, 'a.yml')).toHaveLength(1);
  });

  it('flags an expression inside a github-script `script:`', () => {
    const text = [
      'name: t',
      'runs:',
      '  using: composite',
      '  steps:',
      '    - uses: actions/github-script@0000000000000000000000000000000000000000 # v7.0.0',
      '      with:',
      '        script: |',
      '          core.info("${{ inputs.tag }}")',
      '',
    ].join('\n');
    expect(scanActionText(text, 'a.yml')).toHaveLength(1);
  });

  it('flags every expression, with its step, not only the first', () => {
    const findings = scanActionText(
      composite('echo ${{ inputs.a }}\necho ${{ github.head_ref }}'),
      'a.yml',
    );
    expect(findings.map((f) => f.expression)).toEqual(['inputs.a', 'github.head_ref']);
  });

  it('flags the escaped form: a backslash does not stop GitHub substituting', () => {
    const findings = scanActionText(composite('echo "\\${{ secrets.KUBECONFIG_B64 }}"'), 'a.yml');
    expect(findings).toHaveLength(1);
  });

  const SAFE = ['github.action_path', 'github.workspace', 'github.sha', 'runner.temp'];
  for (const expr of SAFE) {
    it(`does not flag the runner-controlled \${{ ${expr} }}`, () => {
      expect(scanActionText(composite(`node "\${{ ${expr} }}/x.mjs"`), 'a.yml')).toEqual([]);
    });
  }

  it('does not flag an expression in `env:`, `with:`, `if:` or `working-directory:`', () => {
    const text = [
      'name: t',
      'runs:',
      '  using: composite',
      '  steps:',
      '    - shell: bash',
      "      if: inputs.doctor == 'true'",
      '      working-directory: ${{ inputs.working-directory }}',
      '      env:',
      '        KNEXT_TAG: ${{ inputs.tag }}',
      '      run: |',
      '        echo "$KNEXT_TAG"',
      '',
    ].join('\n');
    expect(scanActionText(text, 'a.yml')).toEqual([]);
  });

  it('ignores a non-composite action (there is no run: body to inject into)', () => {
    const text = ['name: t', 'runs:', '  using: node20', '  main: index.js', ''].join('\n');
    expect(scanActionText(text, 'a.yml')).toEqual([]);
  });

  it('fails closed on a file it cannot parse', () => {
    expect(() => scanActionText('runs: [unterminated', 'a.yml')).toThrow(/a\.yml/);
  });

  it('fails closed on a composite whose steps it cannot read', () => {
    const text = ['name: t', 'runs:', '  using: composite', '  steps: nope', ''].join('\n');
    expect(() => scanActionText(text, 'a.yml')).toThrow(/steps/);
  });
});

// ── 2. every tracked action is clean — discovered, not listed ─────────────────

describe('every action.yml in the repo (#2531)', () => {
  const files = discoverActionFiles(REPO_ROOT);

  it('discovers the published actions and the local composite — a vacuous scan fails', () => {
    expect(files).toContain(ROOT_ACTION);
    expect(files).toContain(ACTION);
    expect(files).toContain(MIRROR_ACTION);
  });

  for (const rel of files) {
    it(`${rel} puts no untrusted expression inside a script body`, () => {
      expect(scanActionFile(REPO_ROOT, rel)).toEqual([]);
    });
  }
});

// ── 2b. workflows: outside-controlled contexts never reach a script body ──────

const workflow = (body: string, step = '') =>
  [
    'name: t',
    'on: pull_request',
    'jobs:',
    '  j:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: s',
    step,
    '        run: |',
    ...body.split('\n').map((l) => `          ${l}`),
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');

describe('workflows — event data in a run: body (#2531)', () => {
  const HOSTILE = [
    'github.event.pull_request.title',
    'github.event.head_commit.message',
    'github.event.pull_request.head.ref',
    'github.event.inputs.tag',
    'github.event',
    'github.head_ref',
    'github.base_ref',
    'github.ref_name',
    'github.ref',
    'inputs.tag',
    "inputs['tag']",
    "format('{0}', github.head_ref)",
    'toJSON(github.event)',
    "github.event.pull_request.title || 'x'",
  ];
  for (const expr of HOSTILE) {
    it(`flags \${{ ${expr} }}`, () => {
      const f = scanWorkflowText(workflow(`echo "\${{ ${expr} }}"`), 'w.yml');
      expect(f).toHaveLength(1);
      expect(f[0]?.expression).toBe(expr);
    });
  }

  const OK = [
    'matrix.shard',
    'steps.build.outcome',
    'steps.build.outputs.cmd',
    'github.workspace',
    'github.repository',
    'github.event_name',
    'github.run_id',
    'github.sha',
    'secrets.TOKEN',
    'env.X',
  ];
  for (const expr of OK) {
    it(`does not flag \${{ ${expr} }} (not outside-controlled text)`, () => {
      expect(scanWorkflowText(workflow(`echo "\${{ ${expr} }}"`), 'w.yml')).toEqual([]);
    });
  }

  it('does not flag the same expressions in env:, with:, if: (where they are safe)', () => {
    const text = [
      'name: t',
      'on: pull_request',
      'jobs:',
      '  j:',
      "    if: github.event_name == 'pull_request'",
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: s',
      "        if: github.head_ref != ''",
      '        env:',
      '          HEAD: ${{ github.head_ref }}',
      '          TITLE: ${{ github.event.pull_request.title }}',
      '        run: echo "$HEAD $TITLE"',
      '',
    ].join('\n');
    expect(scanWorkflowText(text, 'w.yml')).toEqual([]);
  });

  it('flags a github-script `script:` body', () => {
    const text = [
      'name: t',
      'on: pull_request',
      'jobs:',
      '  j:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/github-script@0000000000000000000000000000000000000000 # v7.0.0',
      '        with:',
      '          script: |',
      '            core.info("${{ github.event.pull_request.title }}")',
      '',
    ].join('\n');
    expect(scanWorkflowText(text, 'w.yml')).toHaveLength(1);
  });

  it('tolerates a reusable-workflow call (no steps) but fails closed on unreadable shapes', () => {
    const call = [
      'name: t',
      'on: push',
      'jobs:',
      '  j:',
      '    uses: ./.github/workflows/x.yml',
      '',
    ];
    expect(scanWorkflowText(call.join('\n'), 'w.yml')).toEqual([]);
    expect(() => scanWorkflowText('jobs: [', 'w.yml')).toThrow(/w\.yml/);
    expect(() => scanWorkflowText('jobs:\n  j:\n    steps: nope\n', 'w.yml')).toThrow(/steps/);
    expect(() => scanWorkflowText('jobs: nope\n', 'w.yml')).toThrow(/jobs/);
  });

  const workflows = discoverWorkflowFiles(REPO_ROOT);
  it('discovers the repo workflows — a vacuous scan fails', () => {
    expect(workflows.length).toBeGreaterThan(10);
    expect(workflows).toContain('.github/workflows/ci.yml');
  });
  for (const rel of workflows) {
    it(`${rel} puts no event data, ref name or input inside a script body`, () => {
      expect(scanWorkflowFile(REPO_ROOT, rel)).toEqual([]);
    });
  }
});

// ── 3. behaviour: the real Deploy step under hostile input ────────────────────

type Step = { name?: string; run?: string; env?: Record<string, string> };
type ActionDoc = {
  inputs: Record<string, { default?: string }>;
  runs: { steps: Step[] };
};

const scratch = mkdtempSync(join(tmpdir(), 'action-injection-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const actionDoc = (rel: string): ActionDoc =>
  parse(readFileSync(resolve(REPO_ROOT, rel), 'utf8')) as ActionDoc;

/** A fake `npx` that records its argv, one NUL-separated file per call. */
function fakeBin(dir: string, calls: string): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(calls, { recursive: true });
  const body = [
    '#!/bin/sh',
    `f="$(mktemp "${calls}/call.XXXXXX")"`,
    'printf "%s\\0" "$@" > "$f"',
    // `status --json` is piped to jq by the action; give it something valid.
    'case "$1$2$3" in *status*--json*) echo \'{"url":"https://x.example"}\' ;; esac',
    '',
  ].join('\n');
  for (const name of ['npx']) {
    const p = join(bin, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }
  return bin;
}

type RunResult = { status: number; out: string; sentinel: boolean; argv: string[][] };
let seq = 0;

/**
 * Execute the step named `Deploy` of `rel` the way the runner would: evaluate its
 * `env:` expressions to the supplied inputs (falling back to the declared
 * defaults), then hand the UNMODIFIED `run:` text to bash.
 */
function runStep(rel: string, stepName: string, inputs: Record<string, string>): RunResult {
  const doc = actionDoc(rel);
  const step = doc.runs.steps.find((s) => s.name === stepName);
  if (!step?.run) throw new Error(`${rel}: no ${stepName} step`);

  const dir = join(scratch, `run${seq++}`);
  const calls = join(dir, 'calls');
  const sentinel = join(dir, 'PWNED');
  mkdirSync(dir, { recursive: true });
  const bin = fakeBin(dir, calls);

  // A declared default may itself be an expression (`tag` defaults to the commit SHA).
  const SHA = 'a'.repeat(40);
  const resolveInput = (name: string): string =>
    name in inputs
      ? (inputs[name] as string)
      : String(doc.inputs[name]?.default ?? '').replace(/\$\{\{\s*github\.sha\s*\}\}/g, SHA);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.env ?? {})) {
    env[k] = String(v).replace(/\$\{\{\s*inputs\.([\w-]+)\s*\}\}/g, (_, n: string) =>
      resolveInput(n),
    );
  }
  // Anything left is a context we do not model; the step must not need it.
  const run = String(step.run).replace(/\$\{\{[\s\S]*?\}\}/g, '');
  // The scan guarantees none of that was an input; this is the belt to its braces.
  expect(String(step.run)).not.toMatch(/\$\{\{\s*inputs\./);

  const proc = Bun.spawnSync(['bash', '-c', run], {
    cwd: dir,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      GITHUB_OUTPUT: join(dir, 'gh_output'),
      GITHUB_STEP_SUMMARY: join(dir, 'gh_summary'),
      ...env,
    },
  });
  const argv = existsSync(calls)
    ? readdirSync(calls)
        .sort()
        .map((f) => readFileSync(join(calls, f), 'utf8').split('\0').slice(0, -1))
    : [];
  return {
    status: proc.exitCode ?? -1,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    sentinel: existsSync(sentinel),
    argv,
  };
}

const runDeploy = (rel: string, inputs: Record<string, string>): RunResult =>
  runStep(rel, 'Deploy', inputs);

const payloadsFor = (dir: string): string[] => {
  const s = join(dir, 'PWNED');
  return [
    `x";touch ${s};#`,
    `$(touch ${s})`,
    `\`touch ${s}\``,
    `a;touch ${s}`,
    `a\ntouch ${s}`,
    `a" ]; touch ${s}; #`,
    `a'; touch ${s}; '`,
    `\${IFS}$(touch\${IFS}${s})`,
  ];
};

/** Run once with a throwaway payload only to learn the scratch dir it will use. */
const nextDir = (): string => join(scratch, `run${seq}`);

const DEPLOYS = [
  {
    rel: ACTION,
    required: { namespace: 'ns', registry: 'ghcr.io/acme' },
    // The inputs the Deploy step reads that carry free text.
    free: ['tag', 'bucket', 'namespace', 'registry', 'cli-version', 'cli'],
    bools: ['skip-upload', 'skip-build', 'dry-run', 'doctor'],
  },
  {
    rel: ROOT_ACTION,
    required: { namespace: 'ns', registry: 'ghcr.io/acme' },
    free: ['tag', 'bucket', 'namespace', 'registry'],
    bools: ['skip-upload', 'dry-run'],
  },
];

for (const d of DEPLOYS) {
  describe(`${d.rel} — hostile input to the Deploy step (#2531)`, () => {
    const declared = Object.keys(actionDoc(d.rel).inputs);
    for (const name of d.free.filter((n) => declared.includes(n))) {
      it(`input '${name}': no payload ever executes`, () => {
        // `cli` is intentionally a command (split into words, never evaluated).
        for (let i = 0; i < payloadsFor(nextDir()).length; i++) {
          const payload = payloadsFor(nextDir())[i] as string;
          const r = runDeploy(d.rel, { ...d.required, 'dry-run': 'true', [name]: payload });
          expect(r.sentinel).toBe(false);
          // If the step ran the CLI, the value arrived as ONE literal argv entry
          // (or not at all) — never split, never evaluated.
          for (const call of r.argv)
            for (const a of call)
              expect(a === payload || !a.includes('PWNED') || name === 'cli').toBe(true);
        }
      });
    }
    for (const name of d.bools.filter((n) => declared.includes(n))) {
      it(`input '${name}': a payload is neither executed nor treated as true`, () => {
        for (let i = 0; i < payloadsFor(nextDir()).length; i++) {
          const payload = payloadsFor(nextDir())[i] as string;
          const r = runDeploy(d.rel, { ...d.required, [name]: payload });
          expect(r.sentinel).toBe(false);
        }
      });
    }

    it('a tag carrying quote, command substitution and semicolon is refused before the CLI runs', () => {
      const dir = nextDir();
      const payload = `x";$(touch ${join(dir, 'PWNED')});#`;
      const r = runDeploy(d.rel, { ...d.required, tag: payload, 'dry-run': 'true' });
      expect(r.sentinel).toBe(false);
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/::error::.*tag/);
      // The error must not echo the hostile value back into the log.
      expect(r.out).not.toContain('PWNED');
      expect(r.argv.flat()).not.toContain('deploy');
    });

    it('a bucket carrying quote, command substitution and semicolon is refused before the CLI runs', () => {
      const dir = nextDir();
      const payload = `x";$(touch ${join(dir, 'PWNED')});#`;
      const r = runDeploy(d.rel, { ...d.required, bucket: payload, 'dry-run': 'true' });
      expect(r.sentinel).toBe(false);
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/::error::.*bucket/);
      expect(r.out).not.toContain('PWNED');
    });

    it('rejects a tag or bucket that begins with a dash (would read as a CLI flag)', () => {
      for (const bad of [{ tag: '--force' }, { bucket: '--endpoint=x' }] as Record<
        string,
        string
      >[]) {
        const r = runDeploy(d.rel, { ...d.required, 'dry-run': 'true', ...bad });
        expect(r.status).not.toBe(0);
        expect(r.argv.flat()).not.toContain('deploy');
      }
    });

    it('a valid tag and bucket reach the CLI as literal argv entries', () => {
      const r = runDeploy(d.rel, {
        ...d.required,
        tag: 'v1.2.3-rc.1_build',
        bucket: 'acme-assets.eu_1',
        'dry-run': 'true',
      });
      expect(r.status).toBe(0);
      const deploy = r.argv.find((c) => c.includes('--tag'));
      expect(deploy).toBeDefined();
      const at = (flag: string) => (deploy as string[])[(deploy as string[]).indexOf(flag) + 1];
      expect(at('--tag')).toBe('v1.2.3-rc.1_build');
      expect(at('--bucket')).toBe('acme-assets.eu_1');
    });

    it('an empty tag and bucket are simply omitted', () => {
      const r = runDeploy(d.rel, { ...d.required, tag: '', bucket: '', 'dry-run': 'true' });
      expect(r.status).toBe(0);
      const flat = r.argv.flat();
      expect(flat).not.toContain('--tag');
      expect(flat).not.toContain('--bucket');
    });
  });
}

// ── 3b. an error message never echoes an input ────────────────────────────────

describe('workflow commands cannot be forged through an error message (#2531)', () => {
  it('no ::error:: / ::warning:: / ::notice:: line in any action expands an input variable', () => {
    let seen = 0;
    for (const rel of discoverActionFiles(REPO_ROOT)) {
      for (const step of actionDoc(rel).runs.steps) {
        for (const line of String(step.run ?? '').split('\n')) {
          if (!/::(error|warning|notice)(\s[^:]*)?::/.test(line)) continue;
          seen++;
          // KNEXT_* are the env-passed inputs. A newline in one of them would
          // start a new line of output, and `::set-output` or `::add-mask` there
          // is a workflow command.
          expect(line, `${rel}: ${line.trim()}`).not.toMatch(/\$\{?KNEXT_/);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  const NEWLINE_COMMAND = 'x\n::set-output name=pwned::1\n::add-mask::y';

  it("an unknown 'auth' value with a newline is refused without being echoed", () => {
    const r = runStep(ACTION, 'Configure cluster access', { auth: NEWLINE_COMMAND });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/::error::unknown auth mode/);
    expect(r.out).not.toContain('set-output');
    expect(r.out).not.toContain('add-mask');
  });

  it("a 'cli' value with a newline that names no executable is refused without being echoed", () => {
    const r = runStep(ACTION, 'Deploy', {
      namespace: 'ns',
      registry: 'ghcr.io/acme',
      cli: `no-such-binary-2531${NEWLINE_COMMAND}`,
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/::error::the 'cli' input's executable/);
    expect(r.out).not.toContain('set-output');
    expect(r.out).not.toContain('add-mask');
  });
});

// ── 4. the CLI the action runs is pinned ──────────────────────────────────────

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

describe('the CLI an action runs through npx is pinned (#2531)', () => {
  it('kn-next-action exposes cli-version with an exact-semver default', () => {
    const v = actionDoc(ACTION).inputs['cli-version']?.default;
    expect(typeof v).toBe('string');
    expect(String(v)).toMatch(EXACT);
  });

  it('the published-package default is built from cli-version, not from `latest`', () => {
    const doc = actionDoc(ACTION);
    expect(doc.inputs.cli?.default ?? '').toBe('');
    const run = String(doc.runs.steps.find((s) => s.name === 'Deploy')?.run);
    expect(run).toMatch(/@getknext\/core@"?\$\{?KNEXT_CLI_VERSION\}?/);
    expect(run).not.toMatch(/npx --yes @getknext\/core(\s|$)/);
  });

  it('an invalid cli-version is refused, not handed to npx', () => {
    for (const bad of ['latest', 'next', '^1.3.0', '1.x', '1.3.1 --registry=http://evil', '']) {
      const r = runDeploy(ACTION, {
        namespace: 'ns',
        registry: 'ghcr.io/acme',
        'dry-run': 'true',
        'cli-version': bad,
      });
      expect(r.status).not.toBe(0);
      expect(r.argv.flat().join(' ')).not.toContain('evil');
      expect(r.argv.flat()).not.toContain('deploy');
    }
  });

  it('the default version is what npx is asked for', () => {
    const r = runDeploy(ACTION, { namespace: 'ns', registry: 'ghcr.io/acme', 'dry-run': 'true' });
    expect(r.status).toBe(0);
    const want = `@getknext/core@${actionDoc(ACTION).inputs['cli-version']?.default}`;
    for (const call of r.argv) expect(call).toContain(want);
  });

  it('the legacy root action pins the same version, on the same package family', () => {
    const want = String(actionDoc(ACTION).inputs['cli-version']?.default);
    const root = readFileSync(resolve(REPO_ROOT, ROOT_ACTION), 'utf8');
    const pins = [...root.matchAll(/KNEXT_CLI_PACKAGE:\s*['"]?([^\s'"]+)['"]?/g)].map((m) => m[1]);
    // Both steps that run the CLI (doctor and deploy) carry the pin.
    expect(pins.length).toBeGreaterThanOrEqual(2);
    for (const pin of pins) {
      expect(pin).toMatch(/^(@getknext\/core|kn-next)@/);
      expect(String(pin).split('@').pop()).toBe(want);
    }
  });

  it('no run: body in any tracked action invokes an unpinned npx package', () => {
    let seen = 0;
    for (const rel of discoverActionFiles(REPO_ROOT)) {
      const doc = actionDoc(rel);
      for (const step of doc.runs.steps) {
        for (const line of String(step.run ?? '').split('\n')) {
          if (line.trim().startsWith('#')) continue;
          for (const m of line.matchAll(/(?:^|[\s;|&(])npx\s+(?:--yes\s+)?(\S+)/g)) {
            seen++;
            // The package operand is an exact pin, or one of the two pinned variables
            // (each validated and tested above).
            expect(m[1]).toMatch(
              /^"?(?:(?:@getknext\/core|kn-next)@(?:\d+\.\d+\.\d+\S*|\$\{?KNEXT_CLI_VERSION\}?)|\$\{?KNEXT_CLI_PACKAGE\}?)"?\)?$/,
            );
          }
        }
      }
    }
    // A scan that found no npx at all proved nothing.
    expect(seen).toBeGreaterThan(0);
  });
});
