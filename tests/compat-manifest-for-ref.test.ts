/**
 * Run-time enforcement of the ref pin (ADR-0007 amendment 2026-11-04, bar 1).
 *
 * The runner has no notion of a ref: `get-test-filter.js` turns `suites[file].failed` into a jest
 * deselection whatever `NEXTJS_REF` is. So a per-case entry measured at v16.4.3 would also deselect
 * cases on an early-warning night at v16.3.8, where nothing measured them. This file holds the
 * filter that closes that: `scripts/compat-manifest-for-ref.mjs` writes a COPY of the manifest with
 * every ledgered `failed` list dropped unless the entry's `nextjsRef` equals `NEXTJS_REF`, and every
 * lane that runs the harness points `NEXT_EXTERNAL_TESTS_FILTERS` at that copy.
 *
 * Everything below runs the REAL script as a child process and executes the REAL workflow step text,
 * so a rename or a rewire is a red, not a silent bypass.
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseName, REF_PINNED_FILE_CAP } from '../scripts/lib/ref-pinned-cases.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts/compat-manifest-for-ref.mjs');
const MANIFEST = resolve(ROOT, 'test/deploy-tests-manifest.knext.json');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'knext-scope-'));
  tmpDirs.push(d);
  return d;
}

import { afterAll } from 'bun:test';

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

type Manifest = {
  suites: Record<string, { failed?: string[]; flakey?: string[] }>;
  rules: { include: string[]; exclude: string[] };
  $knextRefPinnedCases: {
    test: string;
    nextjsRef: string;
    cases: { path: string[]; title: string }[];
  }[];
  $knextRefPinnedScope?: { ref: string; applied: string[]; dropped: string[] };
  $knextUpstreamRuntimeDefects?: { test: string }[];
  [k: string]: unknown;
};

/**
 * The lane every run below scopes for. The script also applies the upstream-runtime-defect ledger
 * (tests/compat-upstream-runtime-defects.test.ts holds that half), which needs a lane and fails
 * closed without one; the workflows hand it the workflow-level KNEXT_RUNTIME/KNEXT_BUILDER. A
 * fixed, explicit env keeps these runs independent of whatever the test host exports. node/turbopack
 * matches no entry in that ledger, so the ref-pinned assertions here see only the ref-pinned half.
 */
const LANE_ENV = { KNEXT_RUNTIME: 'node', KNEXT_BUILDER: 'turbopack' } as const;

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...LANE_ENV },
  });
}

function scope(ref: string | null, manifestPath = MANIFEST) {
  const out = join(tmp(), 'scoped.json');
  const args = ['--manifest', manifestPath, '--out', out];
  if (ref !== null) args.push('--ref', ref);
  const r = run(args);
  return {
    r,
    out,
    scoped: existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Manifest) : null,
  };
}

const real = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
const ledgered = real.$knextRefPinnedCases.map((e) => e.test);
const PINNED = real.$knextRefPinnedCases[0].nextjsRef;

describe('compat-manifest-for-ref — the filter, on the real script and the real manifest', () => {
  it('at the pinned ref every ledgered failed list is kept verbatim', () => {
    const { r, scoped } = scope(PINNED);
    expect(r.status).toBe(0);
    for (const e of real.$knextRefPinnedCases) {
      expect(scoped?.suites[e.test]?.failed).toEqual(real.suites[e.test].failed);
    }
    expect(scoped?.$knextRefPinnedScope).toMatchObject({ ref: PINNED, dropped: [] });
    expect(scoped?.$knextRefPinnedScope?.applied.sort()).toEqual([...ledgered].sort());
  });

  it('at ANY other ref every ledgered failed list is dropped, so those cases RUN', () => {
    for (const other of ['v16.3.8', 'v16.2.0', 'v16.4.4', 'v16.5.0-canary.3']) {
      const { r, scoped } = scope(other);
      expect(r.status, `${other}: ${r.stderr}`).toBe(0);
      for (const f of ledgered) {
        expect(scoped?.suites[f]?.failed, `${other}: ${f}`).toBeUndefined();
      }
      expect(scoped?.$knextRefPinnedScope?.dropped.sort()).toEqual([...ledgered].sort());
    }
  });

  it('touches nothing but the ledgered failed lists: upstream mirror, flakey and rules are byte-identical', () => {
    const { scoped } = scope('v16.3.8');
    const ledgerSet = new Set(ledgered);
    for (const [f, s] of Object.entries(real.suites)) {
      if (ledgerSet.has(f)) continue;
      expect(scoped?.suites[f], f).toEqual(s);
    }
    expect(scoped?.rules).toEqual(real.rules);
    expect(scoped?.version).toBe(2);
  });

  it('does not rewrite the source manifest', () => {
    const before = readFileSync(MANIFEST, 'utf8');
    scope('v16.3.8');
    expect(readFileSync(MANIFEST, 'utf8')).toBe(before);
  });

  it('drops only the names the ledger records: a flakey list on the same file survives', () => {
    const dir = tmp();
    const m = JSON.parse(JSON.stringify(real)) as Manifest;
    const f = ledgered[0];
    m.suites[f] = { ...m.suites[f], flakey: ['a flakey case'] };
    const p = join(dir, 'm.json');
    writeFileSync(p, JSON.stringify(m));
    const { scoped } = scope('v16.3.8', p);
    expect(scoped?.suites[f]).toEqual({ flakey: ['a flakey case'] });
  });

  it('keeps an unledgered name on a ledgered file (only recorded names are dropped)', () => {
    const dir = tmp();
    const m = JSON.parse(JSON.stringify(real)) as Manifest;
    const f = ledgered[0];
    m.suites[f] = { failed: [...(m.suites[f].failed ?? []), 'a name the ledger never recorded'] };
    const p = join(dir, 'm.json');
    writeFileSync(p, JSON.stringify(m));
    const { scoped } = scope('v16.3.8', p);
    expect(scoped?.suites[f]?.failed).toEqual(['a name the ledger never recorded']);
    expect(caseName(m.$knextRefPinnedCases[0].cases[0])).toBeTruthy();
  });

  it('passes a manifest with no ledger through unchanged (old rc tags, upstream-only manifests)', () => {
    const dir = tmp();
    const m = JSON.parse(JSON.stringify(real)) as Manifest;
    delete (m as Record<string, unknown>).$knextRefPinnedCases;
    const p = join(dir, 'old.json');
    writeFileSync(p, JSON.stringify(m));
    const { r, scoped } = scope('v16.3.8', p);
    expect(r.status).toBe(0);
    expect(scoped?.suites).toEqual(m.suites);
  });
});

describe('compat-manifest-for-ref — FAIL CLOSED', () => {
  it.each([
    ['a missing --ref', null],
    ['an empty ref', ''],
    ['a branch name', 'main'],
    ['a partial version', 'v16.4'],
    ['a bare number with no v', '16.4.3'],
    ['a ref with shell syntax', 'v16.4.3; rm -rf /'],
  ])('%s exits non-zero and writes nothing', (_label, ref) => {
    const { r, out } = scope(ref as string | null);
    expect(r.status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  it('a ledger entry with no parseable nextjsRef exits non-zero and writes nothing', () => {
    const dir = tmp();
    const m = JSON.parse(JSON.stringify(real)) as Manifest;
    delete (m.$knextRefPinnedCases[0] as Record<string, unknown>).nextjsRef;
    const p = join(dir, 'm.json');
    writeFileSync(p, JSON.stringify(m));
    const { r, out } = scope(PINNED, p);
    expect(r.status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  it('an unparseable or missing manifest exits non-zero and writes nothing', () => {
    const dir = tmp();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    expect(scope(PINNED, bad).r.status).not.toBe(0);
    expect(existsSync(scope(PINNED, bad).out)).toBe(false);
    expect(scope(PINNED, join(dir, 'missing.json')).r.status).not.toBe(0);
  });

  it('a ledger that is not an array exits non-zero', () => {
    const dir = tmp();
    const m = JSON.parse(JSON.stringify(real)) as Record<string, unknown>;
    m.$knextRefPinnedCases = { oops: true };
    const p = join(dir, 'm.json');
    writeFileSync(p, JSON.stringify(m));
    expect(scope(PINNED, p).r.status).not.toBe(0);
  });

  it('a stale output file is removed when the run fails, so a failed filter cannot leave a usable copy', () => {
    const out = join(tmp(), 'scoped.json');
    writeFileSync(out, '{"stale":true}');
    const r = run(['--manifest', MANIFEST, '--out', out, '--ref', 'main']);
    expect(r.status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });
});

// ── The workflow wiring: every lane that runs the harness reads the SCOPED copy. ──────────────

type Step = {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  'working-directory'?: string;
  if?: string;
};
type Workflow = { jobs: Record<string, { steps: Step[] }>; env?: Record<string, string> };

// Hand-edited lanes. The v1.3 credential workflow is NOT here: it is GENERATED from the pinned rc
// tag's own test-e2e-deploy.yml, so it gains the scope step when the pin moves to a tag cut from a
// main that has it (see the v1.3 describe below).
const LANES = [
  '.github/workflows/test-e2e-deploy.yml',
  '.github/workflows/compat-vinext.yml',
] as const;
const V13_LANE = '.github/workflows/compat-credential-v1.3.yml';
/**
 * rc tags cut BEFORE the ref-pinned ledger and the scope script existed. Their manifest carries no
 * ledger, so there is nothing to scope and an unscoped read deselects nothing it should not. Verified
 * with `git show <tag>:test/deploy-tests-manifest.knext.json | grep -c RefPinnedCases` = 0 and
 * `git show <tag>:scripts/compat-manifest-for-ref.mjs` = absent. A NEW rc tag is cut from a main that
 * has the script, so it is never added here; if the pin moves and the derived workflow still has no
 * scope step, the v1.3 test below reds. DO NOT extend this list to get green: the tag was cut from the
 * wrong commit (docs/RELEASING.md, "Cutting the next v1.3 rc from `main`"); cut the next rc.
 */
const LEDGER_FREE_RC_TAGS = ['v1.0.0-rc.6', 'v1.3.0-rc.10'] as const;
const SCOPE_STEP = 'Scope ref-pinned per-case deselections to NEXTJS_REF';

function parse(rel: string): Workflow {
  return (Bun as unknown as { YAML: { parse: (s: string) => unknown } }).YAML.parse(
    read(rel),
  ) as Workflow;
}
function harness(wf: Workflow): { job: string; steps: Step[]; idx: number } {
  const hits: { job: string; steps: Step[]; idx: number }[] = [];
  for (const [job, def] of Object.entries(wf.jobs)) {
    def.steps.forEach((s, idx) => {
      if (s.env?.NEXT_TEST_MODE === 'deploy') hits.push({ job, steps: def.steps, idx });
    });
  }
  if (hits.length !== 1)
    throw new Error(`expected exactly one NEXT_TEST_MODE=deploy step, got ${hits.length}`);
  return hits[0];
}

describe('compat-manifest-for-ref — wired into every lane that runs the harness', () => {
  for (const lane of LANES) {
    describe(lane, () => {
      const wf = parse(lane);
      const { steps, idx } = harness(wf);
      const run = steps[idx];

      it('has exactly one scope step, and it runs BEFORE the harness step', () => {
        const at = steps.map((s, i) => (s.name === SCOPE_STEP ? i : -1)).filter((i) => i >= 0);
        expect(at.length).toBe(1);
        expect(at[0]).toBeLessThan(idx);
      });

      it('the harness reads the SCOPED copy, never the raw manifest', () => {
        const f = run.env?.NEXT_EXTERNAL_TESTS_FILTERS ?? '';
        expect(f).toContain('runner.temp');
        expect(f).toContain('knext-deploy-manifest.json');
        expect(f).not.toContain('deploy-tests-manifest');
        // And no other step hands the raw manifest to run-tests.js.
        for (const s of steps) {
          if (s === run) continue;
          expect(s.env?.NEXT_EXTERNAL_TESTS_FILTERS ?? '').not.toContain('deploy-tests-manifest');
        }
      });

      it('the scope step is unconditional, runs in the knext checkout and takes NEXTJS_REF from the job env', () => {
        const s = steps.find((x) => x.name === SCOPE_STEP) as Step;
        expect(s.if).toBeUndefined();
        expect(s['working-directory']).toBe('knext');
        expect(s.run).toContain('compat-manifest-for-ref.mjs');
        expect(s.run).toContain('"${NEXTJS_REF}"');
        expect(wf.env?.NEXTJS_REF).toBeTruthy();
      });

      it('writes where the harness reads', () => {
        const s = steps.find((x) => x.name === SCOPE_STEP) as Step;
        expect(s.env?.SCOPED_MANIFEST).toBe(run.env?.NEXT_EXTERNAL_TESTS_FILTERS);
      });
    });
  }
});

describe('compat-manifest-for-ref — the v1.3 credential lane (generated from the pinned rc tag)', () => {
  const src = read(V13_LANE);
  const tag = src.match(/^# derived-from-tag: (\S+)$/m)?.[1] ?? '';
  const wf = parse(V13_LANE);
  const { steps, idx } = harness(wf);
  const hasScope = steps.some((s) => s.name === SCOPE_STEP);

  it('names the tag it was derived from', () => {
    expect(tag).toMatch(/^v\d+\.\d+\.\d+-rc\.\d+$/);
  });

  it('docs/RELEASING.md tells the founder to cut the rc from main, warns off the ledger-free list, and names the immutable tag rule', () => {
    const doc = read('docs/RELEASING.md');
    expect(doc).not.toMatch(/pushes the annotated `v1\.3\.X-rc\.N\+1` tag on `integration\/v1\.3`/);
    expect(doc).toMatch(/Cut it from `main`, not `integration\/v1\.3`/);
    expect(doc).toContain('Do not extend `LEDGER_FREE_RC_TAGS`');
    expect(doc).toContain('release tags (v*) immutable');
    expect(doc).toContain('v1.3.2-rc.1');
  });

  it('either carries the scope step (a tag cut from a main that has it) or runs a tag known to have no ledger', () => {
    if (hasScope) {
      const at = steps.findIndex((s) => s.name === SCOPE_STEP);
      expect(at).toBeLessThan(idx);
      expect(steps[idx].env?.NEXT_EXTERNAL_TESTS_FILTERS).toContain('knext-deploy-manifest.json');
    } else {
      expect(
        (LEDGER_FREE_RC_TAGS as readonly string[]).includes(tag),
        `${V13_LANE} is derived from ${tag}, has no scope step, and ${tag} is not a ledger-free tag: ` +
          'it would run main-side ref-pinned deselections at an unmeasured ref. Cut the rc from a main ' +
          'that has scripts/compat-manifest-for-ref.mjs and regenerate (docs/RELEASING.md).',
      ).toBe(true);
    }
  });
});

describe('compat-manifest-for-ref — the REAL step text, executed', () => {
  function stepFor(lane: string) {
    const wf = parse(lane);
    return wf.jobs[harness(wf).job].steps.find((s) => s.name === SCOPE_STEP) as Step;
  }

  function execStep(
    lane: string,
    o: {
      ref: string | undefined;
      withScript: boolean;
      manifest: object;
      lane?: { KNEXT_RUNTIME: string; KNEXT_BUILDER: string };
      /** A fake `bun` first on PATH that prints this version. */
      bun?: string;
    },
  ) {
    const s = stepFor(lane);
    const root = tmp();
    const knext = join(root, 'knext');
    mkdirSync(join(knext, 'test'), { recursive: true });
    if (o.withScript) {
      mkdirSync(join(knext, 'scripts/lib'), { recursive: true });
      copyFileSync(SCRIPT, join(knext, 'scripts/compat-manifest-for-ref.mjs'));
      for (const lib of ['ref-pinned-cases.mjs', 'upstream-runtime-defects.mjs']) {
        copyFileSync(resolve(ROOT, 'scripts/lib', lib), join(knext, 'scripts/lib', lib));
      }
    }
    const manifestName = 'deploy-tests-manifest.knext.json';
    writeFileSync(join(knext, 'test', manifestName), JSON.stringify(o.manifest));
    const sub = (v: string) =>
      v
        .replace('${{ runner.temp }}', root)
        .replace('${{ env.KNEXT_DEPLOY_MANIFEST }}', manifestName)
        .replace('${{ github.workspace }}', root);
    // KNEXT_RUNTIME/KNEXT_BUILDER stand in for the workflow-level env the real step inherits.
    let path = process.env.PATH ?? '';
    if (o.bun !== undefined) {
      const bin = join(root, 'fake-bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'bun'), `#!/bin/sh\necho ${o.bun}\n`, { mode: 0o755 });
      path = `${bin}:${path}`;
    }
    const env: Record<string, string> = { PATH: path, ...(o.lane ?? LANE_ENV) };
    for (const [k, v] of Object.entries(s.env ?? {})) env[k] = sub(String(v));
    if (o.ref !== undefined) env.NEXTJS_REF = o.ref;
    const r = spawnSync('bash', ['-c', s.run as string], { cwd: knext, env, encoding: 'utf8' });
    const out = env.SCOPED_MANIFEST;
    return {
      r,
      out,
      scoped: existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Manifest) : null,
    };
  }

  for (const lane of LANES) {
    describe(lane, () => {
      it('script present, ref differs: the ledgered deselections are gone from the copy the harness reads', () => {
        const { r, scoped } = execStep(lane, { ref: 'v16.3.8', withScript: true, manifest: real });
        expect(r.status, r.stderr).toBe(0);
        for (const f of ledgered) expect(scoped?.suites[f]?.failed).toBeUndefined();
      });
      it('script present, ref matches: they are kept', () => {
        const { r, scoped } = execStep(lane, { ref: PINNED, withScript: true, manifest: real });
        expect(r.status, r.stderr).toBe(0);
        for (const f of ledgered) expect(scoped?.suites[f]?.failed?.length).toBeGreaterThan(0);
      });
      it('NEXTJS_REF unset FAILS the step and leaves no usable copy', () => {
        const { r, out } = execStep(lane, { ref: undefined, withScript: true, manifest: real });
        expect(r.status).not.toBe(0);
        expect(existsSync(out)).toBe(false);
      });
      it('NEXTJS_REF empty or not a version FAILS the step', () => {
        for (const ref of ['', 'main']) {
          const { r, out } = execStep(lane, { ref, withScript: true, manifest: real });
          expect(r.status, ref).not.toBe(0);
          expect(existsSync(out)).toBe(false);
        }
      });
      it('script ABSENT (an rc tag cut before it existed) and a ledger present FAILS closed', () => {
        const { r, out } = execStep(lane, { ref: 'v16.3.8', withScript: false, manifest: real });
        expect(r.status).not.toBe(0);
        expect(existsSync(out)).toBe(false);
      });
      it('script ABSENT and no ledger passes the manifest through (nothing could be deselected)', () => {
        const old = JSON.parse(JSON.stringify(real)) as Record<string, unknown>;
        delete old.$knextRefPinnedCases;
        const { r, scoped } = execStep(lane, { ref: 'v16.3.8', withScript: false, manifest: old });
        expect(r.status, r.stderr).toBe(0);
        expect(scoped).toEqual(old as unknown as Manifest);
      });
    });
  }

  // The upstream-runtime-defect half of the same step (ADR-0007 amendment 2026-11-05): the lane
  // comes from the workflow-level env the step inherits, so no workflow edit carries it.
  describe('.github/workflows/test-e2e-deploy.yml — upstream-runtime defects, by lane', () => {
    const defects = (real.$knextUpstreamRuntimeDefects ?? []) as { test: string }[];
    const BUN_TURBO = { KNEXT_RUNTIME: 'bun', KNEXT_BUILDER: 'turbopack' };
    const lane = '.github/workflows/test-e2e-deploy.yml';
    it('bun/turbopack at v16.4.3 on Bun 1.4.2: the copy the harness reads excludes both files', () => {
      const { r, scoped } = execStep(lane, {
        ref: 'v16.4.3',
        withScript: true,
        manifest: real,
        lane: BUN_TURBO,
        bun: '1.4.2',
      });
      expect(r.status, r.stderr).toBe(0);
      expect(defects.length).toBe(2);
      for (const d of defects) {
        // Whole-file entries become file exclusions, never a failed list (a jest run that filters
        // out every case exits 0 and would be credited as a passed file).
        expect(scoped?.rules.exclude).toContain(d.test);
        expect(scoped?.suites[d.test]?.failed).toBeUndefined();
      }
    });
    it.each([
      [
        'node/turbopack at v16.4.3',
        'v16.4.3',
        { KNEXT_RUNTIME: 'node', KNEXT_BUILDER: 'turbopack' },
        '1.4.2',
      ],
      [
        'bun/webpack at v16.4.3',
        'v16.4.3',
        { KNEXT_RUNTIME: 'bun', KNEXT_BUILDER: 'webpack' },
        '1.4.2',
      ],
      ['bun/turbopack at v16.3.8', 'v16.3.8', BUN_TURBO, '1.4.2'],
      ['bun/turbopack at v16.4.3 on another Bun', 'v16.4.3', BUN_TURBO, '1.4.3'],
    ])('%s: they run', (_label, ref, laneEnv, bun) => {
      const { r, scoped } = execStep(lane, {
        ref,
        withScript: true,
        manifest: real,
        lane: laneEnv,
        bun,
      });
      expect(r.status, r.stderr).toBe(0);
      for (const d of defects) {
        expect(scoped?.suites[d.test]?.failed).toBeUndefined();
        expect(scoped?.rules.exclude).not.toContain(d.test);
      }
    });
  });

  it('the cap constant is still what the ADR says (sanity that the real lib was imported)', () => {
    expect(REF_PINNED_FILE_CAP).toBe(10);
  });
});
