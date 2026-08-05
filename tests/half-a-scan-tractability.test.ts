import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanRepo, scanSource } from '../scripts/scan-half-scan-candidates.mjs';

/**
 * #639 second acceptance criterion — is the proposed lint TRACTABLE?
 *
 * The issue asks for "a lint that flags `expect(source).toContain(...)`-style
 * assertions in tests that have no paired negative assertion", and binds whoever
 * answers to judge tractability BEFORE building it, because "a bad heuristic here
 * would be noise".
 *
 * The answer measured in `docs/testing/half-a-scan-tractability.md` is NO — and
 * this file is what keeps that answer honest rather than a paragraph someone can
 * disagree with from memory. It does three things:
 *
 *  1. RECALL. Each of the three defect families from the seven-instance corpus is
 *     represented below by its assertion, taken verbatim from the merge commit
 *     that fixed it. The scanner's verdict on each is asserted — the one it
 *     reaches AND the ones it does not. Both halves: a recall claim proved only by
 *     the hits it finds is the very defect this issue is about.
 *
 *  2. PRECISION. The scanner is run over the repo's own test corpus and the flag
 *     count asserted to be double digits. That is the whole basis for "advisory,
 *     never a gate", and it is measured at test time rather than frozen as a
 *     number in prose that drifts.
 *
 *  3. NOT-A-GATE. The scanner's exit code is asserted to be 0 even when it has
 *     findings, and nothing in CI is allowed to consume it as a pass/fail signal.
 *
 * If a future refinement changes any of these, the conclusion changes with it —
 * which is the point. Re-open #639 and re-measure; do not delete the assertion.
 */

const REPO_ROOT = resolve(__dirname, '..');

/**
 * The corpus, distilled. Each entry is ONE assertion lifted from the real merged
 * PR (the commit is named so the original is one `git show` away), wrapped in the
 * minimum surrounding `it()` needed for the scanner to see it in context. The
 * `reached` field is the measured verdict, not an expectation.
 *
 * The two instances with no TypeScript assertion at all — #626 (a bash harness,
 * `assert_contains … "UNCONFIRMED"`) and #632 (a claim in a header comment that
 * no test enforced) — are outside any TS lint's reach by construction and are
 * recorded in the doc rather than simulated here.
 */
const CORPUS: {
  id: string;
  family: 'a-half-a-scan' | 'b-recurring-needle' | 'c-blocklist';
  origin: string;
  reached: boolean;
  code: string;
}[] = [
  {
    id: '#651 matrix apiVersion',
    family: 'b-recurring-needle',
    origin: 'ffc33b12c tests/release-policy-matrix.test.ts',
    reached: true,
    code: `
      const matrix = readFileSync(resolve(REPO_ROOT, 'docs/COMPATIBILITY.md'), 'utf8');

      it('names the CRD apiVersion the ADR declares (read from the ADR, not re-typed)', () => {
        expect(matrix).toContain(declaredCrdApiVersion());
      });
    `,
  },
  {
    id: '#633 unauthorized.tsx renders the shared component',
    family: 'b-recurring-needle',
    origin: '8e76e0d30 apps/file-manager/src/app/observability/_ui/access-denied.test.tsx',
    reached: true,
    code: `
      it('is backed by an unauthorized.tsx that renders the shared component', () => {
        const source = readFileSync(resolve(OBSERVABILITY_DIR, 'unauthorized.tsx'), 'utf8');
        expect(source).toContain('AccessDenied');
        expect(source).toMatch(/_ui\\/access-denied|\\.\\/_ui\\/access-denied/);
      });
    `,
  },
  {
    id: '#633 routes every gated page through denyObservabilityAccess()',
    family: 'b-recurring-needle',
    origin: '8e76e0d30 — the HEADLINE instance: an import satisfied the check',
    reached: false,
    code: `
      it('routes every gated page through denyObservabilityAccess()', () => {
        const missing = authGatedPages()
          .filter(({ source }) => !source.includes('denyObservabilityAccess'))
          .map(({ path }) => path);
        expect(missing).toEqual([]);
      });
    `,
  },
  {
    id: '#636 only the probe may take the reserved deadline',
    family: 'a-half-a-scan',
    origin: 'c026935b1 apps/file-manager/src/app/observability/deployments/page.test.tsx',
    reached: false,
    code: `
      it('gives every query on this page a deadline, and the probe the reserved one', () => {
        const source = readFileSync(resolve(import.meta.dirname, 'page.tsx'), 'utf8');
        const callSites = source.split('\\n').filter((line) => /\\bquery(?:Instant|Range)\\(/.test(line));
        expect(callSites.length).toBeGreaterThanOrEqual(4);
        expect(callSites.filter((line) => !/\\bdeadline\\b/.test(line))).toEqual([]);
        const probeSites = callSites.filter((line) => line.includes('KUBE_STATE_PROBE'));
        expect(probeSites).toHaveLength(1);
        expect(probeSites[0]).toMatch(/deadline\\.reserved\\(\\)/);
      });
    `,
  },
  {
    id: '#642 template parity classified one of two trees',
    family: 'a-half-a-scan',
    origin: '018615b92 packages/kn-next/src/__tests__/create-scaffold-parity.test.ts',
    reached: false,
    code: `
      it('classifies EVERY zone template file', () => {
        const unclassified = templateFiles(ZONE_TEMPLATE).filter((f) => !classified.has(f));
        expect(unclassified, 'new template file(s) — classify each').toEqual([]);
      });
    `,
  },
  {
    id: '#637 swallow blocklist',
    family: 'c-blocklist',
    origin: '054322f3c tests/seam-alive-app-coverage.test.ts',
    reached: false,
    code: `
      it('does NOT swallow the scanner exit code in a command substitution', () => {
        for (const line of text.split('\\n')) {
          if (!line.includes('seam-alive-apps.mjs')) continue;
          expect(
            /\\$\\(.*seam-alive-apps\\.mjs.*\\)/.test(line) && /\\becho\\b/.test(line),
            'wraps the scanner in a command substitution inside echo',
          ).toBe(false);
        }
      });
    `,
  },
];

describe('#639 — the proposed half-a-scan lint, measured against the corpus that motivated it', () => {
  /**
   * The POSITIVE half of the recall claim. Without this the negative half below
   * would be satisfied by a scanner that flags nothing at all.
   */
  it.each(CORPUS.filter((c) => c.reached))('REACHES $id ($family, $origin)', ({ code, id }) => {
    expect(scanSource(code, `${id}.test.ts`).length, `${id} should be flagged`).toBeGreaterThan(0);
  });

  /**
   * The NEGATIVE half — the reason the answer is "not tractable". Four of the six
   * TypeScript assertions in the corpus are invisible to the heuristic, and not
   * for want of tuning: three of them already carry a negative assertion
   * (`toEqual([])`, `toBe(false)`), which is exactly the signal the proposed lint
   * keys on. The defect is in what the assertion MEANS, not in its shape.
   */
  it.each(CORPUS.filter((c) => !c.reached))('MISSES $id ($family, $origin)', ({ code, id }) => {
    expect(scanSource(code, `${id}.test.ts`), `${id} is out of the heuristic's reach`).toEqual([]);
  });

  it('reaches at most one of the three defect families', () => {
    const reached = new Set(CORPUS.filter((c) => c.reached).map((c) => c.family));
    expect([...reached]).toEqual(['b-recurring-needle']);
  });
});

describe('#639 — precision on the live corpus is what makes this advisory, never a gate', () => {
  const findings = scanRepo(REPO_ROOT);

  /**
   * Double digits. Every one of these assertions is on `main`, green, and reviewed;
   * spot-checking the list finds ordinary presence checks (`toContain('kind: Job')`,
   * `toContain('templates')`) whose whole purpose is presence and for which a paired
   * negative would be meaningless. A gate firing this often is the "cries wolf"
   * failure the issue names — it trains people to ignore it.
   *
   * This is a TRIPWIRE on the finding's premise, not a quality bar. If a future
   * refinement drops it below double digits, the tractability conclusion may have
   * changed: re-open #639 and re-measure. Do not delete this assertion to get green.
   */
  it('flags a double-digit number of correct, shipped assertions', () => {
    expect(findings.length).toBeGreaterThanOrEqual(10);
  });

  it('finds them across many unrelated test files, so it is not one bad file', () => {
    expect(new Set(findings.map((f) => f.file)).size).toBeGreaterThanOrEqual(10);
  });

  /** Every finding must be locatable, or the advisory output is unusable. */
  it('reports a file and a line for every finding', () => {
    expect(findings.filter((f) => !f.file || !Number.isInteger(f.line) || f.line < 1)).toEqual([]);
  });
});

describe('#639 — the scanner is wired as advisory, and nothing consumes it as a gate', () => {
  it('exits 0 on this repo even though it has findings', async () => {
    const { main } = await import('../scripts/scan-half-scan-candidates.mjs');
    expect(scanRepo(REPO_ROOT).length).toBeGreaterThan(0);
    expect(main([REPO_ROOT])).toBe(0);
  });

  /**
   * SCANNED, not enumerated: any workflow that ran this scanner would make an
   * advisory count publish-blocking on a heuristic measured to be mostly noise.
   */
  it('no workflow invokes it', () => {
    const dir = resolve(REPO_ROOT, '.github/workflows');
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    expect(workflows.length, 'no workflows found — the scan would pass vacuously').toBeGreaterThan(
      0,
    );
    const offenders = workflows.filter((f) =>
      readFileSync(resolve(dir, f), 'utf8').includes('scan-half-scan-candidates'),
    );
    expect(offenders).toEqual([]);
  });

  /** The doc must state the verdict the code implements, not a softer one. */
  it('the finding document records the verdict as NOT TRACTABLE as a gate', () => {
    const doc = readFileSync(
      resolve(REPO_ROOT, 'docs/testing/half-a-scan-tractability.md'),
      'utf8',
    );
    expect(doc).toContain('NOT TRACTABLE as a gate');
    expect(doc).toContain('advisory');
  });
});
