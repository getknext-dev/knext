/**
 * Pure comparison logic for `scripts/ga-tarball-diff.mjs` (#1306).
 *
 * The GA check exists because the v1.0 compatibility credential was measured
 * against the `rc.N` tarballs, not the ones actually published under the
 * `v1.0.0` (or later) tag. If a GA tarball differs from its rc counterpart in
 * anything OTHER than version fields, the credential does not cover what
 * ships. This module is the pure decision — packing/CLI plumbing lives in
 * `scripts/ga-tarball-diff.mjs`, and reading the tar stream itself lives in
 * `scripts/lib/tar-entries.mjs` (via `node-tar`, the same library
 * `npm`/`pacote` extract with — see that file for why), so this half is
 * testable without spawning `bun` or touching disk.
 *
 * ALLOWED deltas between an rc tree and its GA counterpart, and nothing else:
 *
 *   1. The top-level `version` field in `package.json`.
 *   2. A `@getknext/*` dependency range (dependencies/devDependencies/
 *      peerDependencies/optionalDependencies) in `package.json`, ONLY when
 *      that sibling is itself part of the compared set (`ctx.siblingNames`)
 *      AND the GA range equals the rc range with the rc version substituted
 *      for the GA version — nothing else. A sibling range pointing anywhere
 *      else (a different version, a git URL, a workspace protocol) fails.
 *   3. The exact rc version string, substituted for the exact GA version
 *      string, wherever it is embedded in a built file's bytes — every such
 *      site, not just the first. The match is BOUNDARY-AWARE: `1.0.0-rc.1`
 *      does not match inside `1.0.0-rc.10`, on either side, so an adjacent
 *      version-like string can never be silently absorbed. A file is
 *      SCANNED for this, never enumerated: any byte-for-byte mismatch is
 *      tried against the substitution first; if that closes the gap in full
 *      it is an embedded-version site, otherwise it is a violation.
 *
 * Anything else fails closed — an extra/missing entry (file, directory,
 * symlink, hardlink — every entry in the tarball, not just the ones a
 * filesystem walk would report), a type change (file<->symlink etc), a MODE
 * change, a symlink/hardlink target change, an entry outside `package/`
 * (rejected outright, not merely diffed — see `assertEntrySafe`), a
 * non-version manifest field drifting (including KEY ORDER — conditional
 * `exports` resolution is order-sensitive, so reordering is a real
 * behavioural change even when the key set is identical), a partial or
 * multi-site-but-inconsistent substitution, or unexplained binary drift.
 */

const PACKAGE_JSON = 'package.json';
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const SAFE_ROOT = 'package';

// --- version well-formedness (#1306 review item 6) --------------------------

// Captures both the base (`X.Y.Z`) and the rc counter (`N`) — the counter is
// unused by `validateVersionPair` (kept byte-for-byte for its existing
// callers/tests) but is what `parseRcVersion`/`validateVersionBump` (#1562)
// need to tell an rc BUMP from a stale or backwards re-cut.
const RC_VERSION_RE = /^(\d+\.\d+\.\d+)-rc\.(\d+)$/;
const GA_VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * Is this an `X.Y.Z-rc.N` -> `X.Y.Z` pair? Returns an error string, or `null`
 * when the pair is well-formed.
 *
 * @param {string} rcVersion
 * @param {string} gaVersion
 * @returns {string | null}
 */
export function validateVersionPair(rcVersion, gaVersion) {
  const m = RC_VERSION_RE.exec(rcVersion);
  if (!m) return `rc version is not well-formed "X.Y.Z-rc.N": ${JSON.stringify(rcVersion)}`;
  if (!GA_VERSION_RE.test(gaVersion)) {
    return `GA version is not well-formed "X.Y.Z": ${JSON.stringify(gaVersion)}`;
  }
  if (m[1] !== gaVersion) {
    return (
      `GA version ${JSON.stringify(gaVersion)} does not match the rc version's base ` +
      `${JSON.stringify(m[1])} (from rc ${JSON.stringify(rcVersion)})`
    );
  }
  return null;
}

/**
 * Parse `X.Y.Z-rc.N` into `{ base: "X.Y.Z", n: N }`, or `null` when the
 * string is not that shape (#1562).
 *
 * @param {string} version
 * @returns {{ base: string, n: number } | null}
 */
export function parseRcVersion(version) {
  const m = RC_VERSION_RE.exec(version);
  if (!m) return null;
  return { base: m[1], n: Number(m[2]) };
}

/**
 * The SHAPE check `release.yml`'s publish-blocking gate (#1562) runs before
 * attempting a content diff: is `toVersion` a version the credentialed rc
 * `fromVersion` may legitimately be diffed against at all?
 *
 * Deliberately a SUPERSET of `validateVersionPair` — every pair that function
 * accepts, this accepts too (case 2 below reproduces it exactly) — plus two
 * more shapes `validateVersionPair` was never asked to allow:
 *
 *   1. IDENTICAL — `toVersion === fromVersion`. This is not a hypothetical:
 *      the founder checklist for cutting an rc (#1591) pushes the git tag
 *      naming it at the SAME commit the version bump publishes from, so the
 *      credentialed rc's own first publish diffs a commit against itself.
 *      Trivially valid — there is nothing to substitute.
 *   2. GA CUT — `toVersion` is `fromVersion`'s rc base with the prerelease
 *      stripped. The #1306 transition this whole check exists for.
 *   3. RC RE-CUT — `toVersion` is a LATER rc of the exact same base
 *      (`fromVersion` is `rc.N`, `toVersion` is `rc.M`, `M > N`). This
 *      function only judges the SHAPE; whether that later rc's CONTENT
 *      actually differs only in version fields is a separate question a mid-
 *      window rc bump is expected to fail (see `decideGaTarballDiffGate`,
 *      which is deliberately narrower — it does not treat every shape this
 *      function accepts as something the release gate should attempt).
 *
 * `fromVersion` must itself be a well-formed `X.Y.Z-rc.N` — there is no
 * "identical" escape hatch for a malformed source, because an identical
 * malformed pair would otherwise validate two strings that are not a version
 * at all.
 *
 * @param {string} fromVersion the credentialed rc's own version
 * @param {string} toVersion the version being compared against it
 * @returns {string | null} an error string, or `null` when the shape is valid
 */
export function validateVersionBump(fromVersion, toVersion) {
  const from = parseRcVersion(fromVersion);
  if (!from) {
    return `credentialed rc version is not well-formed "X.Y.Z-rc.N": ${JSON.stringify(fromVersion)}`;
  }

  if (toVersion === fromVersion) return null; // case 1

  if (GA_VERSION_RE.test(toVersion)) {
    if (toVersion !== from.base) {
      return (
        `GA version ${JSON.stringify(toVersion)} does not match the rc version's base ` +
        `${JSON.stringify(from.base)} (from rc ${JSON.stringify(fromVersion)})`
      );
    }
    return null; // case 2
  }

  const to = parseRcVersion(toVersion);
  if (!to) {
    return (
      'target version is neither identical to the credentialed rc, nor a well-formed GA ' +
      `"X.Y.Z", nor a well-formed rc "X.Y.Z-rc.M": ${JSON.stringify(toVersion)}`
    );
  }
  if (to.base !== from.base) {
    return (
      `target rc version ${JSON.stringify(toVersion)} does not share the credentialed rc's base ` +
      `${JSON.stringify(from.base)} (from ${JSON.stringify(fromVersion)})`
    );
  }
  if (to.n <= from.n) {
    return (
      `target rc.${to.n} does not bump forward past the credentialed rc.${from.n} ` +
      `(from ${JSON.stringify(fromVersion)} to ${JSON.stringify(toVersion)})`
    );
  }
  return null; // case 3
}

/**
 * Should `release.yml`'s publish-blocking gate (#1562) diff THIS publish, and
 * if so against which rc tag?
 *
 * KEYED ON GIT TAGS, NOT ON `rcTag` (#1562 round 2). `rcTag` in
 * `.github/compat-credential-ref.json` is the credential window's LIVE pin
 * (ADR-0056) and is legitimately cleared when a window closes — which is
 * exactly when the GA cut happens. Keying on it made the gate a green no-op
 * for the one publish it exists for (1.0.0 after the window closed), and,
 * while still set, blocked every later release (1.0.1, 1.1.0, ...) with a
 * version-shape failure. So:
 *
 *   - PRERELEASE target (any prerelease id) — SKIP by design. A later rc is
 *     expected to carry real changes relative to an earlier one; that is the
 *     point of cutting it.
 *   - GA target `X.Y.Z` with NO `vX.Y.Z-rc.N` git tag — SKIP: no release
 *     candidate was cut for X.Y.Z, so this release is not claimed as
 *     credentialed. Never blocks it (1.0.1, 1.1.0, 2.0.0, 0.4.4 ...).
 *   - GA target `X.Y.Z` WITH `vX.Y.Z-rc.N` tags — RUN against the HIGHEST N
 *     (numeric, so rc.10 > rc.9): the last rc is the candidate the credential
 *     window ends on.
 *   - ...unless `pinnedRcTag` names a DIFFERENT `vX.Y.Z-rc.*` than that
 *     highest tag — FAIL: the credential is ambiguous (was rc.1 credentialed
 *     and rc.2 cut afterwards?). A pin on another tuple (the next window
 *     already open) is irrelevant to this GA.
 *   - An EMPTY tag list — FAIL closed. The repo has always had tags; zero
 *     means a tagless/shallow checkout, and "no rc tag found" from a
 *     checkout that cannot see tags must never read as "not credentialed".
 *
 * @param {{ targetVersion: string, pinnedRcTag: string | null, gitTags: string[] }} input
 * @returns {{ action: 'run', rcTag: string, reason: string } | { action: 'skip' | 'fail', reason: string }}
 */
export function decideGaTarballDiffGate({ targetVersion, pinnedRcTag, gitTags }) {
  if (!GA_VERSION_RE.test(targetVersion)) {
    return {
      action: 'skip',
      reason:
        `target ${JSON.stringify(targetVersion)} is a prerelease — only a GA cut is diffed ` +
        'against its release candidate; a later rc is expected to carry real changes',
    };
  }
  if (gitTags.length === 0) {
    return {
      action: 'fail',
      reason:
        'no git tags are visible in this checkout — it is tagless or shallow, so "was a release ' +
        `candidate cut for ${targetVersion}?" cannot be answered (fail closed, never a skip)`,
    };
  }

  const tagPrefix = `v${targetVersion}-rc.`;
  const rcTagRe = new RegExp(`^${escapeRegExp(tagPrefix)}(0|[1-9]\\d*)$`);
  let highest = null;
  for (const tag of gitTags) {
    const m = rcTagRe.exec(tag);
    if (!m) continue;
    const n = Number(m[1]);
    if (highest === null || n > highest.n) highest = { tag, n };
  }

  if (highest === null) {
    return {
      action: 'skip',
      reason:
        `no release candidate was cut for ${targetVersion} — this release is not claimed as ` +
        `credentialed (no ${tagPrefix}N git tag exists)`,
    };
  }

  const pinnedSameTuple = pinnedRcTag?.startsWith(tagPrefix) === true;
  if (pinnedSameTuple && pinnedRcTag !== highest.tag) {
    return {
      action: 'fail',
      reason:
        `ambiguous credential: .github/compat-credential-ref.json pins rcTag=${JSON.stringify(pinnedRcTag)} ` +
        `but the highest release candidate cut for ${targetVersion} is ${JSON.stringify(highest.tag)} — ` +
        'either credential the highest rc (and pin it) or explain the later tag before cutting GA',
    };
  }

  return {
    action: 'run',
    rcTag: highest.tag,
    reason: `GA cut of ${targetVersion}; diffing against its highest release candidate ${highest.tag}`,
  };
}

// --- boundary-aware version substitution (#1306 review item 4) -------------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `version` matched only when NOT touching another version-ish character on either side. */
function versionBoundaryRegExp(version) {
  return new RegExp(`(?<![0-9A-Za-z.-])${escapeRegExp(version)}(?![0-9A-Za-z.-])`, 'g');
}

/** How many boundary-aware occurrences of `version` appear in `text`. */
export function countVersionOccurrences(text, version) {
  const matches = text.match(versionBoundaryRegExp(version));
  return matches ? matches.length : 0;
}

/** Replace every boundary-aware occurrence of `rcVersion` with `gaVersion`. */
export function substituteVersion(text, rcVersion, gaVersion) {
  return text.replace(versionBoundaryRegExp(rcVersion), gaVersion);
}

// --- package.json: order-sensitive comparison (#1306 review item 5) --------

/** Order-sensitive structural equality: array order AND object key order both matter. */
function orderedDeepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => orderedDeepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== bKeys[i]) return false;
  }
  return aKeys.every((k) => orderedDeepEqual(a[k], b[k]));
}

/** Missing/extra/reordered keys between two same-purpose key lists. */
function diffKeyOrder(rcKeys, gaKeys, label) {
  const violations = [];
  const rcSet = new Set(rcKeys);
  const gaSet = new Set(gaKeys);
  for (const k of rcKeys) {
    if (!gaSet.has(k)) violations.push(`${label}: key "${k}" present in rc, missing in GA`);
  }
  for (const k of gaKeys) {
    if (!rcSet.has(k)) violations.push(`${label}: key "${k}" present in GA, missing in rc`);
  }
  if (violations.length === 0 && rcKeys.join('\u0000') !== gaKeys.join('\u0000')) {
    violations.push(
      `${label}: key order differs: rc=[${rcKeys.join(', ')}] ga=[${gaKeys.join(', ')}]`,
    );
  }
  return violations;
}

/**
 * Diff one package.json object against its GA counterpart. Order-sensitive
 * everywhere EXCEPT the `version` field's value and a co-versioned sibling
 * dependency range's value (see `diffDependencyField`) — key ORDER still
 * matters even inside `dependencies` etc.
 *
 * @param {Record<string, unknown>} rcPkg
 * @param {Record<string, unknown>} gaPkg
 * @param {{ rcVersion: string, gaVersion: string, siblingNames: Set<string> }} ctx
 * @returns {string[]} violation descriptions; empty means the manifest is clean
 */
export function diffPackageJson(rcPkg, gaPkg, ctx) {
  const rcKeys = Object.keys(rcPkg);
  const gaKeys = Object.keys(gaPkg);
  const violations = diffKeyOrder(rcKeys, gaKeys, 'package.json');
  const gaKeySet = new Set(gaKeys);

  for (const key of rcKeys) {
    if (!gaKeySet.has(key)) continue; // already reported above

    const rcVal = rcPkg[key];
    const gaVal = gaPkg[key];

    if (key === 'version') {
      if (rcVal !== ctx.rcVersion || gaVal !== ctx.gaVersion) {
        violations.push(
          `package.json: "version" is ${JSON.stringify(rcVal)} -> ${JSON.stringify(gaVal)}, expected ${JSON.stringify(ctx.rcVersion)} -> ${JSON.stringify(ctx.gaVersion)}`,
        );
      }
      continue;
    }

    if (DEP_FIELDS.includes(key)) {
      violations.push(...diffDependencyField(key, rcVal, gaVal, ctx));
      continue;
    }

    if (!orderedDeepEqual(rcVal, gaVal)) {
      violations.push(
        `package.json: "${key}" differs: rc=${JSON.stringify(rcVal)} ga=${JSON.stringify(gaVal)}`,
      );
    }
  }

  return violations;
}

function diffDependencyField(field, rcDeps, gaDeps, ctx) {
  const rcObj = rcDeps && typeof rcDeps === 'object' ? rcDeps : {};
  const gaObj = gaDeps && typeof gaDeps === 'object' ? gaDeps : {};
  const rcNames = Object.keys(rcObj);
  const gaNames = Object.keys(gaObj);
  const violations = diffKeyOrder(rcNames, gaNames, `package.json: "${field}"`);
  const gaNameSet = new Set(gaNames);

  for (const name of rcNames) {
    if (!gaNameSet.has(name)) continue; // already reported above
    const rcRange = rcObj[name];
    const gaRange = gaObj[name];
    if (rcRange === gaRange) continue;

    // Leniency is a TWO-PART gate: the dependency must be a name this run
    // actually knows is co-versioned (`ctx.siblingNames`, the packages we are
    // comparing) AND, given that, the GA range must be EXACTLY the rc range
    // with the rc version substituted for the GA version — not "any change".
    // A `@getknext/*`-named dependency that is NOT in `siblingNames` gets
    // none of this: it is held to the same exact-match bar as `pino` or a
    // git URL, because nothing here has verified it moved in lockstep.
    const isSibling =
      typeof rcRange === 'string' && name.startsWith('@getknext/') && ctx.siblingNames.has(name);
    if (isSibling) {
      const expected = substituteVersion(rcRange, ctx.rcVersion, ctx.gaVersion);
      if (expected === gaRange) continue;
      violations.push(
        `package.json: "${field}.${name}" sibling range is not the rc range with the version substituted: rc=${JSON.stringify(rcRange)} -> expected ${JSON.stringify(expected)}, got ${JSON.stringify(gaRange)}`,
      );
      continue;
    }

    violations.push(
      `package.json: "${field}.${name}" differs: rc=${JSON.stringify(rcRange)} ga=${JSON.stringify(gaRange)} (not a co-versioned sibling)`,
    );
  }

  return violations;
}

/**
 * Diff one non-manifest file's bytes against its GA counterpart.
 *
 * @param {Buffer} rcBuf
 * @param {Buffer} gaBuf
 * @param {string} rcVersion
 * @param {string} gaVersion
 * @returns {{ok: true, embedded: boolean} | {ok: false, reason: string}}
 */
export function diffFileBytes(rcBuf, gaBuf, rcVersion, gaVersion) {
  if (rcBuf.equals(gaBuf)) return { ok: true, embedded: false };

  // Only attempt the substitution on decodable text; a mismatched binary file
  // is never "just the version" and should fail loud, not be force-decoded.
  const rcText = tryUtf8(rcBuf);
  const gaText = tryUtf8(gaBuf);
  if (rcText === null || gaText === null) {
    return { ok: false, reason: 'binary content differs' };
  }

  const rcSiteCount = countVersionOccurrences(rcText, rcVersion);
  if (rcSiteCount === 0) {
    return {
      ok: false,
      reason: 'content differs and rc content does not contain the rc version string',
    };
  }

  const substituted = substituteVersion(rcText, rcVersion, gaVersion);
  if (substituted === gaText) {
    return { ok: true, embedded: true };
  }

  const at = firstDiffOffset(rcText, gaText);
  const context = `…${rcText.slice(Math.max(0, at - 40), at + 40)}… -> …${gaText.slice(Math.max(0, at - 40), at + 40)}…`;
  return {
    ok: false,
    reason: `content differs beyond the rc->GA version substitution near offset ${at}: ${context}`,
  };
}

function tryUtf8(buf) {
  const text = buf.toString('utf8');
  // toString('utf8') never throws; detect lossy re-encoding as a binary signal.
  return Buffer.from(text, 'utf8').equals(buf) ? text : null;
}

function firstDiffOffset(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return len;
}

// --- tar-entry-level comparison (#1306 review item 1) -----------------------

/**
 * Reject a tar entry outright — never merely diff it — when it is not safely
 * scoped under `package/`, or (for a symlink/hardlink) its target escapes
 * that scope. This runs on EVERY entry of EVERY tarball before any
 * comparison, so a malicious tarball fails immediately regardless of what its
 * counterpart looks like — two tarballs agreeing on the same unsafe entry
 * must still fail, not cancel out.
 *
 * @param {{name: string, type: string, linkname: string|null}} entry
 */
export function assertEntrySafe(entry) {
  const { name } = entry;
  if (name.startsWith('/')) {
    throw new Error(`unsafe tar entry (absolute path): ${name}`);
  }
  if (name.split('/').some((seg) => seg === '..')) {
    throw new Error(`unsafe tar entry (path traversal): ${name}`);
  }
  if (name !== SAFE_ROOT && !name.startsWith(`${SAFE_ROOT}/`)) {
    throw new Error(`unsafe tar entry (outside ${SAFE_ROOT}/): ${name}`);
  }
  if (entry.type === 'symlink' || entry.type === 'hardlink') {
    const target = entry.linkname ?? '';
    if (target.startsWith('/')) {
      throw new Error(`unsafe tar entry (link target is an absolute path): ${name} -> ${target}`);
    }
    if (target.split('/').some((seg) => seg === '..')) {
      throw new Error(`unsafe tar entry (link target escapes via ..): ${name} -> ${target}`);
    }
  }
}

/**
 * Compare two tarballs' FULL, RAW entry sets directly — type, mode, symlink/
 * hardlink target, and (for regular files) content — never through a
 * filesystem extraction+walk, which is how the review-round bypasses shipped
 * (a symlink and a top-level entry outside `package/` are invisible to
 * `readdirSync`+`isFile()`, and nothing there reads a file's mode at all).
 *
 * @param {Array<{name: string, type: string, mode: number, linkname: string|null, data: Buffer|null}>} rcEntries
 * @param {Array<{name: string, type: string, mode: number, linkname: string|null, data: Buffer|null}>} gaEntries
 * @param {{ rcVersion: string, gaVersion: string, siblingNames: Set<string> }} ctx
 * @returns {{ok: boolean, violations: string[], embeddedVersionSites: string[]}}
 */
export function compareTarEntries(rcEntries, gaEntries, ctx) {
  for (const entry of rcEntries) assertEntrySafe(entry);
  for (const entry of gaEntries) assertEntrySafe(entry);

  const violations = [];
  const embeddedVersionSites = [];

  const rcByName = new Map(rcEntries.map((e) => [e.name, e]));
  const gaByName = new Map(gaEntries.map((e) => [e.name, e]));

  for (const name of rcByName.keys()) {
    if (!gaByName.has(name)) violations.push(`entry present in rc, missing in GA: ${name}`);
  }
  for (const name of gaByName.keys()) {
    if (!rcByName.has(name)) violations.push(`entry present in GA, missing in rc: ${name}`);
  }

  for (const [name, rcEntry] of rcByName) {
    const gaEntry = gaByName.get(name);
    if (!gaEntry) continue;

    if (rcEntry.type !== gaEntry.type) {
      violations.push(`${name}: type differs: rc=${rcEntry.type} ga=${gaEntry.type}`);
      continue;
    }
    if (rcEntry.mode !== gaEntry.mode) {
      violations.push(
        `${name}: mode differs: rc=${rcEntry.mode.toString(8).padStart(3, '0')} ga=${gaEntry.mode.toString(8).padStart(3, '0')}`,
      );
    }

    if (rcEntry.type === 'symlink' || rcEntry.type === 'hardlink') {
      if (rcEntry.linkname !== gaEntry.linkname) {
        violations.push(
          `${name}: ${rcEntry.type} target differs: rc=${rcEntry.linkname} ga=${gaEntry.linkname}`,
        );
      }
      continue;
    }

    if (rcEntry.type !== 'file') continue; // directories etc.: type + mode already checked above

    if (name === `${SAFE_ROOT}/${PACKAGE_JSON}`) {
      let rcPkg;
      let gaPkg;
      try {
        rcPkg = JSON.parse(rcEntry.data.toString('utf8'));
        gaPkg = JSON.parse(gaEntry.data.toString('utf8'));
      } catch (err) {
        violations.push(`${name}: unreadable package.json: ${err.message}`);
        continue;
      }
      violations.push(...diffPackageJson(rcPkg, gaPkg, ctx).map((v) => `${name}: ${v}`));
      continue;
    }

    const result = diffFileBytes(rcEntry.data, gaEntry.data, ctx.rcVersion, ctx.gaVersion);
    if (!result.ok) {
      violations.push(`${name}: ${result.reason}`);
    } else if (result.embedded) {
      embeddedVersionSites.push(name);
    }
  }

  return { ok: violations.length === 0, violations, embeddedVersionSites };
}
