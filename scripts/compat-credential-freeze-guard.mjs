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
 * WHICH PIN STATE. Freeze/unfreeze — "was a credential window ALREADY live
 * before this PR" — is read from the pin as of the PR's BASE commit, not its
 * head/working copy. This is what makes the FIRST PR that ever sets `rcTag`
 * (null -> a real tag) unrestricted at the moment of cutting — its base still
 * reads `rcTag: null` — while every subsequent PR, once the tag is live on
 * `main`, sees frozen=true at its own base.
 *
 * THE MARKER, by contrast, is read from the pin as of the PR's HEAD (review
 * round on #1370: reading it from base is a deadlock — the pin file is
 * itself in the frozen set, so a PR authorized only by a marker it ADDS in
 * the SAME diff could never pass a base-pin check, since base never has the
 * marker the PR is introducing). `pin.rcBumpMarker: { date, expires, reason }`
 * (all YYYY-MM-DD / free text; `date` must not be in the future, and
 * `expires - today` is capped at 14 days — see `markerValidity`) lives in
 * the SAME reviewed-PR pin file ADR-0056 already
 * requires for an rcTag bump — same social-process authorization as the tag
 * itself (a founder pushes the tag, then a REVIEWED PR bumps the file; here,
 * the marker is EVIDENCE that review happened for touching frozen files
 * mid-window, not a cryptographic proof of who approved it — this repo has
 * no mechanism for the latter, and does not pretend to; there is also no
 * CODEOWNERS file in this repo scoping who may review a pin-file change, so
 * "reviewed" today means only "some collaborator with write access approved
 * the PR", the same bar every other reviewed-PR gate here clears). Mechanically
 * this script checks ONLY structural validity and non-expiry; the founder
 * approval itself is enforced by GitHub PR review, same as every other
 * reviewed-PR gate in this repo.
 *
 * PIN-ONLY DIFFS (this PR touches the pin file and NO other frozen file) are
 * evaluated against their own resulting (head) freeze state, not the base
 * one, but only in the direction that closes a window: a pin-only diff that
 * resolves to UNFROZEN (rcTag cleared) is exempt unconditionally — closing a
 * window cannot corrupt bytes already frozen, so there is nothing to
 * authorize. A pin-only diff that resolves to STILL frozen (an unchanged or
 * bumped rcTag) is NOT exempt — it falls through to the same head-marker
 * check as any other frozen-file touch, so a PR cannot silently re-tag or
 * extend a window through the pin file alone without carrying a marker.
 *
 * Usage:
 *   node scripts/compat-credential-freeze-guard.mjs \
 *     --repo-root . \
 *     --base-pin-file base-pin.json \
 *     --head-pin-file head-pin.json \
 *     --changed-files-file changed-files.txt \
 *     [--now 2026-09-24T00:00:00Z]
 */

import { readFileSync } from 'node:fs';
import { CREDENTIAL_CELLS } from './compat-window-audit.mjs';
import { collectHarness } from './compat-window-fingerprint.mjs';

/** The pin file, relative to the repo root — same constant as compat-credential-ref.mjs. */
export const PIN_FILE = '.github/compat-credential-ref.json';

/**
 * The guard's OWN code and workflow (review round on #1370: "the PR can
 * rewrite its own gate" — none of these were in the derived CREDENTIAL_CELLS
 * closure, so a PR could weaken `evaluateFreezeGuard`/`frozenFileSet`/
 * `collectHarness` itself, or delete the workflow's trigger, and the guard
 * would happily run the PR's own weakened copy against itself). Necessarily
 * hardcoded — a guard cannot derive its own protected identity from the
 * harness cells it is not part of — but small and closed, and paired with
 * the workflow running THIS script from a base-commit checkout
 * (`.github/workflows/compat-credential-freeze-guard.yml`'s "base-checkout"
 * step) so a PR editing THIS SCRIPT never gets to execute its own edited
 * copy against itself in the first place; being frozen here is defense in
 * depth on top of that, not the only defense.
 *
 * SCOPE, stated honestly (#1370 review round 2): the base-checkout only
 * protects the .mjs LOGIC. It does nothing for the WORKFLOW YAML itself —
 * GitHub evaluates that from the PR's own ref regardless, so a PR can still
 * replace the job body wholesale (e.g. a single `run: exit 0` step) or drop
 * the base-checkout step entirely, and that edited YAML is what runs on its
 * own PR. See docs/ci/credential-freeze-guard.md's "known limitation"
 * section — closing that needs CODEOWNERS or a pull_request_target
 * redesign, both founder decisions.
 */
export const GUARD_SELF_FILES = Object.freeze([
  'scripts/compat-credential-freeze-guard.mjs',
  'scripts/compat-window-audit.mjs',
  'scripts/compat-window-fingerprint.mjs',
  '.github/workflows/compat-credential-freeze-guard.yml',
]);

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
  // A marker cannot be dated ahead of when it is actually being evaluated
  // (#1370 review round 2): the ORIGINAL 14-day cap was `expires - date`,
  // which a future-dated marker defeats trivially — `{date: 2099-12-20,
  // expires: 2099-12-31}` is an 11-day span, under the cap, but authorizes
  // nothing today and everything the instant the clock reaches 2099. `date`
  // is meant to record when the reviewed PR actually added the marker, so it
  // can never be later than `now`.
  if (date > today) {
    return {
      valid: false,
      reason: `rcBumpMarker.date (${date}) is in the future (today is ${today}) — a marker cannot be dated ahead of when it was added`,
    };
  }
  // Expired check BEFORE the span cap: an expired marker's expires-minus-today
  // is negative, which is not what "exceeds the cap" should ever report.
  if (today > expires) {
    return {
      valid: false,
      reason: `rcBumpMarker expired on ${expires} (today is ${today})`,
    };
  }
  // Cap the window a single marker can authorize, measured from TODAY, not
  // from `date` (#1370 review round 2). NOTE, for honesty: given the two
  // checks directly above (date <= today, today <= expires), this bound is
  // PROVABLY equivalent in outcome to the original `expires - date` cap —
  // algebraically, `expires - today <= expires - date` whenever
  // `today >= date`, so nothing currently reachable can make the two
  // formulas disagree. It is kept measured from `today` anyway because that
  // is the invariant actually meant ("how far does this authorization reach
  // from NOW") and because it stays correct on its own if a future edit ever
  // touches the date<=today check above without touching this line — the
  // `expires - date` form only stayed safe by riding on that other check.
  // 14 days matches ADR-0056's own credential-night cadence unit.
  const MAX_MARKER_SPAN_DAYS = 14;
  const spanFromTodayMs = Date.parse(`${expires}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  const spanFromTodayDays = spanFromTodayMs / (24 * 60 * 60 * 1000);
  if (spanFromTodayDays > MAX_MARKER_SPAN_DAYS) {
    return {
      valid: false,
      reason: `rcBumpMarker.expires (${expires}) is ${spanFromTodayDays} days from today (${today}), which exceeds the ${MAX_MARKER_SPAN_DAYS}-day cap`,
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
 * @param {{ cells?: readonly { lane: string, workflowFile: string | null }[], collectHarnessFn?: (repoRoot: string, lane: string) => { component: string, path: string, line: string }[], guardSelfFiles?: readonly string[] }} [deps]
 *   DI seam for tests — a STRUCTURAL shape (not `typeof CREDENTIAL_CELLS`),
 *   so a test fixture only needs `lane`/`workflowFile`, not every other
 *   CREDENTIAL_CELLS field (`runtime`, `builder`, `wired`, `extraFiles`).
 *   Never used outside tests; production always calls with `deps` omitted.
 * @returns {Set<string>}
 */
export function frozenFileSet(repoRoot, deps = {}) {
  const cells = deps.cells ?? CREDENTIAL_CELLS;
  const collectHarnessFn = deps.collectHarnessFn ?? collectHarness;
  const guardSelfFiles = deps.guardSelfFiles ?? GUARD_SELF_FILES;
  const set = new Set();
  for (const cell of cells) {
    if (!cell.workflowFile) continue;
    for (const entry of collectHarnessFn(repoRoot, cell.lane)) {
      set.add(entry.path);
    }
  }
  // The guard protects its own code/workflow too (#1370 review round) —
  // never derived from a CREDENTIAL_CELLS entry, unioned in directly.
  for (const path of guardSelfFiles) set.add(path);
  return set;
}

/**
 * The whole decision, as a pure function of its inputs — the CLI below is a
 * thin, untested-by-design wrapper around this.
 *
 * `basePin` decides freeze/unfrozen ("was a window already live before this
 * PR") EXCEPT for a pin-only diff resolving to unfrozen, which is read from
 * `headPin` instead (see the file header's "PIN-ONLY DIFFS" section — this is
 * what lets a PR close a live window through the pin file alone, with no
 * marker, since closing cannot corrupt already-frozen bytes). `headPin` is
 * always what `markerValidity` is evaluated against — the marker a PR adds
 * to authorize itself necessarily exists only at head, never at base.
 *
 * @param {{ basePin: unknown, headPin: unknown, touchedFiles: string[], frozenSet: Set<string>, now: Date }} input
 * @returns {{ ok: boolean, reason: string, touchedFrozenFiles: string[] }}
 */
export function evaluateFreezeGuard({ basePin, headPin, touchedFiles, frozenSet, now }) {
  if (!isFrozen(basePin)) {
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

  const pinOnly = touchedFrozenFiles.length === 1 && touchedFrozenFiles[0] === PIN_FILE;
  if (pinOnly && !isFrozen(headPin)) {
    return {
      ok: true,
      reason: `pin-only diff that closes the credential window — ${PIN_FILE}'s rcTag is null at this PR's head, so nothing frozen is at risk`,
      touchedFrozenFiles: [],
    };
  }

  const marker = markerValidity(headPin, now);
  if (marker.valid) {
    return {
      ok: true,
      reason: `frozen and touches [${touchedFrozenFiles.join(', ')}], but a valid rcBumpMarker exempts it (${marker.reason})`,
      touchedFrozenFiles,
    };
  }
  const rcTag =
    basePin && typeof basePin === 'object' ? /** @type {any} */ (basePin).rcTag : undefined;
  return {
    ok: false,
    reason:
      `a credential window is live (rcTag=${JSON.stringify(rcTag)}) and this PR touches frozen ` +
      `credential file(s) with no valid rcBumpMarker (${marker.reason}): ${touchedFrozenFiles.join(', ')}. ` +
      `Add a dated, reviewed rcBumpMarker to ${PIN_FILE} (read from this PR's HEAD) to proceed, or drop the change from this PR.`,
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
  const headPinFile = arg('head-pin-file', null);
  const changedFilesFile = arg('changed-files-file', null);
  const nowArg = arg('now', null);

  if (!basePinFile || !headPinFile || !changedFilesFile) {
    console.error(
      'compat-credential-freeze-guard: --base-pin-file, --head-pin-file and --changed-files-file are all required',
    );
    process.exit(2);
  }

  const readPin = (file) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`compat-credential-freeze-guard: could not read/parse ${file}: ${err.message}`);
      process.exit(2);
    }
  };
  const basePin = readPin(basePinFile);
  const headPin = readPin(headPinFile);

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
  const result = evaluateFreezeGuard({ basePin, headPin, touchedFiles, frozenSet, now });

  console.log(result.ok ? '✅' : '❌', result.reason);
  process.exit(result.ok ? 0 : 1);
}
/* c8 ignore stop */
