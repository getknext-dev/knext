/**
 * The vinext-axis compat lane (#608 / B1) — wiring guard.
 *
 * The lane runs knext's OWN corpus (`test/deploy-tests-manifest.knext.json`, the
 * selection that earned the node-standalone 778/0 credential) against a DIFFERENT
 * axis: the **compiled single executable** ADR-0048 makes the only shipped
 * artifact. Nothing else changes — same manifest, same shard count, same summary
 * and ledger machinery — so the number it publishes is comparable to the node
 * lane's by construction.
 *
 * Three properties are worth a guard, and each has a failure this repo has
 * already lived through on the node lane:
 *
 *  1. **Red-on-fail.** `.claude/rules/` treats a gate that skips rather than fails
 *     as a contradiction of "gate every feature on the official compatibility
 *     suite". A `continue-on-error:` or a conditional on the fail-on-red step
 *     turns the lane into decoration, and the first low number is exactly when
 *     the temptation to add one appears.
 *  2. **It boots the BINARY.** `compat-smoke` boots `bun .output/server/index.mjs`
 *     — the UNCOMPILED nitro output — which misses the two divergences the
 *     compiled artifact actually has: sharp's addon must be `dlopen`ed from a real
 *     path (`vinext-compile.mjs`), and the asset root baked into the binary is the
 *     BUILD machine's tree and has to be re-derived at run time. A lane that boots
 *     the same uncompiled entry would publish a number about an artifact no user
 *     runs.
 *  3. **Same corpus, honestly counted.** A lane that quietly narrowed the manifest
 *     or the shard count would publish a number that looks like the node lane's
 *     and is not.
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from '../scripts/e2e-summary.mjs';

const { X_OK } = constants;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LANE = '.github/workflows/compat-vinext.yml';
const NODE_LANE = '.github/workflows/test-e2e-deploy.yml';
const DEPLOY_SCRIPT = 'scripts/e2e-deploy-vinext.sh';

const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  'continue-on-error'?: unknown;
}
interface Job {
  name?: string;
  if?: string;
  steps?: Step[];
  strategy?: { matrix?: { shard?: string[] } };
  'continue-on-error'?: unknown;
}
interface Workflow {
  on?: Record<string, unknown>;
  env?: Record<string, string>;
  jobs?: Record<string, Job>;
}

function parse(rel: string): Workflow {
  // biome-ignore lint/suspicious/noExplicitAny: the workflow schema is not modelled here
  return (Bun as any).YAML.parse(read(rel)) as Workflow;
}

const steps = (wf: Workflow): Step[] =>
  Object.values(wf.jobs ?? {}).flatMap((job) => job.steps ?? []);

/**
 * The shard job's `Run …` step — the one that invokes the official harness.
 *
 * Selected by `NEXT_TEST_MODE: deploy` rather than by matching `run-tests.js` in
 * the `run:` text: several steps MENTION run-tests.js in a shell comment (the
 * chromium install does, on both lanes), and the first such match is not the
 * harness invocation.
 */
function harnessStep(wf: Workflow): Step {
  const found = steps(wf).filter((s) => s.env?.NEXT_TEST_MODE === 'deploy');
  if (found.length !== 1) {
    throw new Error(`expected exactly one NEXT_TEST_MODE=deploy step, found ${found.length}`);
  }
  return found[0] as Step;
}

/** The workflow's own lines, with full-line comments removed. */
function code(rel: string): string {
  return read(rel)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

describe('the vinext-axis compat lane exists and is wired to the corpus', () => {
  it('ships as its OWN workflow file (the node credential lane is not edited)', () => {
    expect(existsSync(resolve(repoRoot, LANE))).toBe(true);
  });

  it('runs knext’s own manifest — the SAME selection the node lane runs', () => {
    const mine = harnessStep(parse(LANE)).env?.NEXT_EXTERNAL_TESTS_FILTERS ?? '';
    const theirs = harnessStep(parse(NODE_LANE)).env?.NEXT_EXTERNAL_TESTS_FILTERS ?? '';
    const manifest = 'test/deploy-tests-manifest.knext.json';
    expect(mine).toContain(manifest);
    // Not just "a manifest": the same one, so the two numbers are comparable.
    expect(mine.replace(/\$\{\{[^}]*\}\}/g, '')).toEqual(theirs.replace(/\$\{\{[^}]*\}\}/g, ''));
  });

  it('declares the same shard total as the node lane, and its matrix agrees', () => {
    const wf = parse(LANE);
    const declared = Number(wf.env?.COMPAT_SHARD_TOTAL);
    const nodeDeclared = Number(parse(NODE_LANE).env?.COMPAT_SHARD_TOTAL);
    expect(declared).toEqual(nodeDeclared);
    const shards = Object.values(wf.jobs ?? {}).flatMap((job) => job.strategy?.matrix?.shard ?? []);
    expect(shards.length).toEqual(declared);
    for (const shard of shards) expect(shard).toMatch(new RegExp(`^\\d+/${declared}$`));
  });

  it('drives the harness through the vinext deploy script, which exists and is executable', () => {
    const env = harnessStep(parse(LANE)).env ?? {};
    expect(env.NEXT_TEST_DEPLOY_SCRIPT_PATH).toContain(DEPLOY_SCRIPT);
    const path = resolve(repoRoot, DEPLOY_SCRIPT);
    expect(existsSync(path)).toBe(true);
    // The harness spawns this file directly, so a script committed without the
    // exec bit fails once per fixture, deep into a shard. `accessSync(X_OK)`
    // asks the question the spawn asks, rather than re-deriving it from a mode.
    expect(() => accessSync(path, X_OK)).not.toThrow();
  });
});

describe('the lane is red-on-fail — no skip, no swallow', () => {
  it('carries no continue-on-error anywhere', () => {
    // Two views, because either alone has a hole: the PARSED view cannot see a
    // key hiding inside a heredoc or a `run:` block, and the TEXT view cannot
    // tell a prose mention in this file's own header ("no continue-on-error")
    // from a real one. Comments are stripped from the text view for that reason.
    expect(code(LANE)).not.toContain('continue-on-error');
    const wf = parse(LANE);
    const holders: unknown[] = [
      ...Object.values(wf.jobs ?? {}).map((j) => j['continue-on-error']),
      ...steps(wf).map((s) => s['continue-on-error']),
    ].filter((v) => v !== undefined);
    expect(holders).toEqual([]);
  });

  it('has a fail-on-red gate that exits non-zero on failed/notRun/truncated', () => {
    const gate = steps(parse(LANE)).find((s) => /red results/i.test(s.name ?? ''));
    expect(gate, 'the shard job must carry a fail-on-red gate').toBeDefined();
    // `if: always()` is the ONLY admissible condition: anything else is a
    // disarm dressed as a condition.
    expect(gate?.if).toEqual('always()');
    const run = gate?.run ?? '';
    expect(run).toContain('process.exit(1)');
    for (const field of ['failed', 'notRun', 'truncated']) expect(run).toContain(field);
  });

  it('never lets the harness step’s swallowed exit become the shard verdict', () => {
    // run-tests.js's exit is deliberately swallowed (`|| true`) so the summarize
    // tail always runs; that is only safe BECAUSE the gate above exists. Assert
    // both halves together — the swallow without the gate is a silent green.
    const run = harnessStep(parse(LANE)).run ?? '';
    expect(run).toContain('|| true');
    expect(steps(parse(LANE)).some((s) => /red results/i.test(s.name ?? ''))).toBe(true);
  });
});

describe('the lane measures the COMPILED BINARY, not the uncompiled nitro output', () => {
  const script = () => read(DEPLOY_SCRIPT);

  it('compiles the vinext bundle into a single executable, in CODE and not only in prose', () => {
    // Comments are stripped first. The first version of this assertion matched
    // `vinext-compile.mjs` anywhere in the file and stayed GREEN when the whole
    // compile invocation was replaced with `if ! true` — the header comment
    // still mentioned it. A guard a mutation survives is decoration.
    const lines = script()
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'));
    const resolves = lines.filter((l) => /COMPILE_SCRIPT=.*vinext-compile\.js/.test(l));
    const invokes = lines.filter((l) => /bun run "\$\{COMPILE_SCRIPT\}"/.test(l));
    expect(resolves.length, 'the shipped compile script must be resolved').toBe(1);
    expect(invokes.length, 'and actually invoked, not merely named').toBe(1);
    // What is compiled and what is booted must be the same file — a compile
    // whose output nobody boots proves nothing.
    expect(invokes[0]).toContain('--outfile "${KNEXT_EXEC}"');
  });

  it('boots the compiled binary itself', () => {
    // The boot line must exec the compiled artifact. `KNEXT_EXEC` is the one
    // variable the script may boot; a rewrite that boots anything else fails here.
    expect(script()).toMatch(/exec\s+"\$\{KNEXT_EXEC\}"/);
  });

  it('never boots .output/server/index.mjs under a runtime — that misses the dlopen shim and the asset-root divergence', () => {
    const boots = script()
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .filter((line) => /\b(exec|bun|node)\b[^#\n]*\.output\/server\/index\.mjs/.test(line));
    expect(
      boots,
      'booting the uncompiled entry publishes a number about an artifact no user runs ' +
        '(the compiled binary dlopens sharp from a real path and re-derives its asset root)',
    ).toEqual([]);
  });
});

describe('the packed @getknext/core preflight verifies the compile script — and does so SIGPIPE-safely', () => {
  // Run 33965643199 (the vinext lane's first firing PAST the pnpm→bun fix) died
  // at "Preflight — the packed @getknext/core ships the compile script" reporting
  // the tarball ships NO dist/adapters/vinext-compile.js — while the pack log two
  // steps earlier printed `packed 3.70KB dist/adapters/vinext-compile.js`. The
  // file WAS there; the CHECK was wrong: `set -euo pipefail` + `tar tzf … | grep
  // -q P`. `grep -q` exits on its first match, closes the pipe, `tar` dies with
  // SIGPIPE (write error → 141), and `pipefail` propagates 141 as the pipeline's
  // status, so `if ! <pipeline>` reads a PRESENT file as absent and reds the lane
  // on a healthy tarball. The whole 16-shard axis skips behind a false negative.
  const preflightStep = (): Step => {
    const s = steps(parse(LANE)).find((st) => /ships the compile script/i.test(st.name ?? ''));
    if (!s) throw new Error('the compile-script preflight step must exist');
    return s;
  };

  it('still verifies the tarball carries BOTH the compile script and the sharp dlopen shim', () => {
    // Both halves, so a fix that "silences" the check by deleting it reds here.
    const run = preflightStep().run ?? '';
    expect(run).toContain('dist/adapters/vinext-compile.js');
    expect(run).toContain('dist/adapters/sharp-addon-dlopen');
  });

  it('does not gate that check on a `tar … | grep -q` pipeline under pipefail', () => {
    const run = preflightStep().run ?? '';
    // Bash comments are literal text in a `run:` block, so the explanatory
    // comment above the fix (which QUOTES the fragile pattern) is part of this
    // string — strip full-line comments before matching, exactly as `code()` does.
    const executable = run
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    const usesPipefail = /\bpipefail\b/.test(executable);
    // `tar t…f … | grep -q …` — the producer left to SIGPIPE.
    const fragile = /\btar\s+t[a-z]*f\b[^\n|]*\|\s*grep\s+-[a-zA-Z]*q\b/.test(executable);
    expect(
      fragile && usesPipefail,
      'the compile-script preflight materialises `tar … | grep -q` under `set -o pipefail`: ' +
        'grep -q SIGPIPEs tar and pipefail reads that as "file absent". List into a variable ' +
        '(or a temp file) and search THAT, so there is no upstream producer to SIGPIPE.',
    ).toBe(false);
  });
});

describe('the compile-script preflight, RUN as shell against synthetic tarballs', () => {
  // A YAML-text guard cannot tell a correct `case` from one whose arms are
  // swapped (present → error, absent → pass). Execute the ACTUAL step script so
  // an inverted arm reds here: build a real getknext-core tarball with/without
  // each required entry and assert the exit code the arm produces.
  const preflightRun = (): string => {
    const s = steps(parse(LANE)).find((st) => /ships the compile script/i.test(st.name ?? ''));
    if (!s?.run) throw new Error('the compile-script preflight step must exist with a run block');
    return s.run;
  };

  /** Pack a getknext-core-*.tgz under a fresh GITHUB_WORKSPACE/knext-tarballs. */
  function makeWorkspace(entries: string[]): string {
    const ws = mkdtempSync(join(tmpdir(), 'vinext-preflight-ws-'));
    const tarballs = join(ws, 'knext-tarballs');
    const stage = join(ws, 'stage', 'package');
    mkdirSync(tarballs, { recursive: true });
    for (const rel of entries) {
      const abs = join(stage, rel);
      mkdirSync(dirname(abs), { recursive: true });
      // Content is irrelevant — the preflight lists names, never reads bytes.
      spawnSync('bash', ['-c', `printf 'x' > "${abs}"`]);
    }
    // `package/…` is the npm/bun tarball prefix the preflight greps for.
    const pack = spawnSync(
      'tar',
      ['czf', join(tarballs, 'getknext-core-0.0.0.tgz'), '-C', join(ws, 'stage'), 'package'],
      { encoding: 'utf8' },
    );
    if (pack.status !== 0) throw new Error(`tar failed: ${pack.stderr}`);
    return ws;
  }

  function runPreflight(entries: string[]): { status: number | null; stderr: string } {
    const ws = makeWorkspace(entries);
    try {
      const r = spawnSync('bash', ['-c', preflightRun()], {
        env: { ...process.env, GITHUB_WORKSPACE: ws },
        encoding: 'utf8',
        timeout: 30000,
      });
      return { status: r.status, stderr: `${r.stderr}` };
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }

  const COMPILE = 'dist/adapters/vinext-compile.js';
  const SHIM = 'dist/adapters/sharp-addon-dlopen.source.mjs';

  it('exits 0 when BOTH the compile script and the sharp shim are present (the SIGPIPE regression’s scenario)', () => {
    // This is exactly the tarball run 33965643199 had — a healthy one the old
    // `tar | grep -q` under pipefail reddened. The fixed `case` must pass it.
    const r = runPreflight([COMPILE, SHIM]);
    expect(r.status, `preflight rejected a healthy tarball: ${r.stderr}`).toBe(0);
  });

  it('exits non-zero, naming the cause, when the compile script is MISSING', () => {
    const r = runPreflight([SHIM]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('vinext-compile.js');
  });

  it('exits non-zero, naming the cause, when the sharp dlopen shim is MISSING', () => {
    const r = runPreflight([COMPILE]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('sharp-addon-dlopen');
  });
});

describe('the lane publishes its number where the node lane publishes', () => {
  const wf = () => parse(LANE);

  it('uploads a per-shard summary artifact', () => {
    const upload = steps(wf()).find(
      (s) => s.uses?.includes('actions/upload-artifact') && /summary/i.test(String(s.with?.name)),
    );
    expect(upload).toBeDefined();
    expect(upload?.if).toEqual('always()');
  });

  it('builds and uploads a run ledger with the shared, unit-tested script', () => {
    const all = steps(wf());
    expect(all.some((s) => (s.run ?? '').includes('scripts/compat-run-ledger.mjs'))).toBe(true);
    expect(
      all.some(
        (s) => s.uses?.includes('actions/upload-artifact') && /ledger/i.test(String(s.with?.name)),
      ),
    ).toBe(true);
  });

  it('attributes every summary to the vinext BUILDER, so its number is never read as the node one', () => {
    const summarizeStep = steps(wf()).find((s) => (s.run ?? '').includes('e2e-summary.mjs'));
    expect(summarizeStep?.run).toContain('--builder vinext');
  });

  it('alerts under its own issue title — never the node credential’s', () => {
    const alert = steps(wf()).find((s) => (s.run ?? '').includes('gh issue'));
    expect(alert, 'a scheduled red must open an issue, or the lane decays silently').toBeDefined();
    expect(alert?.run).toContain('vinext');
    expect(alert?.run).not.toContain('Compat nightly RED');
  });
});

describe('summarize() carries the builder axis', () => {
  const meta = { ref: 'v16.2.0', shard: '1/16', excluded: 0, expectedTotal: 1 };

  it('records builder: vinext when the lane declares it', () => {
    const s = summarize('test/e2e/x.test.ts finished on retry 1/3 in 1s', {
      ...meta,
      builder: 'vinext',
    });
    expect(s.builder).toEqual('vinext');
  });

  it('omits the key entirely on the node lane, keeping that artifact shape byte-stable', () => {
    const s = summarize('test/e2e/x.test.ts finished on retry 1/3 in 1s', meta);
    // `Object.prototype.hasOwnProperty.call`, not `Object.hasOwn`: the root
    // typecheck gate's lib does not guarantee es2022, where `Object.hasOwn`
    // lands (TS2550). biome-ignore is required BOTH ways — its autofix would
    // rewrite this back to `Object.hasOwn` and re-break the typecheck.
    // biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn is es2022; the typecheck lib does not guarantee it (TS2550)
    expect(Object.prototype.hasOwnProperty.call(s, 'builder')).toBe(false);
  });
});
