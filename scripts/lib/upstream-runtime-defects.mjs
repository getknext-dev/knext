/**
 * The upstream-runtime-defect ledger (ADR-0007 amendment 2026-11-05).
 *
 * WHAT IT IS
 *   A file that fails on exactly ONE cell (one runtime x one builder) because of a defect in a
 *   runtime knext does not own, where the defect has a named upstream issue and an upstream fix
 *   that is not yet released, and where knext refuses the affected user configuration at build
 *   time. It is a SEPARATE category: it is not a section (h) quarantine (`$knextQuarantines`), not a
 *   global exclusion (`$knextExclusions`), and not a ref-pinned per-case entry
 *   (`$knextRefPinnedCases`), and it never counts toward any of their caps.
 *
 * WHAT THE HARNESS DOES WITH IT
 *   Nothing in the committed manifest deselects these cases: the entry is a record. At RUN time
 *   `scripts/compat-manifest-for-ref.mjs` applies the entry to the scoped copy ONLY when all three
 *   hold:
 *     - the lane under test is the entry's lane (`KNEXT_RUNTIME/KNEXT_BUILDER`),
 *     - `NEXTJS_REF` equals the entry's `nextjsRef`,
 *     - on a Bun lane, the Bun under test (`bun --version`) equals the entry's `bunVersion`.
 *   On every other cell, ref or Bun the cases RUN. So a `bun-version=canary` dispatch, or a lane
 *   pin bump to the Bun release that carries the fix, runs them again.
 *
 *   HOW it is applied depends on `wholeFile`, which the validator checks against the upstream
 *   snapshot. An entry that covers EVERY case in its file puts the file in the copy's
 *   `rules.exclude`, so it is never selected. It must not become a `failed` list: next's runner turns
 *   that into a jest `--testNamePattern` that filters out every test, jest exits 0, run-tests prints
 *   `<file> finished on retry 0/N`, and scripts/e2e-summary.mjs counts that as a PASSED file that ran
 *   no case. A partial-file entry (`wholeFile: false`) adds its names to `suites[file].failed`.
 *
 * WHY IT CANNOT OUTLIVE THE BUG
 *   The upstream fix is unreleased, so the Bun version that will contain it is unknown in advance.
 *   The mechanical equivalent is the same as bar 1 of the ref-pinned ledger: the entry is pinned to
 *   the Bun the lane runs today, and a PR that moves the lane's Bun pin is red until every entry is
 *   re-measured at the new Bun or removed. "Re-measured" is checked, not trusted: every Bun-cell run
 *   records the Bun it ran on, and the entry needs a run on its own cell at its `bunVersion`, so
 *   moving the pin and `bunVersion` together without a new run is still red. A re-measure runs the
 *   case (the run-time scope drops the deselection at any other Bun), so a Bun that carries the fix
 *   shows the case passing.
 *
 * Every rule below is a guard held by tests/compat-upstream-runtime-defects.test.ts and has a
 * mutation proof in scripts/mutation-prove-upstream-runtime-defects.mjs.
 */

import {
  CELLS,
  caseName,
  literalProduces,
  REF_SHAPE,
  refPinAdmissible,
} from './ref-pinned-cases.mjs';

/** The manifest key holding the ledger (copied verbatim into the smoke manifest). */
export const UPSTREAM_RUNTIME_DEFECT_KEY = '$knextUpstreamRuntimeDefects';

/** The key the run-time scope writes into the scoped copy, recording what it applied. */
export const UPSTREAM_RUNTIME_DEFECT_SCOPE_KEY = '$knextUpstreamRuntimeDefectScope';

/**
 * The category's OWN cap. Deliberately not the section (h) family bound or the ref-pinned caps:
 * these entries must never consume (or hide behind) their headroom. Raising it needs an ADR-0007
 * amendment.
 */
export const UPSTREAM_RUNTIME_DEFECT_CAP = 5;

/** `<runtime>/<builder>`: a defect is scoped to ONE cell, never to a whole runtime. */
export const LANE_PATTERN = /^(node|bun)\/(turbopack|webpack)$/;

/** `owner/repo#N`: an upstream issue or PR in a repository knext does not own. */
export const UPSTREAM_REF_PATTERN = /^(?!getknext-dev\/)[\w.-]+\/[\w.-]+#\d+$/;

/** A released Bun version, as `bun --version` prints it. */
export const BUN_VERSION_SHAPE = /^\d+\.\d+\.\d+$/;

/** A corpus test path is one concrete file: no glob metacharacters at all. */
const CONCRETE_TEST_PATH = /^test\/[\w./-]+\.test\.[jt]sx?$/;

/** `path/to/file.ts` or `path/to/file.ts#symbol`, anywhere in a free-text field. */
const REFUSAL_REF = /([\w./-]+\.(?:ts|tsx|mjs|cjs|js))(?:#([A-Za-z_$][\w$]*))?/g;

const PROVENANCE_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+/;

const MIN_MECHANISM_CHARS = 60;

/**
 * The lane's pinned Bun, read from the workflow's lane `setup-bun` steps
 * (`bun-version: ${{ github.event.inputs.bun-version || 'X.Y.Z' }}`). Every such step must carry
 * the same default (tests/compat-bun-lane-lockstep.test.ts holds that); this throws when none is
 * found or two disagree, so an unreadable pin can never read as "matches".
 */
const LANE_BUN_PIN =
  /bun-version:\s*\$\{\{\s*github\.event\.inputs\.bun-version\s*\|\|\s*'([^']+)'\s*\}\}/g;

export function laneBunPin(workflowSource, name = 'workflow') {
  const pins = [...new Set([...workflowSource.matchAll(LANE_BUN_PIN)].map((m) => m[1]))];
  if (pins.length !== 1 || !BUN_VERSION_SHAPE.test(pins[0])) {
    throw new Error(`${name}: cannot read ONE X.Y.Z lane Bun pin (found ${JSON.stringify(pins)})`);
  }
  return pins[0];
}

/** `bun/turbopack` -> `bun-turbopack`, the spelling CELLS and run records use. */
export function laneCell(lane) {
  return String(lane).replace('/', '-');
}

/**
 * Parse the ledger out of a manifest's text. FAILS CLOSED: invalid JSON, a missing key or a
 * non-array value all THROW, so an unreadable ledger never reads as "no entries".
 */
export function parseUpstreamRuntimeDefects(manifestText) {
  let parsed;
  try {
    parsed = JSON.parse(manifestText);
  } catch (err) {
    throw new Error(
      `upstream-runtime-defect ledger: manifest is not readable JSON (${err.message})`,
    );
  }
  const list = parsed?.[UPSTREAM_RUNTIME_DEFECT_KEY];
  if (!Array.isArray(list)) {
    throw new Error(
      `upstream-runtime-defect ledger: manifest has no ${UPSTREAM_RUNTIME_DEFECT_KEY} array`,
    );
  }
  return list;
}

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

/** Does the free text name at least one existing repo file (and its symbol, when given)? */
function namesRealGuard(text, ctx) {
  for (const m of text.matchAll(REFUSAL_REF)) {
    const [, path, symbol] = m;
    if (!path || !ctx.exists(path)) continue;
    if (symbol === undefined) return true;
    if (ctx.read(path)?.includes(symbol)) return true;
  }
  return false;
}

/**
 * Everything wrong with ONE entry. Empty means admissible.
 *
 * @param {object} e        the entry
 * @param {object} p
 * @param {{exists: (p: string) => boolean, read: (p: string) => string | undefined}} [p.ctx]
 *   repo access; without it a refusal cannot be verified, which is itself a problem
 * @param {string[]} p.laneRefs   default NEXTJS_REF of every workflow that runs the harness
 * @param {string}   p.shippedRef the shipped Next pin, as vX.Y.Z
 * @param {string}   p.laneBun    the Bun the compat lanes pin (laneBunPin)
 * @param {object}   p.snapshot   parsed test/compat-ref-pinned-cases.upstream.json
 */
export function entryProblems(e, { ctx, laneRefs, shippedRef, laneBun, snapshot } = {}) {
  const out = [];
  const who = e?.test ?? '<no test>';
  if (
    !nonEmpty(e?.test) ||
    !CONCRETE_TEST_PATH.test(e.test) ||
    e.test.split('/').some((seg) => seg === '..' || seg === '.')
  ) {
    out.push(`${who}: test must be one concrete corpus test file (no glob or wildcard)`);
  }
  if (!nonEmpty(e?.lane) || !LANE_PATTERN.test(e.lane)) {
    out.push(`${who}: lane must be <node|bun>/<turbopack|webpack>, got ${JSON.stringify(e?.lane)}`);
  }
  if (!nonEmpty(e?.nextjsRef) || !REF_SHAPE.test(e.nextjsRef)) {
    out.push(`${who}: nextjsRef must be a vX.Y.Z ref`);
  } else if (!refPinAdmissible(e.nextjsRef, laneRefs ?? [], shippedRef)) {
    out.push(
      `${who}: nextjsRef ${e.nextjsRef} is not the default NEXTJS_REF of any harness lane (${(laneRefs ?? []).join(', ')}) nor the shipped pin ahead of them: re-measure or remove the entry`,
    );
  }
  if (e?.reaudited !== undefined) {
    out.push(`${who}: no reaudited escape: re-measure at the new ref and restamp nextjsRef`);
  }
  if (typeof e?.lane === 'string' && e.lane.startsWith('bun/')) {
    if (!nonEmpty(e.bunVersion) || !BUN_VERSION_SHAPE.test(e.bunVersion)) {
      out.push(`${who}: a bun-lane entry must carry the X.Y.Z bunVersion it was measured on`);
    } else if (e.bunVersion !== laneBun) {
      out.push(
        `${who}: bunVersion ${e.bunVersion} is not the lane's pinned Bun (${laneBun}): the Bun moved, so re-measure at it (the fix may have shipped) or remove the entry`,
      );
    }
  }
  if (!e?.upstream || !UPSTREAM_REF_PATTERN.test(e.upstream.issue ?? '')) {
    out.push(`${who}: upstream.issue must be an owner/repo#N reference outside getknext-dev`);
  }
  if (!e?.upstream || !UPSTREAM_REF_PATTERN.test(e.upstream.fix ?? '')) {
    out.push(`${who}: upstream.fix must be an owner/repo#N reference outside getknext-dev`);
  }
  if (!nonEmpty(e?.removeWhen)) {
    out.push(`${who}: removeWhen must be a non-empty removal condition`);
  } else if (nonEmpty(e.upstream?.fix) && !e.removeWhen.includes(e.upstream.fix)) {
    out.push(`${who}: removeWhen must reference the entry's own upstream fix (${e.upstream.fix})`);
  }
  if (!nonEmpty(e?.knextRefusal)) {
    out.push(`${who}: knextRefusal must cite the build-time refusal that makes the red deliberate`);
  } else if (!ctx) {
    out.push(`${who}: knextRefusal cannot be verified without a repository context`);
  } else if (!namesRealGuard(e.knextRefusal, ctx)) {
    out.push(
      `${who}: knextRefusal must name a real guard: a repo path that exists, as path or path#symbol with the symbol present in that file`,
    );
  }
  if (!nonEmpty(e?.mechanism) || e.mechanism.trim().length < MIN_MECHANISM_CHARS) {
    out.push(
      `${who}: mechanism must be a written reason of at least ${MIN_MECHANISM_CHARS} characters`,
    );
  }
  if (!nonEmpty(e?.provenance) || !PROVENANCE_URL.test(e.provenance)) {
    out.push(`${who}: provenance must start with a GitHub issue or pull request URL`);
  }

  // Exact case names that still exist upstream at the entry's ref.
  if (!Array.isArray(e?.cases) || e.cases.length === 0) {
    out.push(`${who}: cases must be a non-empty list of {path, title}`);
  } else {
    const snap = snapshot?.files?.[e.test];
    if (!snap) out.push(`${who}: no upstream snapshot for this file`);
    else if (snapshot.ref !== e.nextjsRef) {
      out.push(`${who}: snapshot is for ${snapshot.ref}, entry is pinned at ${e.nextjsRef}`);
    }
    const seen = new Set();
    for (const c of e.cases) {
      if (!Array.isArray(c?.path) || !nonEmpty(c?.title) || c.path.some((p) => !nonEmpty(p))) {
        out.push(`${who}: a case must be {path: string[], title: string}`);
        continue;
      }
      const name = caseName(c);
      if (seen.has(name)) out.push(`${who}: duplicate case "${name}"`);
      seen.add(name);
      if (snap) {
        for (const part of [...c.path, c.title]) {
          if (!snap.literals.some((l) => literalProduces(l, part))) {
            out.push(
              `${who}: "${part}" is not a describe/it title in the upstream file at ${snapshot.ref}`,
            );
          }
        }
      }
    }
    // wholeFile must say whether the entry covers every case: a title literal upstream has that no
    // case (title or describe path) accounts for is a case that would keep running.
    if (typeof e.wholeFile !== 'boolean') {
      out.push(`${who}: wholeFile must be true or false`);
    } else if (snap) {
      const covered = e.cases.flatMap((c) => [...(c?.path ?? []), c?.title]).filter(nonEmpty);
      const others = snap.literals.filter((l) => !covered.some((t) => literalProduces(l, t)));
      if (e.wholeFile && others.length > 0) {
        out.push(
          `${who}: wholeFile is true but the file has other cases upstream (${others.join(' | ')}); a file exclusion would stop them running`,
        );
      } else if (!e.wholeFile && others.length === 0) {
        out.push(
          `${who}: the entry covers every case in the file, so wholeFile must be true: as a failed list the file runs no case and is credited as passed`,
        );
      }
    }
  }

  // Evidence: at least one run on the entry's own cell, every run at the entry's ref.
  if (!Array.isArray(e?.runs) || e.runs.length === 0) {
    out.push(`${who}: runs must record at least one CI run`);
  } else {
    for (const r of e.runs) {
      if (!/^\d{8,}$/.test(String(r?.run ?? '')))
        out.push(`${who}: run id ${JSON.stringify(r?.run)} is not a CI run id`);
      if (!CELLS.includes(r?.cell))
        out.push(`${who}: run ${r?.run} names no known cell (${r?.cell})`);
      if (r?.ref !== e.nextjsRef)
        out.push(`${who}: run ${r?.run} measured ${r?.ref}, entry is pinned at ${e.nextjsRef}`);
      if (String(r?.cell).startsWith('bun-') && !BUN_VERSION_SHAPE.test(String(r?.bun ?? '')))
        out.push(`${who}: Bun-cell run ${r?.run} records no X.Y.Z bun it ran on`);
    }
    if (nonEmpty(e.lane) && !e.runs.some((r) => r?.cell === laneCell(e.lane))) {
      out.push(`${who}: no recorded run measured the entry's own cell (${laneCell(e.lane)})`);
    } else if (
      typeof e.lane === 'string' &&
      e.lane.startsWith('bun/') &&
      !e.runs.some((r) => r?.cell === laneCell(e.lane) && r?.bun === e.bunVersion)
    ) {
      out.push(
        `${who}: no ${laneCell(e.lane)} run measured on Bun ${e.bunVersion}: moving bunVersion needs a re-measure at that Bun, not an edit`,
      );
    }
  }
  return out;
}

/**
 * Ledger-level problems: every entry, the cap, duplicates, and the boundaries with the other
 * categories. The committed manifest must NOT already deselect an entry's cases: the deselection
 * exists only in the run-time copy, on the entry's lane, or it would apply to every cell.
 *
 * @param {object} manifest the parsed manifest
 * @param {object} deps     as entryProblems
 */
export function ledgerProblems(manifest, deps = {}) {
  const entries = manifest?.[UPSTREAM_RUNTIME_DEFECT_KEY];
  if (!Array.isArray(entries)) return [`manifest has no ${UPSTREAM_RUNTIME_DEFECT_KEY} array`];
  const out = entries.flatMap((e) => entryProblems(e, deps));
  if (entries.length > UPSTREAM_RUNTIME_DEFECT_CAP) {
    out.push(
      `ledger holds ${entries.length} entries, over its own cap of ${UPSTREAM_RUNTIME_DEFECT_CAP} (raising it needs an ADR-0007 amendment)`,
    );
  }
  const seen = new Set();
  const exclude = new Set(manifest.rules?.exclude ?? []);
  const exclusions = new Set((manifest.$knextExclusions ?? []).map((x) => x?.test ?? x?.file ?? x));
  const quarantined = new Set((manifest.$knextQuarantines ?? []).map((q) => q?.test));
  const refPinned = new Set((manifest.$knextRefPinnedCases ?? []).map((r) => r?.test));
  for (const e of entries) {
    const key = `${e?.test}@${e?.lane}`;
    if (seen.has(key)) out.push(`${key}: duplicate entry`);
    seen.add(key);
    if (exclude.has(e?.test) || exclusions.has(e?.test)) {
      out.push(
        `${e?.test}: excluded at file level, so it would not run on the lanes where it passes`,
      );
    }
    if (quarantined.has(e?.test))
      out.push(`${e?.test}: also in $knextQuarantines (not a section (h) entry)`);
    if (refPinned.has(e?.test))
      out.push(`${e?.test}: also in $knextRefPinnedCases (a separate ledger)`);
    const committed = new Set(manifest.suites?.[e?.test]?.failed ?? []);
    for (const c of Array.isArray(e?.cases) ? e.cases : []) {
      if (committed.has(caseName(c))) {
        out.push(
          `${e?.test}: "${caseName(c)}" is in the committed suites failed list, which deselects it on EVERY cell; the deselection must come only from the run-time scope`,
        );
      }
    }
  }
  return out;
}

export class DefectScopeError extends Error {}

/**
 * RUN-TIME half: apply each matching entry to `manifest` (mutated in place; the caller passes a
 * copy): a `wholeFile` entry adds its file to `rules.exclude`, any other adds its case names to
 * `suites[file].failed`. FAIL CLOSED: a ledger that is not an array, an entry without a parseable
 * lane/ref/cases/wholeFile, a non-empty ledger with no runtime or builder, or a matching Bun entry
 * whose Bun cannot be read all throw.
 *
 * @param {object} manifest
 * @param {{ref: string, runtime?: string, builder?: string, bunVersion?: () => string}} lane
 *   `bunVersion` is called lazily, only when a Bun entry matches the lane and the ref.
 */
export function applyUpstreamRuntimeDefects(manifest, { ref, runtime, builder, bunVersion }) {
  const ledger = manifest[UPSTREAM_RUNTIME_DEFECT_KEY];
  if (ledger === undefined) return manifest;
  if (!Array.isArray(ledger))
    throw new DefectScopeError(`${UPSTREAM_RUNTIME_DEFECT_KEY} must be an array`);
  if (ledger.length > 0 && (!nonEmpty(runtime) || !nonEmpty(builder))) {
    throw new DefectScopeError(
      `${UPSTREAM_RUNTIME_DEFECT_KEY} is not empty but the lane is unknown (runtime ${JSON.stringify(runtime)}, builder ${JSON.stringify(builder)}); set KNEXT_RUNTIME and KNEXT_BUILDER or pass --runtime/--builder`,
    );
  }
  const lane = `${runtime}/${builder}`;
  const applied = [];
  const skipped = [];
  let observedBun;
  for (const e of ledger) {
    if (typeof e?.test !== 'string')
      throw new DefectScopeError('an upstream-runtime-defect entry has no "test"');
    if (typeof e.lane !== 'string' || !LANE_PATTERN.test(e.lane)) {
      throw new DefectScopeError(`${e.test}: upstream-runtime-defect entry has no parseable lane`);
    }
    if (typeof e.nextjsRef !== 'string' || !REF_SHAPE.test(e.nextjsRef)) {
      throw new DefectScopeError(
        `${e.test}: upstream-runtime-defect entry has no parseable nextjsRef`,
      );
    }
    if (!Array.isArray(e.cases) || e.cases.length === 0) {
      throw new DefectScopeError(`${e.test}: upstream-runtime-defect entry has no cases`);
    }
    if (typeof e.wholeFile !== 'boolean') {
      throw new DefectScopeError(
        `${e.test}: upstream-runtime-defect entry has no boolean wholeFile`,
      );
    }
    if (e.lane !== lane) {
      skipped.push({ test: e.test, reason: `lane ${e.lane}` });
      continue;
    }
    if (e.nextjsRef !== ref) {
      skipped.push({ test: e.test, reason: `ref ${e.nextjsRef}` });
      continue;
    }
    if (runtime === 'bun') {
      if (observedBun === undefined) observedBun = bunVersion ? bunVersion() : undefined;
      if (!nonEmpty(observedBun)) {
        throw new DefectScopeError(
          `${e.test}: the Bun under test could not be read, so the entry cannot be scoped`,
        );
      }
      if (observedBun !== e.bunVersion) {
        skipped.push({ test: e.test, reason: `bun ${e.bunVersion}, lane runs ${observedBun}` });
        continue;
      }
    }
    if (e.wholeFile) {
      // Every case of the file: exclude the FILE so it is never selected (and never credited as a
      // passed file that ran nothing). get-test-filter honours an exact path in rules.exclude
      // whether or not the file has a suites entry.
      if (!Array.isArray(manifest.rules?.exclude)) {
        throw new DefectScopeError(
          `${e.test}: the manifest has no rules.exclude array to add it to`,
        );
      }
      if (!manifest.rules.exclude.includes(e.test)) manifest.rules.exclude.push(e.test);
      applied.push({ test: e.test, as: 'exclude' });
      continue;
    }
    if (!manifest.suites) manifest.suites = {};
    if (!manifest.suites[e.test]) manifest.suites[e.test] = {};
    const suite = manifest.suites[e.test];
    const failed = suite.failed ?? [];
    for (const name of e.cases.map(caseName)) if (!failed.includes(name)) failed.push(name);
    suite.failed = failed;
    applied.push({ test: e.test, as: 'failed' });
  }
  manifest[UPSTREAM_RUNTIME_DEFECT_SCOPE_KEY] = {
    ref,
    lane,
    bunVersion: observedBun ?? null,
    applied,
    skipped,
  };
  return manifest;
}
