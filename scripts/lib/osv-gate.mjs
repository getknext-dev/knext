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
export const LOCKFILE_NAMES = ['bun.lock', 'Cargo.lock', 'go.mod', 'package-lock.json'];

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
const ALLOW_KEYS = new Set([
  'id',
  'package',
  'version',
  'lockfile',
  'justification',
  'added',
  'expires',
]);
/** The longest an accepted risk may be suppressed without being re-justified. */
export const MAX_ALLOW_DAYS = 180;
const DAY_MS = 86_400_000;

/**
 * Validate the allowlist document and drop the entries that have expired.
 * Throws on a malformed one: a half-read allowlist must not silently suppress.
 *
 * An entry is SCOPED: it suppresses one advisory on one package at one version in
 * one lockfile, never an advisory id everywhere. `expires` is required and at most
 * 180 days after `added`, so no exception is permanent. Unknown keys are rejected so
 * a typo cannot silently widen or drop a scope, and wildcards or ranges are refused
 * in `package`, `version` and `lockfile`.
 *
 * @param {unknown} doc
 * @param {string} today ISO date
 * @returns {{active: Array<{id: string, package: string, version: string, lockfile: string,
 *   justification: string, added: string, expires: string}>,
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
    const at = `allow[${i}] (${e.id})`;
    for (const key of Object.keys(e)) {
      if (!ALLOW_KEYS.has(key)) throw new Error(`${at} has an unknown key \`${key}\``);
    }
    if (typeof e.package !== 'string' || !e.package || /[*?\s]/.test(e.package)) {
      throw new Error(`${at} needs an exact \`package\` name (no wildcards)`);
    }
    if (typeof e.version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(e.version)) {
      throw new Error(`${at} needs an exact \`version\` (no ranges or wildcards)`);
    }
    if (typeof e.lockfile !== 'string' || !e.lockfile || /[*?\s]/.test(e.lockfile)) {
      throw new Error(`${at} needs an exact repo-relative \`lockfile\` path (no globs)`);
    }
    if (typeof e.justification !== 'string' || e.justification.trim().length < 20) {
      throw new Error(`${at} needs a real \`justification\` (>= 20 chars)`);
    }
    if (typeof e.added !== 'string' || !ISO_DATE.test(e.added)) {
      throw new Error(`${at} needs an ISO \`added\` date`);
    }
    if (typeof e.expires !== 'string' || !ISO_DATE.test(e.expires)) {
      throw new Error(`${at} needs an ISO \`expires\` date (it is required)`);
    }
    const span = (Date.parse(e.expires) - Date.parse(e.added)) / DAY_MS;
    if (!(span > 0)) throw new Error(`${at} \`expires\` must be after \`added\``);
    if (span > MAX_ALLOW_DAYS) {
      throw new Error(`${at} \`expires\` is more than ${MAX_ALLOW_DAYS} days after \`added\``);
    }
    if (e.expires < today) expired.push({ id: e.id, expires: e.expires });
    else active.push(e);
  }
  return { active, expired };
}

/**
 * Stable identity of a finding for base-vs-head comparison. The LOCKFILE is part of
 * it: a HIGH package that already sat in a fixture or an example at the merge base
 * is not "pre-existing" when a change moves it into the root lockfile. The version
 * is part of it too, so a bump to another still-vulnerable version is new.
 */
const keyOf = (f) => `${f.lockfile}|${f.ecosystem}|${f.name}|${f.version}|${f.id}`;

/**
 * Apply the policy.
 *
 * @param {{head: ReturnType<typeof parseOsv>, base: ReturnType<typeof parseOsv> | null,
 *   allowlist: ReturnType<typeof loadAllowlist>, today: string, full?: boolean}} input
 */
export function evaluate({ head, base, allowlist, full = false }) {
  // Scoped: the advisory id (or an alias) AND the exact package, version and lockfile.
  const allowed = (f) =>
    allowlist.active.some(
      (e) =>
        (e.id === f.id || (f.aliases ?? []).includes(e.id)) &&
        e.package === f.name &&
        e.version === f.version &&
        e.lockfile === f.lockfile,
    );
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
    // An unscored finding cannot be shown to be below HIGH, so a NEW one is treated
    // like a new HIGH. A pre-existing one (or any, with no base to compare) is only
    // reported, otherwise the ~22 standing GO-/GHSA- advisories without a score would
    // block every unrelated change.
    if (f.severity !== null && f.severity < HIGH_SEVERITY) continue;
    if (allowed(f)) {
      suppressed.push(f);
      continue;
    }
    const isNew = base !== null && !baseKeys.has(keyOf(f));
    if (f.severity === null) {
      if (full || isNew) failures.push(f);
      else unknownSeverity.push(f);
      continue;
    }
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
    out.push(
      `Advisories with no severity score, not introduced by this change (reported only): ${r.unknownSeverity.length}`,
    );
  }
  if (!out.length) out.push('OSV: no malicious packages and no new HIGH/CRITICAL vulnerabilities.');
  return out.join('\n');
}

/** Refs tried, in order, when a change has no usable base commit. */
export const FALLBACK_BASES = ['origin/integration/v2', 'origin/main'];

/**
 * The commit to compare against. A pull request supplies its base. A `workflow_dispatch`
 * or a first push to a new branch supplies nothing (or the all-zero "before"), and
 * "no base" must not mean "no HIGH can block": fall back to the release line, then to
 * main, skipping the branch being built (comparing a branch with itself finds nothing).
 *
 * @param {{supplied?: string, resolves: (ref: string) => boolean, currentRef: string}} input
 * @returns {string | null} null when nothing resolves, and the caller must fail closed
 */
export function pickBase({ supplied, resolves, currentRef }) {
  if (supplied && !/^0+$/.test(supplied) && resolves(supplied)) return supplied;
  for (const ref of FALLBACK_BASES) {
    if (ref === `origin/${currentRef}`) continue;
    if (resolves(ref)) return ref;
  }
  return null;
}
