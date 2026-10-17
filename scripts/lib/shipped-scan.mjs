/**
 * Pure helpers for the nightly re-scan of what we have already shipped
 * (`.github/workflows/shipped-artifacts-nightly.yml`). No process spawning, no
 * network: `scripts/audit-shipped-npm.mjs` and `scripts/resolve-shipped-images.mjs`
 * do the I/O, and `tests/shipped-scan.test.ts` pins every rule here.
 *
 * THE RULE THAT SHAPES ALL OF IT: this lane must fail LOUD. A nightly that goes
 * green because it could not see is worse than none, so every parser throws on an
 * error document, an empty answer or an unreadable one, and a registry that cannot
 * be reached is never read as "nothing there".
 */

/** The published npm fixed group, in the order they are installed for a scan. */
export const NPM_GROUP = ['@getknext/core', '@getknext/lib', '@getknext/db', 'kn-next'];

/** Function-template images. Not published to any registry today. */
export const TEMPLATE_IMAGES = ['knext-function-go', 'knext-function-rust'];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Parse `npm view <pkg> dist-tags --json` output.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseNpmView(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`npm view did not return JSON: ${err.message}\n${String(text).slice(0, 300)}`);
  }
  if (doc && typeof doc === 'object' && 'error' in doc) {
    throw new Error(`npm view returned an error document: ${JSON.stringify(doc.error)}`);
  }
  return doc;
}

/**
 * Every distinct version on any dist-tag, with the tags that point at it, sorted by
 * version string. `latest` must exist: the version users get by default is never
 * skipped.
 *
 * @param {Record<string, string>} distTags
 * @returns {Array<{version: string, tags: string[]}>}
 */
export function versionsToScan(distTags) {
  if (!distTags || typeof distTags !== 'object' || Array.isArray(distTags)) {
    throw new Error('dist-tags must be an object');
  }
  const entries = Object.entries(distTags);
  if (entries.length === 0) throw new Error('registry returned no dist-tags: nothing to scan');
  if (typeof distTags.latest !== 'string') {
    throw new Error('registry returned no `latest` dist-tag: refusing to scan around it');
  }
  const byVersion = new Map();
  for (const [tag, version] of entries) {
    if (typeof version !== 'string' || !SEMVER.test(version)) {
      throw new Error(`dist-tag ${tag} is not a semver version: ${JSON.stringify(version)}`);
    }
    byVersion.set(version, [...(byVersion.get(version) ?? []), tag]);
  }
  return [...byVersion.entries()]
    .map(([version, tags]) => ({ version, tags: tags.sort() }))
    .sort((a, b) => (a.version < b.version ? -1 : 1));
}

/**
 * Parse `npm audit --json`. npm audit against an unreachable registry prints an
 * `error` document and NO `vulnerabilities`, which a lenient reader takes as a
 * clean audit. This one throws.
 *
 * @param {string} text
 */
export function parseNpmAudit(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`npm audit did not return JSON: ${err.message}`);
  }
  if (doc?.error) {
    const e = doc.error;
    throw new Error(
      `npm audit could not run (${e.code ?? 'error'}): ${e.summary ?? e.detail ?? JSON.stringify(e)}`,
    );
  }
  if (!doc || typeof doc.vulnerabilities !== 'object' || doc.vulnerabilities === null) {
    throw new Error('npm audit report has no `vulnerabilities` map: refusing to read it as clean');
  }
  return doc;
}

/** A stable advisory id from an npm-audit `via` object (mirrors audit-published.mjs). */
function advisoryId(a) {
  if (typeof a?.url === 'string') {
    const m = a.url.match(/GHSA-[0-9a-z-]+/i);
    return m ? m[0] : a.url;
  }
  if (typeof a?.source === 'number' || typeof a?.source === 'string') return String(a.source);
  return '';
}

/**
 * The HIGH/CRITICAL groups in an npm audit report, minus allowlisted ones. A group
 * is suppressed only if EVERY contributing advisory is allowlisted. Bare-string
 * `via` entries are transitive pointers, not advisories.
 *
 * @param {{vulnerabilities: Record<string, any>}} report
 * @param {Set<string>} allowedIds
 */
export function failingNpmFindings(report, allowedIds) {
  const vulns = report.vulnerabilities;
  const memo = new Map();
  /**
   * A group is suppressed iff it has something to judge (an advisory or a pointer)
   * and every advisory is allowlisted and every pointer is itself suppressed. A
   * cycle is not suppressed.
   */
  const isSuppressed = (name, visiting) => {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name)) return false;
    const v = vulns[name];
    if (!v) return false;
    visiting.add(name);
    const via = Array.isArray(v.via) ? v.via : [];
    const ids = via
      .filter((x) => typeof x === 'object')
      .map(advisoryId)
      .filter(Boolean);
    const pointers = via.filter((x) => typeof x === 'string');
    const result =
      ids.length + pointers.length > 0 &&
      ids.every((id) => allowedIds.has(id)) &&
      pointers.every((p) => isSuppressed(p, visiting));
    visiting.delete(name);
    memo.set(name, result);
    return result;
  };

  const failing = [];
  const suppressed = [];
  for (const [name, v] of Object.entries(vulns)) {
    if (v.severity !== 'high' && v.severity !== 'critical') continue;
    const via = Array.isArray(v.via) ? v.via : [];
    const ids = via
      .filter((x) => typeof x === 'object')
      .map(advisoryId)
      .filter(Boolean);
    const entry = { name, severity: v.severity, ids };
    (isSuppressed(name, new Set()) ? suppressed : failing).push(entry);
  }
  return { failing, suppressed };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The active advisory ids in `security/npm-audit-allowlist.json`. Same rules as
 * `audit-published.mjs`: id, justification and an ISO `added` date are required;
 * an entry past `expires` stops suppressing.
 *
 * @param {unknown} doc
 * @param {string} today ISO date
 * @returns {Set<string>}
 */
export function loadNpmAllowlist(doc, today) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.allow)) {
    throw new Error('npm audit allowlist must be an object with an `allow` array');
  }
  const ids = new Set();
  for (const e of doc.allow) {
    if (typeof e?.id !== 'string' || !e.id) throw new Error('allowlist entry needs a string `id`');
    if (typeof e.justification !== 'string' || !e.justification) {
      throw new Error(`allowlist entry ${e.id} needs a justification`);
    }
    if (typeof e.added !== 'string' || !ISO_DATE.test(e.added)) {
      throw new Error(`allowlist entry ${e.id} needs an ISO added date`);
    }
    if (typeof e.expires === 'string' && e.expires < today) continue;
    ids.add(e.id);
  }
  return ids;
}

/**
 * The digest-pinned operator image refs in a release bundle's `install.yaml`.
 * Throws when there are none: a bundle that pins no image is not one we can scan,
 * and silently scanning nothing is the failure this lane exists to avoid.
 *
 * @param {string} installYaml
 * @returns {string[]} `ghcr.io/<owner>/kn-next-operator@sha256:<64 hex>`
 */
export function operatorImageRefs(installYaml) {
  const refs = new Set();
  for (const m of installYaml.matchAll(
    /(ghcr\.io\/[A-Za-z0-9._-]+\/kn-next-operator)(?::[A-Za-z0-9._-]+)?@(sha256:[0-9a-f]{64})/g,
  )) {
    refs.add(`${m[1]}@${m[2]}`);
  }
  if (refs.size === 0) {
    throw new Error('no digest-pinned kn-next-operator image in the release bundle');
  }
  return [...refs];
}

/**
 * Did the registry positively say the image does not exist, or did we simply fail
 * to ask? Only the first is "not published". Anything else, including an empty
 * message or an auth failure, is "unreachable" and the caller must fail.
 *
 * @param {string} stderr
 * @returns {'not-found' | 'unreachable'}
 */
export function classifyRegistryError(stderr) {
  return /MANIFEST_UNKNOWN|NAME_UNKNOWN/.test(String(stderr)) ? 'not-found' : 'unreachable';
}

const PUBLISH_VERB = /\b(?:crane|docker)\s+push\b|\bcosign\s+sign\b|push:\s*(?:true|\$\{\{)/;

/**
 * Workflows that appear to PUBLISH a template image: they name it and carry a
 * publish verb. Today none does (the template image jobs build locally and scan).
 * When one starts, the nightly must scan it, so a test turns this into a red
 * until `resolve-shipped-images.mjs` learns the new image's tag convention.
 *
 * @param {Record<string, string>} workflowTexts file name to text
 * @returns {Record<string, string[]>}
 */
export function publishedTemplateImages(workflowTexts) {
  const out = {};
  for (const [file, text] of Object.entries(workflowTexts)) {
    const code = text
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    if (!PUBLISH_VERB.test(code)) continue;
    const named = TEMPLATE_IMAGES.filter((n) => code.includes(n));
    if (named.length > 0) out[file] = named;
  }
  return out;
}
