/**
 * The fresh-release quarantine, enforced on lockfiles.
 *
 * `bunfig.toml` makes bun refuse to RESOLVE a registry version younger than
 * `install.minimumReleaseAge`. That protects the machine running `bun add`, and
 * nothing else: a hand-edited lockfile, a Dependabot branch, a Cargo or Go bump, or
 * an install with `--minimum-release-age 0` all reach the tree untouched. This is
 * the gate that checks the RESULT: every lockfile entry a change adds or alters must
 * have been published at least that long ago, judged from the registry's own
 * metadata, not from the committer's word.
 *
 * Pure functions plus an injected `lookup`, so the policy is tested without a
 * network. `scripts/release-age-gate.mjs` does the I/O.
 *
 * FAIL CLOSED, INCLUDING ON WHAT IT CANNOT AGE-CHECK. A registry that cannot be
 * reached, a version it does not know, a timestamp that does not parse: each is a
 * failure. So is an added or altered entry that does not resolve to a version on
 * the public registry at all: a git or tarball dependency, a package pinned to a
 * non-default registry, a Cargo `git+` or alternate-registry source, a lockfile
 * entry with no resolved URL. Those have no publish time to check, which is exactly
 * why they cannot be waved through; they are "unresolved" entries, and only a
 * scoped, dated exception names one. Local-path sources (workspace, file, link, a
 * Cargo path crate, a Go `replace` to a directory) are code already in the repository
 * and are not dependencies on a registry, so they are skipped.
 *
 * The only way past a too-new release or an unresolved source is a scoped, dated
 * entry in `security/release-age-exceptions.json`.
 */

const SEMVERISH = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

/** The only two ways Cargo spells the public crates.io registry. */
const CRATES_IO_SOURCES = [
  'registry+https://github.com/rust-lang/crates.io-index',
  'sparse+https://index.crates.io/',
];

/** Specs that point at code already in the repository, not at a registry. */
const LOCAL_SPEC = /^(?:workspace|file|link|portal):/;

/**
 * @typedef {{ecosystem: 'npm' | 'crates' | 'go', name: string, version: string,
 *   unresolved?: string, integrity?: string}} Entry
 *   `unresolved` is set (to the reason) when the entry does not resolve to a version
 *   on the public registry; `version` is then the raw source spec.
 * @typedef {Entry & {lockfile: string}} LockEntry
 */

/**
 * `install.minimumReleaseAge` (seconds) and `minimumReleaseAgeExcludes` from bunfig.toml.
 * The number the install-time quarantine uses is the number this gate uses.
 *
 * @param {string} bunfigText
 * @returns {{seconds: number, excludes: string[]}}
 */
export function readBunfig(bunfigText) {
  const age = bunfigText.match(/^\s*minimumReleaseAge\s*=\s*(\d+)\s*(?:#.*)?$/m);
  if (!age) throw new Error('bunfig.toml sets no install.minimumReleaseAge');
  const ex = bunfigText.match(/^\s*minimumReleaseAgeExcludes\s*=\s*\[([^\]]*)\]/m);
  const excludes = ex ? [...ex[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  return { seconds: Number(age[1]), excludes };
}

/**
 * Strip comments and trailing commas from JSONC (`bun.lock`) outside strings. Node has
 * no JSONC parser, and this module must stay dependency-free.
 *
 * @param {string} text
 */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * One `bun.lock` package id: `name@1.2.3`, `@scope/name@1.2.3`, `alias@npm:real@1.2.3`,
 * or a non-registry spec (`pkg@github:o/r#sha`, `pkg@https://…tgz`, `pkg@workspace:…`).
 * `registry` is the lockfile's second field: empty for the default registry.
 *
 * @returns {Entry | null} null for a local (workspace, file, link) package
 */
function npmFromId(id, registry) {
  const at = id.indexOf('@', 1);
  if (at <= 0) return { ecosystem: 'npm', name: id, version: id, unresolved: 'unparseable id' };
  const name = id.slice(0, at);
  const spec = id.slice(at + 1);
  if (LOCAL_SPEC.test(spec)) return null;
  if (spec.startsWith('npm:')) return npmFromId(spec.slice(4), registry);
  if (!SEMVERISH.test(spec)) {
    return { ecosystem: 'npm', name, version: spec, unresolved: 'not a registry version' };
  }
  if (typeof registry === 'string' && registry !== '') {
    return {
      ecosystem: 'npm',
      name,
      version: spec,
      unresolved: `non-default registry ${registry}`,
    };
  }
  return { ecosystem: 'npm', name, version: spec };
}

/** Packages in a `bun.lock` (JSONC). */
function parseBunLock(text, parseJsoncFn) {
  const lock = parseJsoncFn(text);
  const out = [];
  for (const entry of Object.values(lock.packages ?? {})) {
    const id = Array.isArray(entry) ? entry[0] : null;
    if (typeof id !== 'string') continue;
    const e = npmFromId(id, entry[1]);
    if (!e) continue;
    if (e.unresolved) {
      // The content hash is the last string field: [id, registry, meta, integrity] or
      // [id, meta, integrity]. A tarball re-pinned to new bytes keeps the same URL, so
      // the hash is what tells the two apart.
      const integrity = entry
        .slice(2)
        .filter((x) => typeof x === 'string')
        .at(-1);
      if (integrity) e.integrity = integrity;
    }
    out.push(e);
  }
  return out;
}

/** Packages in an npm `package-lock.json`. */
function parsePackageLock(text) {
  const lock = JSON.parse(text);
  const out = [];
  for (const [key, e] of Object.entries(lock.packages ?? {})) {
    if (key === '' || e.link) continue;
    // A key with no `node_modules/` segment is a workspace member: code in the repo.
    const marker = key.lastIndexOf('node_modules/');
    if (marker < 0 || e.inBundle) continue;
    const name = e.name ?? key.slice(marker + 'node_modules/'.length);
    const version = typeof e.version === 'string' ? e.version : '(none)';
    const integrity = typeof e.integrity === 'string' ? { integrity: e.integrity } : {};
    if (typeof e.resolved !== 'string') {
      out.push({ ecosystem: 'npm', name, version, unresolved: 'no resolved URL', ...integrity });
    } else if (e.resolved.startsWith('file:')) {
      // local path dependency
    } else if (e.resolved.startsWith('https://registry.npmjs.org/') && SEMVERISH.test(version)) {
      out.push({ ecosystem: 'npm', name, version });
    } else {
      out.push({
        ecosystem: 'npm',
        name,
        version: e.resolved,
        unresolved: 'resolved outside registry.npmjs.org',
        ...integrity,
      });
    }
  }
  return out;
}

/** Packages in a `Cargo.lock`. Path crates have no `source` and are local. */
function parseCargoLock(text) {
  const out = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    const source = block.match(/^source\s*=\s*"([^"]+)"/m)?.[1];
    if (!name || !version || !source) continue;
    if (CRATES_IO_SOURCES.includes(source)) out.push({ ecosystem: 'crates', name, version });
    else out.push({ ecosystem: 'crates', name, version: source, unresolved: 'not crates.io' });
  }
  return out;
}

const isLocalPath = (p) => p === '.' || p === '..' || /^\.{1,2}\//.test(p) || p.startsWith('/');

/** `old [ver] => new [ver]` from a replace directive body. */
function parseReplace(body) {
  const m = body.match(/^(\S+)(?:\s+(v\S+))?\s*=>\s*(\S+)(?:\s+(v\S+))?$/);
  return m ? { old: m[1], oldVer: m[2], target: m[3], targetVer: m[4] } : null;
}

/**
 * Modules in a `go.mod`: every `require`, minus the ones a `replace` swaps out, plus the
 * replacement targets. A replacement to a directory is local code and is skipped; one to
 * a module path is aged at the REPLACEMENT version (that is what gets built); a malformed
 * one is unresolved.
 */
function parseGoMod(text) {
  const requires = [];
  const replaces = [];
  const unresolved = [];
  let block = null;
  const handle = (kind, body, raw) => {
    if (kind === 'require') {
      const m = body.match(/^(\S+)\s+(v\S+)$/);
      if (m) requires.push({ ecosystem: 'go', name: m[1], version: m[2] });
    } else if (kind === 'replace') {
      const r = parseReplace(body);
      if (r) replaces.push(r);
      else {
        unresolved.push({
          ecosystem: 'go',
          name: body.split(/\s+/)[0] ?? raw,
          version: body,
          unresolved: 'unparseable replace directive',
        });
      }
    }
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (block) {
      if (line === ')') block = null;
      else handle(block, line, raw);
      continue;
    }
    const open = line.match(/^(require|replace|exclude|retract|tool|godebug)\s*\($/);
    if (open) {
      block = open[1];
      continue;
    }
    const single = line.match(/^(require|replace)\s+(.+)$/);
    if (single) handle(single[1], single[2], raw);
  }

  const replacedAway = (e) =>
    replaces.some((r) => r.old === e.name && (r.oldVer === undefined || r.oldVer === e.version));
  const out = requires.filter((e) => !replacedAway(e));
  for (const r of replaces) {
    if (isLocalPath(r.target)) continue;
    if (r.targetVer) out.push({ ecosystem: 'go', name: r.target, version: r.targetVer });
    else {
      out.push({
        ecosystem: 'go',
        name: r.target,
        version: `${r.old} => ${r.target}`,
        unresolved: 'replace without a version',
      });
    }
  }
  return [...out, ...unresolved];
}

/**
 * The entries in one lockfile: registry versions, and "unresolved" ones that do not
 * resolve to a version on the public registry.
 *
 * @param {string} lockfile repo-relative path (the basename picks the parser)
 * @param {string} text
 * @param {(text: string) => any} parseJsoncFn parses `bun.lock`
 * @returns {Entry[]}
 */
export function parseLockfile(lockfile, text, parseJsoncFn = parseJsonc) {
  const base = lockfile.split('/').pop();
  if (base === 'bun.lock') return parseBunLock(text, parseJsoncFn);
  if (base === 'package-lock.json') return parsePackageLock(text);
  if (base === 'Cargo.lock') return parseCargoLock(text);
  if (base === 'go.mod') return parseGoMod(text);
  throw new Error(`no release-age parser for ${lockfile}`);
}

/**
 * Identity of an entry across base and head. An unresolved source's integrity hash is part
 * of it: a tarball URL (or a git tag) can be re-pinned to different bytes with the same
 * spec, and that must read as a change. A Cargo git source carries its revision in the
 * spec, and a go.mod replacement carries its version, so those already change the key.
 */
const keyOf = (e) => `${e.lockfile}|${e.ecosystem}|${e.name}|${e.version}|${e.integrity ?? ''}`;

/**
 * Entries in `head` that `base` does not have, per lockfile: what a change ADDED or
 * ALTERED. A removal needs no check.
 *
 * @param {LockEntry[]} head
 * @param {LockEntry[]} base
 * @returns {LockEntry[]}
 */
export function changedEntries(head, base) {
  const seen = new Set(base.map(keyOf));
  const out = [];
  const dup = new Set();
  for (const e of head) {
    const k = keyOf(e);
    if (seen.has(k) || dup.has(k)) continue;
    dup.add(k);
    out.push(e);
  }
  return out;
}

/** First-party registry packages are published by this repository, so have no quarantine. */
export function isExcluded(entry, excludes) {
  return !entry.unresolved && entry.ecosystem === 'npm' && excludes.includes(entry.name);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXC_KEYS = new Set([
  'ecosystem',
  'package',
  'version',
  'integrity',
  'justification',
  'added',
  'expires',
]);
/** A too-new release stops being too new within days, so an exception is short-lived. */
export const MAX_EXCEPTION_DAYS = 14;
/**
 * An unresolved source (a git or tarball dependency) never ages out, so its exception
 * may run longer, but still has to be renewed and re-justified.
 */
export const MAX_UNRESOLVED_EXCEPTION_DAYS = 180;
const DAY_MS = 86_400_000;

/**
 * Validate `security/release-age-exceptions.json`. Each entry names ONE ecosystem,
 * package and exact version (or, for an unresolved source, the exact source spec),
 * carries a real justification, and expires within 14 days of `added` (180 for an
 * unresolved source). `added` may not be in the future. Unknown keys, wildcards and a
 * missing `expires` are rejected.
 *
 * @param {unknown} doc
 * @param {string} today ISO date
 */
export function loadExceptions(doc, today) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.allow)) {
    throw new Error('exceptions must be an object with an `allow` array');
  }
  const active = [];
  const expired = [];
  for (const [i, e] of doc.allow.entries()) {
    const at = `allow[${i}] (${e?.package}@${e?.version})`;
    for (const key of Object.keys(e ?? {})) {
      if (!EXC_KEYS.has(key)) throw new Error(`${at} has an unknown key \`${key}\``);
    }
    if (!['npm', 'crates', 'go'].includes(e?.ecosystem)) {
      throw new Error(`${at} needs \`ecosystem\`: npm, crates or go`);
    }
    if (typeof e.package !== 'string' || !e.package || /[*?\s]/.test(e.package)) {
      throw new Error(`${at} needs an exact \`package\` (no wildcards)`);
    }
    if (
      typeof e.version !== 'string' ||
      !e.version ||
      /[*?\s]/.test(e.version) ||
      /^[\^~<>=|]/.test(e.version)
    ) {
      throw new Error(`${at} needs an exact \`version\` or source spec (no ranges or wildcards)`);
    }
    if (e.integrity !== undefined && !/^[A-Za-z0-9+/=_.-]+$/.test(String(e.integrity))) {
      throw new Error(`${at} has a malformed \`integrity\` (the lockfile's hash, no spaces)`);
    }
    if (typeof e.justification !== 'string' || e.justification.trim().length < 20) {
      throw new Error(`${at} needs a real \`justification\` (>= 20 chars)`);
    }
    if (typeof e.added !== 'string' || !ISO_DATE.test(e.added)) {
      throw new Error(`${at} needs an ISO \`added\` date`);
    }
    if (e.added > today) throw new Error(`${at} \`added\` is in the future`);
    if (typeof e.expires !== 'string' || !ISO_DATE.test(e.expires)) {
      throw new Error(`${at} needs an ISO \`expires\` date (it is required)`);
    }
    const span = (Date.parse(e.expires) - Date.parse(e.added)) / DAY_MS;
    if (!(span > 0)) throw new Error(`${at} \`expires\` must be after \`added\``);
    const cap = SEMVERISH.test(e.version) ? MAX_EXCEPTION_DAYS : MAX_UNRESOLVED_EXCEPTION_DAYS;
    if (span > cap) {
      throw new Error(`${at} \`expires\` is more than ${cap} days after \`added\``);
    }
    if (e.expires < today) expired.push(e);
    else active.push(e);
  }
  return { active, expired };
}

/**
 * Where to ask for an entry's publish time.
 *
 * @param {Entry} e
 * @returns {string}
 */
export function registryUrl(e) {
  if (e.ecosystem === 'npm') {
    return `https://registry.npmjs.org/${e.name.startsWith('@') ? `@${encodeURIComponent(e.name.slice(1))}` : encodeURIComponent(e.name)}`;
  }
  if (e.ecosystem === 'crates') {
    return `https://crates.io/api/v1/crates/${encodeURIComponent(e.name)}/${encodeURIComponent(e.version)}`;
  }
  // Go's proxy lower-cases module paths and escapes capitals as `!x`.
  const escaped = e.name.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
  return `https://proxy.golang.org/${escaped}/@v/${encodeURIComponent(e.version)}.info`;
}

/**
 * The publish time in a registry response, as epoch milliseconds. Throws when the
 * response does not carry one: an unanswerable question is not a pass.
 *
 * @param {Entry} e
 * @param {any} json
 * @returns {number}
 */
export function publishTime(e, json) {
  const raw =
    e.ecosystem === 'npm'
      ? json?.time?.[e.version]
      : e.ecosystem === 'crates'
        ? json?.version?.created_at
        : json?.Time;
  const ms = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new Error(`${e.ecosystem} registry returned no publish time for ${e.name}@${e.version}`);
  }
  return ms;
}

/**
 * Judge every changed entry.
 *
 * @param {object} input
 * @param {LockEntry[]} input.entries added or altered entries
 * @param {(e: LockEntry) => Promise<number>} input.lookup publish time (epoch ms); must
 *   reject on any failure
 * @param {number} input.now epoch ms
 * @param {number} input.minSeconds
 * @param {string[]} input.excludes bunfig `minimumReleaseAgeExcludes`
 * @param {{active: any[], expired: any[]}} input.exceptions
 * @param {number} [input.concurrency]
 */
export async function evaluateAges({
  entries,
  lookup,
  now,
  minSeconds,
  excludes,
  exceptions,
  concurrency = 8,
}) {
  const tooNew = [];
  const unresolved = [];
  const excepted = [];
  const errors = [];
  const skipped = [];
  const queue = [];
  // An entry that carries an integrity hash is excused only by an exception naming that
  // same hash, so re-pinning an excepted tarball to new bytes is not silently allowed.
  const isExcepted = (e) =>
    exceptions.active.some(
      (x) =>
        x.ecosystem === e.ecosystem &&
        x.package === e.name &&
        x.version === e.version &&
        x.integrity === e.integrity,
    );
  for (const e of entries) {
    if (e.unresolved) {
      // No publish time exists to check, so it cannot pass on age: only a named exception.
      (isExcepted(e) ? excepted : unresolved).push(e);
    } else if (isExcluded(e, excludes)) skipped.push(e);
    else queue.push(e);
  }

  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const e = queue[next++];
      try {
        const published = await lookup(e);
        if (!Number.isFinite(published)) throw new Error('lookup returned a non-time');
        const ageSeconds = (now - published) / 1000;
        if (ageSeconds >= minSeconds) continue;
        const rec = { ...e, ageHours: Math.round((ageSeconds / 3600) * 10) / 10 };
        (isExcepted(e) ? excepted : tooNew).push(rec);
      } catch (err) {
        errors.push({ ...e, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return {
    tooNew,
    unresolved,
    excepted,
    errors,
    skipped,
    checked: queue.length,
    expired: exceptions.expired,
  };
}

const lineOf = (e) =>
  `  - ${e.ecosystem} ${e.name}@${e.version}${e.lockfile ? ` in ${e.lockfile}` : ''}`;

/** Human summary. */
export function renderAgeReport(r, minSeconds) {
  const days = Math.round((minSeconds / 86400) * 10) / 10;
  const out = [];
  if (r.tooNew.length) {
    out.push(
      `FAIL: ${r.tooNew.length} lockfile entr${r.tooNew.length === 1 ? 'y was' : 'ies were'} published less than ${days} days ago:`,
      ...r.tooNew.map((e) => `${lineOf(e)}  (${e.ageHours}h old)`),
      'Wait, or record a short-lived entry in security/release-age-exceptions.json.',
    );
  }
  if (r.unresolved.length) {
    out.push(
      `FAIL: ${r.unresolved.length} added or changed entr${r.unresolved.length === 1 ? 'y does' : 'ies do'} not resolve to a version on the public registry, so there is no publish time to check (git, tarball, other registry, no resolved URL):`,
      ...r.unresolved.map((e) => `${lineOf(e)}  [${e.unresolved}]`),
      'Use a registry release, or record a scoped entry (ecosystem, package, the exact source spec) in security/release-age-exceptions.json.',
    );
  }
  if (r.errors.length) {
    out.push(
      `FAIL: ${r.errors.length} entr${r.errors.length === 1 ? 'y' : 'ies'} could not be checked (the registry is unreachable or does not know it, and an unanswered question is not a pass):`,
      ...r.errors.map((e) => `${lineOf(e)}  ${e.error}`),
    );
  }
  if (r.excepted.length) {
    out.push(
      `Allowed by security/release-age-exceptions.json: ${r.excepted.length}`,
      ...r.excepted.map(lineOf),
    );
  }
  if (r.expired.length) {
    out.push(
      `Expired exceptions (no longer allowing): ${r.expired.map((e) => `${e.package}@${e.version}`).join(', ')}`,
    );
  }
  if (!out.length) {
    out.push(
      `Release age: ${r.checked} added/changed entr${r.checked === 1 ? 'y' : 'ies'} checked, all at least ${days} days old.`,
    );
  }
  return out.join('\n');
}

/**
 * The lockfile entries a version-matching scanner (OSV) cannot judge: git, tarball,
 * other-registry and unresolved sources. OSV matches advisories by package name and
 * version, so a `github:` dependency, or a Cargo `git+` crate whose declared version
 * is whatever its manifest says, is either skipped or matched on a number that does not
 * identify the code. This lists them so the OSV report says what it did NOT cover.
 *
 * @param {LockEntry[]} entries every entry at head
 * @returns {string}
 */
export function renderUnscannable(entries) {
  const bad = entries.filter((e) => e.unresolved);
  if (bad.length === 0) return '';
  return [
    `Not covered by version-matched scanning (git, tarball or other-registry sources): ${bad.length}`,
    ...bad.map((e) => `${lineOf(e)}  [${e.unresolved}]`),
    'A NEW one fails the release-age gate unless a scoped exception names it.',
  ].join('\n');
}

/** @param {Awaited<ReturnType<typeof evaluateAges>>} r */
export const ageFailed = (r) =>
  r.tooNew.length > 0 || r.errors.length > 0 || r.unresolved.length > 0;
