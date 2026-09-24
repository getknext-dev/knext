#!/usr/bin/env node
/**
 * compat-credential-freeze-guard — #1302.
 *
 * WHY. ADR-0056 freezes the harness + packed adapter for the LIFE of a
 * release-candidate window (`.github/compat-credential-ref.json`'s `rcTag`):
 * a credential night hashes that frozen set and a mismatch restarts the
 * 14-night streak. Nothing before this PREVENTED a PR from moving the bytes
 * inside that window in the first place — it only detected the restart
 * AFTER the fact, on the next scheduled night. This is the PR-time half:
 * while a window is live, a PR touching a file the credential harness
 * actually executes is refused, unless it carries an explicit, dated,
 * founder-approved `rcBumpMarker` in the SAME pin file.
 *
 * THE FROZEN FILE SET IS DERIVED, NEVER HARDCODED. `frozenFileSet()` calls
 * `collectHarness()` (`scripts/compat-window-fingerprint.mjs`, exported for
 * this reuse) once per `CREDENTIAL_CELLS` entry that has a `workflowFile` —
 * the SAME function a real credential night's fingerprint step calls — and
 * unions the resulting paths. A cell added to `CREDENTIAL_CELLS`, a script
 * newly reached by the import/source closure, or a workflow file renamed all
 * move this guard's protected set with NO edit here, by construction: this
 * is the whole point of reusing `collectHarness` instead of re-declaring a
 * second, driftable file list (#1301 review's exact complaint about a
 * different guard, generalised).
 *
 * WHICH PIN STATE. The guard reads the pin as of the PR's BASE commit, not
 * its head/working copy: "was a credential window ALREADY live before this
 * PR" is the property being protected. This is what makes the FIRST PR that
 * ever sets `rcTag` (null -> a real tag) unrestricted at the moment of
 * cutting — its base still reads `rcTag: null` — while every subsequent PR,
 * once the tag is live on `main`, sees frozen=true at its own base.
 *
 * THE MARKER is `pin.rcBumpMarker: { date, expires, reason }` (all
 * YYYY-MM-DD / free text) in the SAME reviewed-PR pin file ADR-0056 already
 * requires for an rcTag bump — same social-process authorization as the tag
 * itself (a founder pushes the tag, then a REVIEWED PR bumps the file; here,
 * the marker is EVIDENCE that review happened for touching frozen files
 * mid-window, not a cryptographic proof of who approved it — this repo has
 * no mechanism for the latter, and does not pretend to). Mechanically this
 * script checks ONLY structural validity and non-expiry; the founder
 * approval itself is enforced by GitHub PR review, same as every other
 * reviewed-PR gate in this repo.
 *
 * Usage:
 *   node scripts/compat-credential-freeze-guard.mjs \
 *     --repo-root . \
 *     --base-pin-file base-pin.json \
 *     --changed-files-file changed-files.txt \
 *     [--now 2026-09-24T00:00:00Z]
 */

import { readFileSync } from 'node:fs';
import { CREDENTIAL_CELLS } from './compat-window-audit.mjs';
import { collectHarness } from './compat-window-fingerprint.mjs';

/** The pin file, relative to the repo root — same constant as compat-credential-ref.mjs. */
export const PIN_FILE = '.github/compat-credential-ref.json';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is a credential window currently live? Mirrors ADR-0056's own language
 * ("null = no RC cut yet"): ANY non-null `rcTag` counts, even a malformed
 * one — a malformed-but-truthy tag is still a state someone is actively
 * trying to cut, and treating it as "not frozen" would be the unsafe
 * direction. Format validation is `compat-credential-ref.mjs`'s job, not
 * this guard's.
 *
 * @param {unknown} pin
 * @returns {boolean}
 */
export function isFrozen(pin) {
  return (
    !!pin &&
    typeof pin === 'object' &&
    'rcTag' in /** @type {object} */ (pin) &&
    /** @type {{rcTag: unknown}} */ (pin).rcTag !== null &&
    /** @type {{rcTag: unknown}} */ (pin).rcTag !== undefined
  );
}

/**
 * Structural validity + non-expiry of `pin.rcBumpMarker`, evaluated against
 * `now`. Never checks WHO approved it — see the file header.
 *
 * @param {unknown} pin
 * @param {Date} now
 * @returns {{ valid: boolean, reason: string }}
 */
export function markerValidity(pin, now) {
  const marker = pin && typeof pin === 'object' ? /** @type {any} */ (pin).rcBumpMarker : undefined;
  if (marker === null || marker === undefined) {
    return { valid: false, reason: 'no rcBumpMarker present in the pin file' };
  }
  if (typeof marker !== 'object' || Array.isArray(marker)) {
    return { valid: false, reason: 'rcBumpMarker is not an object' };
  }
  const { date, expires, reason } = marker;
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    return { valid: false, reason: 'rcBumpMarker.date is missing or not YYYY-MM-DD' };
  }
  if (typeof expires !== 'string' || !DATE_RE.test(expires)) {
    return { valid: false, reason: 'rcBumpMarker.expires is missing or not YYYY-MM-DD' };
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    return { valid: false, reason: 'rcBumpMarker.reason is missing or empty' };
  }
  // Lexicographic comparison is correct for YYYY-MM-DD strings.
  if (expires <= date) {
    return {
      valid: false,
      reason: 'rcBumpMarker.expires must be strictly after rcBumpMarker.date',
    };
  }
  const today = now.toISOString().slice(0, 10);
  if (today > expires) {
    return {
      valid: false,
      reason: `rcBumpMarker expired on ${expires} (today is ${today})`,
    };
  }
  return { valid: true, reason: `valid through ${expires}` };
}

/**
 * The union of every workflow-file-bearing CREDENTIAL_CELLS entry's
 * `collectHarness()` paths — the derived, never-hardcoded frozen file set
 * (#1302). Cells with `workflowFile: null` (node-vinext today) are skipped:
 * `collectHarness`/`workflowRootForLane` hard-errors on them by design (no
 * workflow to fingerprint yet), and a cell with nothing wired executes no
 * credential bytes to protect.
 *
 * Deliberately NOT filtered by `cell.wired` — that field tracks 14-night
 * AUDIT/tracker participation (`compat-matrix-tracker.mjs`), a different
 * axis: `bun-vinext` is `wired: false` (not yet counted toward a credential
 * streak) but DOES have a real `workflowFile` and IS fingerprinted by a real
 * `compat-window-fingerprint.mjs --lane bun-vinext` call today. "Which files
 * does a credential-adjacent workflow execute" is the question this guard
 * answers, not "which cells currently bank a streak".
 *
 * @param {string} repoRoot
 * @param {{ cells?: typeof CREDENTIAL_CELLS, collectHarnessFn?: typeof collectHarness }} [deps]
 *   DI seam for tests — never used outside them.
 * @returns {Set<string>}
 */
export function frozenFileSet(repoRoot, deps = {}) {
  const cells = deps.cells ?? CREDENTIAL_CELLS;
  const collectHarnessFn = deps.collectHarnessFn ?? collectHarness;
  const set = new Set();
  for (const cell of cells) {
    if (!cell.workflowFile) continue;
    for (const entry of collectHarnessFn(repoRoot, cell.lane)) {
      set.add(entry.path);
    }
  }
  return set;
}

/**
 * The whole decision, as a pure function of its inputs — the CLI below is a
 * thin, untested-by-design wrapper around this.
 *
 * @param {{ pin: unknown, touchedFiles: string[], frozenSet: Set<string>, now: Date }} input
 * @returns {{ ok: boolean, reason: string, touchedFrozenFiles: string[] }}
 */
export function evaluateFreezeGuard({ pin, touchedFiles, frozenSet, now }) {
  if (!isFrozen(pin)) {
    return {
      ok: true,
      reason: `not frozen — ${PIN_FILE}'s rcTag is null at this PR's base (no active credential window)`,
      touchedFrozenFiles: [],
    };
  }
  const touchedFrozenFiles = touchedFiles.filter((f) => frozenSet.has(f));
  if (touchedFrozenFiles.length === 0) {
    return {
      ok: true,
      reason: 'frozen, but this PR touches none of the frozen credential files',
      touchedFrozenFiles: [],
    };
  }
  const marker = markerValidity(pin, now);
  if (marker.valid) {
    return {
      ok: true,
      reason: `frozen and touches [${touchedFrozenFiles.join(', ')}], but a valid rcBumpMarker exempts it (${marker.reason})`,
      touchedFrozenFiles,
    };
  }
  const rcTag = pin && typeof pin === 'object' ? /** @type {any} */ (pin).rcTag : undefined;
  return {
    ok: false,
    reason:
      `a credential window is live (rcTag=${JSON.stringify(rcTag)}) and this PR touches frozen ` +
      `credential file(s) with no valid rcBumpMarker (${marker.reason}): ${touchedFrozenFiles.join(', ')}. ` +
      `Add a dated, reviewed rcBumpMarker to ${PIN_FILE} to proceed, or drop the change from this PR.`,
    touchedFrozenFiles,
  };
}

/* c8 ignore start — CLI wrapper */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };

  const repoRoot = arg('repo-root', process.cwd());
  const basePinFile = arg('base-pin-file', null);
  const changedFilesFile = arg('changed-files-file', null);
  const nowArg = arg('now', null);

  if (!basePinFile || !changedFilesFile) {
    console.error(
      'compat-credential-freeze-guard: --base-pin-file and --changed-files-file are both required',
    );
    process.exit(2);
  }

  let pin;
  try {
    const pinText = readFileSync(basePinFile, 'utf8');
    pin = JSON.parse(pinText);
  } catch (err) {
    console.error(
      `compat-credential-freeze-guard: could not read/parse ${basePinFile}: ${err.message}`,
    );
    process.exit(2);
  }

  const touchedFiles = readFileSync(changedFilesFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const now = nowArg ? new Date(nowArg) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error(`compat-credential-freeze-guard: --now "${nowArg}" is not a valid date`);
    process.exit(2);
  }

  const frozenSet = frozenFileSet(repoRoot);
  const result = evaluateFreezeGuard({ pin, touchedFiles, frozenSet, now });

  console.log(result.ok ? '✅' : '❌', result.reason);
  process.exit(result.ok ? 0 : 1);
}
/* c8 ignore stop */
