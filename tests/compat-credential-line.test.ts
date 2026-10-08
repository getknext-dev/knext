import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { frozenFileSet } from '../scripts/compat-credential-freeze-guard.mjs';
import {
  CREDENTIAL_LINES,
  isLineRef,
  isLineTag,
  lineSpec,
  resolveLineCredentialRef,
} from '../scripts/compat-credential-line.mjs';
import { PIN_FILE, resolveCredentialRef } from '../scripts/compat-credential-ref.mjs';
import {
  auditLine,
  buildLineTrackerBody,
  fetchLineLedgers,
  lineGh,
  upsertLineTracker,
} from '../scripts/compat-line-tracker.mjs';
import {
  checkLineWorkflow,
  deriveLineWorkflow,
  lineGuardClosure,
  lineGuardDigests,
  lineSubstitutions,
  parseDerivedHeader,
  sha256,
  underiveLineWorkflow,
} from '../scripts/compat-line-workflow.mjs';
import {
  CREDENTIAL_RESET_LABEL,
  TRACKER_LABEL,
  TRACKER_TITLE,
} from '../scripts/compat-matrix-tracker.mjs';
import {
  fetchLedgers,
  parseCredentialCronsFromWorkflow,
  parseScheduleCrons,
} from '../scripts/compat-window-audit.mjs';
import { evaluate, exprBody } from './helpers/gha-expr';

/**
 * The parallel v1.3 credential lane (founder decision 2026-10-08): the four
 * stable node/bun × turbopack/webpack cells earn a SECOND, independent 14-night
 * window on the v1.3 RC tag while v1.0's runs on its own.
 *
 * Both halves are asserted, and both are mutation-proved by exit code in
 * `scripts/mutation-prove-compat-credential-line.mjs`:
 *
 *   A. the v1.3 lane resolves the v1.3 tag and NEVER the v1.0 tag (or main);
 *   B. the v1.0 lane is unchanged: none of the v1.3 lane's files is in the
 *      v1.0 frozen set, the v1.0 crons/pin/resolver/audit still read v1.0, and
 *      every name the two lanes could collide on (workflow name → concurrency
 *      group, alert title, reset label, tracker title/label, crons) is disjoint.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = lineSpec('v1.3');
const V10_WORKFLOW = join(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');
const V13_WORKFLOW = join(REPO_ROOT, '.github/workflows', SPEC.workflowFile);
const V13_TRACKER_WORKFLOW = join(REPO_ROOT, '.github/workflows', SPEC.trackerWorkflow);
const V13_PIN = join(REPO_ROOT, SPEC.pinFile);
const V10_PIN = join(REPO_ROOT, PIN_FILE);

const read = (p: string) => readFileSync(p, 'utf8');
const SHA_13 = '1'.repeat(40);
const SHA_10 = '0'.repeat(40);
const lsRemote = (tag: string) => ({
  sha: tag.startsWith('v1.3.') ? SHA_13 : tag.startsWith('v1.0.') ? SHA_10 : null,
});

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// ── A. the v1.3 lane resolves the v1.3 tag, never v1.0's ────────────────────

describe('A — the v1.3 resolver runs the v1.3 RC tag and refuses everything else', () => {
  const pin = (o: Record<string, unknown>) => JSON.stringify(o);

  it('resolves a pinned v1.3 RC tag to its peeled commit, as a credential night', () => {
    const r = resolveLineCredentialRef({
      line: 'v1.3',
      mode: 'credential',
      pinText: pin({ line: 'v1.3', rcTag: 'v1.3.0-rc.9' }),
      lsRemote,
    });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('resolved');
    expect(r.credential).toBe(true);
    expect(r.checkoutRef).toBe('refs/tags/v1.3.0-rc.9');
    expect(r.checkoutSha).toBe(SHA_13);
    expect(r.tag).toBe('v1.3.0-rc.9');
  });

  it('REFUSES a v1.0 tag pinned into the v1.3 pin — with no checkout target', () => {
    let called = false;
    const r = resolveLineCredentialRef({
      line: 'v1.3',
      mode: 'credential',
      pinText: pin({ line: 'v1.3', rcTag: 'v1.0.0-rc.6' }),
      lsRemote: (t: string) => {
        called = true;
        return lsRemote(t);
      },
    });
    expect(r.ok).toBe(false);
    expect(r.state).toBe('tag-off-line');
    expect(r.checkoutRef).toBeNull();
    expect(r.checkoutSha).toBeNull();
    expect(called).toBe(false);
  });

  it('REFUSES the real v1.0 pin file handed to the v1.3 lane (no `line` declared)', () => {
    const r = resolveLineCredentialRef({
      line: 'v1.3',
      mode: 'credential',
      pinText: read(V10_PIN),
      lsRemote,
    });
    expect(r.ok).toBe(false);
    expect(r.state).toBe('pin-line-mismatch');
    expect(r.checkoutSha).toBeNull();
  });

  it('the committed v1.3 pin declares the v1.3 line and an on-line RC tag', () => {
    const p = JSON.parse(read(V13_PIN));
    expect(p.line).toBe('v1.3');
    expect(isLineTag('v1.3', p.rcTag)).toBe(true);
    const r = resolveLineCredentialRef({
      line: 'v1.3',
      mode: 'credential',
      pinText: read(V13_PIN),
      lsRemote,
    });
    expect(r.ok).toBe(true);
    expect(isLineRef('v1.3', r.checkoutRef)).toBe(true);
    expect(r.checkoutSha).toBe(SHA_13);
  });

  it('a dispatch (early-warning) ALSO runs the pinned v1.3 tag — never main — and is non-credential', () => {
    const r = resolveLineCredentialRef({
      line: 'v1.3',
      mode: 'early-warning',
      pinText: pin({ line: 'v1.3', rcTag: 'v1.3.0-rc.9' }),
      lsRemote,
    });
    expect(r.ok).toBe(true);
    expect(r.credential).toBe(false);
    expect(r.state).toBe('early-warning');
    expect(r.checkoutRef).toBe('refs/tags/v1.3.0-rc.9');
    expect(r.checkoutSha).toBe(SHA_13);
  });

  it.each([
    ['pin-missing', null],
    ['pin-unreadable', '{not json'],
    ['pin-unreadable', JSON.stringify({ line: 'v1.3' })],
    ['not-cut', JSON.stringify({ line: 'v1.3', rcTag: null })],
    ['pin-malformed', JSON.stringify({ line: 'v1.3', rcTag: 'main' })],
    ['pin-malformed', JSON.stringify({ line: 'v1.3', rcTag: 'v1.3.0' })],
    ['tag-missing', JSON.stringify({ line: 'v1.3', rcTag: 'v1.3.0-rc.99' })],
  ])('refuses (%s) with no checkout target, never falling back to main', (state, pinText) => {
    const r = resolveLineCredentialRef({
      line: 'v1.3',
      mode: 'credential',
      pinText,
      lsRemote: (t: string) => ({ sha: t === 'v1.3.0-rc.99' ? null : SHA_13 }),
    });
    expect(r.ok).toBe(false);
    expect(r.state).toBe(state);
    expect(r.checkoutRef).toBeNull();
    expect(r.checkoutSha).toBeNull();
  });

  it('refuses an unknown line and an unknown mode', () => {
    const p = JSON.stringify({ line: 'v1.3', rcTag: 'v1.3.0-rc.9' });
    expect(
      resolveLineCredentialRef({ line: 'v1.0', mode: 'credential', pinText: p, lsRemote }).state,
    ).toBe('line-unknown');
    expect(
      resolveLineCredentialRef({ line: 'v1.3', mode: 'nightly', pinText: p, lsRemote }).state,
    ).toBe('mode-unknown');
  });

  it('the CLI exits non-zero on a refusal and writes EMPTY checkout outputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'line-cli-'));
    tmpDirs.push(dir);
    const pinPath = join(dir, 'pin.json');
    const out = join(dir, 'out.txt');
    writeFileSync(pinPath, JSON.stringify({ line: 'v1.3', rcTag: 'v1.0.0-rc.6' }));
    const r = spawnSync(
      process.execPath.includes('bun') ? 'node' : process.execPath,
      [
        join(REPO_ROOT, 'scripts/compat-credential-line.mjs'),
        '--line',
        'v1.3',
        '--mode',
        'credential',
        '--pin',
        pinPath,
        '--remote-dir',
        dir,
      ],
      { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out } },
    );
    expect(r.status).toBe(1);
    const outputs = read(out);
    expect(outputs).toContain('state=tag-off-line');
    expect(outputs).toContain('checkout_sha=\n');
    expect(outputs).toContain('checkout_ref=\n');
  });

  it('isLineTag/isLineRef accept only v1.3 RC tags', () => {
    expect(isLineTag('v1.3', 'v1.3.0-rc.9')).toBe(true);
    expect(isLineTag('v1.3', 'v1.3.12-rc.0')).toBe(true);
    expect(isLineTag('v1.3', 'v1.0.0-rc.6')).toBe(false);
    expect(isLineTag('v1.3', 'v1.30.0-rc.1')).toBe(false);
    expect(isLineTag('v1.3', 'v1.3.0')).toBe(false);
    expect(isLineRef('v1.3', 'refs/heads/v1.3.0-rc.9')).toBe(false);
    expect(isLineRef('v1.3', 'refs/tags/v1.3.0-rc.9')).toBe(true);
  });
});

// ── The derived workflow: the tag's OWN harness + declared substitutions ─────

describe('the v1.3 workflow is DERIVED from the tag harness, provably', () => {
  const committed = read(V13_WORKFLOW);
  // LAZY, not at describe scope: a stale or hand-edited committed file must
  // fail the tests that read the header/source BY NAME, not abort collection of
  // the whole file (the mutation prover attributes each failure to one test).
  let memo: { header: any; source: any } | undefined;
  const derived = () => {
    memo ??= {
      header: parseDerivedHeader(committed),
      source: underiveLineWorkflow(committed, { line: 'v1.3' }),
    };
    return memo;
  };

  it('round-trips: committed = derive(underive(committed)), and the recovered source matches the recorded digest', () => {
    const { header, source } = derived();
    expect(sha256(source.sourceText)).toBe(header.digest);
    expect(deriveLineWorkflow(source.sourceText, { line: 'v1.3', tag: header.tag })).toBe(
      committed,
    );
  });

  it('is derived from the tag the v1.3 pin names (bumping the pin without regenerating reds here)', () => {
    const { header } = derived();
    expect(header.tag).toBe(JSON.parse(read(V13_PIN)).rcTag);
  });

  it('checkLineWorkflow — the runtime gate — accepts exactly derive(source) and nothing else', () => {
    const { header, source } = derived();
    const tag = header.tag;
    expect(
      checkLineWorkflow({
        line: 'v1.3',
        tag,
        sourceText: source.sourceText,
        executingText: committed,
      }).ok,
    ).toBe(true);
    // A hand edit to the executing file.
    const edited = committed.replace('timeout-minutes: 5', 'timeout-minutes: 6');
    expect(edited).not.toBe(committed);
    expect(
      checkLineWorkflow({ line: 'v1.3', tag, sourceText: source.sourceText, executingText: edited })
        .ok,
    ).toBe(false);
    // A different tag's harness (the source moved; file not regenerated).
    const moved = `${source.sourceText}\n# moved\n`;
    expect(
      checkLineWorkflow({ line: 'v1.3', tag, sourceText: moved, executingText: committed }).ok,
    ).toBe(false);
    // The night resolved a different tag than the file was derived from.
    expect(
      checkLineWorkflow({
        line: 'v1.3',
        tag: 'v1.3.0-rc.10',
        sourceText: source.sourceText,
        executingText: committed,
      }).ok,
    ).toBe(false);
  });

  it('GUARD DIGESTS: the header records the sha256 of every file in the guard closure, and they match the files on disk', () => {
    const { header } = derived();
    expect(SPEC.guardEntries).toEqual([
      'scripts/compat-credential-line.mjs',
      'scripts/compat-line-workflow.mjs',
      'scripts/compat-line-tracker.mjs',
    ]);
    expect(header.guards.map(([p]: [string, string]) => p)).toEqual(lineGuardClosure(SPEC));
    expect(header.guards).toEqual(lineGuardDigests(SPEC));
    for (const [path, digest] of header.guards as [string, string][]) {
      expect(digest).toBe(sha256(read(join(REPO_ROOT, path))));
    }
  });

  it('GUARD ENTRIES: every script the line runs from main (credential-ref job + tracker workflow) is a guard entry', () => {
    // Scanned, not listed: the credential-ref job is the one job whose `knext`
    // checkout is MAIN (no `ref:`), and the tracker workflow runs on main. Any
    // script either one invokes decides a night, so it must root the closure.
    const wf = parse(committed) as any;
    const job = wf.jobs['credential-ref'];
    const mainCheckout = (job.steps as any[]).find((st) => st.with?.path === 'knext');
    expect(mainCheckout.with.ref).toBeUndefined();
    const runs = [
      ...(job.steps as any[]).map((st) => String(st.run ?? '')),
      read(V13_TRACKER_WORKFLOW),
    ].join('\n');
    // ANY script path these runs mention (not just `node <path>` — a quoted or
    // bun-run path counts too); a non-JS script cannot be an entry, so it reds.
    const invoked = new Set(
      [...runs.matchAll(/(?:knext\/)?(scripts\/[\w./-]+\.(?:mjs|cjs|js|ts|sh))/g)].map((m) => m[1]),
    );
    expect(invoked.size).toBeGreaterThanOrEqual(3);
    expect([...invoked].filter((f) => !SPEC.guardEntries.includes(f))).toEqual([]);
    expect([...SPEC.guardEntries].sort()).toEqual([...invoked].sort());
  });

  it('GUARD CLOSURE: every repo file the entries transitively import (found by a real parser) is digested', () => {
    // An INDEPENDENT walk with Bun's own parser (comments and strings are not
    // imports to it), compared against the dependency-free scan the derivation
    // uses. Scan, don't enumerate: whatever the entries import today or after a
    // future edit is in this set without anyone listing it.
    const transpiler = new Bun.Transpiler({ loader: 'js' });
    const real = new Set<string>();
    const queue: string[] = [...SPEC.guardEntries];
    while (queue.length > 0) {
      const rel = queue.shift() as string;
      if (real.has(rel)) continue;
      real.add(rel);
      // The transpiler rejects a shebang (a runtime-only line), so drop it.
      const src = read(join(REPO_ROOT, rel)).replace(/^#![^\n]*/, '');
      for (const imp of transpiler.scanImports(src)) {
        if (!imp.path.startsWith('./') && !imp.path.startsWith('../')) continue;
        const target = relative(REPO_ROOT, resolve(dirname(join(REPO_ROOT, rel)), imp.path));
        expect(target.startsWith('..'), `${rel} imports ${imp.path}, outside the repo`).toBe(false);
        queue.push(target.split(sep).join('/'));
      }
    }
    const { header } = derived();
    const digested = new Set((header.guards as [string, string][]).map(([p]) => p));
    expect([...real].filter((f) => !digested.has(f))).toEqual([]);
    expect([...real].filter((f) => !lineGuardClosure(SPEC).includes(f))).toEqual([]);
    // Non-vacuity: the closure reaches past the entries into the libraries
    // that actually grade a night.
    expect(real.size).toBeGreaterThan(SPEC.guardEntries.length);
    for (const lib of [
      'scripts/compat-window-audit.mjs',
      'scripts/compat-matrix-tracker.mjs',
      'scripts/compat-credential-ref.mjs',
    ]) {
      expect(real.has(lib), lib).toBe(true);
    }
  });

  it('GUARD CLOSURE: the scan follows imports transitively and fails closed on a computed specifier', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v13-closure-'));
    tmpDirs.push(dir);
    const put = (p: string, text: string) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    };
    const spec = { ...SPEC, guardEntries: ['scripts/entry.mjs'] };
    put('scripts/entry.mjs', "import { a } from './a.mjs';\nexport * from './lib/b.mjs';\n");
    put('scripts/a.mjs', "import './c.mjs';\nexport const a = 1;\n");
    put('scripts/lib/b.mjs', "export { d } from '../d.mjs';\n");
    put('scripts/c.mjs', "const m = await import('./e.mjs');\n");
    put('scripts/d.mjs', 'export const d = 1;\n');
    put('scripts/e.mjs', 'export {};\n');
    expect(lineGuardClosure(spec, dir)).toEqual([
      'scripts/a.mjs',
      'scripts/c.mjs',
      'scripts/d.mjs',
      'scripts/e.mjs',
      'scripts/entry.mjs',
      'scripts/lib/b.mjs',
    ]);
    // A computed specifier might be relative — refuse rather than under-report.
    put('scripts/e.mjs', 'const n = "./d.mjs";\nawait import(n);\n');
    expect(() => lineGuardClosure(spec, dir)).toThrow(/non-literal/);
    put('scripts/e.mjs', "import { createRequire } from 'node:module';\n");
    expect(() => lineGuardClosure(spec, dir)).toThrow(/node:module/);
    // A package `imports` alias can name a repo file without looking relative.
    put('scripts/e.mjs', "import { x } from '#internal/x.mjs';\n");
    expect(() => lineGuardClosure(spec, dir)).toThrow(/only relative/);
  });

  it('GUARD DIGESTS: editing ANY file in the guard closure changes the generated bytes the fingerprint hashes (window restarts); untouched is stable', () => {
    const { header, source } = derived();
    const derive = (root?: string) =>
      deriveLineWorkflow(source.sourceText, { line: 'v1.3', tag: header.tag, repoRoot: root });
    // Untouched: deterministic, and equal to the committed file.
    expect(derive()).toBe(committed);
    expect(derive()).toBe(derive());
    const closure = lineGuardClosure(SPEC);
    expect(closure.length).toBeGreaterThan(SPEC.guardEntries.length);
    for (const path of closure) {
      const dir = mkdtempSync(join(tmpdir(), 'v13-guard-'));
      tmpDirs.push(dir);
      for (const p of closure) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), read(join(REPO_ROOT, p)));
      }
      // A faithful copy derives byte-identically (the digest reads CONTENT, not location).
      expect(derive(dir)).toBe(committed);
      // A one-byte edit to exactly this file moves the derived workflow...
      writeFileSync(join(dir, path), `${read(join(REPO_ROOT, path))}\n// weakened\n`);
      const moved = derive(dir);
      expect(moved, path).not.toBe(committed);
      // ...so a committed file that was not regenerated is REFUSED at run time...
      expect(
        checkLineWorkflow({
          line: 'v1.3',
          tag: header.tag,
          sourceText: source.sourceText,
          executingText: committed,
          repoRoot: dir,
        }).ok,
        path,
      ).toBe(false);
      // ...and the regenerated file (new bytes => new fingerprint) is the only one accepted.
      expect(
        checkLineWorkflow({
          line: 'v1.3',
          tag: header.tag,
          sourceText: source.sourceText,
          executingText: moved,
          repoRoot: dir,
        }).ok,
        path,
      ).toBe(true);
    }
  });

  it('GUARD DIGESTS: a hand-edited or missing guard line in the header is refused', () => {
    const { header, source } = derived();
    const line = committed.match(/^# guard-script-sha256: .*$/m)?.[0];
    if (!line) throw new Error('no guard-script-sha256 line in the committed header');
    expect(() => parseDerivedHeader(committed.replace(`${line}\n`, ''))).toThrow();
    // Flip the last hex digit (to a DIFFERENT one, so the edit is never a no-op).
    const forged = `${line.slice(0, -1)}${line.endsWith('0') ? '1' : '0'}`;
    expect(forged).not.toBe(line);
    expect(() => parseDerivedHeader(committed.replace(line, forged))).not.toThrow(); // a different digest still PARSES...
    // ...but no longer equals what the files on disk hash to, so the run-time gate refuses it.
    expect(
      checkLineWorkflow({
        line: 'v1.3',
        tag: header.tag,
        sourceText: source.sourceText,
        executingText: committed.replace(line, forged),
      }).ok,
    ).toBe(false);
  });

  it('every substitution is anchor-exact: a missing or duplicated anchor THROWS, never derives', () => {
    const { header, source } = derived();
    const subs = lineSubstitutions(SPEC);
    expect(subs.length).toBeGreaterThan(5);
    const first = subs.find((s: { count: number }) => s.count === 1);
    if (!first) throw new Error('expected at least one single-occurrence substitution');
    const missing = source.sourceText.replace(first.from, '');
    expect(() => deriveLineWorkflow(missing, { line: 'v1.3', tag: header.tag })).toThrow();
    const doubled = `${source.sourceText}\n${first.from}`;
    expect(() => deriveLineWorkflow(doubled, { line: 'v1.3', tag: header.tag })).toThrow();
  });

  it('runs the tag harness: build-next fingerprints THIS executing file, checks out the resolved sha', () => {
    const wf = parse(committed) as any;
    const steps = wf.jobs['build-next'].steps as any[];
    const exec = steps.find((s) => s.with?.path === 'knext-executing');
    expect(exec.with['sparse-checkout']).toBe(`.github/workflows/${SPEC.workflowFile}`);
    const knext = steps.find((s) => s.with?.path === 'knext');
    expect(knext.with.ref).toBe('${{ needs.credential-ref.outputs.checkout_sha }}');
    expect(committed).toContain(
      `--workflow-file "\${GITHUB_WORKSPACE}/knext-executing/.github/workflows/${SPEC.workflowFile}"`,
    );
  });

  it('the credential-ref job resolves via the v1.3 line resolver + pin, then verifies the derivation', () => {
    const wf = parse(committed) as any;
    const steps = wf.jobs['credential-ref'].steps as any[];
    const resolveStep = steps.find((s) => s.id === 'resolve');
    expect(resolveStep.run).toContain('node knext/scripts/compat-credential-line.mjs');
    expect(resolveStep.run).toContain('--line v1.3');
    expect(resolveStep.run).toContain(`--pin knext/${SPEC.pinFile}`);
    expect(resolveStep.run).not.toContain('compat-credential-ref.mjs');
    const idx = steps.indexOf(resolveStep);
    const verify = steps[idx + 1];
    expect(verify.run).toContain('compat-line-workflow.mjs --check --line v1.3');
    expect(verify.run).toContain(`--executing knext/.github/workflows/${SPEC.workflowFile}`);
    expect(verify['continue-on-error']).toBeUndefined();
    expect(verify.if).toBeUndefined();
  });

  it('EVALUATED: exactly the four v1.3 crons are scheduled, each a credential night of its own cell', () => {
    const wf = parse(committed) as any;
    const crons = (wf.on.schedule as { cron: string }[]).map((s) => s.cron).sort();
    expect(crons).toEqual(Object.values(SPEC.cronMap as Record<string, string>).sort());
    const ev = (key: string, event: Record<string, unknown>) =>
      evaluate(exprBody(wf.env[key]), { github: { event } });
    const want: Record<string, string> = {
      '17 14 * * *': 'node',
      '47 15 * * *': 'bun',
      '17 17 * * *': 'node-webpack',
      '47 18 * * *': 'bun-webpack',
    };
    for (const [cron, lane] of Object.entries(want)) {
      expect(ev('KNEXT_COMPAT_MODE', { schedule: cron, inputs: null })).toBe('credential');
      expect(ev('KNEXT_LANE', { schedule: cron, inputs: null })).toBe(lane);
    }
    // A dispatch can never produce a credential night.
    expect(ev('KNEXT_COMPAT_MODE', { inputs: { runtime: 'bun' } })).toBe('early-warning');
    // The audit's own cron parser reads the same mapping (rule 8 calendar).
    const parsed = parseCredentialCronsFromWorkflow(committed, {
      requiredLanes: SPEC.cells.map((c: { lane: string }) => c.lane),
    });
    expect(Object.fromEntries(parsed)).toEqual({
      node: '17 14 * * *',
      bun: '47 15 * * *',
      'node-webpack': '17 17 * * *',
      'bun-webpack': '47 18 * * *',
    });
  });

  it('runs the same 16-shard x 4-cell shape and the tag-declared NEXTJS_REF', () => {
    const { source } = derived();
    const wf = parse(committed) as any;
    const v10 = parse(read(V10_WORKFLOW)) as any;
    expect(wf.env.COMPAT_SHARD_TOTAL).toBe('16');
    expect(wf.jobs['deploy-tests'].strategy.matrix.shard).toHaveLength(16);
    // NEXTJS_REF comes from the SOURCE (the tag's own YAML) untouched — no
    // substitution may rewrite it.
    expect(
      lineSubstitutions(SPEC).some((s: { from: string }) => s.from.includes('NEXTJS_REF')),
    ).toBe(false);
    expect(source.sourceText).toContain(`NEXTJS_REF: ${v10.env.NEXTJS_REF}`);
  });
});

// ── B. the v1.0 lane is unchanged ────────────────────────────────────────────

describe('B — the v1.0 lane is untouched and nothing collides with it', () => {
  const LANE_FILES = [
    SPEC.pinFile,
    `.github/workflows/${SPEC.workflowFile}`,
    `.github/workflows/${SPEC.trackerWorkflow}`,
    'scripts/compat-credential-line.mjs',
    'scripts/compat-line-workflow.mjs',
    'scripts/compat-line-tracker.mjs',
  ];

  it('no file of the v1.3 lane is in the v1.0 frozen set (frozenFileSet, derived)', () => {
    const frozen = frozenFileSet(REPO_ROOT);
    expect(frozen.size).toBeGreaterThan(10);
    expect(LANE_FILES.filter((f) => frozen.has(f))).toEqual([]);
  });

  it('the v1.0 workflow still maps its OWN four credential crons to its cells', () => {
    expect(
      Object.fromEntries(
        parseCredentialCronsFromWorkflow(read(V10_WORKFLOW), {
          requiredLanes: ['node', 'bun', 'node-webpack', 'bun-webpack'],
        }),
      ),
    ).toEqual({
      node: '17 1 * * *',
      bun: '47 5 * * *',
      'node-webpack': '17 22 * * *',
      'bun-webpack': '47 23 * * *',
    });
  });

  it('the v1.3 crons are disjoint from every v1.0 cron (offset, not shared slots)', () => {
    const v10 = parseScheduleCrons(read(V10_WORKFLOW));
    for (const c of Object.values(SPEC.cronMap)) expect(v10.has(c as string)).toBe(false);
    for (const c of Object.keys(SPEC.cronMap)) expect(v10.has(c)).toBe(true);
  });

  it('the v1.3 crons start after v1.0\u2019s measured late-start window and are spaced >= 90 min', () => {
    // MEASURED (2026-10-07/08): GitHub starts v1.0\u2019s schedules 3-7 h late EVERY
    // day \u2014 the latest v1.0 run of a day started 12:02-12:15 UTC (its 05:47
    // bun slot) and ended ~13:07. The v1.3 slots must not sit inside that.
    const minutes = (Object.values(SPEC.cronMap) as string[])
      .map((c) => {
        const [m, h] = c.split(' ').map(Number);
        return h * 60 + m;
      })
      .sort((a, b) => a - b);
    expect(minutes).toHaveLength(4);
    expect(minutes[0]).toBeGreaterThanOrEqual(14 * 60);
    for (let i = 1; i < minutes.length; i++) {
      expect(minutes[i] - minutes[i - 1]).toBeGreaterThanOrEqual(90);
    }
    // ...and the last one is still well before v1.0\u2019s first nominal slot (22:17).
    expect(minutes[3]).toBeLessThan(22 * 60 + 17 - 3 * 60);
  });

  it('the workflow names differ, so github.workflow-keyed concurrency groups never collide', () => {
    const a = parse(read(V10_WORKFLOW)) as any;
    const b = parse(read(V13_WORKFLOW)) as any;
    expect(b.name).toBe(SPEC.workflowName);
    expect(b.name).not.toBe(a.name);
    expect(b.concurrency.group).toBe(a.concurrency.group);
    const group = (wf: any) =>
      evaluate(exprBody(wf.concurrency.group), {
        github: { event_name: 'schedule', workflow: wf.name, run_id: '42', event: {} },
      });
    expect(group(b)).not.toBe(group(a));
    expect(String(group(b))).toContain('-run-42');
  });

  it('alert title, reset label and tracker title/label are disjoint from v1.0', () => {
    const committed = read(V13_WORKFLOW);
    expect(committed).toContain(`title="${SPEC.alertTitle}"`);
    expect(committed).not.toContain('title="Compat CREDENTIAL RED (${KNEXT_LANE}, RC tag)"');
    expect(committed).not.toContain(`"${CREDENTIAL_RESET_LABEL}"`);
    expect(committed).toContain(`"${SPEC.resetLabel}"`);
    expect(SPEC.resetLabel).not.toBe(CREDENTIAL_RESET_LABEL);
    expect(SPEC.trackerTitle).not.toBe(TRACKER_TITLE);
    expect(SPEC.trackerLabel).not.toBe(TRACKER_LABEL);
  });

  it('the v1.0 resolver still resolves the v1.0 pin to the v1.0 line, untouched', () => {
    const v10pin = JSON.parse(read(V10_PIN));
    expect(isLineTag('v1.3', v10pin.rcTag)).toBe(false);
    const r = resolveCredentialRef({
      mode: 'credential',
      pinText: read(V10_PIN),
      lsRemote,
    });
    expect(r.ok).toBe(true);
    expect(r.tag).toBe(v10pin.rcTag);
    expect(r.checkoutSha).toBe(SHA_10);
  });

  it('the v1.3 audit only ever lists the v1.3 workflow; the v1.0 audit only ever lists its own', () => {
    const calls: string[][] = [];
    const fakeGh = (args: string[]) => {
      calls.push(args);
      return '[]';
    };
    fetchLineLedgers('v1.3', 100, { gh: fakeGh });
    const listed = calls.filter((a) => a[0] === 'run' && a[1] === 'list');
    expect(listed).toHaveLength(1);
    expect(listed[0][listed[0].indexOf('--workflow') + 1]).toBe(SPEC.workflowFile);
    expect(listed[0]).not.toContain('test-e2e-deploy.yml');

    const v10calls: string[][] = [];
    fetchLedgers(100, {
      gh: (args: string[]) => {
        v10calls.push(args);
        return '[]';
      },
    });
    expect(v10calls[0][v10calls[0].indexOf('--workflow') + 1]).toBe('test-e2e-deploy.yml');
  });

  it('lineGh refuses an audit call shape it does not recognise rather than reading v1.0 runs', () => {
    const gh = lineGh(SPEC, () => '[]');
    expect(() => gh(['run', 'list', '--limit', '5'])).toThrow();
    expect(() =>
      gh(['run', 'list', '--workflow', 'test-e2e-deploy.yml', '--workflow', 'x.yml']),
    ).toThrow();
  });
});

// ── The line's own audit + tracker ───────────────────────────────────────────

const HHMM: Record<string, string> = {
  node: '14:17',
  bun: '15:47',
  'node-webpack': '17:17',
  'bun-webpack': '18:47',
};
let seq = 90_000_000_000;
function v13Night(lane: string, i: number, over: Record<string, unknown> = {}) {
  seq += 1;
  const runtime = lane.startsWith('bun') ? 'bun' : 'node';
  const d = new Date(`2026-01-01T${HHMM[lane]}:00.000Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return {
    runId: String(seq),
    runAttempt: '1',
    event: 'schedule',
    lane,
    ref: 'v16.3.8',
    compatMode: 'credential',
    credential: true,
    knextRef: 'refs/tags/v1.3.0-rc.9',
    knextSha: SHA_13,
    workflowSha: 'c'.repeat(40),
    complete: true,
    shardsExpected: 16,
    shardsSeen: 16,
    missingShards: [],
    windowFingerprint: `sha256:${lane}`,
    scheduledAt: d.toISOString(),
    shards: Array.from({ length: 16 }, (_, k) => ({
      shard: `${k + 1}/16`,
      passed: 40,
      failed: 0,
      notRun: 0,
      runtime: lane,
      bytecode: { runtime, deploys: 3, live: 3, notLive: 0, reasons: [] },
    })),
    ...over,
  };
}
const NOW = new Date('2026-01-15T12:00:00.000Z');
const allGreen = (): ReturnType<typeof v13Night>[] =>
  SPEC.cells.flatMap((c: { lane: string }) =>
    Array.from({ length: 14 }, (_, i) => v13Night(c.lane, i)),
  );

describe('the v1.3 audit + tracker are the line’s own', () => {
  const workflowText = read(V13_WORKFLOW);

  it('14 green on-calendar v1.3 nights per cell → every cell MET', () => {
    const a = auditLine(allGreen(), { line: 'v1.3', workflowText, now: NOW });
    for (const c of SPEC.cells) {
      expect(a.cells[c.lane].calendarChecked).toBe(true);
      expect(a.cells[c.lane].met).toBe(true);
    }
    expect(a.allMet).toBe(true);
  });

  it('a night that ran ANOTHER line’s tag (v1.0) can never bank in the v1.3 window', () => {
    const ledgers = allGreen().map((l) =>
      l.lane === 'bun' && l.scheduledAt.startsWith('2026-01-05')
        ? { ...l, knextRef: 'refs/tags/v1.0.0-rc.6', knextSha: SHA_10 }
        : l,
    );
    const a = auditLine(ledgers, { line: 'v1.3', workflowText, now: NOW });
    expect(a.cells.bun.met).toBe(false);
    expect(a.cells.bun.offLineNights.map((n: { knextRef: string }) => n.knextRef)).toEqual([
      'refs/tags/v1.0.0-rc.6',
    ]);
    // Independence: the other three cells are unaffected.
    expect(a.cells.node.met).toBe(true);
    expect(a.cells['node-webpack'].met).toBe(true);
    expect(a.allMet).toBe(false);
  });

  it('a red v1.3 night restarts only its own cell', () => {
    const ledgers = allGreen().map((l) =>
      l.lane === 'node-webpack' && l.scheduledAt.startsWith('2026-01-10')
        ? { ...l, shards: l.shards.map((s, k) => (k === 3 ? { ...s, failed: 1 } : s)) }
        : l,
    );
    const a = auditLine(ledgers, { line: 'v1.3', workflowText, now: NOW });
    expect(a.cells['node-webpack'].met).toBe(false);
    expect(a.cells.node.met).toBe(true);
    expect(a.cells.bun.met).toBe(true);
  });

  it('the tracker body is v1.3’s, lists the four cells, and never claims the v1.0 tracker', () => {
    const a = auditLine(allGreen(), { line: 'v1.3', workflowText, now: NOW });
    const body = buildLineTrackerBody(a, { generatedAt: 'T', runUrl: 'U' });
    expect(body).toContain('v1.3');
    for (const c of SPEC.cells) expect(body).toContain(`\`${c.lane}\``);
    expect(body).not.toContain(TRACKER_TITLE);
    expect(body).toContain('v1.3 CREDENTIAL MET');
  });

  it('the tracker upsert creates/comments on its OWN issue and never pins', () => {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create')
        return 'https://github.com/o/r/issues/4242\n';
      return '';
    };
    const n = upsertLineTracker(gh, 'o/r', 'v1.3', 'body');
    expect(n).toBe(4242);
    const create = calls.find((a) => a[0] === 'issue' && a[1] === 'create') as string[];
    expect(create[create.indexOf('--title') + 1]).toBe(SPEC.trackerTitle);
    expect(create[create.indexOf('--label') + 1]).toBe(SPEC.trackerLabel);
    expect(calls.some((a) => a.join(' ').includes('pinIssue'))).toBe(false);
    expect(calls.some((a) => a[0] === 'issue' && a[1] === 'pin')).toBe(false);

    const calls2: string[][] = [];
    const gh2 = (args: string[]) => {
      calls2.push(args);
      if (args[0] === 'issue' && args[1] === 'list')
        return JSON.stringify([
          { number: 7, title: TRACKER_TITLE },
          { number: 9, title: SPEC.trackerTitle },
        ]);
      return '';
    };
    expect(upsertLineTracker(gh2, 'o/r', 'v1.3', 'body')).toBe(9);
    expect(calls2.find((a) => a[1] === 'comment')?.[2]).toBe('9');
  });

  it('the tracker workflow audits the v1.3 line and runs after every v1.3 slot’s grace', () => {
    const wf = parse(read(V13_TRACKER_WORKFLOW)) as any;
    const text = read(V13_TRACKER_WORKFLOW);
    expect(text).toContain('scripts/compat-line-tracker.mjs');
    expect(text).toContain('--line v1.3');
    expect(text).not.toContain('compat-matrix-tracker.mjs');
    const cron = wf.on.schedule[0].cron as string;
    const [m, h] = cron.split(' ').map(Number);
    // Last v1.3 slot 18:47 + the audit's 10 h missing-night grace = 04:47 UTC;
    // and before the first v1.3 slot (14:17), so the tracker reads a settled day.
    const minutes = h * 60 + m;
    expect(minutes).toBeGreaterThanOrEqual(4 * 60 + 47);
    expect(minutes).toBeLessThan(14 * 60 + 17);
    expect(wf.jobs[Object.keys(wf.jobs)[0]].permissions).toEqual({
      contents: 'read',
      actions: 'read',
      issues: 'write',
    });
  });

  it('the line registry exposes exactly the four stable cells (vinext stays Beta)', () => {
    expect(Object.keys(CREDENTIAL_LINES)).toEqual(['v1.3']);
    expect(SPEC.cells.map((c: { lane: string }) => c.lane)).toEqual([
      'node',
      'bun',
      'node-webpack',
      'bun-webpack',
    ]);
  });
});
