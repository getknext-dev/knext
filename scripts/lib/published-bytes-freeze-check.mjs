/**
 * Pure decision logic for the published-bytes freeze check (#1663).
 *
 * WHY. `scripts/ga-tarball-diff.mjs` proves, AT RELEASE TIME, that a GA cut
 * differs from its credentialed rc tag only in version fields. That proves
 * nothing about the 14 nights IN BETWEEN: a PR merged to `main` while a
 * credential window is open (`.github/compat-credential-ref.json`'s `rcTag`
 * set) can freely change package source, templates, or a package README, and
 * every one of those changes is exactly what would make the EVENTUAL GA-vs-rc
 * diff fail its own gate — forcing an unplanned rc.N+1 and 14 more nights.
 * This module is the PR-TIME half: while a window is open, keep the
 * publishable group's packed bytes identical to what the credentialed rc tag
 * already packed.
 *
 * SCOPE, stated precisely: this module only decides WHETHER to pack-and-diff,
 * never HOW to pack or compare bytes — that machinery already exists
 * (`scripts/ga-tarball-diff.mjs` + `scripts/lib/ga-tarball-diff.mjs`) and is
 * reused as-is by `scripts/published-bytes-freeze-check.mjs` (the CLI
 * wrapper), the same way `scripts/ga-tarball-diff-gate.mjs` reuses it for the
 * release-time question. Nothing here re-implements tar reading or the
 * version/package.json diff rules.
 *
 * WHY A SEPARATE, DUPLICATED MARKER-VALIDITY FUNCTION rather than importing
 * `markerValidity` from `scripts/compat-credential-freeze-guard.mjs`: that
 * module statically imports `CREDENTIAL_CELLS`/`collectHarness`
 * (`scripts/compat-window-audit.mjs` -> `scripts/compat-window-fingerprint.mjs`),
 * which itself statically imports the `typescript` package. Pulling that whole
 * chain into a SKIP decision (the common case — most PRs touch no publishable
 * package) would repeat exactly the mistake `ga-tarball-diff-gate.mjs`'s own
 * header documents fixing for `tar`: a decision that need not touch a heavy
 * dependency should not import it at module scope. The validity RULES are
 * intentionally the same shape (dated `date`/`expires`/`reason`, capped span,
 * no future-dated marker) as `rcBumpMarker` for social-process consistency —
 * this is a second reviewed-PR escalation marker, not a new authorization
 * model — but the code is independent so failure or edits to one guard's
 * heavy import chain can never break the other's cheap path.
 *
 * WHY THE PACKAGE SCOPE IS DERIVED, NEVER HAND-LISTED: `publishScopeDirs`
 * calls the SAME `readWorkspaceManifests`/`publishablePackages` helpers
 * `scripts/ga-tarball-diff.mjs` and `scripts/audit-published.mjs` already use
 * to compute the published set (`@getknext/core`, `@getknext/lib`,
 * `@getknext/db`, and the unscoped `kn-next` npx alias today) — a package
 * added to or removed from that set moves this check's scope with no edit
 * here.
 *
 * THE SMALL ROOT FILE LIST (`ROOT_BUILD_INPUT_FILES`) IS THE ONE PIECE THAT
 * CANNOT BE DERIVED, mirroring the precedent already accepted in this exact
 * codebase (`compat-credential-freeze-guard.mjs`'s `GUARD_SELF_FILES`, unioned
 * in for the same "small, necessarily hardcoded, documented" reason): the
 * root `package.json` and `bun.lock` pin the devDependency versions
 * (`typescript`, `tsup`) every publishable package's build actually runs
 * with — each package's own `tsup.config.ts` EXTERNALIZES its runtime/
 * workspace dependencies (they resolve from the published package's own
 * `dependencies` at install time, never inlined), so a root dependency bump
 * cannot change PUBLISHED bytes through that path, but a devDependency bump
 * CAN change what the build tool itself emits. `.changeset/config.json`'s
 * `ignore` list decides which packages this check even considers publishable.
 * `scripts/rewrite-workspace-ranges.mjs` rewrites `workspace:` sibling ranges
 * to concrete versions immediately before packing — editing it can change the
 * exact bytes `ga-tarball-diff.mjs` packs today, before this check even runs
 * its comparison.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishablePackages, readWorkspaceManifests } from '../publish-preflight.mjs';

/**
 * Root-level files that can change what a publishable package's build emits,
 * without themselves living inside any publishable package's directory. See
 * the file header for why each entry is here and why the list cannot be
 * derived the way the per-package directories are.
 */
export const ROOT_BUILD_INPUT_FILES = Object.freeze([
  'package.json',
  'bun.lock',
  '.changeset/config.json',
  'scripts/rewrite-workspace-ranges.mjs',
]);

/** The pin file this check (and its sibling credential-freeze guard) reads. */
export const PIN_FILE = '.github/compat-credential-ref.json';

/** The reviewed-PR override marker this check honours (see the file header). */
export const OVERRIDE_MARKER_FIELD = 'publishedBytesBumpMarker';

const MAX_OVERRIDE_MARKER_SPAN_DAYS = 14;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is `s` (already matching `DATE_RE`'s digit shape) a REAL calendar date?
 * `Date.parse` alone accepts `2026-02-30` by silently rolling it forward —
 * round-tripping through `toISOString` and requiring the exact string back
 * catches that along with a plainly out-of-range month/day.
 *
 * @param {string} s
 * @returns {boolean}
 */
function isValidCalendarDate(s) {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

/**
 * The repo-relative directories of every publishable package (workspace
 * manifests, minus `private`/changeset-`ignore`d/unversioned ones) — the
 * SAME set `scripts/ga-tarball-diff.mjs` diffs at release time.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function publishScopeDirs(repoRoot) {
  const manifests = readWorkspaceManifests(repoRoot);
  const changesetConfig = JSON.parse(
    readFileSync(join(repoRoot, '.changeset', 'config.json'), 'utf8'),
  );
  const ignore = Array.isArray(changesetConfig.ignore) ? changesetConfig.ignore : [];
  return publishablePackages(manifests, ignore).map((p) => p.dir);
}

/**
 * Does any changed file fall under a publishable package's directory, or
 * match one of the small root build-input files? Returns the MATCHED paths
 * (not just a boolean) so the CLI wrapper can name them in its announcement.
 *
 * @param {{ changedFiles: string[], packageDirs: string[], rootInputFiles?: readonly string[] }} input
 * @returns {{ touches: boolean, matched: string[] }}
 */
export function touchesPublishableScope({
  changedFiles,
  packageDirs,
  rootInputFiles = ROOT_BUILD_INPUT_FILES,
}) {
  const rootSet = new Set(rootInputFiles);
  const matched = changedFiles.filter(
    (f) => rootSet.has(f) || packageDirs.some((dir) => f === dir || f.startsWith(`${dir}/`)),
  );
  return { touches: matched.length > 0, matched };
}

/**
 * Structural validity + non-expiry of `pin[OVERRIDE_MARKER_FIELD]`, evaluated
 * against `now`. Deliberately the same rules as `compat-credential-freeze-
 * guard.mjs`'s `markerValidity` (see the file header for why this is a
 * parallel implementation, not a shared import): a dated, reviewed,
 * <=14-day-from-now escalation for an INTENTIONAL rc.N+1 whose content is
 * expected to differ from the currently-pinned rc. Never checks WHO approved
 * it — that is GitHub PR review, the same bar every other reviewed-PR gate in
 * this repo clears.
 *
 * @param {unknown} pin
 * @param {Date} now
 * @returns {{ valid: boolean, reason: string }}
 */
export function overrideMarkerValidity(pin, now) {
  const marker =
    pin && typeof pin === 'object' ? /** @type {any} */ (pin)[OVERRIDE_MARKER_FIELD] : undefined;
  if (marker === null || marker === undefined) {
    return { valid: false, reason: `no ${OVERRIDE_MARKER_FIELD} present in the pin file` };
  }
  if (typeof marker !== 'object' || Array.isArray(marker)) {
    return { valid: false, reason: `${OVERRIDE_MARKER_FIELD} is not an object` };
  }
  const { date, expires, reason } = marker;
  if (typeof date !== 'string' || !DATE_RE.test(date) || !isValidCalendarDate(date)) {
    return {
      valid: false,
      reason: `${OVERRIDE_MARKER_FIELD}.date is missing, not YYYY-MM-DD, or not a real calendar date`,
    };
  }
  if (typeof expires !== 'string' || !DATE_RE.test(expires) || !isValidCalendarDate(expires)) {
    return {
      valid: false,
      reason: `${OVERRIDE_MARKER_FIELD}.expires is missing, not YYYY-MM-DD, or not a real calendar date`,
    };
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    return { valid: false, reason: `${OVERRIDE_MARKER_FIELD}.reason is missing or empty` };
  }
  if (expires <= date) {
    return {
      valid: false,
      reason: `${OVERRIDE_MARKER_FIELD}.expires must be strictly after ${OVERRIDE_MARKER_FIELD}.date`,
    };
  }
  const today = now.toISOString().slice(0, 10);
  if (date > today) {
    return {
      valid: false,
      reason: `${OVERRIDE_MARKER_FIELD}.date (${date}) is in the future (today is ${today})`,
    };
  }
  if (today > expires) {
    return {
      valid: false,
      reason: `${OVERRIDE_MARKER_FIELD} expired on ${expires} (today is ${today})`,
    };
  }
  const spanFromTodayMs = Date.parse(`${expires}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  const spanFromTodayDays = spanFromTodayMs / (24 * 60 * 60 * 1000);
  if (!(spanFromTodayDays <= MAX_OVERRIDE_MARKER_SPAN_DAYS)) {
    return {
      valid: false,
      reason: `${OVERRIDE_MARKER_FIELD}.expires (${expires}) is ${spanFromTodayDays} days from today, which exceeds the ${MAX_OVERRIDE_MARKER_SPAN_DAYS}-day cap`,
    };
  }
  return { valid: true, reason: `valid through ${expires}` };
}

/**
 * The whole SCOPE decision — everything answerable without shelling to `git`
 * for a tag or spawning the pack-and-diff — as a pure function of its inputs.
 *
 * Three outcomes:
 *   - `skip`: no window open, a valid override marker, or this PR touches no
 *     publishable-package path. Never packs anything — this is what keeps the
 *     check cheap on every PR.
 *   - `proceed`: a window is open, no valid override, and the PR touches
 *     publishable scope. The CLI wrapper must still resolve `rcTag` as a real
 *     git tag before running the pack-and-diff — THAT half fails closed in the
 *     wrapper, not here, because resolving a tag needs `git`, which this pure
 *     function deliberately never shells to.
 *
 * @param {{ pin: unknown, changedFiles: string[], packageDirs: string[], rootInputFiles?: readonly string[], now: Date }} input
 * @returns {{ action: 'skip', reason: string } | { action: 'proceed', rcTag: string, reason: string, matchedFiles: string[] }}
 */
export function decidePublishedBytesScope({
  pin,
  changedFiles,
  packageDirs,
  rootInputFiles = ROOT_BUILD_INPUT_FILES,
  now,
}) {
  const rcTag = pin && typeof pin === 'object' ? /** @type {any} */ (pin).rcTag : undefined;
  if (rcTag === null || rcTag === undefined) {
    return { action: 'skip', reason: `${PIN_FILE}'s rcTag is null — no credential window is open` };
  }
  if (typeof rcTag !== 'string' || rcTag.length === 0) {
    return {
      action: 'skip',
      reason: `${PIN_FILE}'s rcTag is not a non-empty string (${JSON.stringify(rcTag)}) — nothing to diff against`,
    };
  }

  const marker = overrideMarkerValidity(pin, now);
  if (marker.valid) {
    return {
      action: 'skip',
      reason: `a credential window is open (rcTag=${JSON.stringify(rcTag)}), but a valid ${OVERRIDE_MARKER_FIELD} exempts this PR as an intentional rc bump (${marker.reason})`,
    };
  }

  const scope = touchesPublishableScope({ changedFiles, packageDirs, rootInputFiles });
  if (!scope.touches) {
    return {
      action: 'skip',
      reason: `a credential window is open (rcTag=${JSON.stringify(rcTag)}), but this PR touches no path that can reach a published package`,
    };
  }

  return {
    action: 'proceed',
    rcTag,
    reason:
      `a credential window is open (rcTag=${JSON.stringify(rcTag)}) and this PR touches ` +
      `[${scope.matched.join(', ')}] — packing and diffing against the pinned rc tag`,
    matchedFiles: scope.matched,
  };
}
