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
// The gate-ordered publish step is a crane push of the scanned OCI layout
// (#202); `docker push` would mean the flow regressed to the daemon store,
// which cannot carry the buildkit provenance manifest.
const PUSH_RE = /crane\s+push\b/;
const ANY_PUSH_RE = /(?:crane|docker)\s+push\b/;
const SIGN_RE = /cosign\s+sign\b/;
const VERIFY_RE = /cosign-verify\.sh/;
const INSTALLER_RE = /make\s+build-installer/;
const RELEASE_RE = /uses:\s*softprops\/action-gh-release/;
// A `push:` input that enables a registry push (anything but a literal false on
// the SAME line — `[^\S\n]` keeps \s from crossing into the next line, which
// would false-positive on the bare `push:` workflow trigger key).
const PUSH_INPUT_RE = /^\s*push:[^\S\n]*(?!false\b)\S/m;

/** The OCI-layout directory the build step writes (`outputs: type=oci,dest=…`). */
function buildLayoutDest(): string {
  const build = stepBlock(BUILD_RE);
  const m = stripComments(build).match(/^\s*outputs:\s*type=oci,dest=([^,\s]+)/m);
  return m?.[1] ?? '';
}

describe('operator-supply-chain workflow: nothing is published before the Trivy gate (#201)', () => {
  it('the build step builds LOCALLY only — an OCI layout, never a push, on any ref', () => {
    const build = stepBlock(BUILD_RE);
    expect(build, 'expected a docker/build-push-action step').not.toBe('');
    // #202: the local `docker` exporter (load: true) cannot carry the buildkit
    // provenance manifest — the build must export an OCI layout DIRECTORY
    // (tar=false: Trivy's --input rejects OCI tarballs) that is scanned in
    // place and crane-pushed byte-for-byte after the gate.
    expect(
      /^\s*outputs:\s*type=oci,dest=\S+,tar=false\s*$/m.test(stripComments(build)),
      'the build step must export an OCI layout directory (outputs: type=oci,dest=…,tar=false)',
    ).toBe(true);
    expect(
      /^\s*load:\s*true\s*$/m.test(stripComments(build)),
      'the build step must not also load into the docker store — the OCI layout is the single scan+push source',
    ).toBe(false);
    expect(
      PUSH_INPUT_RE.test(stripComments(build)),
      'the build step must not set push (or must set push: false) — publication happens only after the Trivy gate',
    ).toBe(false);
  });

  it('the Trivy gate scans the exact OCI layout that gets pushed, BEFORE any push', () => {
    const trivyIdx = stepIndex(TRIVY_RE);
    const pushIdx = stepIndex(PUSH_RE);
    expect(trivyIdx, 'expected a Trivy scan step').toBeGreaterThanOrEqual(0);
    expect(pushIdx, 'expected an explicit push step (crane push)').toBeGreaterThanOrEqual(0);
    expect(trivyIdx, 'the Trivy gate must come before the push step').toBeLessThan(pushIdx);
    // The gate must consume the SAME layout directory the build wrote — that
    // is the scan-the-bytes-you-push invariant in one line.
    const dest = buildLayoutDest();
    expect(dest, 'expected the build step to declare an OCI layout dest').not.toBe('');
    const trivy = stepBlock(TRIVY_RE);
    expect(
      new RegExp(`^\\s*input:\\s*${dest}\\s*$`, 'm').test(stripComments(trivy)),
      `the Trivy step must scan the build's OCI layout via input: ${dest}`,
    ).toBe(true);
    // Belt-and-braces: no step before the gate may push (crane/docker push or
    // a build-push-action push: input that is not literally false).
    for (const block of stepBlocks().slice(0, trivyIdx)) {
      const content = stripComments(block);
      expect(
        ANY_PUSH_RE.test(content),
        'no step before the Trivy gate may run `crane push`/`docker push`',
      ).toBe(false);
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

  it('the push step is main-gated, crane-pushes the scanned layout, and captures the PUSHED digest fail-loud', () => {
    const push = stepBlock(PUSH_RE);
    expect(push, 'expected a crane push step').not.toBe('');
    expect(
      /if:\s*github\.ref\s*==\s*'refs\/heads\/main'/.test(push),
      'the push step must be gated to main',
    ).toBe(true);
    expect(/^\s*id:\s*push\s*$/m.test(push), 'the push step must have id: push').toBe(true);
    const dest = buildLayoutDest();
    expect(
      new RegExp(`crane\\s+push\\s+"?${dest}"?\\s`).test(stripComments(push)),
      `the push step must crane-push the exact layout Trivy scanned (${dest})`,
    ).toBe(true);
    expect(
      /digest=.*GITHUB_OUTPUT|>>\s*"?\$GITHUB_OUTPUT"?/.test(push) && /digest/i.test(push),
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
    // #203 gate follow-up: stepIndex() returns -1 on a missing step, which
    // would satisfy any toBeLessThan ordering assert vacuously — existence
    // must be asserted before order.
    expect(signIdx, 'expected a cosign sign step').toBeGreaterThanOrEqual(0);
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
    // #203 gate follow-up: -1 (step missing) must not vacuously pass the order.
    expect(trivyIdx, 'expected a Trivy scan step').toBeGreaterThanOrEqual(0);
    expect(pushIdx, 'expected an explicit push step (crane push)').toBeGreaterThanOrEqual(0);
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
      const idx = stepIndex(re);
      // #203 gate follow-up: a missing step (-1) must fail on existence, never
      // vacuously satisfy the ordering assert.
      expect(idx, `expected ${what} step to exist`).toBeGreaterThanOrEqual(0);
      expect(
        idx,
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

// ── #202: buildkit provenance restored via OCI-layout build + crane push ───────
// PR #203 moved the operator build to the local docker exporter (load: true) so
// Trivy gates the exact bytes before any publish — but that exporter cannot
// carry buildkit's provenance attestation manifest, so `provenance: false` was
// set and the drop documented in docs/security/threat-model.md. The restore
// path (noted there): export an OCI layout (which CAN carry the attestation),
// scan the layout in place, and crane-push the layout byte-for-byte after the
// gate.

// The provenance-check step is the one that runs `crane manifest` AND greps for
// the attestation manifest (the SBOM-view step also mentions attestation-manifest
// in its jq filter, so the matcher must require both).
const PROV_CHECK_RE = /crane\s+manifest[\s\S]*attestation-manifest/;

describe('operator buildkit provenance is restored without weakening the gate (#202)', () => {
  it('the build step enables provenance (mode=max) — provenance: false is banned', () => {
    const build = stripComments(stepBlock(BUILD_RE));
    expect(
      /^\s*provenance:\s*mode=max\s*$/m.test(build),
      'the build step must set provenance: mode=max (no secret build-args; max records the full build definition + materials)',
    ).toBe(true);
    expect(
      /^\s*provenance:\s*false\s*$/m.test(stripComments(workflowText())),
      'provenance: false must be gone from the workflow',
    ).toBe(false);
  });

  it('crane is version-pinned AND checksum-verified before it may push (same discipline as the #202 action pins)', () => {
    const crane = stepBlock(/CRANE_VERSION/);
    expect(crane, 'expected a crane install step (CRANE_VERSION env)').not.toBe('');
    expect(
      /CRANE_VERSION:\s*v\d+\.\d+\.\d+/.test(crane),
      'crane must be pinned to an exact version',
    ).toBe(true);
    expect(
      /CRANE_SHA256:\s*[0-9a-f]{64}/.test(crane),
      'the crane tarball must be pinned by sha256',
    ).toBe(true);
    expect(
      /sha256sum\s+(-c|--check)/.test(stripComments(crane)),
      'the crane install must verify the checksum (sha256sum -c) before installing',
    ).toBe(true);
    // #203 gate follow-up: assert existence before order (-1 passes vacuously).
    const craneIdx = stepIndex(/CRANE_VERSION/);
    const pushIdx = stepIndex(PUSH_RE);
    expect(craneIdx, 'expected a crane install step (CRANE_VERSION)').toBeGreaterThanOrEqual(0);
    expect(pushIdx, 'expected an explicit push step (crane push)').toBeGreaterThanOrEqual(0);
    expect(craneIdx, 'crane must be installed before the push step').toBeLessThan(pushIdx);
  });

  it('the SBOM is generated from the same OCI layout blobs (oci-dir source), not the docker daemon', () => {
    const sbom = stepBlock(/uses:\s*anchore\/sbom-action/);
    expect(sbom, 'expected an anchore/sbom-action step').not.toBe('');
    expect(
      /^\s*image:\s*oci-dir:\S+/m.test(stripComments(sbom)),
      'sbom-action must scan an oci-dir: source (the image no longer exists in the docker daemon)',
    ).toBe(true);
  });

  it('a post-push step asserts the provenance attestation SURVIVED the push, fail-loud, before signing', () => {
    const check = stepBlock(PROV_CHECK_RE);
    expect(
      check,
      'expected a post-push provenance check step (crane manifest → attestation-manifest)',
    ).not.toBe('');
    const checkIdx = stepIndex(PROV_CHECK_RE);
    // #203 gate follow-up: assert existence before order (-1 passes vacuously).
    const pushIdx = stepIndex(PUSH_RE);
    const signIdx = stepIndex(SIGN_RE);
    expect(pushIdx, 'expected an explicit push step (crane push)').toBeGreaterThanOrEqual(0);
    expect(signIdx, 'expected a cosign sign step').toBeGreaterThanOrEqual(0);
    expect(checkIdx, 'the provenance check must come after the push').toBeGreaterThan(pushIdx);
    expect(
      checkIdx,
      'the provenance check must gate signing (sign only provenance-bearing images)',
    ).toBeLessThan(signIdx);
    const content = stripComments(check);
    expect(
      /if:\s*github\.ref\s*==\s*'refs\/heads\/main'/.test(check),
      'the provenance check must be main-gated (nothing was pushed on PRs)',
    ).toBe(true);
    expect(
      /steps\.push\.outputs\.digest/.test(check),
      'the provenance check must inspect the digest that was actually pushed',
    ).toBe(true);
    expect(/crane\s+manifest\b/.test(content), 'must inspect via crane manifest').toBe(true);
    expect(
      /slsa\.dev\/provenance/.test(content),
      'must assert the SLSA provenance predicate is present, not just any attestation manifest',
    ).toBe(true);
    expect(/exit\s+1/.test(content), 'the provenance check must fail loud').toBe(true);
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
