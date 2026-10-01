/**
 * scaffold-npm10-resolve.mjs — decision logic for the #1771/#1795
 * release-prep fix to `verify-scaffold-resolves-npm10.mjs` (the #985-class
 * guard).
 *
 * THE PROBLEM (#1771): the guard renders the scaffold template with the
 * WORKSPACE version baked into the `@getknext/*` ranges (`^<version>`). On a
 * normal PR that version is already published, so npm resolves it. On a
 * release-prep PR (changeset version bump to e.g. `1.0.0-rc.4`), that exact
 * version is NOT on npm yet — it ships only once this PR merges and the
 * publish job runs — so npm's arborist throws `ETARGET` ("No matching version
 * found for @getknext/core@^1.0.0-rc.4") on every such PR, every time.
 *
 * THE DEEPER PROBLEM (#1795): the scaffold template only names `@getknext/core`
 * and `@getknext/lib` directly, but `@getknext/core` itself depends on
 * `@getknext/lib` and `@getknext/db` at the SAME unpublished workspace
 * version. #1771's fix packed only the package(s) named in the FIRST
 * `ETARGET`, so resolving `@getknext/core` against its local tarball just
 * moved the ETARGET one level down, onto `@getknext/lib`/`@getknext/db`
 * inside that tarball's own `package.json` — exactly the rc.5 failure this
 * fixes. `isReleasePrepEtarget` already classifies a TRANSITIVE `@getknext/*`
 * ETARGET (e.g. `@getknext/lib` reported because `@getknext/core`'s manifest
 * requested it, not because the scaffold template did) the same way it
 * classifies a direct one — npm's ETARGET text carries no depth information,
 * so the name+version-equality test here is depth-agnostic by construction.
 *
 * THE FIX: when EVERY `ETARGET` is for a `@getknext/*` package whose
 * requested version equals the WORKSPACE version — the exact release-prep
 * shape, at any depth — resolve the WHOLE fixed publishable group
 * (`@getknext/core`, `@getknext/lib`, `@getknext/db`, `kn-next`) against
 * locally packed tarballs (reuse `pack-publishable-group.mjs`, which applies
 * `rewrite-workspace-ranges.mjs` first, exactly as the real release does) via
 * npm `overrides` — which apply tree-wide regardless of nesting depth, so a
 * transitive `@getknext/lib` reference inside the packed `@getknext/core`
 * tarball resolves to the SAME local tarball — while every OTHER dependency
 * still resolves against the real registry under npm 10. Any OTHER `ETARGET`
 * (a genuinely missing/mistyped version, a non-`@getknext` package, or a
 * `@getknext/*` package whose requested version does NOT match the
 * workspace — e.g. someone bumped the template's range by hand without
 * bumping the workspace version) stays red, as does the `edgesOut` crash
 * this guard exists to catch and any other npm failure.
 *
 * Pure, hermetic logic only — no network, no filesystem, no process spawn.
 * The script that drives real `npm install` output through this lives in
 * `scripts/verify-scaffold-resolves-npm10.mjs`.
 */

/**
 * One `ETARGET` entry npm 10 reports in its error text:
 * `No matching version found for @getknext/core@^1.0.0-rc.4.`
 *
 * The name/range split uses the LAST `@` in the token — a scoped package name
 * starts with its own `@`, so `name` and `range` cannot be split on the
 * first one.
 *
 * @typedef {{ name: string, range: string }} EtargetEntry
 */

/**
 * Parse every `ETARGET` ("No matching version found for X@Y.") line out of
 * raw npm output. Order-preserving; duplicates are kept (the caller dedupes
 * if it cares) because a duplicate entry is itself useful diagnostic signal.
 *
 * @param {string} npmOutput combined stdout+stderr
 * @returns {EtargetEntry[]}
 */
export function parseEtargetPackages(npmOutput) {
  const out = [];
  const re = /No matching version found for (\S+)\.(?:\r?\n|\s|$)/g;
  for (const m of npmOutput.matchAll(re)) {
    const token = m[1];
    const lastAt = token.lastIndexOf('@');
    // lastAt === 0 means the token is just "@scope" with no version — not a
    // well-formed `name@range` pair, so skip it rather than guess.
    if (lastAt <= 0) continue;
    out.push({ name: token.slice(0, lastAt), range: token.slice(lastAt + 1) });
  }
  return out;
}

/**
 * Strip a leading `^`/`~` from a semver range so `^1.0.0-rc.4` and
 * `1.0.0-rc.4` compare equal to the bare workspace version. Deliberately
 * narrow: this guard's template only ever emits a caret range
 * (`"^{{ version }}"`), so no other range operator needs handling, and a
 * range this does NOT strip (e.g. `>=1.0.0`) will simply fail the equality
 * check below and fall through to "not a release-prep match" — the safe
 * default.
 *
 * @param {string} range
 * @returns {string}
 */
export function stripRangePrefix(range) {
  return range.replace(/^[\^~]/, '');
}

/**
 * Is `name` a `@getknext/*` scoped package? The unscoped `kn-next` alias
 * package is deliberately EXCLUDED — the scaffold template never depends on
 * it, so an `ETARGET` naming it could not be this release-prep case.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isGetknextScoped(name) {
  return name.startsWith('@getknext/');
}

/**
 * The release-prep shape: every `ETARGET` entry is a `@getknext/*` package
 * whose requested version (caret-stripped) equals the workspace version
 * EXACTLY. Empty input is never a match — "no ETARGET at all" is handled by
 * the caller before this is reached.
 *
 * @param {EtargetEntry[]} entries
 * @param {string} workspaceVersion
 * @returns {boolean}
 */
export function isReleasePrepEtarget(entries, workspaceVersion) {
  if (entries.length === 0) return false;
  return entries.every(
    (e) => isGetknextScoped(e.name) && stripRangePrefix(e.range) === workspaceVersion,
  );
}

/**
 * @typedef {
 *   | { kind: 'ok' }
 *   | { kind: 'edgesOut' }
 *   | { kind: 'release-prep-etarget', packages: string[] }
 *   | { kind: 'other-etarget', packages: string[] }
 *   | { kind: 'other-failure' }
 * } ResolveDecision
 */

/**
 * Classify one npm-install attempt's outcome. The ONLY branch that changes
 * behaviour (retry against local tarballs) is `release-prep-etarget`; every
 * other branch keeps today's "stays red" behaviour.
 *
 * `edgesOut` is checked BEFORE `ETARGET` parsing on purpose: it is the npm-10
 * arborist CRASH this guard exists to catch (the #985 class), and a crash can
 * print alongside incidental `ETARGET`-shaped text — that must never be
 * misread as the release-prep case.
 *
 * @param {{ exitStatus: number, output: string, workspaceVersion: string }} args
 * @returns {ResolveDecision}
 */
export function decideResolveStrategy({ exitStatus, output, workspaceVersion }) {
  if (exitStatus === 0) return { kind: 'ok' };
  if (/edgesOut/.test(output)) return { kind: 'edgesOut' };

  const entries = parseEtargetPackages(output);
  if (entries.length === 0) return { kind: 'other-failure' };

  const names = [...new Set(entries.map((e) => e.name))];
  if (isReleasePrepEtarget(entries, workspaceVersion)) {
    return { kind: 'release-prep-etarget', packages: names };
  }
  return { kind: 'other-etarget', packages: names };
}

/**
 * Build an npm `overrides` object pinning every named package to its local
 * tarball path. `overrides` apply tree-wide regardless of nesting depth —
 * the mechanism that lets a TRANSITIVE `@getknext/*` reference (e.g.
 * `@getknext/lib` pulled in by `@getknext/core`'s own `package.json`, not by
 * the scaffold template directly) resolve against the same local tarball a
 * direct dependency on that name would. A `dependencies`/`devDependencies`
 * rewrite alone cannot reach that case: it only ever touches names the
 * TOP-LEVEL `package.json` lists itself.
 *
 * @param {Map<string, string>} tarballsByName package name -> absolute tarball path
 * @returns {Record<string, string>}
 */
export function buildOverrides(tarballsByName) {
  const out = {};
  for (const [name, tarball] of tarballsByName) {
    out[name] = `file:${tarball}`;
  }
  return out;
}

/**
 * Rewrite a rendered scaffold `package.json` object so:
 *   1. every DIRECT dependency entry named in `tarballsByName` points at its
 *      local tarball instead of the registry range (unchanged from #1771);
 *   2. an `overrides` entry is added for every name in `tarballsByName`, so
 *      a TRANSITIVE reference to that name — at any depth, from any packed
 *      `@getknext/*` tarball's own `package.json` — also resolves locally
 *      instead of ETARGETing on the unpublished release-prep version (#1795).
 * Returns a NEW object (the input is never mutated); `dependencies`/
 * `devDependencies`/`overrides` are shallow-cloned as needed.
 *
 * @param {Record<string, unknown>} pkg parsed rendered package.json
 * @param {Map<string, string>} tarballsByName package name -> absolute tarball path
 * @returns {Record<string, unknown>}
 */
export function applyLocalResolutions(pkg, tarballsByName) {
  const out = { ...pkg };
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = out[field];
    if (!deps || typeof deps !== 'object') continue;
    const nextDeps = { ...deps };
    let changed = false;
    for (const [name, tarball] of tarballsByName) {
      if (name in nextDeps) {
        nextDeps[name] = `file:${tarball}`;
        changed = true;
      }
    }
    if (changed) out[field] = nextDeps;
  }
  if (tarballsByName.size > 0) {
    const existingOverrides =
      pkg.overrides && typeof pkg.overrides === 'object' ? pkg.overrides : {};
    out.overrides = { ...existingOverrides, ...buildOverrides(tarballsByName) };
  }
  return out;
}
