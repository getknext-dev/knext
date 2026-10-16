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
 * The workflow half asserts the template image is scanned on every event
 * (SBOM, then Trivy HIGH/CRITICAL exit 1) and that the workflow holds no
 * write or id-token credential: publishing the image is deferred to a
 * separate push-only workflow, so nothing here pushes or signs.
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

const isPublishing = (s: Step) =>
  /docker push|cosign (sign|attest|verify)/.test(s.run ?? '') ||
  (s.uses ?? '').startsWith('docker/login-action@') ||
  (s.uses ?? '').startsWith('sigstore/cosign-installer@');

const WORKFLOW_TEXT = readFileSync(resolve(REPO_ROOT, '.github/workflows/go-template.yml'), 'utf8');

describe('the template image workflow scans and holds no credential', () => {
  const wf = parse(WORKFLOW_TEXT) as {
    on: Record<string, unknown>;
    permissions?: Record<string, string>;
    jobs: Record<string, Job>;
  };
  const image = wf.jobs.image;
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

  // Publishing (push + cosign) needs a separately approved, push-only workflow.
  // Until then this one grants nothing beyond read: no `write`, no `write-all`,
  // no `id-token` — at the workflow level or on any job. Asserted on the parsed
  // YAML and on the raw text, so a shape the parser view misses still reds.
  it('grants no write or id-token permission, at workflow or job level', () => {
    const scopes = [
      ['workflow', wf.permissions],
      ...Object.entries(wf.jobs).map(([name, job]) => [name, job.permissions] as const),
    ] as const;
    for (const [where, perms] of scopes) {
      expect(perms, `${where} has no explicit permissions block`).toBeDefined();
      expect(typeof perms, `${where} permissions are not a scope map`).toBe('object');
      for (const [scope, level] of Object.entries(perms ?? {})) {
        expect(level, `${where} grants ${scope}: ${level}`).not.toMatch(/write/);
        expect(scope, `${where} grants ${scope}`).not.toBe('id-token');
      }
    }
    expect(WORKFLOW_TEXT).not.toMatch(/^[^#\n]*\b[\w-]+\s*:\s*['"]?write(?:-all)?\b/m);
    expect(WORKFLOW_TEXT).not.toMatch(/^[^#\n]*\bid-token\s*:/m);
  });

  it('writes an SBOM before the Trivy gate', () => {
    const sbom = find(
      image,
      'image',
      (s) => s.uses?.startsWith('anchore/sbom-action@') ?? false,
      'SBOM',
    );
    const trivy = find(image, 'image', trivyStep, 'Trivy');
    expect(sbom).toBeLessThan(trivy);
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
