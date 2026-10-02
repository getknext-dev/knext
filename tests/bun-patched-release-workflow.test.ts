import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  driftVerdict,
  pinnedBunVersion,
  stockVersionFromTag,
} from '../scripts/bun-patched-drift.mjs';

/**
 * GUARD TESTS for the opt-in knext-patched Bun toolchain's release lane.
 *
 * The first release of it (bun-patched-1.4.2-knext.1) signed and PUBLISHED, then ran its end-to-end
 * proof, which was red: the e2e was a post-publish job, not a gate. These assert the corrected shape:
 *   1. the ONLY job that signs, attests or publishes `needs` every gate — the pin check, the x64
 *      smoke, the arm64 smoke on a real arm64 runner, and the e2e;
 *   2. the e2e runs against the verified DRAFT binary (seeded through the `toolchain-artifact`
 *      input), so it gates the very bytes that get published;
 *   3. provenance: cosign over SHA256SUMS AND GitHub build-provenance attestations for both
 *      binaries, each verified in-job;
 *   4. the drift check is nightly, informational, pipefail-safe, and its verdict logic is right.
 *
 * Text + parsed-YAML assertions, like the sibling workflow guards; no network.
 */

const ROOT = resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

type Job = {
  needs?: string | string[];
  'runs-on'?: string;
  permissions?: Record<string, string>;
  uses?: string;
  with?: Record<string, unknown>;
  steps?: {
    name?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
    if?: string;
  }[];
};
type Wf = { on: Record<string, unknown>; jobs: Record<string, Job> };

const releaseText = read('.github/workflows/bun-patched-release.yml');
const release = parse(releaseText) as Wf;
const e2e = parse(read('.github/workflows/bun-patched-e2e.yml')) as Wf;
const needsOf = (j: Job) => (Array.isArray(j.needs) ? j.needs : j.needs ? [j.needs] : []);
const stepText = (j: Job) =>
  (j.steps ?? []).map((s) => `${s.uses ?? ''}\n${s.run ?? ''}`).join('\n');

describe('bun-patched-release: every gate runs BEFORE anything is signed or published', () => {
  const publishers = Object.entries(release.jobs).filter(([, j]) =>
    /cosign sign-blob|attest-build-provenance|gh release edit .*--draft=false|gh release upload/.test(
      stepText(j),
    ),
  );

  it('exactly one job signs, attests or publishes — the publish job', () => {
    expect(publishers.map(([n]) => n)).toEqual(['publish']);
  });

  it('the publish job needs the pin check, both smokes and the e2e', () => {
    const needs = needsOf(release.jobs.publish as Job).sort();
    expect(needs).toEqual(['e2e', 'smoke-arm64', 'smoke-x64', 'verify']);
  });

  it('no gate job holds a signing or attestation permission', () => {
    for (const [name, job] of Object.entries(release.jobs)) {
      if (name === 'publish') continue;
      expect(job.permissions?.['id-token'], `${name} id-token`).toBeUndefined();
      expect(job.permissions?.attestations, `${name} attestations`).toBeUndefined();
    }
  });

  it('the arm64 smoke runs on a real arm64 runner against the pinned stock 1.4.2 control', () => {
    const job = release.jobs['smoke-arm64'] as Job;
    expect(job['runs-on']).toBe('ubuntu-24.04-arm');
    const text = stepText(job);
    expect(text).toContain('bun-linux-aarch64');
    expect(text).toContain('54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7');
    expect(text).toContain('deploy/bun-patched/smoke.sh');
  });

  it('the verify job refuses a release that does not pin BOTH architectures', () => {
    const text = stepText(release.jobs.verify as Job);
    expect(text).toContain("grep -qE '  bun-linux-x64$'");
    expect(text).toContain("grep -qE '  bun-linux-aarch64$'");
    expect(text).toContain('sha256sum -c --strict');
  });

  it('the e2e gate receives the verified draft binaries, and the e2e seeds them into knext’s cache', () => {
    const job = release.jobs.e2e as Job;
    expect(job.uses).toBe('./.github/workflows/bun-patched-e2e.yml');
    expect(job.with?.['toolchain-artifact']).toBe('bun-patched-binaries');
    const call = (e2e.on.workflow_call as { inputs: Record<string, unknown> }).inputs;
    expect(Object.keys(call)).toContain('toolchain-artifact');
    const seed = (e2e.jobs['vinext-bun-patched'] as Job).steps?.find((s) =>
      /Seed knext/.test(s.name ?? ''),
    );
    expect(seed?.if).toContain("inputs.toolchain-artifact != ''");
    expect(seed?.run).toContain('$KNEXT_CACHE_DIR/bun-patched/$tag/bun-linux-x64');
  });

  it('the e2e gate runs knext’s native-include tests on the gated binary, with skipping turned into failure', () => {
    const step = (e2e.jobs['vinext-bun-patched'] as Job).steps?.find((x) =>
      /compile-include-patched\.test\.ts/.test(x.run ?? ''),
    ) as { if?: string; run?: string; env?: Record<string, string> } | undefined;
    expect(step?.if).toContain("inputs.toolchain-artifact != ''");
    expect(step?.env?.KNEXT_REQUIRE_PATCHED_BUN).toBe('1');
    expect(step?.run).toContain(
      'KNEXT_TEST_PATCHED_BUN="$RUNNER_TEMP/toolchain-under-test/bun-linux-x64"',
    );
  });

  it('provenance: cosign over SHA256SUMS and a build-provenance attestation per binary, both verified in-job', () => {
    const text = stepText(release.jobs.publish as Job);
    expect(text).toContain('cosign sign-blob');
    expect(text).toContain('cosign verify-blob');
    expect(text).toMatch(/actions\/attest-build-provenance@[0-9a-f]{40}/);
    const attest = (release.jobs.publish as Job).steps?.find((s) =>
      /attest-build-provenance/.test(s.uses ?? ''),
    );
    expect(String(attest?.with?.['subject-path'])).toContain('out/bun-linux-x64');
    expect(String(attest?.with?.['subject-path'])).toContain('out/bun-linux-aarch64');
    expect(text).toContain('gh attestation verify');
    expect((release.jobs.publish as Job).permissions?.attestations).toBe('write');
  });

  it('publishing happens only after signing and attesting (step order in the publish job)', () => {
    const steps = (release.jobs.publish as Job).steps ?? [];
    const idx = (re: RegExp) => steps.findIndex((s) => re.test(`${s.uses ?? ''}\n${s.run ?? ''}`));
    const sign = idx(/cosign sign-blob/);
    const attest = idx(/attest-build-provenance/);
    const publish = idx(/--draft=false/);
    expect(sign).toBeGreaterThanOrEqual(0);
    expect(attest).toBeGreaterThan(sign);
    expect(publish).toBeGreaterThan(attest);
  });
});

describe('bun-patched drift check (informational, nightly)', () => {
  const drift = parse(read('.github/workflows/bun-patched-drift-nightly.yml')) as Wf;

  it('is scheduled nightly and dispatchable, and is not a reusable/required gate', () => {
    const sched = drift.on.schedule as { cron: string }[];
    expect(sched).toHaveLength(1);
    expect(sched[0]?.cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(Object.keys(drift.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  it('cannot go green through a pipe: pipefail is set where the script is piped to the summary', () => {
    const run = stepText(drift.jobs.drift as Job);
    expect(run).toContain('set -euo pipefail');
    expect(run).toContain('node scripts/bun-patched-drift.mjs');
  });

  it('reads the pinned stock version from bun-toolchain.ts (exactly one pin)', () => {
    expect(pinnedBunVersion(read('packages/kn-next/src/cli/bun-toolchain.ts'))).toBe('1.4.2');
    expect(() => pinnedBunVersion('')).toThrow();
  });

  it('reds on a newer stock Bun, stays green on the same or an older one', () => {
    expect(driftVerdict({ pinned: '1.4.2', latestTag: 'bun-v1.4.3' }).drift).toBe(true);
    expect(driftVerdict({ pinned: '1.4.2', latestTag: 'bun-v1.5.0' }).drift).toBe(true);
    expect(driftVerdict({ pinned: '1.4.2', latestTag: 'bun-v1.4.10' }).drift).toBe(true);
    expect(driftVerdict({ pinned: '1.4.2', latestTag: 'bun-v1.4.2' }).drift).toBe(false);
    expect(driftVerdict({ pinned: '1.4.2', latestTag: 'bun-v1.4.1' }).drift).toBe(false);
  });

  it('a malformed upstream answer throws instead of reading as "no drift"', () => {
    expect(() => stockVersionFromTag('')).toThrow();
    expect(() => stockVersionFromTag('canary')).toThrow();
    expect(() => stockVersionFromTag(undefined)).toThrow();
  });

  it('reports the upstream merge as a retirement signal', () => {
    const v = driftVerdict({ pinned: '1.4.2', latestTag: 'bun-v1.4.2', upstreamMerged: true });
    expect(v.drift).toBe(false);
    expect(v.messages.join('\n')).toContain('retire the patched toolchain');
  });
});
