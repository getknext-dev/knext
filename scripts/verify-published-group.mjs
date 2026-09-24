#!/usr/bin/env node
/**
 * verify-published-group.mjs — the GUARD that keeps a broken `@getknext/*` set
 * off npm (sprint-8 T1), after two live incidents:
 *
 *   1. PARTIAL PUBLISH — `core`+`db` shipped at 0.3.1 but `lib` was skipped, so
 *      `core@0.3.1` needed `lib@^0.3.1` that did not exist → uninstallable.
 *   2. `workspace:` LEAK — `core@0.4.0`/`db@0.4.0` shipped with
 *      `@getknext/lib: workspace:^` unrewritten (npm publish ships bun's
 *      `workspace:` verbatim; see scripts/rewrite-workspace-ranges.mjs) →
 *      `EUNSUPPORTEDPROTOCOL`, uninstallable for everyone.
 *
 * TWO MODES, both fail-closed, wired into `release.yml`:
 *
 *   --pre   BEFORE the credentialed publish. Packs each publishable package
 *           with `npm pack` — the SAME tool `changeset publish` shells to for a
 *           bun workspace, so the tarball is byte-faithful to what would ship —
 *           and asserts (a) NO tarball dependency carries a `workspace:` spec,
 *           and (b) the fixed group is internally coherent (all one version,
 *           every `@getknext/*` `^`-dep satisfiable by its co-packed sibling).
 *           This reds the run before NPM_TOKEN is ever used if the rewrite fix
 *           regressed. (Packing with `bun pm pack` would HIDE the leak — bun
 *           rewrites `workspace:` — which is exactly why the old audit missed
 *           it; `npm pack` is deliberate.)
 *
 *   --post  AFTER publish. Reads the target version from the tree and asks the
 *           registry whether EVERY fixed-group member now resolves to it. A
 *           missing member (partial publish) or one stuck at the old version
 *           fails the job. Fail-closed on an unreachable registry (a reachability
 *           probe against a package that certainly exists), mirroring
 *           publish-preflight.mjs — an unanswerable question is never a pass.
 *
 *           #1364 finding 1: `--post` used to read each member with ONE
 *           `npm view`, no retry. Run 36040935670 (0.4.3) measured why that is
 *           not enough: `ensure-published-group.mjs` absorbed npm's conflict
 *           for `core`/`kn-next` (proof they were ACCEPTED) at 18:30:46, but
 *           `--post`'s single read at 18:32:39 still saw the OLD version —
 *           npm's own package `time` field shows `core@0.4.3` was not
 *           COMMITTED (durably visible) until 18:33:00, ~2.5 minutes of
 *           registry read-after-write lag. `viewVersion` is now polled with
 *           a generous, bounded budget (`POST_POLL_MAX_MS`, default ~5
 *           minutes, capped backoff) BEFORE `registryGroupProblems` judges it
 *           — this is the run's REAL confirmation; `ensure-published-group
 *           .mjs`'s own poll is deliberately brief and non-gating (it must
 *           not itself run for minutes on every release). Still fails closed:
 *           a member that never resolves within the budget is still reported
 *           missing/incoherent exactly as before.
 *
 *           #1364 round 2: the FIRST version of the poll checked `npm view
 *           <name> version` (no `@version`) and returned as soon as that
 *           came back NON-NULL. That command reports whatever the `latest`
 *           dist-tag currently resolves to — during the lag window that is
 *           the OLD version, exit 0, non-null — so the poll returned on
 *           round ONE with the stale version and the caller reported it
 *           incoherent immediately (`elapsed === 0`), reproducing the exact
 *           bug this file exists to fix. `pollViewVersion` now polls
 *           `npm view <name>@<targetVersion> version` BY EXIT CODE
 *           (`npmResolvesAtVersion`, the same shape as `ensure-published-
 *           group.mjs`'s `npmResolvesAt`) — the only read that answers "did
 *           THIS publish land", not "does the name resolve to something".
 *
 * The pure decision logic is exported and unit-tested without a network or a
 * real publish; main() supplies the process spawns.
 *
 * Usage: node scripts/verify-published-group.mjs --pre | --post
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { workspaceRoots } from './lib/workspace-globs.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_PREFIX = 'workspace:';
const SIBLING_SCOPE = '@getknext/';
const DEP_GROUPS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
/** A package that certainly exists — the registry-reachability probe. */
export const REACHABILITY_PROBE = 'npm';

/** Thrown when the registry cannot be reached, so a 404 cannot be trusted. */
export class RegistryUnreachableError extends Error {}

/** Parse `x.y.z` (an optional leading v tolerated); null when not that shape. */
export function parseSemver(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Caret satisfaction for plain `^x.y.z` ranges — npm's rule: same major (same
 * minor when major is 0, same patch when both are 0), and >= the floor.
 * Deliberately NOT a general semver engine: a workspace sibling range is always
 * a caret over a release, and any other shape must fail closed.
 */
export function caretSatisfies(range, version) {
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(String(range).trim());
  const v = parseSemver(version);
  if (!m || !v) return false;
  const floor = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
  if (v.major !== floor.major) return false;
  if (floor.major === 0 && v.minor !== floor.minor) return false;
  if (floor.major === 0 && floor.minor === 0 && v.patch !== floor.patch) return false;
  const cmp = v.major - floor.major || v.minor - floor.minor || v.patch - floor.patch;
  return cmp >= 0;
}

/**
 * Every packed manifest's dependency groups, scanned for a surviving
 * `workspace:` spec — the incident-#2 shape. Pure.
 *
 * @param {Array<Record<string, unknown>>} manifests packed package.json objects
 * @returns {string[]} one problem per surviving workspace: spec; empty is clean
 */
export function workspaceProtocolProblems(manifests) {
  const problems = [];
  for (const manifest of manifests) {
    for (const group of DEP_GROUPS) {
      const deps = manifest[group];
      if (!deps || typeof deps !== 'object') continue;
      for (const [dep, range] of Object.entries(deps)) {
        if (typeof range === 'string' && range.startsWith(WORKSPACE_PREFIX)) {
          problems.push(
            `${manifest.name}@${manifest.version} ${group} on ${dep} is '${range}' — an unrewritten ` +
              'workspace: spec would publish as EUNSUPPORTEDPROTOCOL (incident #2). The publish must ' +
              'rewrite it to a concrete range (scripts/rewrite-workspace-ranges.mjs).',
          );
        }
      }
    }
  }
  return problems;
}

/**
 * The fixed group (`@getknext/{core,lib,db}` + `kn-next`) must ship as one
 * coherent set: every member present, all at the same version, and every
 * sibling `^`-dep satisfiable by its co-packed sibling. Pure.
 *
 * @param {Array<{name: string, version: string} & Record<string, unknown>>} manifests
 * @param {string[]} fixedGroup the changesets `fixed` group member names
 * @returns {string[]} problems; empty means coherent
 */
export function fixedGroupProblems(manifests, fixedGroup) {
  const problems = [];
  const byName = new Map(manifests.map((m) => [m.name, m]));

  // (1) every fixed-group member is present in the packed set.
  for (const name of fixedGroup) {
    if (!byName.has(name)) {
      problems.push(
        `fixed-group member ${name} is missing from the packed set — the #255/#256 partial-publish ` +
          'shape: consumers 404 on the missing member',
      );
    }
  }

  // (2) all present members carry the same version (a fixed group moves together).
  const versions = [...new Set(fixedGroup.map((n) => byName.get(n)?.version).filter(Boolean))];
  if (versions.length > 1) {
    problems.push(
      `fixed-group members are at DIFFERENT versions (${versions.sort().join(', ')}) — a fixed group ` +
        'must publish at a single version',
    );
  }

  // (3) every sibling ^-dep is satisfiable by the co-packed sibling.
  for (const manifest of manifests) {
    for (const group of DEP_GROUPS) {
      const deps = manifest[group];
      if (!deps || typeof deps !== 'object') continue;
      for (const [dep, range] of Object.entries(deps)) {
        if (!dep.startsWith(SIBLING_SCOPE) && !fixedGroup.includes(dep)) continue;
        const sibling = byName.get(dep);
        if (!sibling) continue; // presence already reported in (1)
        if (!/^\^\d+\.\d+\.\d+$/.test(String(range).trim())) {
          problems.push(
            `${manifest.name}@${manifest.version} ${group} on ${dep} has range '${range}', which this ` +
              'gate cannot vouch for (expected ^x.y.z) — a surviving workspace: spec or unexpected shape',
          );
          continue;
        }
        if (!caretSatisfies(range, sibling.version)) {
          problems.push(
            `${manifest.name}@${manifest.version} declares ${dep}@'${range}' but the co-packed ${dep} ` +
              `is ${sibling.version} — consumers would resolve a REGISTRY copy of a different release`,
          );
        }
      }
    }
  }
  return problems;
}

/** Total poll budget for a single member's `--post` read (#1364 finding 1): ~5 minutes. */
export const POST_POLL_MAX_MS = 5 * 60 * 1000;

/**
 * `runPost`'s actual poll budget: `POST_POLL_MAX_MS`, overridable ONLY by
 * `VERIFY_POST_POLL_MAX_MS` — a test-only knob (#1364 round 3). Its purpose is
 * narrow: let a PROCESS-LEVEL `--post` test (a fake npm on PATH, driving the
 * real `runPost()` wiring end-to-end, not just `pollViewVersion` in
 * isolation) fail FAST on a target version that never resolves, instead of
 * the real ~5-minute budget. Production never sets this var, so the default
 * is unchanged. See `tests/verify-published-group-post-e2e.test.ts`.
 */
function postPollMaxMs() {
  const raw = process.env.VERIFY_POST_POLL_MAX_MS;
  if (raw === undefined) return POST_POLL_MAX_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : POST_POLL_MAX_MS;
}

/** Capped exponential backoff for the `--post` poll — slower-growing than a quick retry, deliberately. */
export function defaultPostPollBackoffMs(attempt) {
  return Math.min(15_000, 2_000 * 2 ** attempt);
}

/**
 * Poll `resolvesAtTarget(name)` — TRUE iff the registry resolves `name` AT
 * THE SPECIFIC TARGET VERSION (an `npm view <name>@<version> version`
 * exit-code check, like `ensure-published-group.mjs`'s `npmResolvesAt`) —
 * until it is TRUE or the total elapsed time exceeds `maxTotalMs`. Pure —
 * `resolvesAtTarget` and `sleep` are injected, no network here.
 *
 * #1364 round 2: the FIRST version of this function polled `npm view <name>
 * version` (no `@version`) and returned on ANY non-null result. That command
 * reports whatever the `latest` dist-tag currently resolves to — during
 * read-after-write lag that is the OLD version, exit 0, non-null — so the
 * poll returned on round ONE with the STALE version and the caller reported
 * it incoherent immediately, `elapsed === 0`, reproducing the exact original
 * bug this whole file exists to fix. Checking the SPECIFIC target version's
 * existence (exit-code, not printed text) is the only read that actually
 * answers "did THIS publish land" rather than "does the name resolve to
 * something".
 *
 * `--post` has no retry of its own otherwise: a single racy read after
 * `changeset publish` measured ~2.5 minutes of registry read-after-write lag
 * in production (#1364, run 36040935670) — long enough that
 * `ensure-published-group.mjs`'s own brief, non-gating confirmation poll
 * cannot cover it (that poll must stay short; it runs on EVERY release, not
 * just the rare slow one). This is the run's real, bounded confirmation.
 *
 * @param {{
 *   name: string,
 *   resolvesAtTarget: (name: string) => boolean,
 *   sleep: (ms: number) => Promise<void>,
 *   maxTotalMs?: number,
 *   backoffMs?: (attempt: number) => number,
 *   now?: () => number,
 * }} input
 * @returns {Promise<boolean>} TRUE once the target version is seen, FALSE if the budget ran out
 */
export async function pollViewVersion({
  name,
  resolvesAtTarget,
  sleep,
  maxTotalMs = POST_POLL_MAX_MS,
  backoffMs = defaultPostPollBackoffMs,
  now = Date.now,
}) {
  const start = now();
  for (let attempt = 0; ; attempt++) {
    if (resolvesAtTarget(name)) return true;
    const elapsed = now() - start;
    if (elapsed >= maxTotalMs) return false;
    await sleep(Math.min(backoffMs(attempt), maxTotalMs - elapsed));
  }
}

/**
 * Post-publish: every fixed-group member must resolve, on the registry, to the
 * target version just published. Pure — the registry read is injected.
 *
 * THROWS `RegistryUnreachableError` when the reachability probe fails: an
 * unreachable registry must fail the job, never read as "all coherent".
 *
 * @param {{members: string[], targetVersion: string, probeOk: boolean,
 *   viewVersion: (name: string) => string | null}} input
 * @returns {string[]} problems; empty means the whole group landed at target
 */
export function registryGroupProblems({ members, targetVersion, probeOk, viewVersion }) {
  if (!probeOk) {
    throw new RegistryUnreachableError(
      `cannot reach the registry — refusing to report the published group coherent from an ` +
        'unreachable registry',
    );
  }
  const problems = [];
  for (const name of members) {
    const version = viewVersion(name);
    if (version === null) {
      problems.push(
        `${name} is NOT on the registry at any version — the group did not all publish (incident #1, ` +
          'partial publish)',
      );
      continue;
    }
    if (version !== targetVersion) {
      problems.push(
        `${name} resolves to ${version} on the registry, not the target ${targetVersion} — the group ` +
          'did not all land at one version',
      );
    }
  }
  return problems;
}

// ── process wiring ─────────────────────────────────────────────────────────

/** Read every workspace manifest as `{ dir, pkg }`. */
function readWorkspace() {
  const manifests = [];
  for (const root of workspaceRoots()) {
    const base = join(REPO_ROOT, root);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(base, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof pkg.name !== 'string') continue;
      manifests.push({ dir: join(base, entry.name), pkg });
    }
  }
  return manifests;
}

function readChangesetConfig() {
  return JSON.parse(readFileSync(join(REPO_ROOT, '.changeset/config.json'), 'utf8'));
}

function publishableDirs() {
  const config = readChangesetConfig();
  const ignored = new Set(Array.isArray(config.ignore) ? config.ignore : []);
  return readWorkspace().filter(
    (w) => w.pkg.private !== true && !ignored.has(w.pkg.name) && typeof w.pkg.version === 'string',
  );
}

/**
 * Per-call timeout for every `npm view` spawn below (#1364 round 3, optional
 * ask). `spawnSync`'s own `timeout` sends SIGTERM and sets `run.error`
 * (ETIMEDOUT) — already the same "not ok" path each caller already takes for
 * any other spawn error, so a hung npm process degrades exactly like a 404
 * rather than stalling the whole `--post` job (which otherwise has no other
 * bound on a single call within `pollViewVersion`'s own multi-minute budget).
 */
const NPM_SPAWN_TIMEOUT_MS = 30_000;

/**
 * `npm view <name> version` → the version string, or null when npm exits
 * non-zero. Exported so a test can drive the real spawnSync + exit-code
 * boundary against a fake `npm` on PATH (mirrors `ensure-published-group.mjs`'s
 * `npmResolvesAt`).
 */
export function npmViewVersion(name, registry) {
  const run = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['view', name, 'version', '--registry', registry],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: NPM_SPAWN_TIMEOUT_MS },
  );
  if (run.error || run.status !== 0) return null;
  return run.stdout.trim();
}

/**
 * `npm view <name>@<version> version` — TRUE iff npm exited 0 (branch on exit
 * code, never the printed text — mirrors `ensure-published-group.mjs`'s
 * `npmResolvesAt`). #1364 round 2: this is the read `pollViewVersion` polls,
 * because a bare `npm view <name> version` reports the `latest` dist-tag
 * regardless of whether THIS run's target version is what it points at.
 */
export function npmResolvesAtVersion(name, version, registry) {
  const run = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['view', `${name}@${version}`, 'version', '--registry', registry],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NPM_SPAWN_TIMEOUT_MS,
    },
  );
  return !run.error && run.status === 0;
}

export function npmProbe(registry) {
  const run = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['view', REACHABILITY_PROBE, 'version', '--registry', registry],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: NPM_SPAWN_TIMEOUT_MS },
  );
  return !run.error && run.status === 0;
}

function die(message) {
  console.error(`\n[verify-published-group] FAIL: ${message}`);
  process.exit(1);
}

function runPre() {
  const publishable = publishableDirs();
  if (publishable.length === 0) {
    die('no publishable packages found — this gate would pass vacuously');
  }
  const workDir = mkdtempSync(join(tmpdir(), 'knext-verify-group-'));
  const manifests = [];
  try {
    console.log(
      '[verify-published-group] packing the publishable set with `npm pack` (the publish tool)…',
    );
    for (const { dir } of publishable) {
      // `npm pack` reproduces exactly what `changeset publish` -> `npm publish`
      // would ship for a bun workspace: it does NOT rewrite workspace: ranges.
      execFileSync('npm', ['pack', '--pack-destination', workDir, '--ignore-scripts'], {
        cwd: dir,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
    }
    for (const file of readdirSync(workDir)) {
      if (!file.endsWith('.tgz')) continue;
      const out = spawnSync('tar', ['-xzOf', join(workDir, file), 'package/package.json'], {
        encoding: 'utf8',
      });
      if (out.status !== 0 || !out.stdout) {
        die(
          `could not read package/package.json from ${file}: ${out.stderr || `exit ${out.status}`}`,
        );
      }
      manifests.push(JSON.parse(out.stdout));
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  if (manifests.length !== publishable.length) {
    die(`expected ${publishable.length} tarballs, packed ${manifests.length}`);
  }

  const fixedGroup = readChangesetConfig().fixed?.[0] ?? [];
  const problems = [
    ...workspaceProtocolProblems(manifests),
    ...fixedGroupProblems(manifests, fixedGroup),
  ];
  if (problems.length > 0) {
    die(
      `the set about to publish is NOT safe — refusing before the credentialed publish:\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log(
    '\n[verify-published-group] PASS (pre): no workspace: specs and the fixed group is coherent.',
  );
}

async function runPost() {
  const registry = process.env.PUBLISH_PREFLIGHT_REGISTRY || DEFAULT_REGISTRY;
  const config = readChangesetConfig();
  const fixedGroup = config.fixed?.[0] ?? [];
  if (fixedGroup.length === 0) die('no fixed group in .changeset/config.json to verify');

  // The target version: the fixed group is one version by construction; read it
  // from any member in the tree.
  const byName = new Map(readWorkspace().map((w) => [w.pkg.name, w.pkg.version]));
  const targetVersion = byName.get(fixedGroup[0]);
  if (typeof targetVersion !== 'string')
    die(`could not read a target version for ${fixedGroup[0]}`);

  // #1364 finding 1: probe reachability ONCE, up front, exactly as before — an
  // unreachable registry must fail immediately, not after minutes of polling
  // members that could never have answered. Only when reachable do we spend
  // the (potentially minutes-long) per-member poll budget.
  const probeOk = npmProbe(registry);
  const resolved = new Map();
  if (probeOk) {
    for (const name of fixedGroup) {
      const hitTarget = await pollViewVersion({
        name,
        resolvesAtTarget: (n) => npmResolvesAtVersion(n, targetVersion, registry),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        maxTotalMs: postPollMaxMs(),
      });
      // Once confirmed at the target, no need for a second read. Otherwise a
      // SINGLE best-effort plain `npm view <name> version` names whatever it
      // currently resolves to (or null) — purely for `registryGroupProblems`'s
      // diagnostic message; it never re-litigates the poll's own verdict.
      resolved.set(name, hitTarget ? targetVersion : npmViewVersion(name, registry));
    }
  }

  let problems;
  try {
    problems = registryGroupProblems({
      members: fixedGroup,
      targetVersion,
      probeOk,
      viewVersion: (name) => resolved.get(name) ?? null,
    });
  } catch (err) {
    if (!(err instanceof RegistryUnreachableError)) throw err;
    die(`${registry}: ${err.message}`);
  }
  if (problems.length > 0) {
    die(
      `the published group at ${targetVersion} is INCOHERENT on the registry:\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log(
    `\n[verify-published-group] PASS (post): every fixed-group member resolves to ${targetVersion}.`,
  );
}

async function main() {
  const mode = process.argv[2];
  if (mode === '--pre') return runPre();
  if (mode === '--post') return await runPost();
  die('usage: verify-published-group.mjs --pre | --post');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
