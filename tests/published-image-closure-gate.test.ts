import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AUDIT_SCRIPT,
  auditedAppDirs,
  loadWorkflows,
  parseWorkflow,
  publishingVinextJobs,
  vinextAppDirs,
} from './helpers/vinext-artifact-scan';

/**
 * C1 / #785 — WHAT THE PUBLISHED IMAGE'S ATTESTATION ACTUALLY ASSERTS.
 *
 * The defect this file exists to keep closed: `supply-chain.yml` builds
 * `apps/file-manager`'s image (a `bun build --compile` single executable),
 * Trivy-scans it, pushes it to GHCR, cosign-signs the digest, and then
 * `cosign attest`s an SBOM — and that SBOM was syft's view of the IMAGE, which
 * for this artifact shape is an Alpine package DB plus one ~70 MB opaque blob.
 * Every JS dependency (react, next, vinext, nitro, the app) is inside the blob.
 * So the attestation was signed, verifiable, and vacuous. A signed attestation
 * asserting nothing is WORSE than no attestation: it makes an absent control
 * look audited.
 *
 * ADR-0042 C6 built the right gate — the PRE-COMPILE closure SBOM + scan — but
 * scoped it to `examples/bun-exec`, and `tests/precompile-closure-gate-ci.test.ts`
 * says so verbatim ("A USER app built on the vinext target has no equivalent
 * gate"). That test's ordering scan keys on jobs that mention `examples/bun-exec`
 * and credits only jobs in the transitive `needs` closure, so the publish lane —
 * a different app, auditing in-job — is invisible to it. This file is the half
 * it cannot see, and the two are deliberately separate rather than merged:
 * widening the C6 scan to every vinext image build would also demand a `needs:`
 * on ci.yml's local-only `prod-image-optimization` probe, which is a different
 * (and lower) risk than a PUBLISHED, SIGNED, ATTESTED image.
 *
 * SCANNED, NOT ENUMERATED, on both axes:
 *   - the set of vinext apps comes from reading package.json files (any app that
 *     declares `vinext`), so a second one is covered the day it lands;
 *   - the set of publish lanes comes from parsing every workflow for a job that
 *     pushes an image, so a new publish lane is covered without a list edit.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SUPPLY_CHAIN = '.github/workflows/supply-chain.yml';
/** The document the publish lane must attest — written by the audit's --app mode. */
const CLOSURE_SBOM = 'sbom/app-closure.cdx.json';

describe('the vinext app set is discovered, not listed', () => {
  it('finds the apps that build on vinext by reading their manifests', () => {
    const dirs = vinextAppDirs(REPO_ROOT);
    expect(dirs, 'the reference app must be discovered').toContain('apps/file-manager');
    expect(dirs, 'the in-repo example must be discovered').toContain('examples/bun-exec');
  });

  it('does not discover an app that has no vinext dependency', () => {
    // Non-vacuity: if the matcher returned every directory, the guard below
    // would be trivially satisfiable.
    expect(vinextAppDirs(REPO_ROOT)).not.toContain('apps/db-demo');
  });
});

describe('every job that PUBLISHES a vinext image audits that app’s closure first', () => {
  it('finds the real publish lane (non-vacuity)', () => {
    const hits = publishingVinextJobs(loadWorkflows(REPO_ROOT), vinextAppDirs(REPO_ROOT));
    expect(
      hits.map((h) => `${h.workflow}:${h.job}`),
      'no job that pushes a vinext image was found — the scan is not reading the workflows',
    ).toContain(`${SUPPLY_CHAIN}:image-supply-chain`);
  });

  it('audits the app it actually publishes — not some other app’s closure', () => {
    for (const hit of publishingVinextJobs(loadWorkflows(REPO_ROOT), vinextAppDirs(REPO_ROOT))) {
      for (const app of hit.appDirs) {
        expect(
          hit.auditedAppDirs,
          `${hit.workflow}:${hit.job} pushes a vinext image built from ${app}, but nothing in ` +
            `that job (or its \`needs\` closure) runs ${AUDIT_SCRIPT} against ${app}. The pushed ` +
            'image would be signed and SBOM-attested with a document that cannot see its JS closure.',
        ).toContain(app);
      }
    }
  });

  it('runs the audit BEFORE the image is built, not after', () => {
    for (const hit of publishingVinextJobs(loadWorkflows(REPO_ROOT), vinextAppDirs(REPO_ROOT))) {
      expect(
        hit.auditBeforeBuild,
        `${hit.workflow}:${hit.job} runs the closure audit at or after the image build. A scan ` +
          'that runs afterwards cannot stop the build; ADR-0042 C6 requires the closure be clean ' +
          'before the opaque binary exists.',
      ).toBe(true);
    }
  });

  it('REDS when the audit is scoped back down to the other app (mutation)', () => {
    // The exact regression this task closes: the gate exists, but pointed at
    // examples/bun-exec while the publish lane ships apps/file-manager.
    const synthetic = parseWorkflow(
      SUPPLY_CHAIN,
      [
        'jobs:',
        '  image-supply-chain:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        `      - run: node ${AUDIT_SCRIPT} --closure examples/bun-exec`,
        '      - uses: docker/build-push-action@aaaa',
        '        with:',
        '          file: apps/file-manager/Dockerfile',
        '      - run: crane push image-oci "${IMAGE}:${GITHUB_SHA}"',
      ].join('\n'),
    );
    const [hit] = publishingVinextJobs([synthetic], ['apps/file-manager', 'examples/bun-exec']);
    expect(hit.appDirs, 'the lane builds file-manager').toContain('apps/file-manager');
    expect(
      hit.auditedAppDirs,
      'a lane auditing examples/bun-exec while publishing apps/file-manager must NOT be credited',
    ).not.toContain('apps/file-manager');
  });

  it('credits an audit that runs in a separate job in the `needs` closure', () => {
    const synthetic = parseWorkflow(
      '.github/workflows/publish.yml',
      [
        'jobs:',
        '  closure:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        `      - run: node ${AUDIT_SCRIPT} --app apps/file-manager`,
        '  publish:',
        '    needs: closure',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: docker/build-push-action@aaaa',
        '        with:',
        '          file: apps/file-manager/Dockerfile',
        '          push: true',
      ].join('\n'),
    );
    const [hit] = publishingVinextJobs([synthetic], ['apps/file-manager']);
    expect(hit.auditedAppDirs).toContain('apps/file-manager');
    expect(hit.auditBeforeBuild, 'a separate gating job is trivially before the build').toBe(true);
  });

  it('does NOT credit an audit step that runs after the build in the same job', () => {
    const synthetic = parseWorkflow(
      '.github/workflows/publish.yml',
      [
        'jobs:',
        '  publish:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: docker/build-push-action@aaaa',
        '        with:',
        '          file: apps/file-manager/Dockerfile',
        '          push: true',
        `      - run: node ${AUDIT_SCRIPT} --app apps/file-manager`,
      ].join('\n'),
    );
    const [hit] = publishingVinextJobs([synthetic], ['apps/file-manager']);
    expect(hit.auditBeforeBuild).toBe(false);
  });

  it('parses --app and --closure alike when reading which app was audited', () => {
    expect(auditedAppDirs(`node ${AUDIT_SCRIPT} --app apps/file-manager`)).toEqual([
      'apps/file-manager',
    ]);
    expect(auditedAppDirs(`node ${AUDIT_SCRIPT} --closure examples/bun-exec`)).toEqual([
      'examples/bun-exec',
    ]);
    // A bare mention of the path, with no audit invocation, is NOT an audit.
    expect(auditedAppDirs('working-directory: apps/file-manager')).toEqual([]);
  });
});

describe('the attestation predicate is the closure SBOM (#785)', () => {
  const text = () => readFileSync(resolve(REPO_ROOT, SUPPLY_CHAIN), 'utf8');

  it('cosign-attests the closure SBOM onto the pushed digest', () => {
    const workflow = text();
    expect(
      workflow,
      `${SUPPLY_CHAIN} must attest ${CLOSURE_SBOM} — the document that describes the JS actually ` +
        'compiled into the binary. Without it the only attested SBOM is the image scan, which for ' +
        'a compiled single executable sees an Alpine package DB and one opaque blob.',
    ).toContain(CLOSURE_SBOM);
    const attestations = workflow
      .split('\n')
      .filter((line) => line.includes('cosign attest') || line.includes('--predicate'));
    expect(
      attestations.join('\n'),
      'the closure SBOM is mentioned in the workflow but is not a `cosign attest` predicate',
    ).toContain(CLOSURE_SBOM);
  });

  it('attests it as CycloneDX — the format the audit emits', () => {
    // Attesting a CycloneDX document under `--type spdxjson` produces an
    // attestation whose predicateType lies about its own contents.
    const line = text()
      .split('\n')
      .find((l) => l.includes('--predicate') && l.includes(CLOSURE_SBOM));
    expect(line, 'no attest line for the closure SBOM').toBeDefined();
    expect(line, 'the closure SBOM is CycloneDX; attest it as such').toContain('cyclonedx');
  });

  it('labels the image-level SBOM honestly where one is still produced', () => {
    // Keeping the image SBOM is fine — it is the only thing covering the Alpine
    // base packages (musl, libstdc++, libgcc). Presenting it as the image's
    // software bill of materials is not. The label is the control here, so the
    // label is what is asserted.
    const workflow = text();
    if (!workflow.includes('sbom.spdx.json')) return; // retired entirely — also acceptable
    const labels = workflow
      .split('\n')
      .filter((line) => /^\s*(- )?name:/.test(line) && /SBOM/i.test(line));
    expect(
      labels.join('\n'),
      'the image-level SBOM step must say in its NAME that it does not see the compiled JS ' +
        'closure — an unqualified "Generate SBOM" is the label that made a vacuous document read ' +
        'as complete',
    ).toMatch(/OS packages only|does not see|no JS closure/i);
  });
});
