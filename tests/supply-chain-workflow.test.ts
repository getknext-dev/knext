import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD TESTS for .github/workflows/supply-chain.yml (#199).
 *
 * The workflow used to push the file-manager image to GHCR *before* the Trivy
 * HIGH/CRITICAL gate ran (build-push-action with `push: true` on main), and
 * cosign signing only happened after Trivy passed. Net effect when Trivy
 * failed: the newest published app digest in ghcr was one that FAILED the scan
 * and carried NO signature — inverting security.md's supply-chain rule ("scan
 * every image, fail the build on HIGH/CRITICAL, sign what we ship"). Observed
 * on main run 28649365278 (file-manager@sha256:f12fc7c6…).
 *
 * The invariant these tests lock in: **a scan-failed image is never pullable
 * at a stable tag and never signed.** Concretely:
 *   build (local only) → SBOM → Trivy gate → push (main only) → cosign sign →
 *   verify — in that order, with the push/sign parameterized by the digest of
 *   the image that was actually pushed after the gate.
 *
 * Implementation note: like tests/compat-suite-workflow.test.ts, this scans
 * the workflow YAML as text (step blocks split at `- name:`/`- uses:`
 * boundaries) so the test adds no runtime YAML dependency.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/supply-chain.yml');
const DOCKERFILE_PATH = resolve(REPO_ROOT, 'apps/file-manager/Dockerfile');
const ROOT_PKG_PATH = resolve(REPO_ROOT, 'package.json');
const LOCKFILE_PATH = resolve(REPO_ROOT, 'pnpm-lock.yaml');

function workflowText(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
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
// A `push:` input that enables a registry push (anything but a literal false on
// the SAME line — `[^\S\n]` keeps \s from crossing into the next line, which
// would false-positive on the bare `push:` workflow trigger key).
const PUSH_INPUT_RE = /^\s*push:[^\S\n]*(?!false\b)\S/m;

describe('supply-chain workflow: nothing is published before the Trivy gate (#199)', () => {
  it('the build step builds LOCALLY only — it never pushes, on any ref', () => {
    const build = stepBlock(BUILD_RE);
    expect(build, 'expected a docker/build-push-action step').not.toBe('');
    // The regression: `push: ${{ github.ref == 'refs/heads/main' }}` published
    // the image before the scan. The build step must load into the local docker
    // store unconditionally and never push.
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

  it('the push step is main-gated, comes after the gate, and captures the PUSHED digest', () => {
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
    expect(
      /steps\.build\.outputs\.digest/.test(sign),
      'the sign step must NOT reference the pre-gate build digest',
    ).toBe(false);
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
});

// ── The CVE fixes that unblock the first green main run (#199 part 2) ──────────
// Run 28649365278's Trivy report: 17 HIGH/CRITICAL findings in the shipped image.
// Two buckets:
//   (a) app-tree deps under node_modules/@knext/core (via @knext/lib →
//       @cerbos/grpc, minio; and @google-cloud/storage): @grpc/grpc-js 1.14.3,
//       fast-xml-parser 4.5.3 + 5.3.5, form-data 2.5.5, lodash 4.17.23,
//       protobufjs 7.5.4 → fixed via pnpm overrides (same discipline as the
//       operator CVE fix in #155: bump deps, don't suppress).
//   (b) the node:22-alpine base image's BUNDLED npm ships sigstore 3.1.0
//       (CVE-2026-48815) and picomatch 4.0.3 (CVE-2026-33671). The runtime
//       never runs npm/corepack/yarn — strip them from the runner stage.

describe('file-manager image CVE remediation (#199)', () => {
  it('the runner stage strips npm/corepack/yarn (the sigstore + picomatch findings)', () => {
    const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8');
    // Only the FINAL stage matters to Trivy — take the text after the last FROM.
    const runnerStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    expect(
      /rm\s+-rf[^\n\\]*(\\\n[^\n]*)*\/usr\/local\/lib\/node_modules\/npm\b/.test(
        runnerStage.replace(/\\\n/g, ' '),
      ),
      'the runner stage must remove the bundled npm (ships vulnerable sigstore/picomatch)',
    ).toBe(true);
    const flattened = runnerStage.replace(/\\\n/g, ' ');
    expect(/rm\s+-rf[^\n]*corepack/.test(flattened), 'the runner stage must remove corepack').toBe(
      true,
    );
    expect(/rm\s+-rf[^\n]*yarn/.test(flattened), 'the runner stage must remove yarn').toBe(true);
  });

  it('root package.json pins pnpm overrides for every flagged app-tree package', () => {
    const pkg = JSON.parse(readFileSync(ROOT_PKG_PATH, 'utf8')) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    const overrides = pkg.pnpm?.overrides ?? {};
    const required: Array<[selectorRe: RegExp, minVersionRe: RegExp, why: string]> = [
      [/^@grpc\/grpc-js/, /1\.14\.([4-9]|\d{2,})/, 'CVE-2026-48068/48069 fixed in 1.14.4'],
      [/^fast-xml-parser@.*4/, /4\.5\.([5-9]|\d{2,})/, 'CVE-2026-25896/26278/33036 fixed in 4.5.5'],
      [
        /^fast-xml-parser@.*5/,
        /5\.(5\.([6-9]|\d{2,})|[6-9]\.)/,
        'CVE-2026-26278/33036 fixed in 5.5.6',
      ],
      [/^form-data/, /2\.5\.([6-9]|\d{2,})/, 'CVE-2026-12143 fixed in 2.5.6'],
      [/^lodash/, /4\.(1[8-9]|[2-9]\d)\./, 'CVE-2026-4800 fixed in 4.18.0'],
      [/^protobufjs/, /7\.([6-9]|\d{2,})\./, 'CVE-2026-41242/44289…/48712 fixed in 7.6.1'],
    ];
    for (const [selectorRe, minVersionRe, why] of required) {
      const entry = Object.entries(overrides).find(([k]) => selectorRe.test(k));
      expect(entry, `expected a pnpm override matching ${selectorRe} (${why})`).toBeTruthy();
      const [key, value] = entry as [string, string];
      expect(
        minVersionRe.test(value),
        `override "${key}": "${value}" must pin at least the fixed version (${why})`,
      ).toBe(true);
    }
  });

  it('the lockfile no longer resolves any of the flagged vulnerable versions', () => {
    const lock = readFileSync(LOCKFILE_PATH, 'utf8');
    const banned = [
      'fast-xml-parser@4.5.3:',
      'fast-xml-parser@5.3.5:',
      "'@grpc/grpc-js@1.14.3'",
      'form-data@2.5.5:',
      'lodash@4.17.23:',
      'protobufjs@7.5.4:',
    ];
    for (const needle of banned) {
      expect(
        lock.includes(needle),
        `pnpm-lock.yaml must not still resolve ${needle.replace(/[:']/g, '')} (Trivy HIGH/CRITICAL)`,
      ).toBe(false);
    }
  });
});
