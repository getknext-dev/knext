#!/usr/bin/env node
/**
 * Full-history secret scan with a disposition-classed allowlist.
 *
 * Runs gitleaks over the ENTIRE git history (measured ~3s on this repo), then
 * filters findings against security/gitleaks-allowlist.json. Full-history
 * rather than diff scanning is deliberate: it kills the whole bypass class the
 * sprint design review named — a base-branch secret the diff never re-reads,
 * and a force-push that rewrites the PR base out of the scanned window.
 *
 * Exit codes:
 *   0  no unsuppressed findings
 *   1  unsuppressed findings (or gitleaks itself failed — unrunnable is a
 *      FAILURE, never a pass, same principle as the action-pin checker)
 *   2  configuration error (malformed allowlist — a bad entry is REJECTED,
 *      not honored; otherwise editing the allowlist becomes the bypass)
 *
 * Output is REDACTED by construction: gitleaks runs with --redact=100 and this
 * script prints only rule + path + commit + fingerprint, never match content.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_PATH = resolve(REPO_ROOT, 'security/gitleaks-allowlist.json');

const CLASSES = new Set(['rotated-historical', 'false-positive']);
const REQUIRED_KEYS = ['fingerprint', 'rule', 'path', 'class', 'justification', 'added'];

/**
 * Validate the allowlist; throws with a reason on ANY malformed entry.
 * Exported shape kept simple so the unit test can drive it directly.
 */
export function validateAllowlist(raw) {
  if (!raw || !Array.isArray(raw.entries)) {
    throw new Error('allowlist invalid: top-level { entries: [...] } required');
  }
  for (const e of raw.entries) {
    for (const k of REQUIRED_KEYS) {
      if (!e[k] || typeof e[k] !== 'string') {
        throw new Error(`allowlist invalid: entry missing "${k}": ${JSON.stringify(e)}`);
      }
    }
    if (!CLASSES.has(e.class)) {
      throw new Error(`allowlist invalid: unknown class "${e.class}" (${e.fingerprint})`);
    }
    if (e.class === 'rotated-historical') {
      if (!e.rotationEvidence) {
        throw new Error(
          `allowlist invalid: rotated-historical without rotationEvidence (${e.fingerprint}) — ` +
            'permanent suppression is admissible only with proof the credential is dead',
        );
      }
      if (e.expires) {
        throw new Error(
          `allowlist invalid: rotated-historical must not expire (${e.fingerprint}) — ` +
            'history is never rewritten, so an expiry just schedules a false alarm ' +
            'whose routine fix would be bumping the date',
        );
      }
    }
    if (e.class === 'false-positive' && !/^\d{4}-\d{2}-\d{2}$/.test(e.expires ?? '')) {
      throw new Error(
        `allowlist invalid: false-positive without a dated expiry (${e.fingerprint})`,
      );
    }
  }
  return raw.entries;
}

/**
 * Partition findings into suppressed / unsuppressed. An entry suppresses a
 * finding only on an EXACT fingerprint match AND matching rule + path — a
 * fingerprint alone could be replayed onto a different rule by a config change.
 * Expired false-positives suppress nothing (the finding resurfaces).
 */
export function filterFindings(findings, entries, now = new Date()) {
  const unsuppressed = [];
  const suppressed = [];
  for (const f of findings) {
    const hit = entries.find(
      (e) => e.fingerprint === f.Fingerprint && e.rule === f.RuleID && e.path === f.File,
    );
    if (!hit) {
      unsuppressed.push(f);
      continue;
    }
    if (hit.class === 'false-positive' && new Date(`${hit.expires}T00:00:00Z`) <= now) {
      unsuppressed.push({ ...f, expiredAllowlist: hit.expires });
      continue;
    }
    suppressed.push(f);
  }
  return { unsuppressed, suppressed };
}

function describe(f) {
  // rule + path + commit + fingerprint ONLY — never match content.
  const expired = f.expiredAllowlist ? `  [allowlist EXPIRED ${f.expiredAllowlist}]` : '';
  return `  ${f.RuleID}  ${f.File}  ${String(f.Commit).slice(0, 8)}  ${f.Fingerprint}${expired}`;
}

function main() {
  let entries;
  try {
    entries = validateAllowlist(JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')));
  } catch (err) {
    console.error(`[secret-scan] ${err.message}`);
    process.exit(2);
  }

  const tmp = mkdtempSync(join(tmpdir(), 'gitleaks-'));
  const report = join(tmp, 'report.json');
  try {
    // --redact=100: even gitleaks' own log lines carry no secret content.
    // --exit-code 0: findings are OUR verdict (via the allowlist), not gitleaks'.
    const r = spawnSync(
      'gitleaks',
      [
        'git',
        '.',
        '--redact=100',
        '--exit-code',
        '0',
        '--report-format',
        'json',
        '--report-path',
        report,
      ],
      { cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
    );
    // gitleaks missing or crashed: unrunnable is a FAILURE, never a pass.
    if (r.error || r.status !== 0 || !existsSync(report)) {
      console.error(
        `[secret-scan] gitleaks did not produce a report (status=${r.status ?? 'spawn-fail'}) — ` +
          'unrunnable is a FAILURE, never a pass',
      );
      process.exit(1);
    }
    const findings = JSON.parse(readFileSync(report, 'utf8'));
    const { unsuppressed, suppressed } = filterFindings(findings, entries);
    console.log(
      `[secret-scan] history scan: ${findings.length} finding(s), ` +
        `${suppressed.length} allowlisted, ${unsuppressed.length} unsuppressed`,
    );
    if (unsuppressed.length > 0) {
      console.error('[secret-scan] UNSUPPRESSED FINDINGS (references only, values redacted):');
      for (const f of unsuppressed) console.error(describe(f));
      console.error(
        '[secret-scan] a pushed secret is LEAKED regardless of any later commit removing it: ' +
          'ROTATE the credential first, then either fix the code or (if genuinely dead/false) ' +
          'add a justified entry to security/gitleaks-allowlist.json.',
      );
      process.exit(1);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Import-safe: the unit tests import the pure functions without running a scan.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
