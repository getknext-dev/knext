import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD TESTS for the docs dependency-closure NIGHTLY Trivy scan (#320).
 *
 * The per-PR `docs-site` job in ci.yml scans the docs closure, but it is
 * PATH-FILTERED (only runs when apps/docs/** or the @knext/core surface
 * changes) AND report-on-PR / fail-on-main. So a transitive HIGH/CRITICAL
 * introduced by a PR that DOESN'T touch apps/docs escapes the gate entirely
 * and only turns main red on the next push that happens to touch docs — the
 * exact class that produced the #319 main-red.
 *
 * The fix (#320): a SCHEDULED (nightly) workflow that scans the docs closure
 * WITHOUT the path filter, FAILS on HIGH/CRITICAL, and fires an IDEMPOTENT
 * pinned alert issue (mirrors the `nightly-red-alert` pattern in
 * test-e2e-deploy.yml — one pinned issue, comment don't spam).
 *
 * The load-bearing invariant these tests lock in: the nightly scan config MUST
 * NOT DRIFT from the per-PR docs-site scan config. Both scan the SAME closure
 * lockfile with the SAME severity / exit-code / ignore-unfixed, so a CVE the
 * nightly catches is the same class the PR gate would enforce on main — no
 * "nightly is stricter/looser than main" surprise. We assert the two Trivy
 * `with:` blocks are byte-identical (modulo formatting) so they cannot diverge.
 *
 * Like tests/supply-chain-workflow.test.ts this scans the workflow YAML as text
 * (no runtime YAML dependency); CI-safe paths via import.meta.dirname + resolve.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const CI_WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const NIGHTLY_WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/docs-closure-nightly.yml');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Splits a workflow into step blocks in document order. A step starts at a
 * `- name:` or `- uses:` line; everything up to the next such line belongs to
 * the same step. (Same splitter as supply-chain-workflow.test.ts.)
 */
function stepBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) blocks.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    if (/^\s*-\s+(name|uses):/.test(line)) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

function stripComments(block: string): string {
  return block
    .split('\n')
    .filter((l) => !l.trim().startsWith('#') && !/^\s*-?\s*name:/.test(l))
    .join('\n');
}

const TRIVY_RE = /uses:\s*aquasecurity\/trivy-action/;

/** The first Trivy step block in `text`, or '' if none. */
function trivyStep(text: string): string {
  return stepBlocks(text).find((b) => TRIVY_RE.test(stripComments(b))) ?? '';
}

/**
 * Extracts the `with:` mapping of a Trivy step as a normalized set of
 * `key: value` pairs (comments stripped, whitespace collapsed, unquoted).
 * This is the drift-detection primitive: two Trivy steps have "the same scan
 * config" iff their normalized with-maps are equal.
 */
function trivyWithConfig(text: string): Record<string, string> {
  const step = stripComments(trivyStep(text));
  const lines = step.split('\n');
  const withIdx = lines.findIndex((l) => /^\s*with:\s*$/.test(l));
  if (withIdx === -1) return {};
  const withIndent = (lines[withIdx].match(/^\s*/)?.[0].length ?? 0) + 1;
  const config: Record<string, string> = {};
  for (const line of lines.slice(withIdx + 1)) {
    if (line.trim() === '') continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent < withIndent) break; // dedented out of the with: block
    const m = line.match(/^\s*([\w-]+):\s*(.*?)\s*$/);
    if (m) {
      const [, key, rawVal] = m;
      config[key] = rawVal.replace(/^['"]|['"]$/g, '');
    }
  }
  return config;
}

describe('#320 docs-closure nightly workflow exists and is scheduled', () => {
  it('a dedicated nightly workflow file exists', () => {
    expect(() => read(NIGHTLY_WORKFLOW_PATH), 'docs-closure-nightly.yml must exist').not.toThrow();
  });

  it('the workflow is triggered on a cron schedule (not path-filtered)', () => {
    const text = read(NIGHTLY_WORKFLOW_PATH);
    expect(/^on:/m.test(text), 'workflow needs an on: trigger block').toBe(true);
    expect(/schedule:/.test(text), 'workflow must run on a schedule').toBe(true);
    expect(/-\s*cron:\s*['"][^'"]+['"]/.test(text), 'workflow must declare a cron expression').toBe(
      true,
    );
    // The nightly must NOT gate the scan behind a paths-filter — that is the
    // whole point (#320): continuous coverage decoupled from PR file cadence.
    const scanText = text.slice(text.indexOf('trivy') >= 0 ? 0 : 0);
    expect(
      /dorny\/paths-filter/.test(scanText),
      'the nightly must NOT use a paths-filter — it must always run the scan',
    ).toBe(false);
  });

  it('the workflow prunes the SAME docs closure (turbo prune knext-docs → .docs-closure)', () => {
    const text = read(NIGHTLY_WORKFLOW_PATH);
    expect(
      /turbo prune knext-docs --out-dir \.\/\.docs-closure/.test(text),
      'the nightly must materialise the docs closure via turbo prune knext-docs --out-dir ./.docs-closure',
    ).toBe(true);
  });
});

describe('#320 the nightly Trivy scan is fail-loud on HIGH/CRITICAL', () => {
  it('scans the pruned closure lockfile with severity HIGH,CRITICAL, exit-code 1, ignore-unfixed', () => {
    const cfg = trivyWithConfig(read(NIGHTLY_WORKFLOW_PATH));
    expect(cfg['scan-type'], 'must be an fs scan').toBe('fs');
    expect(cfg['scan-ref'], 'must scan the docs closure lockfile').toBe(
      './.docs-closure/pnpm-lock.yaml',
    );
    expect(cfg.severity, 'must scan HIGH,CRITICAL').toBe('HIGH,CRITICAL');
    expect(cfg['exit-code'], 'must exit non-zero on findings').toBe('1');
    expect(cfg['ignore-unfixed'], 'must match docs-site ignore-unfixed').toBe('true');
  });

  it('does NOT soften the gate with continue-on-error (the nightly always enforces)', () => {
    const step = stripComments(trivyStep(read(NIGHTLY_WORKFLOW_PATH)));
    // Unlike the per-PR docs-site step (report-on-PR / fail-on-main), the
    // nightly has no PR phase — it must never carry a continue-on-error that
    // could let a HIGH/CRITICAL pass silently.
    expect(
      /continue-on-error/.test(step),
      'the nightly Trivy step must not set continue-on-error — it always fails on HIGH/CRITICAL',
    ).toBe(false);
  });
});

describe('#320 NO DRIFT: nightly scan config equals the per-PR docs-site scan config', () => {
  it('the two Trivy with-configs are identical (severity/exit-code/scan-ref/ignore-unfixed)', () => {
    const nightly = trivyWithConfig(read(NIGHTLY_WORKFLOW_PATH));
    const docsSite = trivyWithConfig(read(CI_WORKFLOW_PATH));
    // Sanity: both must actually be populated (a missing step yields {} which
    // would make an equality check pass vacuously).
    expect(Object.keys(docsSite).length, 'ci.yml docs-site Trivy step not found').toBeGreaterThan(
      0,
    );
    expect(Object.keys(nightly).length, 'nightly Trivy step not found').toBeGreaterThan(0);
    // The security-load-bearing keys must be byte-equal between the two jobs so
    // they cannot diverge (one enforcing a different severity/ref than the
    // other). `format` is presentation-only and excluded.
    const loadBearing = ['scan-type', 'scan-ref', 'severity', 'exit-code', 'ignore-unfixed'];
    for (const key of loadBearing) {
      expect(
        nightly[key],
        `nightly and docs-site must agree on Trivy "${key}" (drift = #320 regression)`,
      ).toBe(docsSite[key]);
    }
  });

  it('the trivy-action is the SAME pinned SHA as ci.yml (no version drift)', () => {
    const nightlyPin = read(NIGHTLY_WORKFLOW_PATH).match(
      /uses:\s*(aquasecurity\/trivy-action@[0-9a-f]{40})/,
    );
    const ciPin = read(CI_WORKFLOW_PATH).match(/uses:\s*(aquasecurity\/trivy-action@[0-9a-f]{40})/);
    expect(nightlyPin, 'nightly must SHA-pin trivy-action').toBeTruthy();
    expect(ciPin, 'ci.yml must SHA-pin trivy-action').toBeTruthy();
    expect((nightlyPin as RegExpMatchArray)[1]).toBe((ciPin as RegExpMatchArray)[1]);
  });
});

describe('#320 idempotent pinned alert (mirrors nightly-red-alert)', () => {
  it('has an alert job that only fires on a failed SCHEDULED run', () => {
    const text = read(NIGHTLY_WORKFLOW_PATH);
    // scheduled scope: don't spam an issue on a manual workflow_dispatch
    // experiment — mirror the compat nightly's event scoping.
    expect(
      /github\.event_name == 'schedule'/.test(text),
      'the alert must be scoped to schedule events (not dispatch experiments)',
    ).toBe(true);
    // fires on failure of the scan job (result == 'failure' after always()).
    expect(
      /result == 'failure'/.test(text),
      'the alert must fire only when the scan job failed',
    ).toBe(true);
    expect(
      /always\(\)/.test(text),
      'the alert job needs always() so a failed need does not skip it',
    ).toBe(true);
  });

  it('needs issues: write permission to file/update the alert issue', () => {
    expect(
      /issues:\s*write/.test(read(NIGHTLY_WORKFLOW_PATH)),
      'the alert job must request issues: write',
    ).toBe(true);
  });

  it('is IDEMPOTENT: looks up ONE open pinned issue and comments on it instead of opening a new one', () => {
    const text = read(NIGHTLY_WORKFLOW_PATH);
    // dedup lookup: gh issue list filtered by the fixed alert title.
    expect(
      /gh issue list/.test(text),
      'the alert must look up the existing pinned issue (gh issue list)',
    ).toBe(true);
    // #187-class guard mirrored from nightly-red-alert: --limit must be raised
    // above gh's default 30 so a busy backlog can't hide the pinned issue and
    // cause daily NEW-issue spam.
    const limitMatch = text.match(/gh issue list[\s\S]*?--limit\s+(\d+)/);
    expect(limitMatch, 'the lookup must pass an explicit --limit').toBeTruthy();
    expect(
      Number((limitMatch as RegExpMatchArray)[1]),
      'the --limit must be well above gh default 30 so the pinned issue is not missed',
    ).toBeGreaterThanOrEqual(100);
    // comment-if-exists / create-if-absent branch.
    expect(
      /gh issue comment/.test(text),
      'an existing alert issue must be UPDATED via gh issue comment (idempotent, not a new issue)',
    ).toBe(true);
    expect(/gh issue create/.test(text), 'a first red must CREATE the alert issue').toBe(true);
    expect(/gh issue pin/.test(text), 'the created alert issue must be pinned').toBe(true);
  });

  it('the alert title is a fixed literal (a stable idempotency key)', () => {
    const text = read(NIGHTLY_WORKFLOW_PATH);
    // The idempotency key is the issue TITLE; it must be a fixed string the
    // lookup and the create share, not something interpolated per-run (which
    // would defeat dedup). Assert a title= assignment to a constant literal.
    const titleMatch = text.match(/title=['"]([^'"$]+)['"]/);
    expect(titleMatch, 'the alert must use a fixed literal title as the dedup key').toBeTruthy();
  });
});

describe('#320 per-PR docs-site behavior is UNCHANGED', () => {
  const ci = read(CI_WORKFLOW_PATH);

  it('docs-site stays path-filtered (dorny/paths-filter on apps/docs/**)', () => {
    expect(/dorny\/paths-filter/.test(ci), 'docs-site must keep its paths-filter').toBe(true);
    expect(/apps\/docs\/\*\*/.test(ci), 'docs-site must still filter on apps/docs/**').toBe(true);
  });

  it('docs-site Trivy step keeps report-on-PR / fail-on-main (continue-on-error ref-gate)', () => {
    const step = trivyStep(ci);
    const coe = step.match(/continue-on-error:\s*(.+)/);
    expect(coe, 'docs-site Trivy must keep its continue-on-error ref-gate').toBeTruthy();
    expect(
      (coe as RegExpMatchArray)[1].includes("github.ref != 'refs/heads/main'"),
      'docs-site continue-on-error must remain PR-only (report-on-PR / fail-on-main)',
    ).toBe(true);
  });
});
