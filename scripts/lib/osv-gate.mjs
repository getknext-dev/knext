/**
 * The decision logic of the OSV dependency gate: pure functions over OSV-Scanner's
 * JSON report, so the policy is unit-tested without a network or a binary.
 * `scripts/osv-gate.mjs` is the thin CLI that runs the scanner and calls this.
 *
 * POLICY (tests/osv-gate.test.ts pins every line of it):
 *   - a malicious-package advisory (`MAL-…`) on any locked package FAILS, always;
 *   - a vulnerability FAILS only when it is HIGH or CRITICAL (CVSS >= 7.0) and NEW
 *     relative to the base, because the tree already carries advisories and a gate
 *     that reds every unrelated PR gets ignored. `full: true` fails on all of them;
 *   - unknown severity is reported, never failed;
 *   - the only suppression is a dated, justified allowlist entry that has not expired;
 *   - anything unreadable is an error, never a pass.
 */

import { relative } from 'node:path';

/** CVSS base score at which a vulnerability is HIGH (the Trivy/npm-audit threshold). */
export const HIGH_SEVERITY = 7;

/** The lockfile basenames OSV-Scanner understands for the ecosystems knext ships. */
export const LOCKFILE_NAMES = ['bun.lock', 'Cargo.lock', 'go.mod'];

/**
 * The lockfiles among a list of tracked paths. The caller supplies the list
 * (`git ls-files`), so a new crate, module or workspace is scanned the day it
 * lands, with no list kept here. Nothing is exempt: a malicious package is
 * malicious in a fixture too.
 *
 * @param {string[]} trackedPaths repo-relative paths
 * @returns {string[]}
 */
export function selectLockfiles(trackedPaths) {
  return trackedPaths.filter((p) => LOCKFILE_NAMES.includes(p.split('/').pop() ?? ''));
}

/**
 * A MAL- advisory marks a package as malware (OpenSSF malicious-packages feed,
 * carried by OSV). It may be the advisory id or an alias of a GHSA.
 *
 * @param {{id: string, aliases?: string[]}} v
 */
export function isMalicious(v) {
  return /^MAL-/.test(v.id) || (v.aliases ?? []).some((a) => /^MAL-/.test(a));
}

/**
 * Flatten OSV-Scanner's `--format json` report into findings.
 *
 * @param {string} text the report
 * @param {string} scanRoot absolute directory the scan paths are relative to
 * @returns {Array<{lockfile: string, ecosystem: string, name: string, version: string,
 *   id: string, aliases: string[], severity: number | null, malicious: boolean}>}
 */
export function parseOsv(text, scanRoot) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`OSV report is not JSON: ${err.message}`);
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.results)) {
    throw new Error('OSV report has no `results` array: refusing to read it as a clean scan');
  }
  const findings = [];
  for (const result of doc.results) {
    const abs = result?.source?.path;
    if (typeof abs !== 'string') throw new Error('OSV result has no source.path');
    const lockfile = relative(scanRoot, abs);
    for (const p of result.packages ?? []) {
      const groups = p.groups ?? [];
      for (const v of p.vulnerabilities ?? []) {
        const group = groups.find((g) => (g.ids ?? []).includes(v.id));
        const raw = group?.max_severity;
        const parsed = raw === undefined || raw === '' ? Number.NaN : Number.parseFloat(raw);
        const finding = {
          lockfile,
          ecosystem: p.package.ecosystem,
          name: p.package.name,
          version: p.package.version,
          id: v.id,
          aliases: v.aliases ?? [],
          severity: Number.isFinite(parsed) ? parsed : null,
          malicious: false,
        };
        finding.malicious = isMalicious(finding);
        findings.push(finding);
      }
    }
  }
  return findings;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate the allowlist document and drop the entries that have expired.
 * Throws on a malformed one: a half-read allowlist must not silently suppress.
 *
 * @param {unknown} doc
 * @param {string} today ISO date
 * @returns {{active: Array<{id: string, justification: string, added: string, expires?: string}>,
 *   expired: Array<{id: string, expires: string}>}}
 */
export function loadAllowlist(doc, today) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.allow)) {
    throw new Error('allowlist must be an object with an `allow` array');
  }
  const active = [];
  const expired = [];
  for (const [i, e] of doc.allow.entries()) {
    if (typeof e?.id !== 'string' || !e.id) throw new Error(`allow[${i}] needs a string \`id\``);
    if (typeof e.justification !== 'string' || e.justification.trim().length < 20) {
      throw new Error(`allow[${i}] (${e.id}) needs a real \`justification\` (>= 20 chars)`);
    }
    if (typeof e.added !== 'string' || !ISO_DATE.test(e.added)) {
      throw new Error(`allow[${i}] (${e.id}) needs an ISO \`added\` date`);
    }
    if (e.expires !== undefined && !(typeof e.expires === 'string' && ISO_DATE.test(e.expires))) {
      throw new Error(`allow[${i}] (${e.id}) has a malformed \`expires\` date`);
    }
    if (e.expires !== undefined && e.expires < today)
      expired.push({ id: e.id, expires: e.expires });
    else active.push(e);
  }
  return { active, expired };
}

/** Stable identity of a finding for base-vs-head comparison: the version is part of it. */
const keyOf = (f) => `${f.ecosystem}|${f.name}|${f.version}|${f.id}`;

/**
 * Apply the policy.
 *
 * @param {{head: ReturnType<typeof parseOsv>, base: ReturnType<typeof parseOsv> | null,
 *   allowlist: ReturnType<typeof loadAllowlist>, today: string, full?: boolean}} input
 */
export function evaluate({ head, base, allowlist, full = false }) {
  const allowed = (f) =>
    allowlist.active.some((e) => e.id === f.id || (f.aliases ?? []).includes(e.id));
  const baseKeys = new Set((base ?? []).map(keyOf));

  const failures = [];
  const suppressed = [];
  const preexisting = [];
  const unknownSeverity = [];

  for (const f of head) {
    if (f.malicious) {
      (allowed(f) ? suppressed : failures).push(f);
      continue;
    }
    if (f.severity === null) {
      unknownSeverity.push(f);
      continue;
    }
    if (f.severity < HIGH_SEVERITY) continue;
    if (allowed(f)) {
      suppressed.push(f);
      continue;
    }
    const isNew = base !== null && !baseKeys.has(keyOf(f));
    if (full || isNew) failures.push(f);
    else preexisting.push(f);
  }
  return { failures, suppressed, preexisting, unknownSeverity, expired: allowlist.expired };
}

/**
 * A human summary for the job log and step summary.
 *
 * @param {ReturnType<typeof evaluate>} r
 * @returns {string}
 */
export function renderReport(r) {
  const line = (f) =>
    `  - ${f.id}${f.malicious ? ' [MALICIOUS]' : ''}  ${f.name}@${f.version} (${f.ecosystem}) in ${f.lockfile}` +
    `${f.severity === null ? '' : `  CVSS ${f.severity}`}`;
  const out = [];
  if (r.failures.length) {
    out.push(`FAIL: ${r.failures.length} finding(s) block this change:`, ...r.failures.map(line));
  }
  if (r.expired.length) {
    out.push(
      `Expired allowlist entries (no longer suppressing): ${r.expired.map((e) => `${e.id} (${e.expires})`).join(', ')}`,
    );
  }
  if (r.suppressed.length) {
    out.push(
      `Suppressed by security/osv-allowlist.json: ${r.suppressed.length}`,
      ...r.suppressed.map(line),
    );
  }
  if (r.preexisting.length) {
    out.push(
      `HIGH/CRITICAL not introduced by this change (pre-existing, or no base to compare), not blocking: ${r.preexisting.length}`,
      ...r.preexisting.map(line),
    );
  }
  if (r.unknownSeverity.length) {
    out.push(`Advisories with no severity score (reported only): ${r.unknownSeverity.length}`);
  }
  if (!out.length) out.push('OSV: no malicious packages and no new HIGH/CRITICAL vulnerabilities.');
  return out.join('\n');
}
