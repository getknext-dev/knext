/**
 * The Rust zone-function template (templates/rust) stays in lockstep with the
 * contract `knext add function` writes, keeps connect-rust on its pinned,
 * conformance-gated 0.9 line, and its CI keeps the supply-chain gates in the
 * order that makes them gates.
 *
 * Proto is the single source of truth: the template's contract must be the
 * bytes `contractFor('example')` produces, and its copy of the knext options
 * contract must be the one @getknext/grpc ships. The generated Rust in
 * templates/rust/gen is checked against the proto by `buf generate` in the
 * template's workflow (a regenerate-then-diff), not here.
 *
 * connect-rust is pre-1.0: the conformance suite in the workflow runs the
 * upstream conformance server built from the commit of the connectrpc
 * version Cargo.lock pins, so a lockfile bump without a matching conformance
 * checkout reds here (and in the workflow's own step).
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
const TEMPLATE = resolve(REPO_ROOT, 'templates/rust');
const read = (rel: string) => readFileSync(resolve(TEMPLATE, rel), 'utf8');

/** Every `[[package]]` in Cargo.lock as name → versions. */
function lockedVersions(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const block of read('Cargo.lock').split('[[package]]').slice(1)) {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    const version = block.match(/^version = "([^"]+)"$/m)?.[1];
    if (name && version) out.set(name, [...(out.get(name) ?? []), version]);
  }
  return out;
}

function lockedOnce(name: string): string {
  const versions = lockedVersions().get(name) ?? [];
  expect(versions, `Cargo.lock must hold exactly one ${name}`).toHaveLength(1);
  return versions[0] as string;
}

const minor = (version: string) => version.split('.').slice(0, 2).join('.');

/** `NAME=value` from codegen.sh. */
function codegenPin(name: string): string {
  const m = read('codegen.sh').match(new RegExp(`^${name}=(\\d+\\.\\d+\\.\\d+)$`, 'm'));
  expect(m, `codegen.sh has no ${name}=X.Y.Z`).not.toBeNull();
  return (m as RegExpMatchArray)[1] as string;
}

describe('the Rust template contract is the one `knext add function` writes', () => {
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

  it('the generated code is committed for both trees buf.gen.yaml writes', () => {
    const gen = read('buf.gen.yaml');
    expect(gen).toContain('out: gen/buffa');
    expect(gen).toContain('out: gen/connect');
    expect(gen).toContain('opt: [buffa_module=crate::proto]');
    expect(read('gen/connect/example.v1.example.__connect.rs')).toContain(
      'pub trait ExampleService',
    );
    expect(read('gen/buffa/example.v1.example.rs')).toContain('pub struct PutItemRequest');
  });
});

describe('connect-rust stays on its pinned, conformance-gated 0.9 line', () => {
  it('Cargo.toml and Cargo.lock hold connectrpc 0.9.x', () => {
    expect(read('Cargo.toml')).toMatch(/^connectrpc = \{ version = "0\.9\.\d+"/m);
    expect(lockedOnce('connectrpc')).toMatch(/^0\.9\.\d+$/);
    expect(lockedOnce('connectrpc-health')).toMatch(/^0\.9\.\d+$/);
  });

  it('connectrpc resolves without zstd: the template accepts gzip only', () => {
    const block = read('Cargo.lock')
      .split('[[package]]')
      .find((b) => /^name = "connectrpc"$/m.test(b));
    expect(block, 'no connectrpc in Cargo.lock').toBeDefined();
    const deps = [...(block as string).matchAll(/^ "([^" ]+)"/gm)].map((m) => m[1]);
    expect(deps).toContain('flate2');
    expect(deps, 'connectrpc pulls zstd into the release binary').not.toContain('zstd');
  });

  it('the zstd drop is wired by a vendored path patch, not only a lock outcome', () => {
    expect(read('Cargo.toml')).toMatch(
      /^\[patch\.crates-io\]\nconnectrpc-health = \{ path = "vendor\/connectrpc-health" \}$/m,
    );
    expect(read('vendor/connectrpc-health/Cargo.toml')).toMatch(
      /^\[dependencies\.connectrpc\]\n(?:(?!\[).*\n)*?default-features = false$/m,
    );
    const block = read('Cargo.lock')
      .split('[[package]]')
      .find((b) => /^name = "connectrpc-health"$/m.test(b));
    expect(block, 'no connectrpc-health in Cargo.lock').toBeDefined();
    expect(block, 'connectrpc-health must be the vendored path package').not.toMatch(
      /^source = /m,
    );
  });

  it('the codegen plugins are pinned to the runtime lines Cargo.lock holds', () => {
    expect(minor(codegenPin('CONNECTRPC_CODEGEN_VERSION'))).toBe(minor(lockedOnce('connectrpc')));
    expect(codegenPin('PROTOC_GEN_BUFFA_VERSION')).toBe(lockedOnce('buffa'));
    expect(codegenPin('PROTOC_GEN_BUFFA_PACKAGING_VERSION')).toBe(lockedOnce('buffa'));
    for (const plugin of [
      'protoc-gen-buffa',
      'protoc-gen-buffa-packaging',
      'protoc-gen-connect-rust',
    ]) {
      expect(read('buf.gen.yaml')).toContain(`local: .codegen/bin/${plugin}`);
    }
    expect(read('codegen.sh')).toContain('cargo install --quiet --locked');
  });

  it('the conformance job checks out the commit of the connectrpc version Cargo.lock pins', () => {
    const m = WORKFLOW_TEXT.match(
      /repository: connectrpc\/connect-rust\n\s+ref: ([0-9a-f]{40}) # v(\d+\.\d+\.\d+)\n/,
    );
    expect(m, 'no connect-rust checkout pinned as `ref: <sha> # vX.Y.Z`').not.toBeNull();
    expect((m as RegExpMatchArray)[2]).toBe(lockedOnce('connectrpc'));
  });
});

describe('the image is a static binary the scanners can read', () => {
  it('the Dockerfile builds on the Rust release rust-toolchain.toml names, on distroless static', () => {
    const channel = read('rust-toolchain.toml').match(/^channel = "(\d+\.\d+\.\d+)"$/m);
    expect(channel, 'rust-toolchain.toml has no `channel = "X.Y.Z"`').not.toBeNull();
    const version = (channel as RegExpMatchArray)[1] as string;
    expect(read('Dockerfile')).toMatch(
      new RegExp(
        `^FROM rust:${version.replaceAll('.', '\\.')}-alpine[\\d.]*@sha256:[0-9a-f]{64} AS build$`,
        'm',
      ),
    );
    expect(read('Dockerfile')).toMatch(
      /^FROM gcr\.io\/distroless\/static:nonroot@sha256:[0-9a-f]{64}$/m,
    );
    expect(read('Dockerfile')).toMatch(/^USER 65532:65532$/m);
  });

  it('the binary is built with cargo auditable from the lockfile', () => {
    expect(read('Dockerfile')).toMatch(/cargo install --locked .*cargo-auditable@\d+\.\d+\.\d+/);
    expect(read('Dockerfile')).toContain('cargo auditable build --release --locked');
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

const WORKFLOW_TEXT = readFileSync(
  resolve(REPO_ROOT, '.github/workflows/rust-template.yml'),
  'utf8',
);

describe('the template workflow scans, gates and holds no credential', () => {
  const wf = parse(WORKFLOW_TEXT) as {
    on: Record<string, unknown>;
    permissions?: Record<string, string>;
    env?: Record<string, string>;
    jobs: Record<string, Job>;
  };
  const image = wf.jobs.image as Job;
  const find = (job: Job, name: string, pred: (s: Step) => boolean, what: string) => {
    expect(job, `no ${name} job`).toBeDefined();
    const i = job.steps.findIndex(pred);
    expect(i, `no ${what} step in the ${name} job`).toBeGreaterThanOrEqual(0);
    return i;
  };
  const trivyStep = (s: Step) => s.uses?.startsWith('aquasecurity/trivy-action@') ?? false;
  const runs = (job: string) => (wf.jobs[job] as Job).steps.map((s) => s.run ?? '').join('\n');

  it('the zstd graph check fails closed', () => {
    const step = Object.values(wf.jobs)
      .flatMap((j) => j.steps)
      .find((s) => s.name === 'zstd is not in the release dependency graph');
    expect(step, 'no zstd graph step').toBeDefined();
    const run = step?.run ?? '';
    expect(run).toContain('set -euo pipefail');
    expect(run, 'stderr must not be discarded').not.toContain('2>/dev/null');
    expect(run).toMatch(/cargo tree --locked [^\n]*> "\$\{tree\}"/);
    expect(run).toContain('[ ! -s "${tree}" ]');
    expect(run).toContain("grep -E '^zstd(-sys|-safe)? '");
  });

  it('scans with Trivy and fails on HIGH/CRITICAL, on every event', () => {
    const trivy = image.steps[find(image, 'image', trivyStep, 'Trivy')] as Step;
    expect(trivy.with?.severity).toBe('HIGH,CRITICAL');
    expect(String(trivy.with?.['exit-code'])).toBe('1');
    expect(trivy.if, 'the Trivy gate must run on every event').toBeUndefined();
    expect(image.if, 'the image job must run on every event').toBeUndefined();
    expect(wf.on).toHaveProperty('pull_request');
  });

  it('writes an SBOM, checks it lists the binary crates, then gates on Trivy', () => {
    const sbom = find(
      image,
      'image',
      (s) => s.uses?.startsWith('anchore/sbom-action@') ?? false,
      'SBOM',
    );
    const listed = find(
      image,
      'image',
      (s) => (s.run ?? '').includes('"connectrpc"'),
      'SBOM content',
    );
    const trivy = find(image, 'image', trivyStep, 'Trivy');
    expect(sbom).toBeLessThan(listed);
    expect(listed).toBeLessThan(trivy);
  });

  it('the job that runs on pull requests holds no write credential and publishes nothing', () => {
    expect(image.permissions).toEqual({ contents: 'read' });
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const [name, job] of Object.entries(wf.jobs)) {
      const publishing = job.steps.filter(isPublishing).map((s) => s.name);
      expect(publishing, `the ${name} job pushes or signs`).toEqual([]);
    }
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

  it('pins every third-party action by full commit SHA with its version', () => {
    const uses = [...WORKFLOW_TEXT.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, rest] of uses) {
      if ((ref as string).startsWith('./')) continue;
      expect(ref, `${ref} is not pinned by a 40-hex SHA`).toMatch(
        /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/,
      );
      expect(rest, `${ref} has no # vX.Y.Z comment`).toMatch(/^\s+# v\d+\.\d+\.\d+$/);
    }
  });

  it('the check job runs the tests, the drift check, fmt, clippy, cargo deny and cargo audit', () => {
    const check = runs('check');
    expect(check).toContain('cargo test --locked');
    expect(check).toContain('cargo fmt --check');
    expect(check).toContain('cargo clippy --all-targets --all-features --locked -- -D warnings');
    expect(check).toContain('verified-buf.ts lint');
    expect(check).toContain('./codegen.sh');
    expect(check).toContain('git status --porcelain -- gen');
    expect(check).toContain('cargo deny check');
    expect(check).toContain('cargo audit');
    expect(check).toMatch(/sha256sum -c -/);
  });

  it('the conformance job runs every server test with a sha256-verified runner', () => {
    const conformance = runs('conformance');
    expect(conformance).toContain(
      'templates/rust/conformance.sh connect-rust "${HOME}/.cargo/bin/connectconformance"',
    );
    const script = read('conformance.sh');
    expect(script).toContain(
      'RUST_LOG=warn "${RUNNER}" --mode server -- target/release/conformance-server',
    );
    expect(script).not.toContain('--conf');
    expect(script).toMatch(/the checkout is connectrpc \$\{have\}; Cargo.lock locks \$\{want\}/);
    expect(conformance).toContain('echo "${CONFORMANCE_SHA256}  ${tarball}" | sha256sum -c -');
    expect(wf.env?.CONFORMANCE_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect((wf.jobs.conformance as Job).if).toBeUndefined();
  });

  it('the image and kind-e2e jobs need the check job', () => {
    expect(image.needs).toEqual(['check']);
    expect((wf.jobs['kind-e2e'] as Job).needs).toEqual(['check']);
    expect(runs('kind-e2e')).toContain('templates/rust/e2e/kind-e2e.sh');
  });
});
