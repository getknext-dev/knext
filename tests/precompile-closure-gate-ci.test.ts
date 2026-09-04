import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { auditBlockingGate } from './helpers/blocking-gate';
import {
  AUDIT_SCRIPT,
  loadWorkflows,
  parseWorkflow,
  readWorkflow,
  vinextArtifactJobs,
} from './helpers/vinext-artifact-scan';

/**
 * ADR-0042 Consequence 6 / #764 — the pre-compile closure gate is WIRED.
 *
 * `tests/precompile-closure-audit.test.ts` proves the gate's logic reds on a
 * scan of nothing. That is half a scan on its own: logic nothing invokes is
 * decoration, and the whole point of C6 is that the gate must run BEFORE any
 * vinext binary/image is built or published — otherwise the compiled artifact
 * is produced with no CVE-scannable surface behind it.
 *
 * So this file asserts the wiring, in three parts:
 *   1. the gate job exists, is blocking on a PR, and actually runs the audit;
 *   2. it generates + uploads the CycloneDX SBOM (criterion 1: "attached per
 *      vinext image build");
 *   3. SCANNED, not enumerated — EVERY job in EVERY `.github/workflows/*.yml`
 *      that compiles the vinext binary or builds its image has a job running
 *      the closure audit in its transitive `needs` closure. A future publish
 *      lane that forgets it fails here rather than shipping an opaque binary
 *      past a scan that never ran.
 *
 * BE PRECISE ABOUT WHAT PART 3 GUARANTEES, because the honest boundary is
 * narrower than "any future publish lane is covered":
 *   - it covers ORDERING only — that the audit ran before the build. It does
 *     NOT check that the resulting SBOM is attached to a published image as a
 *     cosign attestation. For THIS subject that is correct rather than owed:
 *     nothing publishes an examples/bun-exec image, so there is no digest to
 *     bind an attestation to. For the app that IS published
 *     (apps/file-manager, via supply-chain.yml) the attestation half is covered
 *     by tests/published-image-closure-gate.test.ts (C1/#785);
 *   - a job is recognised as building a vinext artifact when it mentions
 *     `examples/bun-exec` AND runs `build.sh`, `test:image`, `docker build`, or
 *     a `bun|npm|pnpm|yarn run build` (the package.json alias for `./build.sh`).
 *     A lane that compiles by some other spelling — a reusable workflow
 *     (`uses:` a `workflow_call`), a composite action, a shell wrapper — is not
 *     seen. Adding one of those to a vinext build path means extending
 *     `tests/helpers/vinext-artifact-scan.ts` in the same PR;
 *   - the subject of THIS scan is the in-repo `examples/bun-exec` closure. A
 *     USER app built on the vinext target still has no equivalent gate. The
 *     repo's OWN published app does, as of C1/#785: `supply-chain.yml` runs the
 *     same audit in `--app apps/file-manager` mode before its build and attests
 *     the result onto the pushed digest — a separate lane with a separate guard
 *     (tests/published-image-closure-gate.test.ts), deliberately not merged into
 *     this one, because widening this `needs:`-based scan to every vinext image
 *     build would also catch ci.yml's local-only `prod-image-optimization`
 *     probe, which is a lower risk than a published, signed, attested image.
 */

const REPO_ROOT = resolve(__dirname, '..');
const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const GATE_JOB = 'vinext-precompile-closure';
const ALLOWLIST = 'security/precompile-closure-allowlist.json';

/** The gate job's own lines, bounded by the next top-level job key. */
function jobBlock(jobId: string): string {
  const raw = readFileSync(CI_YML, 'utf8');
  const start = raw.indexOf(`  ${jobId}:`);
  expect(start, `no ${jobId} job in ci.yml`).toBeGreaterThan(-1);
  const rest = raw.slice(start + jobId.length + 3);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('the pre-compile closure gate exists and blocks (ADR-0042 C6)', () => {
  it('runs the audit script', () => {
    expect(
      jobBlock(GATE_JOB),
      `the ${GATE_JOB} job never runs ${AUDIT_SCRIPT}, so nothing audits the closure`,
    ).toContain(AUDIT_SCRIPT);
  });

  it('installs bun and materialises the closure that feeds `vite build`', () => {
    const block = jobBlock(GATE_JOB);
    expect(block, 'the gate never installs bun').toMatch(/oven-sh\/setup-bun@[0-9a-f]{40}/);
    // The INSTALLED tree is the subject of the scan — a lockfile-only scan was
    // MEASURED: a lockfile-only scan catalogues 60 packages against a tree of
    // 210 installed (409 syft components) and misses a HIGH the tree carries.
    expect(block, 'the gate never installs the example dependencies').toMatch(
      /bun install --frozen-lockfile/,
    );
    expect(block, 'the gate does not run in examples/bun-exec').toMatch(/examples\/bun-exec/);
  });

  it('uploads the CycloneDX SBOM as an artifact (criterion 1: attached per build)', () => {
    const block = jobBlock(GATE_JOB);
    expect(block, 'the closure SBOM is never uploaded').toMatch(
      /actions\/upload-artifact@[0-9a-f]{40}/,
    );
    expect(block, 'the uploaded artifact is not the CycloneDX closure SBOM').toMatch(/\.cdx\.json/);
  });

  it('runs unconditionally on a PR and its failure fails the run (#661)', () => {
    // PARSED, not text-matched — see tests/helpers/blocking-gate.ts. A quoted
    // `"if":`, `continue-on-error: ${{ true }}`, or a `needs:` on a skippable
    // job all disarm a job while leaving text assertions green.
    const audit = auditBlockingGate({
      workflowPath: CI_YML,
      jobId: GATE_JOB,
      gateCommand: new RegExp(AUDIT_SCRIPT.replace(/[.]/g, '\\.')),
    });
    expect(audit.jobsSeen, 'the audit parsed no jobs at all').toBeGreaterThan(5);
    expect(audit.gateStepsSeen, 'the audit never found the step that runs the closure audit').toBe(
      1,
    );
    expect(audit.needsClosure, 'the `needs` closure the audit walked').toEqual([GATE_JOB]);
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
  });
});

/**
 * Criterion 2, the ordering half: the closure audit runs BEFORE any vinext
 * binary is compiled or its image is built. SCANNED rather than enumerated — an
 * enumerated list of image jobs is how the second one gets missed, and there is
 * no vinext PUBLISH lane in CI today, so the rule has to hold for jobs that do
 * not exist yet.
 *
 * Two escape routes an earlier revision of this scan had, both closed below and
 * both covered by a synthetic lane rather than by the current tree (which
 * happens to contain neither, so the real tree cannot prove they are shut):
 *
 *   1. a lane in ANY OTHER workflow file — the scan read only ci.yml;
 *   2. a lane that compiles via the `build` package script alias
 *      (`bun run build` → `./build.sh`, examples/bun-exec/package.json) rather
 *      than naming `build.sh` outright.
 */
describe('every vinext binary/image job runs the closure audit first', () => {
  it('scans EVERY workflow file, not just ci.yml (escape route 1)', () => {
    const onDisk = readdirSync(resolve(REPO_ROOT, '.github/workflows'))
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .sort();
    const scanned = loadWorkflows(REPO_ROOT)
      .map((d) => d.path.replace('.github/workflows/', ''))
      .sort();
    expect(onDisk.length, 'no workflow files found — the scan has no subject').toBeGreaterThan(5);
    expect(
      scanned,
      'the scan does not read every workflow — a vinext publish lane in release.yml (or a new publish-vinext.yml) would be invisible to it',
    ).toEqual(onDisk);
  });

  it('catches a vinext publish lane in a NON-ci.yml workflow (escape route 1)', () => {
    const synthetic = parseWorkflow(
      '.github/workflows/publish-vinext.yml',
      [
        'jobs:',
        '  publish-vinext-image:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - working-directory: examples/bun-exec',
        '        run: ./build.sh',
        '      - run: docker build -t ghcr.io/example/vinext:sha examples/bun-exec',
      ].join('\n'),
    );
    const hits = vinextArtifactJobs([synthetic]);
    expect(
      hits.map((h) => h.job),
      'a publish lane outside ci.yml is not recognised as building a vinext artifact',
    ).toEqual(['publish-vinext-image']);
    expect(
      hits[0].gates,
      'a publish lane with no closure audit in its `needs` closure must be reported as unguarded',
    ).toEqual([]);
  });

  it('catches a lane that compiles via the `build` script alias (escape route 2)', () => {
    const synthetic = parseWorkflow(
      '.github/workflows/ci.yml',
      [
        'jobs:',
        '  bun-exec-binary:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - working-directory: examples/bun-exec',
        '        run: bun install --frozen-lockfile',
        '      - working-directory: examples/bun-exec',
        // package.json:8 — "build": "./build.sh". Names neither build.sh nor
        // test:image nor docker build, and compiles the binary anyway.
        '        run: bun run build',
      ].join('\n'),
    );
    const hits = vinextArtifactJobs([synthetic]);
    expect(
      hits.map((h) => h.job),
      '`bun run build` in examples/bun-exec compiles the binary (package.json `build` aliases ./build.sh) and is not recognised',
    ).toEqual(['bun-exec-binary']);
    expect(hits[0].gates, 'the alias lane has no audit in its `needs` closure').toEqual([]);
  });

  it('a lane that does have the audit in its needs closure is NOT reported unguarded', () => {
    const synthetic = parseWorkflow(
      '.github/workflows/publish-vinext.yml',
      [
        'jobs:',
        '  closure-audit:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        `      - run: node ${AUDIT_SCRIPT} --closure examples/bun-exec`,
        '  publish-vinext-image:',
        '    needs: closure-audit',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - working-directory: examples/bun-exec',
        '        run: bun run build',
      ].join('\n'),
    );
    const hits = vinextArtifactJobs([synthetic]);
    expect(hits.map((h) => h.job)).toEqual(['publish-vinext-image']);
    expect(hits[0].gates, 'the audit job in the needs closure was not credited').toEqual([
      'closure-audit',
    ]);
  });

  it('the scan actually finds the real vinext artifact jobs (non-vacuity)', () => {
    const hits = vinextArtifactJobs(loadWorkflows(REPO_ROOT)).map((h) => h.job);
    expect(
      hits,
      'the scan found no job that builds a vinext binary/image — it is not reading the workflows',
    ).toContain('bun-exec-alpine-image');
  });

  it('each real one runs the closure audit somewhere in its needs closure', () => {
    for (const hit of vinextArtifactJobs(loadWorkflows(REPO_ROOT))) {
      expect(
        hit.gates,
        `job \`${hit.job}\` in ${hit.workflow} builds a vinext artifact with NO job running ${AUDIT_SCRIPT} in its transitive \`needs\` closure — the opaque binary would be produced with no scannable surface behind it (ADR-0042 C6)`,
      ).not.toEqual([]);
    }
  });

  it('the real gate job in ci.yml is the one named in the docs', () => {
    const hits = vinextArtifactJobs([readWorkflow(REPO_ROOT, '.github/workflows/ci.yml')]);
    for (const hit of hits) {
      expect(hit.gates, `${hit.job} is gated by something other than ${GATE_JOB}`).toContain(
        GATE_JOB,
      );
    }
  });
});

describe('the closure allowlist is dated + justified (mirrors the npm-audit gate)', () => {
  it('exists and every entry carries id, justification and added date', () => {
    const path = resolve(REPO_ROOT, ALLOWLIST);
    expect(existsSync(path), `${ALLOWLIST} is missing`).toBe(true);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    expect(Array.isArray(doc.allow), `${ALLOWLIST} has no \`allow\` array`).toBe(true);
    for (const entry of doc.allow) {
      expect(entry.id, `an allowlist entry has no id: ${JSON.stringify(entry)}`).toBeTruthy();
      expect(entry.justification, `allowlist entry ${entry.id} has no justification`).toBeTruthy();
      expect(entry.added, `allowlist entry ${entry.id} has no \`added\` date`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
      if (entry.expires !== undefined) {
        expect(entry.expires, `allowlist entry ${entry.id} has a malformed \`expires\``).toMatch(
          /^\d{4}-\d{2}-\d{2}$/,
        );
      }
    }
  });
});
