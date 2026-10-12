#!/usr/bin/env node
/**
 * The publish-lane guard (#2035, v2 task R0).
 *
 * `release.yml` used to accept a `workflow_dispatch` from ANY ref, and the
 * `npm-publish` environment has no branch policy. Meanwhile 242 remote branches
 * — `integration/v1-coldstart` among them — still carry the changeset marker
 * (`.changeset/pre/v1-0-0-release-candidate.md`, `"@getknext/core": major`) that
 * once computed 2.0.0 by accident. A dispatch from any of them was one click from
 * publishing a major nobody meant to cut.
 *
 * This script answers two questions, fail-closed, before any job in
 * `release.yml` can touch the npm token:
 *
 *   `ref`   — is `github.ref` a publish lane? An EXACT allowlist, compared by
 *             string equality on the FULL ref (a tag named `main` has
 *             `ref_name == "main"`; its full ref is `refs/tags/main`). No globs:
 *             `integration/v*` admits `integration/v1-coldstart`.
 *   `major` — does the version changesets would publish carry the lane's
 *             expected major? Run AFTER `changeset version` in the runner, so it
 *             sees what a Version PR would contain on a changesets run and what
 *             `changeset publish` would ship on a publish run.
 *
 * What it does NOT cover, stated so nobody reads more into it. The CURRENT
 * exposure is wider than stale dispatches:
 *   - a `workflow_dispatch` runs the workflow file AT THE DISPATCHED REF, so a
 *     stale branch, `integration/v1.3` or a cut taken from it runs its own older,
 *     unguarded `release.yml`;
 *   - the `npm-publish` environment has NO deployment-branch policy today
 *     (null), so ANY same-repo pull-request workflow that declares
 *     `environment: npm-publish` gets NPM_TOKEN on `refs/pull/N/merge`;
 *   - an environment branch policy matches by branch NAME only, so a lane name
 *     that does not exist yet (`release/1.x`) can be created by anyone with push
 *     at a stale marker SHA and dispatched.
 * This guard protects every ref cut from guarded `main`; closing the rest takes
 * repository settings (interim `main`-only policy, a ruleset over the lane
 * names, lane names added to the policy only once they exist), not code.
 *
 * Usage:
 *   node scripts/publish-lane-guard.mjs ref   --ref <full ref>
 *   node scripts/publish-lane-guard.mjs major --ref <full ref> [--root <repo root>]
 *
 * Exit 0 = admitted. Exit 1 = refused (the workflow fails closed on it).
 * Exit 2 = usage error (also non-zero, so also fails closed).
 *
 * Node builtins only: the `ref` step runs before `bun install`
 * (`tests/workflow-script-install-guard.test.ts` scans for that).
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkspaceManifests } from './publish-preflight.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * THE LANE MAP — the one place a publish lane and its expected major live.
 *
 * Keys are FULL refs, matched by string equality. Adding a lane is a reviewed
 * edit to this map (and to the pin in `tests/publish-lane-guard.test.ts`).
 *
 * R4 (v2 plan) flips `refs/heads/main` from 1 to 2 at 2.0 GA, BEFORE the first
 * 2.x publish from `main`. Nothing else needs to change for that flip.
 */
export const PUBLISH_LANES = new Map([
  ['refs/heads/main', 1],
  ['refs/heads/integration/v1.3', 1],
  ['refs/heads/integration/v1.4', 1],
  ['refs/heads/integration/v2', 2],
]);

/**
 * PREPARED LANES (#2040, v2 task R4p) — lanes the guards RECOGNISE (major +
 * stable dist-tag) but that are deliberately NOT on the publish allowlist.
 *
 * `release/1.x` is the 1.x maintenance lane (ADR-0063 Amendment): cut from
 * the 1.x tip at 2.0 GA, security fixes only, stable dist-tag `latest-1`. It
 * is prepared here and kept OFF `PUBLISH_LANES` because the `npm-publish`
 * environment still has no deployment-branch policy, and a branch-NAME policy
 * admits whatever is pushed under that name — a lane that does not exist yet
 * could be created at a stale marker SHA and dispatched.
 *
 * R4 (the full task) makes it publishable by MOVING its entry from this map to
 * `PUBLISH_LANES` in one reviewed edit; `tests/publish-lane-guard-prepared.test.ts`
 * goes red on purpose the moment the two maps overlap or the entry vanishes.
 * TODO(#2040): R4 — move to PUBLISH_LANES, route `--tag latest-1` in release.yml,
 * add the name to the environment policy once the branch exists.
 *
 * `distTag` is the tag a STABLE publish from the lane carries. It must never
 * be `latest`: a 1.x security patch landing there would regress newest-stable.
 */
export const PREPARED_LANES = new Map([
  ['refs/heads/release/1.x', { major: 1, distTag: 'latest-1' }],
]);

/**
 * Release CUT branches: the 1.3 procedure publishes by cutting
 * `release/vX.Y.Z` or `release/vX.Y.Z-rc.N` at the merge SHA on the lane and
 * dispatching `release.yml` from it (1.3.0 shipped from `release/v1.3.0`,
 * rc.2–rc.10 from `release/v1.3.0-rc.N`). Anchored at both ends, canonical
 * semver numbers only, `-rc.N` the only prerelease form: the look-alikes on
 * origin today (`release/v1.3-prepare-rc.2`, `release/v1.3-dist-tag-next`,
 * `release/prepare-v1.3.0`) do not match.
 *
 * A cut's name DECLARES its version: the major check requires the computed
 * version to equal it exactly, not just share its major.
 */
export const RELEASE_CUT_REF =
  /^refs\/heads\/release\/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.(0|[1-9][0-9]*))?$/;

/**
 * Majors a release cut may publish. Only the 1.x line publishes through cuts
 * today; the 2.0 plan publishes its rcs from `integration/v2` itself. If the 2.x
 * line adopts cuts, adding 2 here is the reviewed edit that opens it.
 */
export const RELEASE_CUT_MAJORS = Object.freeze([1]);

const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * @param {string} version
 * @returns {{major: number, minor: number, patch: number, prerelease: string | null} | null}
 */
export function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const m = SEMVER.exec(version);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

/**
 * @typedef {{ok: true, ref: string, kind: 'lane' | 'cut' | 'prepared', expectedMajor: number, expectedVersion: string | null}} Lane
 * @typedef {{ok: false, ref: string, reason: string}} Refusal
 */

/**
 * @param {string} ref the FULL ref (`github.ref`)
 * @returns {Lane | Refusal}
 */
export function resolveLane(ref) {
  if (typeof ref !== 'string' || ref === '') {
    return { ok: false, ref: String(ref), reason: 'no ref was given' };
  }
  const expectedMajor = PUBLISH_LANES.get(ref);
  if (expectedMajor !== undefined) {
    return { ok: true, ref, kind: 'lane', expectedMajor, expectedVersion: null };
  }
  if (PREPARED_LANES.has(ref)) {
    return {
      ok: false,
      ref,
      reason:
        'a prepared lane that is not yet publishable (it is recognised but not on the publish allowlist; see PREPARED_LANES)',
    };
  }
  const cut = RELEASE_CUT_REF.exec(ref);
  if (cut) {
    const major = Number(cut[1]);
    if (!RELEASE_CUT_MAJORS.includes(major)) {
      return {
        ok: false,
        ref,
        reason: `release cuts for major ${major} are not open (open: ${RELEASE_CUT_MAJORS.join(', ')})`,
      };
    }
    return {
      ok: true,
      ref,
      kind: 'cut',
      expectedMajor: major,
      expectedVersion: ref.slice('refs/heads/release/v'.length),
    };
  }
  return {
    ok: false,
    ref,
    reason: 'not a publish lane (exact allowlist) and not a release/vX.Y.Z[-rc.N] cut',
  };
}

/**
 * Recognise a ref as ANY lane the guards know — live, release cut or prepared —
 * without admitting it. Unlike `resolveLane`, a prepared lane comes back `ok`
 * with `publishable: false`, so lane-aware checks (the major check) can apply
 * to `release/1.x` before it may publish. Anything unreadable or unknown is
 * `null`, never a default lane.
 *
 * @param {string} ref the FULL ref
 * @returns {{ok: true, ref: string, kind: 'lane' | 'cut' | 'prepared', expectedMajor: number, expectedVersion: string | null, distTag: string | null, publishable: boolean} | null}
 */
export function recognisedLane(ref) {
  if (typeof ref !== 'string') return null;
  const prepared = PREPARED_LANES.get(ref);
  if (prepared !== undefined) {
    return {
      ok: true,
      ref,
      kind: 'prepared',
      expectedMajor: prepared.major,
      expectedVersion: null,
      distTag: prepared.distTag,
      publishable: false,
    };
  }
  const lane = resolveLane(ref);
  return lane.ok ? { ...lane, distTag: null, publishable: true } : null;
}

/**
 * The stable dist-tag a prepared lane publishes under, or null for any other
 * (or unreadable) ref.
 *
 * @param {string} ref the FULL ref
 * @returns {string | null}
 */
export function preparedDistTag(ref) {
  if (typeof ref !== 'string') return null;
  return PREPARED_LANES.get(ref)?.distTag ?? null;
}

/**
 * Every member of every `fixed` group in `.changeset/config.json`, read from the
 * config rather than re-listed, so a package that joins or leaves the group is
 * checked the moment it does. Throws on a config with no usable fixed group —
 * an empty group would make the major check pass by checking nothing.
 *
 * @param {unknown} config
 * @returns {string[]}
 */
export function fixedGroupNames(config) {
  const fixed = /** @type {{fixed?: unknown}} */ (config ?? {}).fixed;
  if (!Array.isArray(fixed) || fixed.length === 0) {
    throw new Error('.changeset/config.json has no `fixed` group');
  }
  /** @type {string[]} */
  const names = [];
  for (const group of fixed) {
    if (!Array.isArray(group) || group.length === 0) {
      throw new Error('.changeset/config.json has an empty or malformed `fixed` group');
    }
    for (const name of group) {
      if (typeof name !== 'string' || name === '') {
        throw new Error(
          `.changeset/config.json \`fixed\` holds a non-name: ${JSON.stringify(name)}`,
        );
      }
      names.push(name);
    }
  }
  return names;
}

/**
 * The pure major check.
 *
 * @param {{lane: Lane, packages: Array<{name: string, version: string}>, fixedNames: string[]}} input
 * @returns {{ok: boolean, rows: Array<{name: string, version: string, major: number | null}>, problems: string[]}}
 */
export function checkLaneMajor({ lane, packages, fixedNames }) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Array<{name: string, version: string, major: number | null}>} */
  const rows = [];
  if (fixedNames.length === 0) {
    problems.push(
      'the fixed group is empty, so there is nothing to check (refusing a vacuous pass)',
    );
  }
  const byName = new Map(packages.map((p) => [p.name, p]));
  for (const name of fixedNames) {
    const pkg = byName.get(name);
    if (!pkg) {
      problems.push(`${name}: in the fixed group but no workspace manifest declares it`);
      continue;
    }
    const parsed = parseSemver(pkg.version);
    rows.push({ name, version: pkg.version, major: parsed?.major ?? null });
    if (!parsed) {
      problems.push(`${name}: version ${JSON.stringify(pkg.version)} is not semver`);
      continue;
    }
    if (parsed.major !== lane.expectedMajor) {
      problems.push(
        `${name}: would publish ${pkg.version} (major ${parsed.major}) but ${lane.ref} publishes major ${lane.expectedMajor}`,
      );
      continue;
    }
    if (lane.expectedVersion !== null && pkg.version !== lane.expectedVersion) {
      problems.push(
        `${name}: would publish ${pkg.version} but the release cut ${lane.ref} declares ${lane.expectedVersion}`,
      );
    }
  }
  return { ok: problems.length === 0, rows, problems };
}

function summarise(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${lines.join('\n')}\n`);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const [mode, ...rest] = argv;
  /** @type {{mode: string | undefined, ref: string | undefined, root: string}} */
  const args = { mode, ref: undefined, root: REPO_ROOT };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === '--ref' && value !== undefined) {
      args.ref = value;
      i += 1;
    } else if (flag === '--root' && value !== undefined) {
      args.root = resolve(value);
      i += 1;
    } else {
      throw new UsageError(`unknown or incomplete argument: ${flag}`);
    }
  }
  return args;
}

class UsageError extends Error {}

function refuse(message) {
  console.error(`::error title=Publish-lane guard refused this run::${message}`);
  summarise(['### Publish-lane guard: REFUSED', '', message]);
  return 1;
}

/** @param {string[]} argv */
export function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`[publish-lane-guard] ${err.message}`);
    return 2;
  }
  if (args.mode !== 'ref' && args.mode !== 'major') {
    console.error('usage: publish-lane-guard.mjs <ref|major> --ref <full ref> [--root <dir>]');
    return 2;
  }

  const lane = resolveLane(args.ref ?? '');
  if (!lane.ok) {
    return refuse(
      `${JSON.stringify(lane.ref)} may not run the release workflow: ${lane.reason}. Publish lanes: ${[...PUBLISH_LANES.keys()].join(', ')}; release cuts: release/vX.Y.Z[-rc.N] for major ${RELEASE_CUT_MAJORS.join(', ')}.`,
    );
  }

  if (args.mode === 'ref') {
    const declared = lane.expectedVersion === null ? '' : `, version ${lane.expectedVersion}`;
    console.log(
      `[publish-lane-guard] ${lane.ref} is a publish ${lane.kind} (major ${lane.expectedMajor}${declared}).`,
    );
    summarise([
      `Publish-lane guard: \`${lane.ref}\` admitted as a ${lane.kind}, major ${lane.expectedMajor}${declared}.`,
    ]);
    return 0;
  }

  let fixedNames;
  try {
    const config = JSON.parse(readFileSync(resolve(args.root, '.changeset/config.json'), 'utf8'));
    fixedNames = fixedGroupNames(config);
  } catch (err) {
    return refuse(`cannot read the changesets fixed group: ${err.message}`);
  }
  const result = checkLaneMajor({
    lane,
    packages: readWorkspaceManifests(args.root),
    fixedNames,
  });
  for (const row of result.rows) {
    console.log(`[publish-lane-guard] ${row.name} ${row.version} (major ${row.major ?? '?'})`);
  }
  if (!result.ok) {
    return refuse(
      `the version changesets would publish does not match ${lane.ref}:\n${result.problems.join('\n')}`,
    );
  }
  summarise([
    `Publish-lane guard: every fixed-group package carries major ${lane.expectedMajor} for \`${lane.ref}\`.`,
  ]);
  return 0;
}

// Only run when invoked directly, so the spec can import the pure helpers.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
