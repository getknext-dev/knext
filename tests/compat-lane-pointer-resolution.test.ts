import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD TEST — a CI file may not point at a compat lane that does not exist.
 *
 * WHAT WENT WRONG, MEASURED
 * -------------------------
 * `.github/workflows/ci.yml` told every reader — human and agent — that the
 * `compat-smoke` job is NOT the official Next.js compatibility suite, and that
 * "the official deploy-test harness is a separate scheduled job (A3-2,
 * compat-suite-full)". `apps/file-manager/scripts/compat-smoke.mjs` said the
 * same. **Nothing named `compat-suite-full` exists** — not a workflow file, not
 * a workflow `name:`, not a job id, not an artifact. The name comes from
 * ADR-0007 §"Scheduled/dispatch", which binds it there to the file that really
 * carries the lane (`.github/workflows/test-e2e-deploy.yml`, workflow name
 * "Compat suite (official Next.js deploy harness)"). The two CI-side copies
 * dropped that binding and kept the name.
 *
 * The failure mode is not cosmetic and it is not hypothetical. A reader who
 * greps `.github/workflows/` for the name it was given finds nothing, and the
 * available conclusions are "the lane was deleted" or "the lane never existed"
 * — both false. The lane runs twice a week on two crons and its every scheduled
 * run since 2026-07-28 is on file. A release-readiness review reached exactly
 * that wrong conclusion off exactly this line, which is what this guard exists
 * to stop recurring: an honest-status project cannot afford a pointer that
 * reads as evidence of absence.
 *
 * BOTH HALVES, and both are SCANNED rather than enumerated
 * --------------------------------------------------------
 *   1. **The lane exists** (positive). If the scheduled harness were deleted
 *      outright, a "no dangling pointer" check alone would go GREEN on the
 *      wreckage — nothing would be pointing anywhere. So the workflow, both its
 *      crons, and its lane-selection expression are asserted directly.
 *   2. **Nothing names a lane that does not exist** (negative). Scanned by
 *      SHAPE: every `compat-suite-*` token anywhere in the CI-config and script
 *      surface must denote a real workflow, job, artifact, or tracked file. An
 *      allowlist was rejected — this repo has twice had to unwind a silent
 *      exemption list, and an allowlist would have to name `compat-suite-full`
 *      to go green, which is the defect.
 *   3. **Every pointer to the harness names the workflow that runs it.** The
 *      complement of (2): a pointer can dangle by naming nothing at all, not
 *      only by naming something wrong.
 *
 * SCAN BOUNDARY, asserted rather than documented (see the boundary test at the
 * end). `docs/adr/` is deliberately OUT: an ADR is a historical decision record,
 * and ADR-0007 is self-consistent — it introduces the name bound to the file.
 * Rewriting a merged ADR's decision text to satisfy a lint is the wrong trade.
 */

const REPO_ROOT = resolve(__dirname, '..');
const COMPAT_WORKFLOW = '.github/workflows/test-e2e-deploy.yml';

/** Every tracked path, as git sees it. */
function trackedPaths(): string[] {
  const paths = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  // Non-vacuity: an empty index would make every identifier below "resolve".
  expect(paths.length, 'git ls-files returned nothing — the index is not readable').toBeGreaterThan(
    200,
  );
  return paths;
}

function workflowFiles(): string[] {
  const files = trackedPaths().filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));
  expect(files.length, 'no workflow files found').toBeGreaterThan(5);
  return files;
}

/**
 * Everything a `compat-suite-*` token could legitimately denote.
 *
 * Deliberately GENEROUS — the question this guard asks is "does the thing you
 * named exist at all", not "did you name it in the canonical register". A
 * narrow identity set would red on correct references and teach people to edit
 * the guard, which is how a guard becomes the thing that gets changed to get
 * green.
 */
interface Identities {
  exact: Set<string>;
  /** Prefixes of templated artifact names, e.g. `compat-suite-summary-${{ … }}`. */
  prefixes: string[];
  /** Basenames of tracked files, so `compat-suite-workflow` resolves via its spec. */
  basenames: string[];
}

function laneIdentities(): Identities {
  const exact = new Set<string>();
  const prefixes: string[] = [];

  for (const rel of workflowFiles()) {
    const base = rel.split('/').pop() as string;
    exact.add(base);
    exact.add(base.replace(/\.ya?ml$/, ''));

    const text = readFileSync(resolve(REPO_ROOT, rel), 'utf8');

    // The workflow's own display name.
    for (const m of text.matchAll(/^name:\s*(.+)$/gm)) {
      exact.add(m[1].trim().replace(/^['"]|['"]$/g, ''));
    }

    // Top-level job ids.
    let inJobs = false;
    for (const line of text.split('\n')) {
      if (/^jobs:\s*$/.test(line)) {
        inJobs = true;
        continue;
      }
      if (!inJobs) continue;
      if (/^\S/.test(line)) {
        inJobs = false;
        continue;
      }
      const m = line.match(/^ {2}([A-Za-z0-9_-]+):/);
      if (m) exact.add(m[1]);
    }

    // Artifact names, including the templated `name: foo-${{ … }}` shape.
    for (const m of text.matchAll(/^\s+name:\s*([A-Za-z0-9._-]+)\$\{\{/gm)) prefixes.push(m[1]);
    for (const m of text.matchAll(/^\s+name:\s*([A-Za-z0-9._-]+)\s*$/gm)) exact.add(m[1]);
  }

  const basenames = trackedPaths().map((p) => p.split('/').pop() as string);

  // Non-vacuity on the identity set itself: if this collapsed, every token
  // would dangle and the scan would red for the wrong reason — or, worse, a
  // future `resolves()` that fails open would pass everything.
  expect(exact.size, 'the identity set is suspiciously small').toBeGreaterThan(50);
  expect(prefixes.length, 'no templated artifact names found').toBeGreaterThan(0);

  return { exact, prefixes, basenames };
}

function resolves(id: string, ids: Identities): boolean {
  if (ids.exact.has(id) || ids.exact.has(`${id}.yml`) || ids.exact.has(`${id}.yaml`)) return true;
  // A token may be the stem of a templated artifact (`compat-suite-summary`
  // for `compat-suite-summary-${{ … }}`) or carry its index.
  if (ids.prefixes.some((p) => id.startsWith(p) || p.startsWith(id))) return true;
  return ids.basenames.some((b) => b.startsWith(id));
}

/**
 * The CI-configuration and script surface: where a pointer is a self-contained
 * instruction to a reader, and where a stale one is read as fact.
 *
 * `docs/compat-matrix.md` is included for the SHAPE scan (2) because it is the
 * published claim surface, and excluded from the prose-pointer scan (3), where
 * it names the workflow in its own header prose rather than beside every
 * mention. See the boundary test.
 *
 * `scripts/mutation-prove-*.mjs` is EXCLUDED, and the exclusion is asserted
 * below rather than left implicit. A prover's job is to write the broken shape
 * on purpose and watch the guard fire; this guard's own prover carries the
 * literal stale pointer twice. Scanning the provers would make every guard in
 * the corpus red on its own proof — the same self-reading trap
 * `tests/bun-exec-alpine-image-ci.test.ts` records for its sweep scan. The hole
 * this leaves is narrow and stated: a stale pointer hidden inside a prover is
 * not caught here. A prover is not a document a reader consults to find out
 * where the lane runs, and the corpus has its own audit in
 * `tests/mutation-prover-lane.test.ts`.
 */
const PROVER = /^scripts\/mutation-prove-[^/]+\.mjs$/;

function shapeScanFiles(): string[] {
  const tracked = trackedPaths();
  const files = [
    ...tracked.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)),
    ...tracked.filter(
      (p) => /^(scripts\/|apps\/[^/]+\/scripts\/).+\.(mjs|js|ts|sh)$/.test(p) && !PROVER.test(p),
    ),
    'docs/compat-matrix.md',
  ];
  return [...new Set(files)];
}

function pointerScanFiles(): string[] {
  return shapeScanFiles().filter((p) => !p.endsWith('.md'));
}

describe('the official compat lane exists (the positive half)', () => {
  const text = () => readFileSync(resolve(REPO_ROOT, COMPAT_WORKFLOW), 'utf8');

  it('is a real workflow file, not a name in a comment', () => {
    expect(trackedPaths(), `${COMPAT_WORKFLOW} is not tracked`).toContain(COMPAT_WORKFLOW);
    expect(text()).toMatch(/^name:\s*Compat suite \(official Next\.js deploy harness\)\s*$/m);
  });

  it('runs on BOTH schedules — the node nightly and the bun weekly', () => {
    // Named, not counted: a guard that only asserted "two crons" would stay
    // green if the weekly bun lane were replaced by a second nightly.
    expect(text(), 'the node nightly cron is gone').toMatch(/^\s*-\s*cron:\s*'17 3 \* \* \*'/m);
    expect(text(), 'the weekly bun cron is gone').toMatch(/^\s*-\s*cron:\s*'17 5 \* \* 0'/m);
  });

  it('selects the bun lane FROM the weekly cron, so the two crons are not interchangeable', () => {
    // The cron literal has to appear in the lane expression too, or the weekly
    // schedule would silently run the node lane and the bun axis would never
    // execute while both crons still read as present above.
    expect(text()).toMatch(/KNEXT_RUNTIME:.*github\.event\.schedule == '17 5 \* \* 0'.*'bun'/);
  });
});

describe('no CI file names a compat lane that does not exist (the negative half)', () => {
  it('every `compat-suite-*` identifier denotes a real workflow, job, artifact, or file', () => {
    const ids = laneIdentities();
    const LANE = /\bcompat-suite-[a-z0-9][a-z0-9-]*\b/g;

    const seen: Array<{ id: string; where: string }> = [];
    for (const rel of shapeScanFiles()) {
      readFileSync(resolve(REPO_ROOT, rel), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.match(LANE) ?? []) seen.push({ id: m, where: `${rel}:${i + 1}` });
        });
    }

    // BOTH HALVES of the scan itself. A broken regex or a walk that read
    // nothing would otherwise pass by finding no dangling identifier.
    expect(seen.length, 'the scan found no `compat-suite-*` identifiers at all').toBeGreaterThan(
      10,
    );
    expect(
      seen.some((s) => s.where.startsWith(COMPAT_WORKFLOW)),
      'the scan never read the compat workflow, so it is not reading the files it claims to',
    ).toBe(true);

    const dangling = seen.filter((s) => !resolves(s.id, ids));
    expect(
      dangling,
      `these names denote nothing — no workflow file, workflow name, job id, artifact or tracked file matches:\n${dangling
        .map((d) => `  ${d.where} -> ${d.id}`)
        .join('\n')}`,
    ).toEqual([]);
  });
});

describe('every pointer to the official harness names the workflow that runs it', () => {
  /**
   * A DEFLECTION, not a mention. Both parts are required, and that is the whole
   * point: `compat-smoke`'s job name and its banner both say "NOT the official
   * compat suite" without deflecting anywhere, and a disclaimer owes the reader
   * no destination. What owes a destination is the sentence that says the real
   * thing runs SOMEWHERE ELSE — and a deflection that names nowhere is worse
   * than silence, because the reader stops looking.
   */
  const SUBJECT = /deploy-test harness|official (?:Next\.js )?compat(?:ibility)? suite/i;
  const DEFLECTION =
    /\b(separate|elsewhere|lives (?:behind|in|at)|its own|runs (?:in|as)|not here)\b/i;

  it('names `test-e2e-deploy` within three lines of the claim', () => {
    const found: Array<{ where: string; line: string; ok: boolean }> = [];

    for (const rel of pointerScanFiles()) {
      const lines = readFileSync(resolve(REPO_ROOT, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!SUBJECT.test(line) || !DEFLECTION.test(line)) return;
        const window = lines.slice(Math.max(0, i - 3), i + 4).join(' ');
        found.push({
          where: `${rel}:${i + 1}`,
          line: line.trim(),
          ok:
            /test-e2e-deploy/.test(window) ||
            /Compat suite \(official Next\.js deploy harness\)/.test(window),
        });
      });
    }

    // Non-vacuity: no pointers found means the regex or the scan set broke,
    // and "no dangling pointer" would be true only in the useless sense.
    expect(found.length, 'the scan found no pointers to the official harness').toBeGreaterThan(1);

    const dangling = found.filter((f) => !f.ok);
    expect(
      dangling,
      `these tell a reader the official suite runs elsewhere without naming where:\n${dangling
        .map((d) => `  ${d.where}  ${d.line}`)
        .join('\n')}`,
    ).toEqual([]);
  });
});

describe('the scan boundary is asserted, not merely described', () => {
  it('covers the two files that carried the stale pointer', () => {
    // Named because these two are the incident. Everything else in the scan set
    // arrives by shape; if a future edit narrows the globs, these go red first.
    for (const rel of ['.github/workflows/ci.yml', 'apps/file-manager/scripts/compat-smoke.mjs']) {
      expect(shapeScanFiles(), `${rel} dropped out of the shape scan`).toContain(rel);
      expect(pointerScanFiles(), `${rel} dropped out of the pointer scan`).toContain(rel);
    }
  });

  it('covers the compat workflow and the published matrix, and excludes ADRs', () => {
    expect(shapeScanFiles()).toContain(COMPAT_WORKFLOW);
    expect(shapeScanFiles()).toContain('docs/compat-matrix.md');
    // The exclusion is a decision, so it is asserted: an ADR is a historical
    // record and ADR-0007 binds `compat-suite-full` to the real file where it
    // introduces the name. If someone later pulls `docs/adr/` into the scan,
    // this reds and they make that call deliberately.
    expect(shapeScanFiles().filter((p) => p.startsWith('docs/adr/'))).toEqual([]);
    expect(pointerScanFiles().filter((p) => p.endsWith('.md'))).toEqual([]);
  });

  it('excludes the mutation provers, and there is a prover to exclude', () => {
    // BOTH HALVES. Asserting only "no prover is scanned" would be satisfied by a
    // corpus with no provers in it, at which point the exclusion is describing
    // nothing and this guard has no standing proof either. So the corpus must be
    // non-empty AND this guard's own prover must be in it.
    const provers = trackedPaths().filter((p) => PROVER.test(p));
    expect(provers.length, 'no mutation provers are tracked at all').toBeGreaterThan(4);
    expect(provers, 'this guard has no prover, so nothing shows it is not decoration').toContain(
      'scripts/mutation-prove-compat-lane-pointer.mjs',
    );
    expect(shapeScanFiles().filter((p) => PROVER.test(p))).toEqual([]);
  });
});
