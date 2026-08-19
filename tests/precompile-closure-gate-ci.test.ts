import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { auditBlockingGate } from './helpers/blocking-gate';

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
 *   3. SCANNED, not enumerated — EVERY ci.yml job that compiles the vinext
 *      binary or builds its image has the gate in its transitive `needs`
 *      closure. A future publish lane that forgets it fails here rather than
 *      shipping an opaque binary past a scan that never ran.
 */

const REPO_ROOT = resolve(__dirname, '..');
const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const GATE_JOB = 'vinext-precompile-closure';
const AUDIT_SCRIPT = 'scripts/precompile-closure-audit.mjs';
const ALLOWLIST = 'security/precompile-closure-allowlist.json';

function workflow(): Record<string, { needs?: string | string[]; steps?: unknown[] }> {
  const raw = readFileSync(CI_YML, 'utf8');
  expect(raw.length, 'ci.yml is empty or unreadable').toBeGreaterThan(1000);
  const doc = parse(raw) as { jobs?: Record<string, never> };
  const jobs = doc.jobs ?? {};
  expect(Object.keys(jobs).length, 'ci.yml parsed to no jobs at all').toBeGreaterThan(5);
  return jobs;
}

/** The gate job's own lines, bounded by the next top-level job key. */
function jobBlock(jobId: string): string {
  const raw = readFileSync(CI_YML, 'utf8');
  const start = raw.indexOf(`  ${jobId}:`);
  expect(start, `no ${jobId} job in ci.yml`).toBeGreaterThan(-1);
  const rest = raw.slice(start + jobId.length + 3);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Transitive `needs` closure of a job (excluding the job itself). */
function needsClosure(jobs: ReturnType<typeof workflow>, jobId: string): Set<string> {
  const out = new Set<string>();
  const walk = (id: string) => {
    const raw = jobs[id]?.needs;
    const parents = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    for (const p of parents) {
      if (out.has(p)) continue;
      out.add(p);
      walk(p);
    }
  };
  walk(jobId);
  return out;
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
    // MEASURED to cover 60 of 408 packages and to miss a HIGH the tree carries.
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
 * Criterion 2, the ordering half: `needs`-before any vinext image build or
 * publish. SCANNED rather than enumerated — an enumerated list of image jobs is
 * how the second one gets missed, and there is no vinext PUBLISH lane in CI
 * today, so the rule has to hold for jobs that do not exist yet.
 */
describe('every vinext binary/image job needs the closure gate first', () => {
  /** Steps that compile the binary (`build.sh`) or build/run its image. */
  const BUILDS_VINEXT_ARTIFACT = /build\.sh|test:image|docker build/;

  function vinextArtifactJobs(): string[] {
    const jobs = workflow();
    const hits: string[] = [];
    for (const [id, job] of Object.entries(jobs)) {
      const steps = (job.steps ?? []) as Array<Record<string, unknown>>;
      const text = steps
        .map((s) => `${s.run ?? ''} ${s['working-directory'] ?? ''} ${s.uses ?? ''}`)
        .join('\n');
      if (!text.includes('examples/bun-exec')) continue;
      if (BUILDS_VINEXT_ARTIFACT.test(text)) hits.push(id);
    }
    return hits;
  }

  it('the scan actually finds the vinext artifact jobs (non-vacuity)', () => {
    const hits = vinextArtifactJobs();
    expect(
      hits,
      'the scan found no job that builds a vinext binary/image — it is not reading ci.yml',
    ).toContain('bun-exec-alpine-image');
  });

  it('each of them has the gate in its transitive needs closure', () => {
    const jobs = workflow();
    for (const id of vinextArtifactJobs()) {
      expect(
        [...needsClosure(jobs, id)],
        `job \`${id}\` builds a vinext artifact WITHOUT \`needs: ${GATE_JOB}\` — the opaque binary would be produced with no scannable surface behind it (ADR-0042 C6)`,
      ).toContain(GATE_JOB);
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
