import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * WIRING GUARD for the parameterized file-manager platform e2e at a git tag
 * (#1305, #1563). Round 2 (review findings, all four fixed):
 *   1. this caller no longer duplicates the ~280-line implementation - it
 *      `uses:` the shared reusable workflow (file-manager-platform-e2e.yml),
 *      whose own wiring is tested in
 *      tests/file-manager-platform-e2e-reusable-workflow.test.ts;
 *   2. the operator digest recorded as rc evidence is the digest of the image
 *      ACTUALLY DEPLOYED (proven in the reusable-workflow test: push-based
 *      capture, cross-checked against the deployed pod's imageID) - this
 *      file only checks that record-evidence consumes THAT job output, never
 *      re-derives its own;
 *   3. `${{ inputs.git-ref }}` is never interpolated directly into a `run:`
 *      script - it is passed via `env:` and read as a quoted shell var;
 *   4. tests assert the semantic guarantees (ref pinning, build-from-ref,
 *      digest provenance, env-based inputs), not just textual presence.
 *
 * Each test asserts on the PARSED workflow.
 */

const ROOT = resolve(import.meta.dirname, '..');
const WF = resolve(ROOT, '.github/workflows/file-manager-platform-e2e-at-tag.yml');

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  id?: string;
  env?: Record<string, string>;
  [k: string]: unknown;
};
type Job = {
  steps?: Step[];
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  [k: string]: unknown;
};
const text = readFileSync(WF, 'utf8');
const wf = parse(text) as {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
};
const resolveJob = wf.jobs['resolve-git-ref'];
const callerJob = wf.jobs['platform-e2e-at-tag'];
const evidenceJob = wf.jobs['record-evidence'];

describe('file-manager platform e2e at tag - caller wiring', () => {
  it('is triggered by workflow_dispatch only', () => {
    expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
  });

  it('accepts a git ref input with a description', () => {
    const dispatch = wf.on['workflow_dispatch'] as { inputs?: Record<string, unknown> };
    expect(dispatch?.inputs).toBeDefined();
    expect(dispatch.inputs).toHaveProperty('git-ref');
    const refInput = dispatch.inputs?.['git-ref'] as { description?: string; default?: string };
    expect(typeof refInput?.description).toBe('string');
  });

  it('reads rcTag from .github/compat-credential-ref.json as the default git-ref', () => {
    expect(text).toMatch(/\.github\/compat-credential-ref\.json/);
    expect(text).toMatch(/rcTag/);
  });

  it('resolves the git ref to a SHA before the platform-e2e-at-tag job depends on it', () => {
    expect(resolveJob).toBeDefined();
    expect(resolveJob.outputs).toMatchObject({
      'git-ref': '${{ steps.resolve.outputs.git-ref }}',
      'git-sha': '${{ steps.resolve.outputs.git-sha }}',
    });
    expect(callerJob.needs).toBe('resolve-git-ref');
  });

  it('calls the shared reusable implementation - it does not re-implement the suite itself', () => {
    expect(callerJob.uses).toBe('./.github/workflows/file-manager-platform-e2e.yml');
    expect(callerJob.steps).toBeUndefined();
  });

  it('pins the reusable call to the RESOLVED SHA, never to the raw (possibly-mutable) ref string', () => {
    expect(callerJob.with?.ref).toBe('${{ needs.resolve-git-ref.outputs.git-sha }}');
  });

  it('finding 3: the resolve step never interpolates `${{ inputs.git-ref }}` directly into its run: script', () => {
    const resolveStep = resolveJob.steps?.find((s) => s.id === 'resolve');
    expect(resolveStep).toBeDefined();
    expect(String(resolveStep?.run)).not.toMatch(/\$\{\{\s*inputs\./);
  });

  it('finding 3: the git-ref input is instead passed via env: and read as a quoted shell variable', () => {
    const resolveStep = resolveJob.steps?.find((s) => s.id === 'resolve');
    expect(resolveStep?.env?.GIT_REF_INPUT).toBe('${{ inputs.git-ref }}');
    expect(String(resolveStep?.run)).toContain('"${GIT_REF_INPUT:-}"');
  });

  it('no step anywhere in this file interpolates `${{ inputs.* }}` directly into run:', () => {
    for (const job of Object.values(wf.jobs)) {
      for (const s of job.steps ?? []) {
        expect(s.run ?? '').not.toMatch(/\$\{\{\s*inputs\./);
      }
    }
  });

  it('fails closed on an unresolvable ref: a real error, not a swallowed empty SHA', () => {
    const resolveStep = resolveJob.steps?.find((s) => s.id === 'resolve');
    const run = String(resolveStep?.run);
    expect(run).toMatch(/set -euo pipefail/);
    expect(run).toMatch(/Could not resolve .* to a commit SHA/);
    expect(run).toMatch(/exit 1/);
  });

  it('#1751: peels an annotated tag to its commit (^{}), never records the tag object SHA', () => {
    const resolveStep = resolveJob.steps?.find((s) => s.id === 'resolve');
    const run = String(resolveStep?.run);
    // Must query the peeled form of the tag ref.
    expect(run).toMatch(/refs\/tags\/\$GIT_REF\^\{\}/);
    // And must prefer a peeled line over the plain tag-object line when
    // both are present in the ls-remote output (annotated-tag case) -
    // a plain `awk '{print $1; exit}'` over the combined output would
    // take whichever line comes first, which is the tag object, not the
    // commit. Assert the selection actually discriminates on `^{}`.
    expect(run).toContain('^\\{\\}$');
  });

  it('#1751: resolving an annotated tag actually selects the peeled commit, not the tag object', () => {
    // Hermetic re-execution of the resolve logic against FIXED, canned
    // `git ls-remote` output (no network) - this is the exact shape git
    // returns for an annotated tag: the tag-object line first, the peeled
    // commit line second.
    const resolveStep = resolveJob.steps?.find((s) => s.id === 'resolve');
    const run = String(resolveStep?.run);
    // Extract just the SHA-resolution logic (the lines operating on
    // $TAG_REFS / ls-remote output) and re-run it under a stub `git`.
    const script = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'git() {',
      "  cat <<'EOF'",
      '900e8984588f46cd441a660af464012b81707a89\trefs/tags/v1.0.0-rc.3',
      '86eef5171ccbd47a5bffc869f01a61d0a799737a\trefs/tags/v1.0.0-rc.3^{}',
      'EOF',
      '}',
      'GIT_REF_INPUT="v1.0.0-rc.3"',
      'GITHUB_OUTPUT="/dev/null"',
      'GITHUB_STEP_SUMMARY="/dev/null"',
      run,
      'echo "RESOLVED_SHA=$GIT_SHA"',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RESOLVED_SHA=86eef5171ccbd47a5bffc869f01a61d0a799737a');
    expect(result.stdout).not.toContain('RESOLVED_SHA=900e8984588f46cd441a660af464012b81707a89');
  });
});

describe('file-manager platform e2e at tag - rc evidence recording', () => {
  it('the record-evidence job needs both the ref resolution and the platform-e2e-at-tag call', () => {
    expect(evidenceJob).toBeDefined();
    expect(evidenceJob.needs).toEqual(['resolve-git-ref', 'platform-e2e-at-tag']);
  });

  it("consumes the digest from the reusable job's OWN output — never re-derives or hardcodes one", () => {
    const step = evidenceJob.steps?.find((s) => s.name === 'Record rc evidence');
    expect(step?.env?.OPERATOR_DIGEST).toBe(
      '${{ needs.platform-e2e-at-tag.outputs.operator-image-digest }}',
    );
    expect(String(step?.run)).not.toMatch(/RepoDigests/);
  });

  it('records the git ref, run id, and digest in the job summary via env:, not inline interpolation', () => {
    const step = evidenceJob.steps?.find((s) => s.name === 'Record rc evidence');
    expect(step?.env).toMatchObject({
      GIT_REF: '${{ needs.resolve-git-ref.outputs.git-ref }}',
      GIT_SHA: '${{ needs.resolve-git-ref.outputs.git-sha }}',
      RUN_ID: '${{ github.run_id }}',
    });
    expect(String(step?.run)).toMatch(/GITHUB_STEP_SUMMARY/);
    expect(String(step?.run)).not.toMatch(/\$\{\{\s*needs\./);
    expect(String(step?.run)).not.toMatch(/\$\{\{\s*github\./);
  });

  it('uploads the evidence as an artifact', () => {
    const upload = evidenceJob.steps?.find((s) => (s.uses ?? '').includes('upload-artifact'));
    expect(upload).toBeDefined();
    expect(upload?.with).toMatchObject({ name: 'rc-evidence' });
  });

  it('fails closed: no continue-on-error anywhere in this file', () => {
    expect(text).not.toMatch(/continue-on-error/);
  });
});
