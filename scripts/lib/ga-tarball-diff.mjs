/**
 * Pure comparison logic for `scripts/ga-tarball-diff.mjs` (#1306).
 *
 * The GA check exists because the v1.0 compatibility credential was measured
 * against the `rc.N` tarballs, not the ones actually published under the
 * `v1.0.0` (or later) tag. If a GA tarball differs from its rc counterpart in
 * anything OTHER than version fields, the credential does not cover what
 * ships. This module is the pure decision — extraction, packing and CLI
 * plumbing live in `scripts/ga-tarball-diff.mjs` so this half is testable
 * without spawning `tar`/`bun`.
 *
 * ALLOWED deltas between an rc tree and its GA counterpart, and nothing else:
 *
 *   1. The top-level `version` field in `package.json`.
 *   2. A `@getknext/*` dependency range (dependencies/devDependencies/
 *      peerDependencies) in `package.json`, when that sibling is itself part
 *      of the compared set — i.e. it moved in lockstep with the version bump.
 *   3. The EXACT rc version string, substituted for the EXACT GA version
 *      string, inside a built file's bytes — and nowhere else in that file.
 *      A file is scanned for this, never enumerated: any byte-for-byte
 *      mismatch is tried against the substitution first; if that closes the
 *      gap it is an embedded-version site, otherwise it is a violation.
 *
 * Anything else — an extra/missing file, a package present in one set and
 * not the other, a non-version package.json field drifting, a partial or
 * multiple-site substitution, binary content that differs — fails closed.
 */

const PACKAGE_JSON = 'package.json';
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * Diff one package.json object against its GA counterpart.
 *
 * @param {Record<string, unknown>} rcPkg
 * @param {Record<string, unknown>} gaPkg
 * @param {{ rcVersion: string, gaVersion: string, siblingNames: Set<string> }} ctx
 * @returns {string[]} violation descriptions; empty means the manifest is clean
 */
export function diffPackageJson(rcPkg, gaPkg, ctx) {
  const violations = [];
  const rcKeys = new Set(Object.keys(rcPkg));
  const gaKeys = new Set(Object.keys(gaPkg));
  for (const key of rcKeys) {
    if (!gaKeys.has(key))
      violations.push(`package.json: key "${key}" present in rc, missing in GA`);
  }
  for (const key of gaKeys) {
    if (!rcKeys.has(key))
      violations.push(`package.json: key "${key}" present in GA, missing in rc`);
  }

  for (const key of rcKeys) {
    if (!gaKeys.has(key)) continue;
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

    if (!deepEqual(rcVal, gaVal)) {
      violations.push(
        `package.json: "${key}" differs: rc=${JSON.stringify(rcVal)} ga=${JSON.stringify(gaVal)}`,
      );
    }
  }

  return violations;
}

function diffDependencyField(field, rcDeps, gaDeps, ctx) {
  const violations = [];
  const rcObj = rcDeps && typeof rcDeps === 'object' ? rcDeps : {};
  const gaObj = gaDeps && typeof gaDeps === 'object' ? gaDeps : {};
  const rcNames = new Set(Object.keys(rcObj));
  const gaNames = new Set(Object.keys(gaObj));

  for (const name of rcNames) {
    if (!gaNames.has(name))
      violations.push(`package.json: "${field}.${name}" present in rc, missing in GA`);
  }
  for (const name of gaNames) {
    if (!rcNames.has(name))
      violations.push(`package.json: "${field}.${name}" present in GA, missing in rc`);
  }

  for (const name of rcNames) {
    if (!gaNames.has(name)) continue;
    const rcRange = rcObj[name];
    const gaRange = gaObj[name];
    if (rcRange === gaRange) continue;

    const isSibling = name.startsWith('@getknext/') && ctx.siblingNames.has(name);
    if (isSibling) continue; // a sibling range is allowed to move with the lockstep bump

    violations.push(
      `package.json: "${field}.${name}" differs: rc=${JSON.stringify(rcRange)} ga=${JSON.stringify(gaRange)} (not a co-versioned sibling)`,
    );
  }

  return violations;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => deepEqual(a[k], b[k]));
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

  const rcSiteCount = countOccurrences(rcText, rcVersion);
  if (rcSiteCount === 0) {
    return {
      ok: false,
      reason: 'content differs and rc content does not contain the rc version string',
    };
  }

  const substituted = rcText.split(rcVersion).join(gaVersion);
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

function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function firstDiffOffset(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return len;
}

/**
 * Compare two extracted package trees (relative-path -> absolute-path maps).
 *
 * @param {Map<string, string>} rcFiles relative path -> absolute path
 * @param {Map<string, string>} gaFiles relative path -> absolute path
 * @param {{ rcVersion: string, gaVersion: string, siblingNames: Set<string>, readFile: (path: string) => Buffer }} ctx
 * @returns {{ok: boolean, violations: string[], embeddedVersionSites: string[]}}
 */
export function compareTrees(rcFiles, gaFiles, ctx) {
  const violations = [];
  const embeddedVersionSites = [];

  const rcPaths = new Set(rcFiles.keys());
  const gaPaths = new Set(gaFiles.keys());
  for (const p of rcPaths) {
    if (!gaPaths.has(p)) violations.push(`file present in rc, missing in GA: ${p}`);
  }
  for (const p of gaPaths) {
    if (!rcPaths.has(p)) violations.push(`file present in GA, missing in rc: ${p}`);
  }

  for (const relPath of rcPaths) {
    if (!gaPaths.has(relPath)) continue;
    const rcAbs = rcFiles.get(relPath);
    const gaAbs = gaFiles.get(relPath);

    if (relPath === PACKAGE_JSON || relPath.endsWith(`/${PACKAGE_JSON}`)) {
      const rcPkg = JSON.parse(ctx.readFile(rcAbs).toString('utf8'));
      const gaPkg = JSON.parse(ctx.readFile(gaAbs).toString('utf8'));
      const pkgViolations = diffPackageJson(rcPkg, gaPkg, ctx);
      violations.push(...pkgViolations.map((v) => `${relPath}: ${v}`));
      continue;
    }

    const result = diffFileBytes(
      ctx.readFile(rcAbs),
      ctx.readFile(gaAbs),
      ctx.rcVersion,
      ctx.gaVersion,
    );
    if (!result.ok) {
      violations.push(`${relPath}: ${result.reason}`);
    } else if (result.embedded) {
      embeddedVersionSites.push(relPath);
    }
  }

  return { ok: violations.length === 0, violations, embeddedVersionSites };
}
