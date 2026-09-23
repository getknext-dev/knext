import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * WIRING GUARD for the nightly file-manager platform e2e (#1282).
 *
 * The suite's value is that it goes red when the platform regresses. That is
 * lost if the workflow quietly stops running it, tolerates its failure, or runs
 * it against an unpinned image. Each test below asserts on the PARSED workflow
 * and the committed profile - and each was mutation-proved (delete the behaviour
 * it protects; it goes red).
 */

const ROOT = resolve(import.meta.dirname, '..');
const WF = resolve(ROOT, '.github/workflows/file-manager-platform-e2e-nightly.yml');
const DATA_PLANE = resolve(ROOT, 'apps/file-manager/platform-e2e/data-plane.yaml');
const PROFILE = resolve(ROOT, 'apps/file-manager/platform-e2e/kn-next.config.e2e.ts');
const REAL_CONFIG = resolve(ROOT, 'apps/file-manager/kn-next.config.ts');

type Step = { name?: string; uses?: string; run?: string; if?: string; [k: string]: unknown };
type Job = { steps: Step[]; needs?: string[]; if?: string; [k: string]: unknown };
const text = readFileSync(WF, 'utf8');
const wf = parse(text) as { on: Record<string, unknown>; jobs: Record<string, Job> };
const check = wf.jobs['platform-e2e'];
const alert = wf.jobs['nightly-red-alert'];

describe('file-manager platform e2e nightly - wiring', () => {
  it('triggers on schedule + workflow_dispatch ONLY', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  it('the check job is fail-closed: no continue-on-error anywhere, no `if:` on the suite step', () => {
    expect(text).not.toMatch(/continue-on-error/);
    const suite = check.steps.find((s) => (s.run ?? '').includes('platform-e2e.mjs'));
    expect(suite).toBeDefined();
    expect(suite?.if).toBeUndefined();
  });

  it('runs the deploy through the product CLI, and no hand-written Knative apply', () => {
    const deploy = check.steps.find((s) => (s.run ?? '').includes('kn-next.js deploy'));
    expect(deploy).toBeDefined();
    for (const s of check.steps) {
      expect(s.run ?? '').not.toMatch(/kind:\s*Service\b|serving\.knative\.dev\/v1/);
    }
  });

  it('runs the harness self-test BEFORE the cluster suite', () => {
    const idx = (needle: string) => check.steps.findIndex((s) => (s.run ?? '').includes(needle));
    const selftest = idx('platform-e2e.selftest.mjs');
    expect(selftest).toBeGreaterThanOrEqual(0);
    expect(selftest).toBeLessThan(idx('scripts/platform-e2e.mjs'));
  });

  it('states a budget: a timeout, and a documented expectation', () => {
    expect(typeof (check as unknown as { 'timeout-minutes': number })['timeout-minutes']).toBe(
      'number',
    );
    expect(text).toMatch(/BUDGET:/);
  });

  it('every third-party action is pinned by 40-hex SHA with a version comment', () => {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(3);
    for (const [, ref, rest] of uses) {
      expect(ref).toMatch(/@[0-9a-f]{40}$/);
      expect(rest).toMatch(/#\s*v\d/);
    }
  });

  it('every container image (workflow + data plane) is digest-pinned', () => {
    const images = [
      ...text.matchAll(/(?:image:\s*|docker run [^\n]*\\\n\s*|CURL_IMAGE:\s*)(\S+:\S+)/g),
      ...readFileSync(DATA_PLANE, 'utf8').matchAll(/image:\s*(\S+)/g),
    ].map((m) => m[1]);
    expect(images.length).toBeGreaterThanOrEqual(5);
    for (const img of images) expect(img).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(text).toMatch(/registry:2\.8\.3@sha256:[0-9a-f]{64}/);
  });

  it('the red alert is schedule-only and keyed on the check job FAILING', () => {
    expect(alert.needs).toEqual(['platform-e2e']);
    expect(String(alert.if)).toContain("github.event_name == 'schedule'");
    expect(String(alert.if)).toContain("needs.platform-e2e.result == 'failure'");
  });

  it('secrets are created per run from random values and masked, never committed', () => {
    const setup = check.steps.find((s) => (s.run ?? '').includes('create secret'));
    expect(setup?.run).toContain('openssl rand');
    expect(setup?.run).toContain('::add-mask::');
  });
});

describe('platform e2e config profile', () => {
  const norm = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const keys = (src: string) =>
    [...norm(src).matchAll(/^ {2}([a-zA-Z]+):/gm)].map((m) => m[1]).sort();

  it('differs from the real config only in storage/registry/cache/database', () => {
    const real = keys(readFileSync(REAL_CONFIG, 'utf8'));
    const prof = keys(readFileSync(PROFILE, 'utf8'));
    const allowed = new Set(['storage', 'registry', 'cache', 'database']);
    const onlyReal = real.filter((k) => !prof.includes(k));
    const onlyProf = prof.filter((k) => !real.includes(k));
    for (const k of [...onlyReal, ...onlyProf]) expect(allowed.has(k)).toBe(true);
    expect(onlyReal).toContain('storage');
  });

  it('non-differing keys are byte-identical', () => {
    const block = (src: string, key: string) =>
      new RegExp(`^ {2}${key}:[\\s\\S]*?(?=^ {2}[a-zA-Z]+:|^\\};?$)`, 'm')
        .exec(norm(src))?.[0]
        .replace(/\s+/g, ' ')
        .trim();
    const real = readFileSync(REAL_CONFIG, 'utf8');
    const prof = readFileSync(PROFILE, 'utf8');
    for (const k of ['name', 'infrastructure', 'scaling', 'observability', 'secrets']) {
      expect(block(prof, k)).toBeDefined();
      expect(block(prof, k)).toBe(block(real, k));
    }
  });
});

describe('platform e2e harness self-test', () => {
  it('passes: every check is green when healthy and red on each defect', () => {
    const r = spawnSync('node', ['apps/file-manager/scripts/platform-e2e.selftest.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(r.stdout + r.stderr).toContain('goes red on each defect');
    expect(r.status).toBe(0);
  });
});
