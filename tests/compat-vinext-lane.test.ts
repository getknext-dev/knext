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
  env?: Record<string, string>;
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
 * Every value `KNEXT_COMPILE` is bound to anywhere in the workflow — workflow
 * env, job env, step env, and step `with:`. The deploy script's default is
 * COMPILED; `KNEXT_COMPILE=0` is the diagnostic uncompiled-boot toggle, and the
 * lane must never carry it, or it would publish an ADR-0048-prohibited number
 * (a compat figure measured on an artifact no user runs) with every other guard
 * green. Collect across ALL scopes rather than one, so a leak in any of them
 * reds this.
 */
function knextCompileBindings(wf: Workflow): unknown[] {
  const out: unknown[] = [];
  const push = (v: unknown) => {
    if (v !== undefined) out.push(v);
  };
  push(wf.env?.KNEXT_COMPILE);
  for (const job of Object.values(wf.jobs ?? {})) {
    push(job.env?.KNEXT_COMPILE);
    for (const step of job.steps ?? []) {
      push(step.env?.KNEXT_COMPILE);
      push(step.with?.KNEXT_COMPILE);
    }
  }
  return out;
}

/** Does a YAML scalar read as the uncompiled/off value the lane must never set? */
function isUncompiledValue(v: unknown): boolean {
  const s = String(v).trim().toLowerCase();
  return s === '0' || s === '' || s === 'false' || s === 'no' || s === 'off';
}

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

  it('runs knext’s own manifest — the SAME selection the node lane runs by default (#1301)', () => {
    const mine = harnessStep(parse(LANE)).env?.NEXT_EXTERNAL_TESTS_FILTERS ?? '';
    const manifest = 'test/deploy-tests-manifest.knext.json';
    expect(mine).toContain(manifest);
    // #1301 — the node lane's filename now flows through the
    // KNEXT_DEPLOY_MANIFEST decision (smoke-vs-credential) rather than being
    // a literal here, so a byte comparison after stripping `${{ }}`
    // expressions no longer applies. What still has to hold — the vinext
    // lane's own manifest matches the NODE LANE'S DEFAULT (non-smoke)
    // resolution — is asserted directly against the workflow source: the node
    // lane's KNEXT_DEPLOY_MANIFEST decision must resolve to this exact
    // filename outside the smoke branch.
    const nodeLaneSrc = read(NODE_LANE);
    expect(
      new RegExp(`KNEXT_DEPLOY_MANIFEST:.*'${manifest.replace('test/', '')}'`).test(nodeLaneSrc),
      "the node lane's KNEXT_DEPLOY_MANIFEST default must resolve to the same manifest the vinext lane runs",
    ).toBe(true);
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

/**
 * #1294 — the fingerprint step must hash THIS workflow file, not the node
 * lane's. Before this, `compat-window-fingerprint.mjs` hardcoded
 * `.github/workflows/test-e2e-deploy.yml` as its only `harness` workflow
 * entry, so an edit here never moved the digest a credential night would
 * eventually record for this cell (ADR-0056 D3).
 */
describe("the lane fingerprints ITS OWN workflow file, not the node lane's (#1294, ADR-0056 D3)", () => {
  const workflow = read(LANE);

  it('computes the fingerprint from the SAME packed tarballs the shards use', () => {
    expect(workflow).toContain('scripts/compat-window-fingerprint.mjs');
    const step = workflow.slice(workflow.indexOf('scripts/compat-window-fingerprint.mjs'));
    expect(step).toContain('knext-tarballs');
  });

  it('passes --lane bun-vinext, the CREDENTIAL_CELLS key whose workflowFile is compat-vinext.yml', () => {
    const idx = workflow.indexOf('scripts/compat-window-fingerprint.mjs');
    const step = workflow.slice(idx, idx + 900);
    expect(step).toContain('--lane bun-vinext');
  });

  it('checks out the EXECUTING workflow file at github.workflow_sha and points --workflow-file at it (ADR-0039 Amendment 1)', () => {
    expect(workflow).toContain('sparse-checkout: .github/workflows/compat-vinext.yml');
    expect(workflow).toContain('ref: ${{ github.workflow_sha }}');
    const idx = workflow.indexOf('scripts/compat-window-fingerprint.mjs');
    const step = workflow.slice(idx, idx + 900);
    expect(step).toContain('--workflow-file');
    expect(step).toContain('knext-executing/.github/workflows/compat-vinext.yml');
  });

  it('uploads the fingerprint artifact durably', () => {
    const idx = workflow.indexOf('Upload the compat-window fingerprint');
    expect(idx, 'fingerprint artifact upload missing').toBeGreaterThan(-1);
    const upload = workflow.slice(idx, idx + 400);
    expect(upload).toMatch(/retention-days:\s*90/);
  });

  // A mutation-adjacent sanity check: if this lane's fingerprint step ever
  // reverted to the node lane's `--workflow-file` target, this SCANS for it
  // rather than trusting the `--lane` flag alone — either would independently
  // catch the #1294 regression this test exists to close.
  it("does NOT point --workflow-file at the node lane's checked-out copy", () => {
    const idx = workflow.indexOf('scripts/compat-window-fingerprint.mjs');
    const step = workflow.slice(idx, idx + 900);
    expect(step).not.toContain('knext-executing/.github/workflows/test-e2e-deploy.yml');
  });

  // #1294 round 5 — same regression guard as the node lane
  // (tests/compat-window-fingerprint.test.ts): the fingerprint script
  // imports `typescript` (a root devDependency), so the workspace install
  // must run before the fingerprint step or the import fails closed with
  // Node's own module-not-found error.
  it('"Install knext deps" (the bun install that provides typescript) runs BEFORE the fingerprint step', () => {
    const installIdx = workflow.indexOf('name: Install knext deps');
    const fingerprintIdx = workflow.indexOf('name: Fingerprint the frozen compat-window set');
    expect(installIdx, 'Install knext deps step not found').toBeGreaterThan(-1);
    expect(fingerprintIdx, 'Fingerprint step not found').toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(fingerprintIdx);
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

describe('the harness runs with the retry multiplier cut, for shard completeness', () => {
  // WHY this is a guarded value, not an incidental flag: high-case-count fixtures
  // that FAIL deterministically on the vinext axis (the binary boots but never
  // serves the route, so every case burns the harness's hardcoded 60 s per-case
  // timeout) were retried 3× per file under upstream's default `retries: 2`. A
  // single ~32-case fixture at 32 × 60 s × 3 ≈ 96 min could exceed the shard cap
  // and TRUNCATE the shard, losing its number (complete=false). `--retries 0`
  // (upstream's first-class `.number('retries')` flag) drops that to one attempt
  // so every shard banks a COMPLETE result.
  //
  // This is verdict-neutral in the safe direction: a deterministic failure fails
  // on attempt 1 regardless, so no red becomes green — the only movement is that a
  // genuinely-flaky pass-on-retry now books as fail, pushing the axis MORE red,
  // never softer. So it does NOT touch the red-on-fail contract (guarded above).
  it('passes --retries 0 to run-tests.js (locks the value; a bump back to the default re-truncates shards)', () => {
    const run = harnessStep(parse(LANE)).run ?? '';
    // The exact token, not just "--retries": `--retries 2` would restore the
    // 3-attempt multiplier that truncates shards, and `--retries` with no value
    // is a parse error. Lock the value.
    expect(run).toMatch(/\brun-tests\.js\b[^\n]*\s--retries 0\b/);
    // And it is on the SAME invocation as the shard split, not a stray mention.
    expect(run).toMatch(/--retries 0\b[^\n]*-g \$\{\{ matrix\.shard \}\}/);
  });

  it('does not soften the lane while cutting retries — no continue-on-error, no skip token', () => {
    // The completeness fix must not have smuggled in a softener. Re-assert the
    // red-on-fail surface locally to this change: the executable text of the
    // harness step carries no disarm, and the fail-on-red gate still exists.
    const run = harnessStep(parse(LANE)).run ?? '';
    expect(run).not.toContain('continue-on-error');
    expect(run.toLowerCase()).not.toMatch(/\bskip\b/);
    expect(code(LANE)).not.toContain('continue-on-error');
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

  it('never sets KNEXT_COMPILE=0 (or any off value) — the lane runs the COMPILED default', () => {
    // The script's `KNEXT_COMPILE=0` toggle boots the uncompiled nitro entry
    // (`exec bun "${NITRO_ENTRY}"`), which evades the literal `.output/server`
    // guard above by naming a variable instead of the path. The only remaining
    // way to flip the lane onto that path is a `KNEXT_COMPILE: '0'` in the
    // workflow env — job, step, or `with`. Scan EVERY scope: the default is
    // compiled, so ABSENT is fine; PRESENT-but-off is the prohibited state.
    const bindings = knextCompileBindings(parse(LANE));
    const off = bindings.filter(isUncompiledValue);
    expect(
      off,
      'the vinext lane sets KNEXT_COMPILE to an uncompiled/off value — it would publish ' +
        'an ADR-0048-prohibited compat number measured on the uncompiled artifact',
    ).toEqual([]);
  });

  it('the KNEXT_COMPILE scan actually catches a leaked off value (mutation proof)', () => {
    // Inject the exact leak the assertion above guards against, into a PARSED
    // fixture, and prove the scan reds. A guard a mutation survives is
    // decoration; this executes the same collector on a mutated workflow.
    const wf = parse(LANE);
    const firstJob = Object.values(wf.jobs ?? {})[0];
    expect(firstJob, 'the lane must have at least one job to mutate').toBeDefined();
    (firstJob as Job).env = { ...(firstJob?.env ?? {}), KNEXT_COMPILE: '0' };
    const off = knextCompileBindings(wf).filter(isUncompiledValue);
    expect(off).toContain('0');
    // And the real, un-mutated workflow is clean — the mutation is what reds it.
    expect(knextCompileBindings(parse(LANE)).filter(isUncompiledValue)).toEqual([]);
  });
});

describe('fixture normalization is EXPLICIT and bounded to the ESM app contract — not softening', () => {
  // The lane's honesty rests on measuring the fixture, changed only in the ways
  // a knext-vinext user's own app is already shaped. Three normalizations are
  // legitimate and NO MORE:
  //   (a) the per-fixture `vite.config.mjs` injection (already asserted above), and
  //   (b) merging `"type":"module"` into the fixture's package.json — knext's
  //       scaffolder writes it into every generated app (package.json.hbs) and the
  //       vinext build assumes ESM, so this is normalization-to-contract, the SAME
  //       class as (a). It is NOT softening: a CommonJS-app limitation is a tracked,
  //       separate gap and this axis's compat claim is scoped to ESM apps.
  //   (c) renaming a CommonJS `next.config.js` → `next.config.cjs` — a direct
  //       consequence of (b): the forced `"type":"module"` makes node read a `.js`
  //       config as ESM, breaking a fixture whose config uses `module.exports`.
  //       vinext resolves `next.config.cjs` and a `.cjs` file is CommonJS
  //       regardless of package `type`, so the rename RECONCILES the CJS config
  //       with the ESM app contract without weakening it. It renames a config
  //       file, touches no app/test source, and is gated on a CJS marker — the
  //       SAME class as (a)/(b), asserted positively and bounded below.
  // Anything BROADER — deleting failing test/spec files, rewriting fixture source,
  // narrowing the manifest — is softening the number, and must red here.
  const script = () => read(DEPLOY_SCRIPT);
  const executable = () =>
    script()
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

  it('MERGES `type:module` into the fixture package.json, in CODE and not only in prose', () => {
    // Comments are stripped first: an earlier sibling guard here stayed green
    // against a mutation because the header comment still named the thing the
    // code no longer did. Assert the mutation is a real, executed statement.
    const lines = script()
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'));
    const setsType = lines.filter((l) => /pkg\.type\s*=\s*["']module["']/.test(l));
    expect(setsType.length, 'the harness must set pkg.type="module" on the fixture').toBe(1);
  });

  it('MERGES rather than overwrites — it reads the fixture package.json before writing it', () => {
    // A merge preserves the fixture's own deps/scripts/everything else and changes
    // one key; an overwrite would test a different app. The read-before-write is
    // what makes it a merge.
    const e = executable();
    expect(e).toMatch(/readFileSync\([^)]*"utf8"\)/);
    expect(e).toContain('JSON.parse(');
    expect(e).toMatch(/writeFileSync\(/);
  });

  it('does NOT delete or rewrite fixture tests or source to force a pass', () => {
    // The only fixture mutations permitted are (a) vite.config.mjs and (b) the
    // type:module merge. Deleting a failing test file, or rewriting fixture
    // source, inflates the number by removing what it measures — the exact
    // softening the red-on-fail contract forbids. Scan for the shapes that do it.
    // The scan is broadened past the two verbs it first knew (`rm`,
    // `find … -delete`): a deletion has more shapes than those two, and #1032's
    // code review named three the enumeration missed — `unlink(Sync)`, a `: >`
    // truncate-to-empty, and `git rm`. Each removes what the lane measures.
    const e = executable();
    expect(e, 'no rm of .test/.spec files in the fixture').not.toMatch(
      /\brm\b[^\n]*\.(test|spec)\b/,
    );
    expect(e, 'no blanket removal of a fixture test/ directory').not.toMatch(
      /\brm\b[^\n]*(?:\btest\b|__tests__)\//,
    );
    expect(e, 'no find … -delete sweep over the fixture').not.toMatch(/\bfind\b[^\n]*-delete\b/);
    expect(e, 'no unlink(Sync) of .test/.spec files').not.toMatch(
      /\bunlink(?:Sync)?\b[^\n]*\.(test|spec)\b/,
    );
    expect(e, 'no `: >` truncate-to-empty of a .test/.spec file').not.toMatch(
      /:\s*>\s*[^\n]*\.(test|spec)\b/,
    );
    expect(e, 'no git rm of .test/.spec files').not.toMatch(/\bgit\s+rm\b[^\n]*\.(test|spec)\b/);
  });

  it('LIMITS per-fixture edits to the closed allowlist — a novel source rewrite or manifest narrowing reds', () => {
    // Denylist → closed allowlist (#1032 sysdesign non-blocking #2). The two
    // legitimate normalizations are asserted positively above; here we assert
    // NOTHING ELSE edits the fixture in place. The sibling scan enumerates the
    // deletion SHAPES it knows — but a novel rewrite it never listed (a `sed -i`
    // over a .tsx, a SECOND `node -e` writeFileSync into fixture source, a line
    // that narrows the shared corpus manifest) would slip straight through an
    // enumeration. Close the set rather than keep extending the denylist.
    const e = executable();

    // (1) EXACTLY ONE writeFileSync — the type:module merge. A second one is the
    // most direct way to rewrite a fixture source file from node, and the
    // positive guard above (presence, not count) cannot see it.
    const writes = e.match(/writeFileSync\(/g) ?? [];
    expect(writes.length, 'the only writeFileSync is the type:module merge').toBe(1);

    // (2) No in-place stream editor. None is needed by this script; each is a
    // fixture-source rewrite in disguise.
    expect(e, 'no sed -i in-place edit').not.toMatch(/\bsed\b[^\n]*\s-[a-zA-Z]*i\b/);
    expect(e, 'no perl -i in-place edit').not.toMatch(/\bperl\b[^\n]*\s-[a-zA-Z]*i\b/);
    expect(e, 'no awk -i in-place edit').not.toMatch(/\bawk\b[^\n]*-i\b/);

    // (3) No shell redirection into a fixture SOURCE file. The only redirects
    // this script makes are into knext artifacts (`.log`) and the one `.mjs`
    // vite config (asserted above); `> src/x.tsx` is a source rewrite.
    expect(e, 'no shell redirect into a fixture .ts/.tsx/.js/.jsx/.cjs source').not.toMatch(
      />>?\s*"?[^"\n;|&<>\s]*\.(tsx?|jsx?|cjs)\b/,
    );

    // (4) The deploy script must NOT touch the shared corpus manifest — narrowing
    // it here would inflate the number while still looking like the node lane's.
    expect(e, 'the deploy script never references the corpus manifest').not.toMatch(/manifest/i);

    // (5) EXACTLY ONE `mv` — the next.config.js → .cjs rename. #1042's review
    // (both reviewers) flagged that `mv` is a NEW verb the deletion-shape scan
    // above does not cover: `mv fixture/x.test.tsx /tmp` is a move-away deletion
    // that evades every check here AND the single-rename count in the CJS-gate
    // guard below. Bound the verb — the only move this script makes is the config
    // rename — so a novel `mv` reds.
    const moves = e.match(/\bmv\b/g) ?? [];
    expect(moves.length, 'the only mv is the next.config.js → .cjs rename').toBe(1);
    expect(e, 'the sole mv renames next.config.js → next.config.cjs, nothing else').toMatch(
      /\bmv\b[^\n]*next\.config\.js[^\n]*next\.config\.cjs/,
    );
    expect(e, 'no mv of a .test/.spec file out of the fixture').not.toMatch(
      /\bmv\b[^\n]*\.(test|spec)\b/,
    );
  });
});

describe('the lane resolves the deploy/build-time fixture failures it can (lane fidelity)', () => {
  // Five corpus fixtures fail at INSTALL/BUILD time in the vinext lane — not at
  // vinext runtime — because the knext toolchain install or the generated config
  // is missing something the node lane gets for free. Each guard below asserts the
  // lane DOES the concrete thing that recovers a fixture, comment-stripped so a
  // prose mention never satisfies it. (The babel + tsx installs are asserted in
  // vinext-toolchain-peers.test.ts; here we guard the two config-shaped fixes.)
  const script = () => read(DEPLOY_SCRIPT);
  const executable = () =>
    script()
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

  it('registers @mdx-js/rollup in the generated vite.config.mjs (mdx fixtures)', () => {
    // vinext ships no MDX loader, so an app with `.mdx` modules needs
    // @mdx-js/rollup registered in the vite config or the build dies with
    // `[vinext] Encountered MDX module … but no MDX plugin is configured`.
    // Assert the generated config both IMPORTS the plugin and PLACES it in the
    // plugins array — an import with no plugin entry is a no-op.
    const e = executable();
    expect(e, 'the generated vite config imports @mdx-js/rollup').toMatch(
      /import\s+mdx\s+from\s+["']@mdx-js\/rollup["']/,
    );
    expect(e, 'and registers mdx() as a vite plugin, enforced pre so .mdx compiles first').toMatch(
      /\.\.\.mdx\(\)/,
    );
  });

  it('resolves the webpack `~pkg` CSS-import convention in the generated vite.config.mjs', () => {
    // A Next fixture may `@import '~nprogress/nprogress.css'` — the webpack/
    // sass-loader `~` = "resolve from node_modules" convention. Next's webpack
    // build honours it; vite/rolldown does not, so the lane's build dies with
    // `[postcss] ENOENT … open '~nprogress/nprogress.css'`. A knext-vinext app
    // that used `~` imports would carry the same one-line resolve.alias — knext
    // does not emit the vite config (the CLI tells the user to bring their own,
    // vinext-build.ts), so this is userland config the lane stands in for, the
    // SAME class as the bun preset and the mdx() plugin, NOT a fixture-source
    // mutation. Inert unless an import starts with `~`. Assert the generated
    // config strips the leading `~` so vite resolves the bare specifier.
    const e = executable();
    expect(
      e,
      'the generated vite config must alias a leading `~` to the bare node_modules specifier',
    ).toMatch(/find:\s*\/\^~\/[\s\S]*replacement:\s*["']["']/);
  });

  it('renames a CommonJS next.config.js → next.config.cjs, in CODE not prose (next-config fixture)', () => {
    // The forced `type:module` (normalization (b)) makes node read a `.js`
    // next.config as ESM, breaking a fixture whose config uses `module.exports`
    // (`require is not defined in ES module scope`). The lane renames the CJS
    // config to `.cjs` — which vinext resolves and node always treats as CJS.
    const lines = script()
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'));
    const renames = lines.filter((l) =>
      /\bmv\b[^\n]*next\.config\.js[^\n]*next\.config\.cjs/.test(l),
    );
    expect(renames.length, 'the lane must rename a CJS next.config.js to .cjs exactly once').toBe(
      1,
    );
  });

  it('gates the next.config.js rename on a CJS marker anchored at statement start, and excludes ESM configs', () => {
    // Unconditionally renaming would corrupt an ESM `next.config.js` (which loads
    // fine under type:module). #1042's review (both reviewers) flagged that a bare
    // `grep -Eq 'module\.exports'` false-positives on an ESM config that merely
    // MENTIONS `module.exports` in a comment/string — it would be renamed to .cjs
    // and then fail to load. The hardened gate (a) anchors `module.exports =` at
    // statement start (a `//`-comment mention no longer matches) AND (b) negates
    // on a top-level ESM `export`/`import` statement, so a genuinely-ESM file is
    // never renamed even if it contains the literal.
    const e = executable();
    expect(
      e,
      'the CJS gate anchors module.exports at statement start (not a comment mention)',
    ).toMatch(/\^\[\[:space:\]\]\*module\\?\.exports/);
    expect(e, 'and excludes ESM configs via a negating export/import grep').toMatch(
      /!\s*grep[^\n]*(?:export|import)/,
    );
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

describe('the lane restores fixture-shipped node_modules the toolchain reify prunes', () => {
  // Fixtures like `app-dir/next-config-ts/import-from-node-modules` ship
  // `node_modules/cjs` + `node_modules/esm` and import them from next.config.ts.
  // The toolchain `npm install` reifies an ideal tree and PRUNES them
  // ("removed N packages"), so the config load fails with `Cannot find module
  // 'cjs'` and the fixture reds at build. The node lane already snapshots them
  // before its install and restores what the reify removed; the vinext lane must
  // too. Assert BOTH halves AND the ordering — removing either half, or moving
  // the restore before the install, reds this guard.
  const src = code(DEPLOY_SCRIPT);
  const iSnap = src.indexOf('NM_SNAP="$(mktemp');
  const iInstall = src.search(/npm\s+install\s+--no-audit[\s\S]*?vinext@/);
  const iRestore = src.indexOf('cp -RP "${NM_SNAP}/${entry}" "${NM_DIR}');

  it('snapshots the fixture node_modules BEFORE the toolchain install', () => {
    expect(src).toContain('nm_package_entries');
    expect(iSnap, 'no NM_SNAP snapshot in the lane').toBeGreaterThan(-1);
    expect(iInstall, 'could not locate the toolchain npm install').toBeGreaterThan(-1);
    expect(
      iSnap < iInstall,
      'the node_modules snapshot must run BEFORE the toolchain install (else it captures the pruned tree)',
    ).toBe(true);
  });

  it('restores only the entries the reify pruned, AFTER the install', () => {
    expect(iRestore, 'no restore of pruned fixture packages after the install').toBeGreaterThan(-1);
    expect(
      iRestore > iInstall,
      'the restore must run AFTER the toolchain install (that is what prunes them)',
    ).toBe(true);
    // Guarded restore: only copy back an entry the reify actually removed.
    expect(src).toMatch(/if \[ ! -e "\$\{NM_DIR\}\/\$\{entry\}" \]/);
  });
});
