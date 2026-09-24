/**
 * Pure comparison logic for `scripts/ga-tarball-diff.mjs` (#1306).
 *
 * The GA check exists because the v1.0 compatibility credential was measured
 * against the `rc.N` tarballs, not the ones actually published under the
 * `v1.0.0` (or later) tag. If a GA tarball differs from its rc counterpart in
 * anything OTHER than version fields, the credential does not cover what
 * ships. This module is the pure decision — packing/CLI plumbing lives in
 * `scripts/ga-tarball-diff.mjs`, and reading the tar stream itself lives in
 * `scripts/lib/tar-inventory.mjs`, so this half is testable without spawning
 * `tar`/`bun` or touching disk.
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

const RC_VERSION_RE = /^(\d+\.\d+\.\d+)-rc\.\d+$/;
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
