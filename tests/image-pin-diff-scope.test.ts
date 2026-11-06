/**
 * PR-time diff scoping for `scripts/verify-image-pins.mjs` (#2739).
 *
 * An upstream tag rebuilt in place (`golang:1.26.10` has carried four digests in
 * two days) reddened PRs whose diff touches no pin. The decision: on a PR the
 * registry is asked only about pins the PR ADDS OR CHANGES; the nightly keeps
 * the full tree and owns "upstream moved under us".
 *
 * Every case runs against a REAL throwaway git repository (the diff is computed
 * by git, not by a double) and a FAKE registry injected through the tool's
 * existing `api` seam. The CLI cases make no network call by construction: an
 * unchanged pin must not be resolved, so a regression that resolves it shows up
 * as a red exit code rather than a hang.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

import { verifyRepo } from '../scripts/verify-image-pins.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts/verify-image-pins.mjs');

const hex = (c: string) => `sha256:${c.repeat(64)}`;
const OLD = hex('a'); // what the tree pinned
const NEW = hex('b'); // what the PR repins to
const UPSTREAM = hex('c'); // what the fake registry serves today (rebuilt tag)

const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: cleanEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A git repo with the given files committed once; returns the dir and the base sha. */
function repoWith(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'pin-diff-'));
  made.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 't');
  const write = (rel: string, body: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  const commit = (message = 'pr') => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', message);
  };
  return { dir, base, write, commit };
}

/** A registry double that records every lookup and serves UPSTREAM for every tag. */
const fakeRegistry = () => {
  const calls: string[] = [];
  const api = async ({ repository, tag }: { repository: string; tag: string }) => {
    calls.push(`${repository}:${tag}`);
    return { status: 200, digest: UPSTREAM };
  };
  return { api, calls };
};

const docker = (digest: string, tag = 'golang:1.26.10') =>
  `FROM ${tag}@${digest} AS build\nRUN true\n`;
const goSrc = (digest: string) => `package x\n\nconst helper = "busybox:1.36.1-uclibc@${digest}"\n`;
const yamlSrc = (digest: string) => `spec:\n  containers:\n    - image: alpine:3.20@${digest}\n`;

describe('PR mode: only pins the PR adds or changes are resolved', () => {
  it('does NOT resolve an unchanged pin, even though upstream has moved (the #2739 case)', async () => {
    const r = repoWith({
      'svc/Dockerfile': docker(OLD),
      'README.md': 'one\n',
    });
    r.write('README.md', 'two\n'); // the PR touches no pin
    r.commit();
    const { api, calls } = fakeRegistry();
    const result = await verifyRepo(r.dir, { api, base: r.base });
    expect(calls).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.pins.length).toBe(1); // the pin is still SEEN, just not resolved
  });

  it('resolves and fails a pin the PR CHANGES to a digest the tag does not serve', async () => {
    const r = repoWith({ 'svc/Dockerfile': docker(OLD) });
    r.write('svc/Dockerfile', docker(NEW));
    r.commit();
    const { api, calls } = fakeRegistry();
    const result = await verifyRepo(r.dir, { api, base: r.base });
    expect(calls).toEqual(['library/golang:1.26.10']);
    expect(result.findings.map((f) => f.reason)).toEqual(['digest-mismatch']);
  });

  it('passes a changed pin that matches what the tag serves', async () => {
    const r = repoWith({ 'svc/Dockerfile': docker(OLD) });
    r.write('svc/Dockerfile', docker(UPSTREAM));
    r.commit();
    const { api, calls } = fakeRegistry();
    const result = await verifyRepo(r.dir, { api, base: r.base });
    expect(calls.length).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it('resolves a pin the PR ADDS in a new file, for every source kind', async () => {
    const r = repoWith({
      'svc/Dockerfile': docker(OLD),
      'packages/kn-next-operator/a.go': 'package a\n',
    });
    r.write('svc2/Dockerfile', docker(NEW, 'rust:1.99.1-alpine3.23'));
    r.write('packages/kn-next-operator/internal/b.go', goSrc(NEW));
    r.write('benchmarks/x/job.yaml', yamlSrc(NEW));
    r.write('benchmarks/x/run.sh', 'IMG="${NODESH_IMAGE:-alpine:3.21@' + NEW + '}"\n');
    r.commit();
    const { api, calls } = fakeRegistry();
    const result = await verifyRepo(r.dir, { api, base: r.base });
    expect(calls.sort()).toEqual([
      'library/alpine:3.20',
      'library/alpine:3.21',
      'library/busybox:1.36.1-uclibc',
      'library/rust:1.99.1-alpine3.23',
    ]);
    expect(result.findings.length).toBe(4);
    // the untouched Dockerfile pin was not resolved
    expect(calls).not.toContain('library/golang:1.26.10');
  });

  it('checks a changed pin in a Go source and in benchmark YAML (not only Dockerfiles)', async () => {
    const r = repoWith({
      'packages/kn-next-operator/internal/b.go': goSrc(OLD),
      'benchmarks/x/job.yaml': yamlSrc(OLD),
    });
    r.write('packages/kn-next-operator/internal/b.go', goSrc(NEW));
    r.write('benchmarks/x/job.yaml', yamlSrc(NEW));
    r.commit();
    const { api, calls } = fakeRegistry();
    const result = await verifyRepo(r.dir, { api, base: r.base });
    expect(calls.sort()).toEqual(['library/alpine:3.20', 'library/busybox:1.36.1-uclibc']);
    expect(result.findings.length).toBe(2);
  });

  it('a MOVED line is not a changed pin: line numbers are not part of the key', async () => {
    const r = repoWith({ 'svc/Dockerfile': docker(OLD) });
    r.write('svc/Dockerfile', `# a\n# b\n# c\n${docker(OLD)}`);
    r.commit();
    const { api, calls } = fakeRegistry();
    const result = await verifyRepo(r.dir, { api, base: r.base });
    expect(calls).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it('a pin moved but ALSO changed on another line is still caught', async () => {
    const r = repoWith({ 'svc/Dockerfile': docker(OLD) });
    r.write('svc/Dockerfile', `# a\n# b\n${docker(NEW)}`);
    r.commit();
    const { api, calls } = fakeRegistry();
    await verifyRepo(r.dir, { api, base: r.base });
    expect(calls.length).toBe(1);
  });

  it('a RENAMED file cannot hide a changed digest', async () => {
    const r = repoWith({ 'svc/Dockerfile': `${docker(OLD)}RUN echo padding-padding-padding\n` });
    renameSync(join(r.dir, 'svc/Dockerfile'), join(r.dir, 'svc/Dockerfile.prod'));
    r.write('svc/Dockerfile.prod', `${docker(NEW)}RUN echo padding-padding-padding\n`);
    r.commit();
    const { api, calls } = fakeRegistry();
    const result = await verifyRepo(r.dir, { api, base: r.base });
    expect(calls).toEqual(['library/golang:1.26.10']);
    expect(result.findings.map((f) => f.reason)).toEqual(['digest-mismatch']);
  });

  it('a pure RENAME leaves the pin unchanged: nothing is resolved', async () => {
    const r = repoWith({ 'svc/Dockerfile': `${docker(OLD)}RUN echo padding-padding-padding\n` });
    renameSync(join(r.dir, 'svc/Dockerfile'), join(r.dir, 'svc/Dockerfile.prod'));
    r.commit();
    const { api, calls } = fakeRegistry();
    const result = await verifyRepo(r.dir, { api, base: r.base });
    expect(calls).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it('copying a stale pin into a NEW file is an added pin and is resolved', async () => {
    const r = repoWith({ 'svc/Dockerfile': docker(OLD) });
    r.write('other/Dockerfile', docker(OLD));
    r.commit();
    const { api, calls } = fakeRegistry();
    const result = await verifyRepo(r.dir, { api, base: r.base });
    expect(calls.length).toBe(1);
    expect(result.findings.map((f) => f.file)).toEqual(['other/Dockerfile']);
  });

  it('resolves a changed tag with the same digest', async () => {
    const r = repoWith({ 'svc/Dockerfile': docker(UPSTREAM, 'golang:1.26.9') });
    r.write('svc/Dockerfile', docker(UPSTREAM, 'golang:1.26.10'));
    r.commit();
    const { api, calls } = fakeRegistry();
    await verifyRepo(r.dir, { api, base: r.base });
    expect(calls).toEqual(['library/golang:1.26.10']);
  });

  it("diffs against the MERGE BASE, not the base tip: a repin that landed on the base is not the PR's", async () => {
    const r = repoWith({ 'svc/Dockerfile': docker(OLD) });
    git(r.dir, 'switch', '-q', '-c', 'pr');
    r.write('README.md', 'pr\n');
    r.commit('pr work');
    git(r.dir, 'switch', '-q', 'main');
    r.write('svc/Dockerfile', docker(NEW)); // base moves on, repinning
    r.commit('base moved');
    git(r.dir, 'switch', '-q', 'pr'); // HEAD is the PR head, NOT yet merged with main
    const { api, calls } = fakeRegistry();
    // Against the base TIP this tree looks like it "changed" the pin back to OLD.
    const result = await verifyRepo(r.dir, { api, base: 'main' });
    expect(calls).toEqual([]);
    expect(result.findings).toEqual([]);
  });
});

describe('PR mode keeps the no-network checks on the full tree', () => {
  it('still reports an UNCHANGED digest-only reference (form check, no network)', async () => {
    const r = repoWith({ 'svc/Dockerfile': `FROM golang@${OLD}\n` });
    r.write('README.md', 'x\n');
    r.commit();
    const { api, calls } = fakeRegistry();
    const result = await verifyRepo(r.dir, { api, base: r.base });
    expect(calls).toEqual([]);
    expect(result.findings.map((f) => f.reason)).toEqual(['no-tag']);
  });

  // The real shape in security/dockerfile-base-exclusions.json: a private,
  // digest-only baseline, bound to an exact file AND digest.
  const variantsExclusion = (digest: string, expires = '2999-01-01') => ({
    file: 'scripts/bench-cold-start-phases/gke/variants/Dockerfile.variants',
    covers: ['registry-resolution'],
    justification: 'private digest-only baseline; the digest is the experiment control',
    added: '2026-11-02',
    expires,
    digest,
  });
  const VARIANTS = 'scripts/bench-cold-start-phases/gke/variants/Dockerfile.variants';
  const digestOnly = (digest: string) => `FROM us-docker.pkg.dev/p/r/bc-bun-turbopack@${digest}\n`;

  it('an UNCHANGED excluded digest-only pin behaves as in full-tree mode: not a finding', async () => {
    const r = repoWith({ [VARIANTS]: digestOnly(OLD), 'README.md': 'a\n' });
    r.write('README.md', 'b\n');
    r.commit();
    const { api, calls } = fakeRegistry();
    const exclusions = [variantsExclusion(OLD)];
    const full = await verifyRepo(r.dir, { api, exclusions });
    const pr = await verifyRepo(r.dir, { api, base: r.base, exclusions });
    expect(full.findings).toEqual([]);
    expect(pr.findings).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('an excluded digest-only pin is still exempt only for the EXACT digest it names', async () => {
    const r = repoWith({ [VARIANTS]: digestOnly(OLD), 'README.md': 'a\n' });
    r.write('README.md', 'b\n');
    r.commit();
    const exclusions = [variantsExclusion(NEW)]; // names a different digest
    const { api } = fakeRegistry();
    const pr = await verifyRepo(r.dir, { api, base: r.base, exclusions });
    expect(pr.findings.map((f) => f.reason)).toEqual(['no-tag']);
  });

  it('an EXPIRED exclusion on an unchanged digest-only pin is a finding in PR mode too (offline)', async () => {
    const r = repoWith({ [VARIANTS]: digestOnly(OLD), 'README.md': 'a\n' });
    r.write('README.md', 'b\n');
    r.commit();
    const exclusions = [variantsExclusion(OLD, '2020-01-01')];
    const { api } = fakeRegistry();
    const full = await verifyRepo(r.dir, { api, exclusions });
    const pr = await verifyRepo(r.dir, { api, base: r.base, exclusions });
    expect(full.findings.map((f) => f.reason)).toEqual(['no-tag']);
    expect(pr.findings.map((f) => f.reason)).toEqual(['no-tag']);
  });

  it('still applies a dated registry-resolution exclusion to a changed pin', async () => {
    const r = repoWith({ 'svc/Dockerfile': docker(OLD) });
    r.write('svc/Dockerfile', docker(NEW));
    r.commit();
    const { api, calls } = fakeRegistry();
    const exclusions = [
      {
        file: 'svc/Dockerfile',
        image: 'golang:1.26.10',
        digest: NEW,
        covers: ['registry-resolution'],
        justification: 'fixture',
        added: '2026-01-01',
        expires: '2999-01-01',
      },
    ];
    const result = await verifyRepo(r.dir, { api, base: r.base, exclusions });
    expect(calls).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it('still reports no-sources when the tree has nothing to scan', async () => {
    const r = repoWith({ 'README.md': 'x\n' });
    const result = await verifyRepo(r.dir, { api: fakeRegistry().api, base: r.base });
    expect(result.findings.map((f) => f.reason)).toEqual(['no-sources']);
  });
});

describe('PR mode fails CLOSED when the diff cannot be computed', () => {
  it('a base revision that does not exist', async () => {
    const r = repoWith({ 'svc/Dockerfile': docker(OLD) });
    const { api, calls } = fakeRegistry();
    const result = await verifyRepo(r.dir, { api, base: 'no-such-rev-anywhere' });
    expect(result.findings.map((f) => f.reason)).toEqual(['diff-unavailable']);
    expect(calls).toEqual([]);
  });

  it('a shallow clone', async () => {
    const r = repoWith({ 'svc/Dockerfile': docker(OLD) });
    r.write('svc/Dockerfile', docker(NEW));
    r.commit();
    const shallow = mkdtempSync(join(tmpdir(), 'pin-diff-shallow-'));
    made.push(shallow);
    git(tmpdir(), 'clone', '-q', '--depth', '1', `file://${r.dir}`, shallow);
    const { api, calls } = fakeRegistry();
    const result = await verifyRepo(shallow, { api, base: r.base });
    expect(result.findings.map((f) => f.reason)).toEqual(['diff-unavailable']);
    expect(calls).toEqual([]);
  });

  it('a shallow clone that still HAS the base commit is refused too', async () => {
    const r = repoWith({ 'svc/Dockerfile': docker(OLD) });
    r.write('svc/Dockerfile', docker(NEW));
    r.commit();
    const shallow = mkdtempSync(join(tmpdir(), 'pin-diff-shallow2-'));
    made.push(shallow);
    git(tmpdir(), 'clone', '-q', '--depth', '2', `file://${r.dir}`, shallow);
    expect(git(shallow, 'rev-parse', '--is-shallow-repository')).toBe('true');
    expect(git(shallow, 'cat-file', '-t', r.base)).toBe('commit'); // the base IS reachable
    const { api, calls } = fakeRegistry();
    const result = await verifyRepo(shallow, { api, base: r.base });
    expect(result.findings.map((f) => f.reason)).toEqual(['diff-unavailable']);
    expect(calls).toEqual([]);
  });

  it('a directory that is not a git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pin-diff-nogit-'));
    made.push(dir);
    writeFileSync(join(dir, 'Dockerfile'), docker(OLD));
    const result = await verifyRepo(dir, { api: fakeRegistry().api, base: 'HEAD' });
    expect(result.findings.map((f) => f.reason)).toEqual(['diff-unavailable']);
  });
});

describe('without --base (nightly / manual) the whole tree is resolved', () => {
  it('resolves unchanged pins and reports the drift', async () => {
    const r = repoWith({
      'svc/Dockerfile': docker(OLD),
      'benchmarks/x/job.yaml': yamlSrc(OLD),
    });
    const { api, calls } = fakeRegistry();
    const result = await verifyRepo(r.dir, { api });
    expect(calls.sort()).toEqual(['library/alpine:3.20', 'library/golang:1.26.10']);
    expect(result.findings.map((f) => f.reason)).toEqual(['digest-mismatch', 'digest-mismatch']);
  });

  it('an unreachable registry is a failure, never a pass', async () => {
    const r = repoWith({ 'svc/Dockerfile': docker(OLD) });
    const api = async () => ({ status: 503, digest: undefined });
    const result = await verifyRepo(r.dir, { api });
    expect(result.findings.map((f) => f.reason)).toEqual(['api-error']);
  });
});

describe('the CLI, really invoked', () => {
  const run = (cwd: string, ...args: string[]) =>
    spawnSync('node', [SCRIPT, '--root', cwd, ...args], {
      env: cleanEnv(),
      encoding: 'utf8',
      timeout: 60_000,
    });

  it('--base with only unchanged (stale) pins exits 0 and says what it skipped, with no registry call', () => {
    const r = repoWith({ 'svc/Dockerfile': docker(OLD), 'README.md': 'a\n' });
    r.write('README.md', 'b\n');
    r.commit();
    const out = run(r.dir, '--base', r.base);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/diff-scoped/i);
    expect(out.stdout).toMatch(/1 unchanged pin\(s\) not resolved/);
  });

  it('--base with an unusable base exits 1 and names the cause', () => {
    const r = repoWith({ 'svc/Dockerfile': docker(OLD) });
    const out = run(r.dir, '--base', 'no-such-rev-anywhere');
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/diff-unavailable/);
  });

  it('--base needs a value', () => {
    const r = repoWith({ 'svc/Dockerfile': docker(OLD) });
    const out = run(r.dir, '--base');
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/unrecognised argument/);
  });
});

describe('the workflow: PRs are diff-scoped, the schedule is not', () => {
  const text = readFileSync(
    join(ROOT, '.github/workflows/image-pin-resolution-nightly.yml'),
    'utf8',
  );
  const doc = parse(text) as {
    jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
  };
  const steps = doc.jobs['resolve-image-pins'].steps;
  const gate = steps.find(
    (s) => typeof s.run === 'string' && /verify-image-pins\.mjs/.test(s.run as string),
  );
  const checkout = steps.find((s) => String(s.uses ?? '').startsWith('actions/checkout'));

  it('the gate step passes --base only on a pull_request, from env (never interpolated)', () => {
    const run = String(gate?.run);
    expect(run).toMatch(/--base\s+"origin\/\$\{?BASE_REF\}?"/);
    expect(run).not.toMatch(/\$\{\{/);
    const env = gate?.env as Record<string, string>;
    expect(env.EVENT_NAME).toBe('${{ github.event_name }}');
    expect(env.BASE_REF).toBe('${{ github.base_ref }}');
  });

  it('only ONE branch of the gate step carries --base, and it is the pull_request branch', () => {
    const run = String(gate?.run);
    const lines = run.split('\n').filter((l) => /verify-image-pins\.mjs/.test(l));
    expect(lines.length).toBe(2);
    expect(lines.filter((l) => /--base/.test(l)).length).toBe(1);
    expect(run).toMatch(/if \[ "\$EVENT_NAME" = "pull_request" \]; then\s+node [^\n]*--base/);
    expect(run).toMatch(/else\s+node scripts\/verify-image-pins\.mjs\s*\n\s*fi/);
  });

  it('the checkout fetches full history on a PR so the merge base exists', () => {
    const w = checkout?.with as Record<string, unknown>;
    // Quoted '0': in a GitHub expression the NUMBER 0 is falsy, so
    // `cond && 0 || 1` evaluates to 1 and silently ships a shallow checkout.
    expect(String(w['fetch-depth'])).toBe(
      "${{ github.event_name == 'pull_request' && '0' || '1' }}",
    );
  });

  it('the one tracking issue is still schedule-only and idempotent', () => {
    expect(text).toMatch(/nightly-red-alert:/);
    expect(text).toMatch(/github\.event_name == 'schedule'/);
    expect(text).toMatch(/scripts\/nightly-alert-issue\.mjs/);
  });
});
