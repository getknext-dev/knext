import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD TESTS for .github/workflows/operator-supply-chain.yml (#201).
 *
 * Same class as #199 (fixed for the app image in PR #200): the operator
 * workflow pushed the image to GHCR *at build time* on main
 * (build-push-action with `push: ${{ github.ref == 'refs/heads/main' }}`),
 * BEFORE the SBOM + Trivy HIGH/CRITICAL gate ran. A scan-failed operator
 * image therefore landed at a stable tag, unsigned, as the newest published
 * digest — inverting security.md's supply-chain rule.
 *
 * The invariant these tests lock in (mirrors tests/supply-chain-workflow.test.ts):
 *   build (local only) → SBOM → Trivy gate → push (main only) → cosign sign →
 *   verify → installer digest-pin → release attach — in that order, with every
 *   post-gate consumer parameterized by the digest of the image that was
 *   ACTUALLY pushed (steps.push.outputs.digest), never the pre-gate build output.
 *
 * Operator-specific extra invariant: this workflow also rewrites
 * dist/install.yaml with the published digest and attaches it to the
 * `operator-latest` GitHub Release (#117/#156 flow). Those steps must come
 * AFTER the Trivy gate + push, and must bake in the POST-gate pushed digest —
 * a scan-failed run must never update the release asset either.
 *
 * Implementation note: like tests/supply-chain-workflow.test.ts, this scans
 * the workflow YAML as text (step blocks split at `- name:`/`- uses:`
 * boundaries) so the test adds no runtime YAML dependency.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const OPERATOR_WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/operator-supply-chain.yml');
const APP_WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/supply-chain.yml');

function workflowText(): string {
  return readFileSync(OPERATOR_WORKFLOW_PATH, 'utf8');
}

/**
 * Splits the workflow into step blocks in document order. A step starts at a
 * `- name:` or `- uses:` line at the steps-list indent; everything up to the
 * next such line belongs to the same step.
 */
function stepBlocks(): string[] {
  const lines = workflowText().split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) blocks.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    if (/^\s*-\s+(name|uses):/.test(line)) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

/**
 * Removes YAML comment lines AND name: metadata lines so prose (a comment or a
 * step/job title that merely MENTIONS `docker push` or `cosign sign`) never
 * satisfies a content matcher — only real step content (uses/run/with) counts.
 */
function stripComments(block: string): string {
  return block
    .split('\n')
    .filter((l) => !l.trim().startsWith('#') && !/^\s*-?\s*name:/.test(l))
    .join('\n');
}

/** Index (document order) of the first step block matching `re` (comments ignored), or -1. */
function stepIndex(re: RegExp): number {
  return stepBlocks().findIndex((b) => re.test(stripComments(b)));
}

/** The first step block matching `re` (comments ignored), or '' if none. */
function stepBlock(re: RegExp): string {
  return stepBlocks().find((b) => re.test(stripComments(b))) ?? '';
}

const BUILD_RE = /uses:\s*docker\/build-push-action/;
const TRIVY_RE = /uses:\s*aquasecurity\/trivy-action/;
const PUSH_RE = /docker\s+push\b/;
const SIGN_RE = /cosign\s+sign\b/;
const VERIFY_RE = /cosign-verify\.sh/;
const INSTALLER_RE = /make\s+build-installer/;
const RELEASE_RE = /uses:\s*softprops\/action-gh-release/;
// A `push:` input that enables a registry push (anything but a literal false on
// the SAME line — `[^\S\n]` keeps \s from crossing into the next line, which
// would false-positive on the bare `push:` workflow trigger key).
const PUSH_INPUT_RE = /^\s*push:[^\S\n]*(?!false\b)\S/m;

describe('operator-supply-chain workflow: nothing is published before the Trivy gate (#201)', () => {
  it('the build step builds LOCALLY only — it never pushes, on any ref', () => {
    const build = stepBlock(BUILD_RE);
    expect(build, 'expected a docker/build-push-action step').not.toBe('');
    // The regression: `push: ${{ github.ref == 'refs/heads/main' }}` published
    // the operator image before the scan. The build step must load into the
    // local docker store unconditionally and never push.
    expect(
      /^\s*load:\s*true\s*$/m.test(build),
      'the build step must `load: true` unconditionally (scan the local image)',
    ).toBe(true);
    expect(
      PUSH_INPUT_RE.test(stripComments(build)),
      'the build step must not set push (or must set push: false) — publication happens only after the Trivy gate',
    ).toBe(false);
  });

  it('the Trivy gate runs BEFORE any push to the registry', () => {
    const trivyIdx = stepIndex(TRIVY_RE);
    const pushIdx = stepIndex(PUSH_RE);
    expect(trivyIdx, 'expected a Trivy scan step').toBeGreaterThanOrEqual(0);
    expect(pushIdx, 'expected an explicit push step (docker push)').toBeGreaterThanOrEqual(0);
    expect(trivyIdx, 'the Trivy gate must come before the push step').toBeLessThan(pushIdx);
    // Belt-and-braces: no step before the gate may push (docker push or a
    // build-push-action push: input that is not literally false).
    for (const block of stepBlocks().slice(0, trivyIdx)) {
      const content = stripComments(block);
      expect(PUSH_RE.test(content), 'no step before the Trivy gate may run `docker push`').toBe(
        false,
      );
      expect(
        PUSH_INPUT_RE.test(content),
        'no step before the Trivy gate may enable a registry push',
      ).toBe(false);
    }
  });

  it('the Trivy gate stays fail-loud: HIGH/CRITICAL, exit-code 1, enforced on main', () => {
    const trivy = stepBlock(TRIVY_RE);
    expect(/severity:\s*HIGH,CRITICAL/.test(trivy), 'must scan HIGH,CRITICAL').toBe(true);
    expect(/exit-code:\s*["']?1["']?/.test(trivy), 'must exit non-zero on findings').toBe(true);
    // continue-on-error is allowed ONLY as the PR-phased-rollout expression —
    // never a bare `true` that would soften the gate on main.
    const coe = trivy.match(/continue-on-error:\s*(.+)/);
    if (coe) {
      expect(
        coe[1].includes("github.ref != 'refs/heads/main'"),
        `continue-on-error must be PR-only, got: ${coe[1]}`,
      ).toBe(true);
    }
  });

  it('the push step is main-gated, comes after the gate, and captures the PUSHED digest fail-loud', () => {
    const push = stepBlock(PUSH_RE);
    expect(push, 'expected a docker push step').not.toBe('');
    expect(
      /if:\s*github\.ref\s*==\s*'refs\/heads\/main'/.test(push),
      'the push step must be gated to main',
    ).toBe(true);
    expect(/^\s*id:\s*push\s*$/m.test(push), 'the push step must have id: push').toBe(true);
    expect(
      /digest=.*GITHUB_OUTPUT|>>\s*"?\$GITHUB_OUTPUT"?/.test(push) &&
        /RepoDigests|digest/.test(push),
      'the push step must expose the pushed digest as a step output',
    ).toBe(true);
    expect(
      /exit\s+1/.test(push),
      'the push step must fail loud when the pushed digest cannot be resolved (never sign a guessed digest)',
    ).toBe(true);
  });

  it('cosign signs AFTER the push, parameterized by the pushed digest — never the pre-gate build output', () => {
    const pushIdx = stepIndex(PUSH_RE);
    const signIdx = stepIndex(SIGN_RE);
    expect(signIdx, 'expected a cosign sign step').toBeGreaterThanOrEqual(0);
    expect(pushIdx, 'signing requires a prior push step').toBeGreaterThanOrEqual(0);
    expect(pushIdx, 'signing must come after the push').toBeLessThan(signIdx);
    const sign = stepBlock(SIGN_RE);
    expect(
      /steps\.push\.outputs\.digest/.test(sign),
      'the sign step must sign the digest of the image that was actually pushed (steps.push.outputs.digest)',
    ).toBe(true);
  });

  it('the verify step runs after signing, against the pushed digest', () => {
    const signIdx = stepIndex(SIGN_RE);
    const verifyIdx = stepIndex(VERIFY_RE);
    expect(verifyIdx, 'expected a cosign verify step').toBeGreaterThanOrEqual(0);
    expect(signIdx, 'verify must come after sign').toBeLessThan(verifyIdx);
    const verify = stepBlock(VERIFY_RE);
    expect(
      /steps\.push\.outputs\.digest/.test(verify),
      'the verify step must verify the pushed digest',
    ).toBe(true);
  });

  it('no step consumes the pre-gate build digest — steps.build.outputs.digest is gone', () => {
    // After the reorder the build step never pushes, so its digest output is a
    // local (unpublished, unscanned-registry) identifier. NOTHING downstream —
    // sign, verify, installer pin, release — may consume it.
    expect(
      /steps\.build\.outputs\.digest/.test(workflowText()),
      'the workflow must not reference steps.build.outputs.digest anywhere',
    ).toBe(false);
  });
});

describe('operator release asset (install.yaml) is gated behind the Trivy gate + push (#201)', () => {
  it('the installer digest-pin step comes after the Trivy gate AND the push, and bakes in the PUSHED digest', () => {
    const trivyIdx = stepIndex(TRIVY_RE);
    const pushIdx = stepIndex(PUSH_RE);
    const installerIdx = stepIndex(INSTALLER_RE);
    expect(installerIdx, 'expected the build-installer digest-pin step').toBeGreaterThanOrEqual(0);
    expect(trivyIdx, 'installer pin must come after the Trivy gate').toBeLessThan(installerIdx);
    expect(pushIdx, 'installer pin must come after the push').toBeLessThan(installerIdx);
    const installer = stepBlock(INSTALLER_RE);
    expect(
      /if:\s*github\.ref\s*==\s*'refs\/heads\/main'/.test(installer),
      'the installer pin step must be gated to main',
    ).toBe(true);
    expect(
      /steps\.push\.outputs\.digest/.test(installer),
      'install.yaml must bake in the POST-gate pushed digest (steps.push.outputs.digest)',
    ).toBe(true);
  });

  it('the operator-latest release attach comes after gate, push, sign and verify', () => {
    const releaseIdx = stepIndex(RELEASE_RE);
    expect(releaseIdx, 'expected the softprops/action-gh-release step').toBeGreaterThanOrEqual(0);
    for (const [what, re] of [
      ['the Trivy gate', TRIVY_RE],
      ['the push', PUSH_RE],
      ['cosign sign', SIGN_RE],
      ['cosign verify', VERIFY_RE],
    ] as const) {
      expect(
        stepIndex(re),
        `the release-attach step must come after ${what} — a scan-failed run must not update the release asset`,
      ).toBeLessThan(releaseIdx);
    }
    const release = stepBlock(RELEASE_RE);
    expect(
      /if:\s*github\.ref\s*==\s*'refs\/heads\/main'/.test(release),
      'the release-attach step must be gated to main',
    ).toBe(true);
  });
});

// ── #202 (folded in): SHA-pin the actions that gate publication ────────────────
// aquasecurity/trivy-action@master was the scan GATE in a job holding
// packages:write + id-token:write — a compromised @master could push/sign with
// this repo's OIDC identity. Pin BOTH scan-path actions to full commit SHAs in
// BOTH supply-chain workflows (repo pattern: setup-bun is SHA-pinned), with a
// `# vX.Y.Z` provenance comment so bumps stay deliberate.

describe('supply-chain actions are SHA-pinned in both workflows (#202)', () => {
  const PINNED = [
    [/uses:\s*aquasecurity\/trivy-action@([^\s#]+)/g, 'aquasecurity/trivy-action'],
    [/uses:\s*anchore\/sbom-action@([^\s#]+)/g, 'anchore/sbom-action'],
  ] as const;

  for (const [label, path] of [
    ['operator-supply-chain.yml', OPERATOR_WORKFLOW_PATH],
    ['supply-chain.yml', APP_WORKFLOW_PATH],
  ] as const) {
    it(`${label}: trivy-action + sbom-action are pinned to full commit SHAs`, () => {
      const text = readFileSync(path, 'utf8');
      for (const [re, name] of PINNED) {
        const matches = [...text.matchAll(new RegExp(re.source, 'g'))];
        expect(matches.length, `expected at least one ${name} usage in ${label}`).toBeGreaterThan(
          0,
        );
        for (const m of matches) {
          expect(
            /^[0-9a-f]{40}$/.test(m[1]),
            `${name} in ${label} must be pinned to a 40-hex commit SHA (got @${m[1]})`,
          ).toBe(true);
        }
      }
    });
  }
});
