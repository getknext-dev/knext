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
 * FAIL CLOSED. A registry that cannot be reached, a version it does not know, a
 * timestamp that does not parse: each is a failure. The only way past a too-new
 * release is a scoped, dated, short-lived entry in `security/release-age-exceptions.json`.
 */

const SEMVERISH = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

/**
 * @typedef {{ecosystem: 'npm' | 'crates' | 'go', name: string, version: string}} Entry
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

function npmFromId(id) {
  // "name@1.2.3", "@scope/name@1.2.3", "alias@npm:real@1.2.3"; anything else
  // (workspace:, file:, link:, github:, http) is not a registry version.
  const target = id.includes('@npm:') ? id.slice(id.indexOf('@npm:') + 5) : id;
  const at = target.lastIndexOf('@');
  if (at <= 0) return null;
  const version = target.slice(at + 1);
  if (!SEMVERISH.test(version)) return null;
  return { ecosystem: 'npm', name: target.slice(0, at), version };
}

/** Registry packages in a `bun.lock` (JSONC). */
function parseBunLock(text, parseJsonc) {
  const lock = parseJsonc(text);
  const out = [];
  for (const entry of Object.values(lock.packages ?? {})) {
    const id = Array.isArray(entry) ? entry[0] : null;
    if (typeof id !== 'string') continue;
    const e = npmFromId(id);
    if (e) out.push(e);
  }
  return out;
}

/** Registry packages in an npm `package-lock.json`. */
function parsePackageLock(text) {
  const lock = JSON.parse(text);
  const out = [];
  for (const [key, e] of Object.entries(lock.packages ?? {})) {
    if (key === '' || e.link) continue;
    if (typeof e.resolved !== 'string' || !e.resolved.startsWith('https://registry.npmjs.org/')) {
      continue;
    }
    const name = e.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (typeof e.version === 'string' && SEMVERISH.test(e.version)) {
      out.push({ ecosystem: 'npm', name, version: e.version });
    }
  }
  return out;
}

/** crates.io packages in a `Cargo.lock` (path, workspace and git sources are skipped). */
function parseCargoLock(text) {
  const out = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    const source = block.match(/^source\s*=\s*"([^"]+)"/m)?.[1];
    if (name && version && source?.startsWith('registry+') && source.includes('crates.io')) {
      out.push({ ecosystem: 'crates', name, version });
    }
  }
  return out;
}

/** Required modules in a `go.mod` (replace/exclude/retract blocks are ignored). */
function parseGoMod(text) {
  const out = [];
  let block = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (block) {
      if (line === ')') {
        block = null;
        continue;
      }
      if (block === 'require') {
        const m = line.match(/^(\S+)\s+(v\S+)$/);
        if (m) out.push({ ecosystem: 'go', name: m[1], version: m[2] });
      }
      continue;
    }
    const open = line.match(/^(require|replace|exclude|retract|tool|godebug)\s*\($/);
    if (open) {
      block = open[1];
      continue;
    }
    const single = line.match(/^require\s+(\S+)\s+(v\S+)$/);
    if (single) out.push({ ecosystem: 'go', name: single[1], version: single[2] });
  }
  return out;
}

/**
 * The registry entries in one lockfile.
 *
 * @param {string} lockfile repo-relative path (the basename picks the parser)
 * @param {string} text
 * @param {(text: string) => any} parseJsonc injected so this module stays dependency-free
 * @returns {Entry[]}
 */
export function parseLockfile(lockfile, text, parseJsonc = JSON.parse) {
  const base = lockfile.split('/').pop();
  if (base === 'bun.lock') return parseBunLock(text, parseJsonc);
  if (base === 'package-lock.json') return parsePackageLock(text);
  if (base === 'Cargo.lock') return parseCargoLock(text);
  if (base === 'go.mod') return parseGoMod(text);
  throw new Error(`no release-age parser for ${lockfile}`);
}

const keyOf = (e) => `${e.lockfile}|${e.ecosystem}|${e.name}|${e.version}`;

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

/** First-party packages are published by this repository, so have no quarantine. */
export function isExcluded(entry, excludes) {
  return entry.ecosystem === 'npm' && excludes.includes(entry.name);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXC_KEYS = new Set(['ecosystem', 'package', 'version', 'justification', 'added', 'expires']);
/** A too-new release stops being too new within days, so an exception is short-lived. */
export const MAX_EXCEPTION_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * Validate `security/release-age-exceptions.json`. Each entry names ONE ecosystem,
 * package and exact version, carries a real justification, and expires within 14 days
 * of `added`. Unknown keys, wildcards and a missing `expires` are rejected.
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
    if (typeof e.version !== 'string' || !SEMVERISH.test(e.version)) {
      throw new Error(`${at} needs an exact \`version\` (no ranges)`);
    }
    if (typeof e.justification !== 'string' || e.justification.trim().length < 20) {
      throw new Error(`${at} needs a real \`justification\` (>= 20 chars)`);
    }
    if (typeof e.added !== 'string' || !ISO_DATE.test(e.added)) {
      throw new Error(`${at} needs an ISO \`added\` date`);
    }
    if (typeof e.expires !== 'string' || !ISO_DATE.test(e.expires)) {
      throw new Error(`${at} needs an ISO \`expires\` date (it is required)`);
    }
    const span = (Date.parse(e.expires) - Date.parse(e.added)) / DAY_MS;
    if (!(span > 0)) throw new Error(`${at} \`expires\` must be after \`added\``);
    if (span > MAX_EXCEPTION_DAYS) {
      throw new Error(`${at} \`expires\` is more than ${MAX_EXCEPTION_DAYS} days after \`added\``);
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
  const excepted = [];
  const errors = [];
  const skipped = [];
  const queue = [];
  for (const e of entries) {
    if (isExcluded(e, excludes)) skipped.push(e);
    else queue.push(e);
  }
  const isExcepted = (e) =>
    exceptions.active.some(
      (x) => x.ecosystem === e.ecosystem && x.package === e.name && x.version === e.version,
    );

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
  return { tooNew, excepted, errors, skipped, checked: queue.length, expired: exceptions.expired };
}

/** Human summary. `failed` is true when the change must not merge. */
export function renderAgeReport(r, minSeconds) {
  const days = Math.round((minSeconds / 86400) * 10) / 10;
  const line = (e) =>
    `  - ${e.ecosystem} ${e.name}@${e.version}${e.lockfile ? ` in ${e.lockfile}` : ''}`;
  const out = [];
  if (r.tooNew.length) {
    out.push(
      `FAIL: ${r.tooNew.length} lockfile entr${r.tooNew.length === 1 ? 'y was' : 'ies were'} published less than ${days} days ago:`,
      ...r.tooNew.map((e) => `${line(e)}  (${e.ageHours}h old)`),
      'Wait, or record a short-lived entry in security/release-age-exceptions.json.',
    );
  }
  if (r.errors.length) {
    out.push(
      `FAIL: ${r.errors.length} entr${r.errors.length === 1 ? 'y' : 'ies'} could not be checked (the registry is unreachable or does not know it, and an unanswered question is not a pass):`,
      ...r.errors.map((e) => `${line(e)}  ${e.error}`),
    );
  }
  if (r.excepted.length) {
    out.push(
      `Allowed by security/release-age-exceptions.json: ${r.excepted.length}`,
      ...r.excepted.map(line),
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

/** @param {Awaited<ReturnType<typeof evaluateAges>>} r */
export const ageFailed = (r) => r.tooNew.length > 0 || r.errors.length > 0;
