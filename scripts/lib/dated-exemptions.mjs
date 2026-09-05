/**
 * The ONE dated-exemption reader (#927).
 *
 * WHY IT IS SHARED. Three places in this repo now say "this is excused, with a
 * justification and a clock": the npm/Trivy allowlist
 * (`precompile-closure.mjs:206-248`), the coverage metric exceptions, and the
 * prover-lane exemptions added for #927. Written three times they would drift
 * three ways, and the failure mode is silent in every direction — an exemption
 * reader that is a little bit wrong excuses a little bit more than anyone
 * intended, and nothing observes it.
 *
 * THE TWO PROPERTIES THAT MAKE IT WORTH HAVING, both learned the hard way:
 *
 *   - AN UNKNOWN KEY THROWS. A typo'd `expiress` otherwise parses as an entry
 *     with no expiry — an exemption that never lapses, wearing the appearance of
 *     one that does. This is the quietest possible way to neuter a clock.
 *   - `expires` IS REQUIRED. The security allowlist makes it optional because a
 *     vulnerability finding can be permanently accepted after triage. Nothing
 *     here can be: a metric leaving the coverage gate, or a guard shipping with
 *     no prover, is a debt, and a debt with no date is a decision nobody ever
 *     makes again.
 *
 * EXPIRY FAILS CLOSED at every call site — a lapsed entry simply stops appearing
 * in the returned set, and it is the CALLER's job to have no fallback that reads
 * "not excused" as "fine". Each caller asserts that separately, because a shared
 * helper cannot enforce what its callers do with a smaller set.
 */

const ALLOWED_KEYS = new Set(['justification', 'added', 'expires', 'note']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The subjects excused RIGHT NOW. Throws on any malformed entry.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} entries
 * @param {object} opts
 * @param {string} opts.field the key naming the exemption's subject, e.g. `metric`
 * @param {Date} [opts.now]
 * @param {number} [opts.minJustification] characters; defaults to 40
 * @returns {Set<string>}
 */
export function activeExemptions(entries, { field, now = new Date(), minJustification = 40 }) {
  if (!Array.isArray(entries)) throw new TypeError('exemptions must be an array');
  const active = new Set();
  const seen = new Set();
  for (const entry of entries) {
    const subject = entry?.[field];
    if (typeof subject !== 'string' || subject === '') {
      throw new Error(`exemption: an entry has no \`${field}\`: ${JSON.stringify(entry)}`);
    }
    // A duplicate is not harmless: two entries for one subject means one of them
    // is dead text, and the live one is whichever this loop happens to reach —
    // which is how an expiry gets silently extended by adding a second row.
    if (seen.has(subject)) throw new Error(`exemption: duplicate entry for ${field} ${subject}`);
    seen.add(subject);

    const unknown = Object.keys(entry).filter((k) => k !== field && !ALLOWED_KEYS.has(k));
    if (unknown.length > 0) {
      throw new Error(
        `exemption: ${subject} has unknown key(s) [${unknown.join(', ')}] — allowed keys are ` +
          `[${field}, ${[...ALLOWED_KEYS].join(', ')}]. A misspelled \`expires\` never expires.`,
      );
    }
    if (typeof entry.justification !== 'string' || entry.justification.length < minJustification) {
      throw new Error(
        `exemption: ${subject} has no substantive \`justification\` — restating what is excused ` +
          'is not a reason for excusing it',
      );
    }
    if (!DATE_RE.test(String(entry.added ?? ''))) {
      throw new Error(`exemption: ${subject} has no valid \`added\` date (YYYY-MM-DD)`);
    }
    if (!DATE_RE.test(String(entry.expires ?? ''))) {
      throw new Error(
        `exemption: ${subject} has no valid \`expires\` date — an exemption with no clock is not ` +
          'an exemption, it is a silent removal',
      );
    }
    if (new Date(`${entry.expires}T00:00:00Z`) <= new Date(`${entry.added}T00:00:00Z`)) {
      throw new Error(`exemption: ${subject} expires on or before it was added`);
    }
    if (new Date(`${entry.expires}T00:00:00Z`) <= now) continue; // lapsed
    active.add(subject);
  }
  return active;
}
