/**
 * The Go zone-function template (templates/go) stays in lockstep with the
 * contract `knext add function` writes, and its CI keeps the supply-chain
 * gates in the order that makes them gates.
 *
 * Proto is the single source of truth: the template's contract must be the
 * bytes `contractFor('example')` produces, and its copy of the knext options
 * contract must be the one @getknext/grpc ships. The generated Go in
 * templates/go/gen is checked against the proto by `buf generate` in the
 * template's workflow (a regenerate-then-diff), not here.
 *
 * The workflow half asserts the supply-chain ORDER for the template image:
 * Trivy (HIGH/CRITICAL, exit 1) runs before any push or signature, and every
 * push/sign step is gated to a publish ref, so a scan-failed image is never
 * pushed or signed and a PR image is never signed.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { contractFor, packagedOptionsProto } from '../packages/grpc/src/add-function';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const TEMPLATE = resolve(REPO_ROOT, 'templates/go');
const read = (rel: string) => readFileSync(resolve(TEMPLATE, rel), 'utf8');

describe('the Go template contract is the one `knext add function` writes', () => {
  it('proto/example/v1/example.proto is contractFor("example"), byte for byte', () => {
    expect(read('proto/example/v1/example.proto')).toBe(contractFor('example'));
  });

  it('proto/knext/v1/options.proto is the options contract @getknext/grpc ships', () => {
    expect(read('proto/knext/v1/options.proto')).toBe(packagedOptionsProto());
  });

  it('buf.yaml matches the lint and breaking rules apps get', () => {
    expect(read('buf.yaml')).toBe(
      readFileSync(resolve(REPO_ROOT, 'packages/grpc/buf.yaml'), 'utf8'),
    );
  });

  it('the Go module pins connect-go v2 and generates with its v2 plugin', () => {
    const goMod = read('go.mod');
    expect(goMod).toMatch(/^\tconnectrpc\.com\/connect\/v2 v2\.\d+\.\d+$/m);
    expect(goMod).toMatch(/^\tconnectrpc\.com\/connect\/v2\/cmd\/protoc-gen-connect-go$/m);
    expect(read('buf.gen.yaml')).toContain('local: ["go", "tool", "protoc-gen-connect-go"]');
  });

  it('the Dockerfile builds on the Go point release go.mod names', () => {
    const goLine = read('go.mod').match(/^go (\d+\.\d+\.\d+)$/m);
    expect(goLine, 'go.mod has no `go X.Y.Z` line').not.toBeNull();
    const version = (goLine as RegExpMatchArray)[1];
    expect(read('Dockerfile')).toMatch(
      new RegExp(
        `^FROM golang:${version.replaceAll('.', '\\.')}@sha256:[0-9a-f]{64} AS build$`,
        'm',
      ),
    );
    expect(read('Dockerfile')).toMatch(
      /^FROM gcr\.io\/distroless\/static:nonroot@sha256:[0-9a-f]{64}$/m,
    );
  });
});

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  steps: Step[];
  needs?: string[];
  if?: string;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
};

// The refs that publish. The publish job's job-level `if` and the image job's
// PUBLISH (which gates saving the scanned image) must both be exactly this.
const PUBLISH_REF =
  "github.event_name == 'push' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/integration/'))";

const isPublishing = (s: Step) =>
  /docker push|cosign (sign|attest|verify)/.test(s.run ?? '') ||
  (s.uses ?? '').startsWith('docker/login-action@') ||
  (s.uses ?? '').startsWith('sigstore/cosign-installer@');

describe('the template image workflow gates before it publishes', () => {
  const wf = parse(
    readFileSync(resolve(REPO_ROOT, '.github/workflows/go-template.yml'), 'utf8'),
  ) as {
    on: Record<string, unknown>;
    permissions?: Record<string, string>;
    jobs: Record<string, Job>;
  };
  const image = wf.jobs.image;
  const publishJob = wf.jobs.publish;
  const find = (job: Job, name: string, pred: (s: Step) => boolean, what: string) => {
    expect(job, `no ${name} job`).toBeDefined();
    const i = job.steps.findIndex(pred);
    expect(i, `no ${what} step in the ${name} job`).toBeGreaterThanOrEqual(0);
    return i;
  };
  const trivyStep = (s: Step) => s.uses?.startsWith('aquasecurity/trivy-action@') ?? false;

  it('scans with Trivy and fails on HIGH/CRITICAL, on every event', () => {
    const trivy = image.steps[find(image, 'image', trivyStep, 'Trivy')];
    expect(trivy.with?.severity).toBe('HIGH,CRITICAL');
    expect(String(trivy.with?.['exit-code'])).toBe('1');
    expect(trivy.if, 'the Trivy gate must run on every event').toBeUndefined();
    expect(image.if, 'the image job must run on every event').toBeUndefined();
    expect(wf.on).toHaveProperty('pull_request');
  });

  it('the job that runs on pull requests holds no write credential and publishes nothing', () => {
    expect(image.permissions).toEqual({ contents: 'read' });
    expect(wf.permissions).toEqual({ contents: 'read' });
    const publishing = image.steps.filter(isPublishing).map((s) => s.name);
    expect(publishing, 'the image job pushes or signs').toEqual([]);
  });

  it('only the publish job holds write credentials, gated at job level to a publish ref', () => {
    for (const [name, job] of Object.entries(wf.jobs)) {
      const writes = Object.entries(job.permissions ?? {}).filter(([, v]) => v === 'write');
      if (name === 'publish') continue;
      expect(writes, `${name} holds a write permission`).toEqual([]);
      expect(job.permissions, `${name} inherits the workflow's permissions`).toBeDefined();
    }
    expect(publishJob.permissions).toEqual({ packages: 'write', 'id-token': 'write' });
    expect(publishJob.if).toBe(PUBLISH_REF);
    expect(image.env?.PUBLISH).toBe(`\${{ ${PUBLISH_REF} }}`);
  });

  it('the publish job runs no PR-controllable code: no checkout, no local action, SHA-pinned actions', () => {
    for (const s of publishJob.steps) {
      if (s.uses === undefined) continue;
      expect(s.uses, `${s.name} checks out the repository`).not.toMatch(/^actions\/checkout@/);
      expect(s.uses, `${s.name} runs a local action`).not.toMatch(/^\.\//);
      expect(s.uses, `${s.name} is not pinned by commit SHA`).toMatch(
        /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/,
      );
    }
  });

  it('writes an SBOM before the gate and saves the scanned image only after it, on a publish ref', () => {
    const sbom = find(
      image,
      'image',
      (s) => s.uses?.startsWith('anchore/sbom-action@') ?? false,
      'SBOM',
    );
    const trivy = find(image, 'image', trivyStep, 'Trivy');
    expect(sbom).toBeLessThan(trivy);
    const save = find(
      image,
      'image',
      (s) => s.run?.includes('docker save') ?? false,
      'docker save',
    );
    const upload = find(
      image,
      'image',
      (s) => (s.uses ?? '').startsWith('actions/upload-artifact@') && s.with?.path === 'image.tar',
      'upload the image',
    );
    for (const i of [save, upload]) {
      expect(i, `${image.steps[i].name} runs before the Trivy gate`).toBeGreaterThan(trivy);
      expect(image.steps[i].if).toBe("env.PUBLISH == 'true'");
    }
    expect(save).toBeLessThan(upload);
    expect(image.steps[save].id).toBe('save');
    expect(image.outputs?.['image-id']).toBe('${{ steps.save.outputs.image-id }}');
    expect(image.steps[save].run).toContain("docker inspect --format '{{.Id}}'");
  });

  it('publishes exactly the scanned image: load, refuse a different ID, then push, sign, verify', () => {
    expect(publishJob.needs).toEqual(['image']);
    expect(publishJob.env?.SCANNED_ID).toBe('${{ needs.image.outputs.image-id }}');
    const download = find(
      publishJob,
      'publish',
      (s) =>
        (s.uses ?? '').startsWith('actions/download-artifact@') &&
        String(s.with?.name).startsWith('go-template-image-'),
      'download the image',
    );
    const load = find(
      publishJob,
      'publish',
      (s) => s.run?.includes('docker load') ?? false,
      'docker load',
    );
    expect(publishJob.steps[load].run).toContain('"$loaded" != "$SCANNED_ID"');
    const push = find(
      publishJob,
      'publish',
      (s) => s.run?.includes('docker push') ?? false,
      'push',
    );
    const sign = find(
      publishJob,
      'publish',
      (s) => s.run?.includes('cosign sign --yes') ?? false,
      'sign',
    );
    const verify = find(
      publishJob,
      'publish',
      (s) => s.run?.includes('cosign verify ') ?? false,
      'verify',
    );
    expect(download).toBeLessThan(load);
    expect(load).toBeLessThan(push);
    expect(push).toBeLessThan(sign);
    expect(sign).toBeLessThan(verify);
    expect(publishJob.steps.filter(isPublishing).length).toBeGreaterThanOrEqual(5);
    expect(publishJob.steps[sign].run).toContain(
      'cosign attest --yes --predicate sbom.spdx.json --type spdxjson',
    );
  });

  it('signs keylessly by digest and verifies against this workflow identity', () => {
    const sign = publishJob.steps.find((s) => s.run?.includes('cosign sign --yes'));
    expect(sign?.run).toMatch(/"\$\{IMAGE\}@\$\{DIGEST\}"/);
    const verify = publishJob.steps.find((s) => s.run?.includes('cosign verify '));
    expect(verify?.run).toContain('cosign verify-attestation');
    expect(verify?.run).toContain(
      '--certificate-oidc-issuer https://token.actions.githubusercontent.com',
    );
  });

  it('the check job runs the tests, the drift check and govulncheck', () => {
    const runs = wf.jobs.check.steps.map((s) => s.run ?? '').join('\n');
    expect(runs).toContain('go test -race -count=1 ./...');
    expect(runs).toMatch(/go run golang\.org\/x\/vuln\/cmd\/govulncheck@v\d+\.\d+\.\d+ \.\/\.\.\./);
    expect(runs).toContain('verified-buf.ts generate');
    expect(runs).toContain('git status --porcelain -- gen');
  });

  it('the image and kind-e2e jobs need the check job', () => {
    expect(image.needs).toEqual(['check']);
    expect(wf.jobs['kind-e2e'].needs).toEqual(['check']);
  });
});
