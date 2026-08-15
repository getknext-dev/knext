/**
 * The CI secret-scanning gate must exist, fail closed, and keep its teeth.
 *
 * WHY THIS EXISTS. block-secrets is a LOCAL hook: a contributor without hooks,
 * or a GitHub web edit, commits a secret and nothing in CI notices — the
 * security sprint found exactly one such secret (a private key, later rotated
 * via PR #730) that sat in history for weeks. This gate scans FULL history on
 * every CI run (measured at ~3s for this repo), which also kills the entire
 * diff-only bypass class: a force-push that rewrites the PR base cannot hide a
 * commit from a scan that reads all of history.
 *
 * WHAT THIS GUARDS (both halves, per #639):
 *   1. the job exists, on the PR path, with NO escape hatch — the house idiom
 *      `continue-on-error: ${{ github.ref != 'refs/heads/main' }}` is FORBIDDEN
 *      here by the sprint plan's design review: it makes the gate advisory on
 *      exactly the event it exists for;
 *   2. the scanner binary is version+checksum pinned (a `gitleaks-action`
 *      dependency would add org licensing and an unpinned code path);
 *   3. the allowlist cannot rot into a bypass: entries are fingerprint-scoped
 *      with two disposition classes — `rotated-historical` (permanent, needs
 *      rotation evidence; history is never rewritten, so the finding is
 *      forever) and `false-positive` (needs a dated expiry) — and the wrapper
 *      script REJECTS any entry outside that schema rather than honoring it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const ci = readFileSync(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
const nightly = readFileSync(
  resolve(REPO_ROOT, '.github/workflows/secret-scan-nightly.yml'),
  'utf8',
);
const script = readFileSync(resolve(REPO_ROOT, 'scripts/secret-scan.mjs'), 'utf8');
const allowlist = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'security/gitleaks-allowlist.json'), 'utf8'),
);

/** The secret-scan job's YAML block: from its key to the next job at the same indent. */
function jobBlock(yaml: string, jobKey: string): string {
  const start = yaml.indexOf(`\n  ${jobKey}:`);
  expect(start, `job ${jobKey} not found`).toBeGreaterThan(-1);
  const rest = yaml.slice(start + 1);
  const next = rest.slice(rest.indexOf('\n')).search(/\n  [a-zA-Z0-9_-]+:/);
  return next === -1 ? rest : rest.slice(0, next + rest.indexOf('\n'));
}

describe('secret-scan job in ci.yml — present and unable to fail open', () => {
  const job = jobBlock(ci, 'secret-scan');

  it('has no continue-on-error and no ref-conditional if', () => {
    // The design-review finding this encodes: the repo's own house idiom
    // (`continue-on-error` gated on ref, ci.yml uses it elsewhere) would make
    // this gate advisory on pull_request — the one event it exists for.
    expect(job, 'continue-on-error makes the gate advisory').not.toMatch(/continue-on-error/);
    expect(job, 'a ref-conditional if: skips the gate somewhere').not.toMatch(/^\s+if:/m);
  });

  it('checks out FULL history — a shallow clone reintroduces the diff-only bypass class', () => {
    expect(job).toMatch(/fetch-depth:\s*0/);
  });

  it('runs the wrapper via node with nothing swallowing the exit code', () => {
    const runLines = job.split('\n').filter((l) => l.includes('secret-scan.mjs'));
    expect(runLines.length, 'the job must invoke scripts/secret-scan.mjs').toBeGreaterThanOrEqual(
      1,
    );
    for (const l of runLines) {
      expect(l, `exit-code swallow in: ${l}`).not.toMatch(/\|\|\s*true|\|\s*tee|echo\s+"?\$\(/);
    }
  });

  it('pins the gitleaks version AND tarball sha256', () => {
    expect(job).toMatch(/GITLEAKS_VERSION:\s*["']?8\.30\.1/);
    expect(job).toMatch(/GITLEAKS_SHA256:\s*["']?[0-9a-f]{64}/);
    // Checksum must actually be VERIFIED, not just declared.
    expect(job).toMatch(/sha256sum -c|shasum -a 256 -c/);
    // And the verification must abort the install on mismatch (no soft-fail).
    const installLines = job.split('\n').filter((l) => /sha256sum -c|shasum -a 256 -c/.test(l));
    for (const l of installLines) {
      expect(l, `checksum soft-fail in: ${l}`).not.toMatch(/\|\|/);
    }
  });

  it('does not use gitleaks-action', () => {
    expect(ci).not.toMatch(/uses:\s*gitleaks\/gitleaks-action/);
  });
});

describe('nightly full-history scan — the drift catcher for new rules', () => {
  it('exists on a cron schedule and reuses the same wrapper', () => {
    expect(nightly).toMatch(/schedule:/);
    expect(nightly).toMatch(/cron:/);
    expect(nightly).toMatch(/secret-scan\.mjs/);
    expect(nightly).toMatch(/fetch-depth:\s*0/);
    expect(nightly).not.toMatch(/continue-on-error/);
  });
});

describe('allowlist — scoped, justified, and incapable of quiet rot', () => {
  it('every entry carries fingerprint, rule, path, class, justification, added', () => {
    expect(Array.isArray(allowlist.entries)).toBe(true);
    for (const e of allowlist.entries) {
      for (const k of ['fingerprint', 'rule', 'path', 'class', 'justification', 'added']) {
        expect(e[k], `allowlist entry missing ${k}: ${JSON.stringify(e)}`).toBeTruthy();
      }
      expect(['rotated-historical', 'false-positive']).toContain(e.class);
      if (e.class === 'rotated-historical') {
        // Permanent suppression is admissible ONLY with rotation evidence —
        // otherwise "add an allowlist line" becomes the rotation.
        expect(e.rotationEvidence, 'rotated-historical without rotationEvidence').toBeTruthy();
        expect(e.expires, 'rotated-historical must NOT expire (history is forever)').toBe(
          undefined,
        );
      }
      if (e.class === 'false-positive') {
        expect(e.expires, 'false-positive without a dated expiry').toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('carries the one known historical finding as rotated-historical', () => {
    const entry = allowlist.entries.find((e: { path: string }) =>
      e.path.includes('private-key.pem'),
    );
    expect(entry, 'the PR #730 rotated key must be allowlisted as rotated-historical').toBeTruthy();
    expect(entry.class).toBe('rotated-historical');
  });
});

describe('wrapper semantics — driven through the exported pure functions', () => {
  const finding = (over = {}) => ({
    Fingerprint: 'c0ffee:path/f.txt:rule-x:1',
    RuleID: 'rule-x',
    File: 'path/f.txt',
    Commit: 'c0ffee',
    ...over,
  });
  const entry = (over = {}) => ({
    fingerprint: 'c0ffee:path/f.txt:rule-x:1',
    rule: 'rule-x',
    path: 'path/f.txt',
    class: 'false-positive',
    justification: 'test fixture',
    added: '2026-08-15',
    expires: '2099-01-01',
    ...over,
  });

  it('an expired false-positive resurfaces the finding', async () => {
    const { filterFindings } = await import('../scripts/secret-scan.mjs');
    const live = filterFindings([finding()], [entry()], new Date('2026-08-15'));
    expect(live.unsuppressed).toHaveLength(0);
    const expired = filterFindings([finding()], [entry()], new Date('2099-01-02'));
    expect(expired.unsuppressed).toHaveLength(1);
    expect(expired.unsuppressed[0].expiredAllowlist).toBe('2099-01-01');
  });

  it('a fingerprint match with a DIFFERENT rule or path suppresses nothing', async () => {
    const { filterFindings } = await import('../scripts/secret-scan.mjs');
    for (const bad of [{ RuleID: 'rule-y' }, { File: 'other/g.txt' }]) {
      const r = filterFindings([finding(bad)], [entry()], new Date('2026-08-15'));
      expect(r.unsuppressed, `should not suppress with ${JSON.stringify(bad)}`).toHaveLength(1);
    }
  });

  it('validateAllowlist throws on every malformed shape rather than honoring it', async () => {
    const { validateAllowlist } = await import('../scripts/secret-scan.mjs');
    const wrap = (e: Record<string, unknown>) => ({ entries: [e] });
    expect(() => validateAllowlist(wrap(entry({ justification: undefined })))).toThrow();
    expect(() => validateAllowlist(wrap(entry({ class: 'accepted' })))).toThrow();
    expect(() =>
      validateAllowlist(wrap(entry({ class: 'rotated-historical', expires: undefined }))),
    ).toThrow(/rotationEvidence/);
    expect(() =>
      validateAllowlist(
        wrap(
          entry({
            class: 'rotated-historical',
            rotationEvidence: 'PR #x',
            // an expiring rotated-historical schedules a false alarm
          }),
        ),
      ),
    ).toThrow(/must not expire/);
    expect(() => validateAllowlist(wrap(entry({ expires: 'soonish' })))).toThrow(/dated expiry/);
    // the real committed allowlist passes
    expect(() => validateAllowlist(allowlist)).not.toThrow();
  });
});

describe('wrapper script — fails closed', () => {
  it('treats a missing/unrunnable gitleaks as failure, never a pass', () => {
    // The action-pin checker's own principle: unreachable is a FAILURE.
    expect(script).toMatch(/unrunnable is a FAILURE|missing is a FAILURE|never a pass/i);
  });

  it('redacts: no secret values in output', () => {
    expect(script).toMatch(/--redact/);
  });

  it('rejects malformed allowlist entries instead of honoring them', () => {
    expect(script).toMatch(/malformed|invalid.*allowlist|allowlist.*invalid/i);
  });
});
