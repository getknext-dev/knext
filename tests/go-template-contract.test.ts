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
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
};
type Job = { steps: Step[]; needs?: string[]; permissions?: Record<string, string> };

describe('the template image workflow gates before it publishes', () => {
  const wf = parse(
    readFileSync(resolve(REPO_ROOT, '.github/workflows/go-template.yml'), 'utf8'),
  ) as {
    jobs: Record<string, Job>;
  };
  const image = wf.jobs.image;
  const steps = image.steps;
  const index = (pred: (s: Step) => boolean, what: string) => {
    const i = steps.findIndex(pred);
    expect(i, `no ${what} step in the image job`).toBeGreaterThanOrEqual(0);
    return i;
  };

  it('scans with Trivy and fails on HIGH/CRITICAL', () => {
    const trivy =
      steps[index((s) => s.uses?.startsWith('aquasecurity/trivy-action@') ?? false, 'Trivy')];
    expect(trivy.with?.severity).toBe('HIGH,CRITICAL');
    expect(String(trivy.with?.['exit-code'])).toBe('1');
    expect(trivy.if, 'the Trivy gate must run on every event').toBeUndefined();
  });

  it('writes an SBOM before the gate and attests it after signing', () => {
    const sbom = index((s) => s.uses?.startsWith('anchore/sbom-action@') ?? false, 'SBOM');
    const trivy = index((s) => s.uses?.startsWith('aquasecurity/trivy-action@') ?? false, 'Trivy');
    expect(sbom).toBeLessThan(trivy);
    const sign = index((s) => s.run?.includes('cosign sign --yes') ?? false, 'cosign sign');
    expect(steps[sign].run).toContain(
      'cosign attest --yes --predicate sbom.spdx.json --type spdxjson',
    );
  });

  it('pushes, signs and verifies only after the Trivy gate, and only on a publish ref', () => {
    const trivy = index((s) => s.uses?.startsWith('aquasecurity/trivy-action@') ?? false, 'Trivy');
    const publishing = steps
      .map((s, i) => ({ s, i }))
      .filter(
        ({ s }) =>
          /docker push|cosign (sign|attest|verify)/.test(s.run ?? '') ||
          (s.uses ?? '').startsWith('docker/login-action@') ||
          (s.uses ?? '').startsWith('sigstore/cosign-installer@'),
      );
    expect(publishing.length).toBeGreaterThanOrEqual(5);
    for (const { s, i } of publishing) {
      expect(i, `${s.name} runs before the Trivy gate`).toBeGreaterThan(trivy);
      expect(s.if, `${s.name} is not gated to a publish ref`).toBe("env.PUBLISH == 'true'");
    }
    const publish = (image as unknown as { env: Record<string, string> }).env.PUBLISH;
    expect(publish).toContain("github.event_name == 'push'");
    expect(publish).toContain("github.ref == 'refs/heads/main'");
    expect(publish).toContain("startsWith(github.ref, 'refs/heads/integration/')");
  });

  it('signs keylessly by digest and verifies against this workflow identity', () => {
    const sign = steps.find((s) => s.run?.includes('cosign sign --yes'));
    expect(sign?.run).toMatch(/"\$\{IMAGE\}@\$\{DIGEST\}"/);
    const verify = steps.find((s) => s.run?.includes('cosign verify '));
    expect(verify?.run).toContain('cosign verify-attestation');
    expect(verify?.run).toContain(
      '--certificate-oidc-issuer https://token.actions.githubusercontent.com',
    );
    expect(image.permissions?.['id-token']).toBe('write');
  });

  it('the check job runs the tests, the drift check and govulncheck', () => {
    const runs = wf.jobs.check.steps.map((s) => s.run ?? '').join('\n');
    expect(runs).toContain('go test -race -count=1 ./...');
    expect(runs).toMatch(/go run golang\.org\/x\/vuln\/cmd\/govulncheck@v\d+\.\d+\.\d+ \.\/\.\.\./);
    expect(runs).toContain('verified-buf.ts generate');
    expect(runs).toContain('git status --porcelain -- gen');
  });

  it('both downstream jobs need the check job', () => {
    expect(image.needs).toEqual(['check']);
    expect(wf.jobs['kind-e2e'].needs).toEqual(['check']);
  });
});
