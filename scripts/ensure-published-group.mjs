#!/usr/bin/env node
/**
 * ensure-published-group.mjs — the SELF-HEAL step for a PARTIAL publish
 * (sprint-8). Runs in `release.yml` AFTER `changeset publish` and BEFORE the
 * `verify-published-group.mjs --post` fail-closed assertion.
 *
 * WHY THIS EXISTS (twice-observed, transient)
 * -------------------------------------------
 * `bun run release` = `changeset publish`. For a bun workspace changesets shells
 * to per-package `npm publish` (getPublishTool: bun ∉ {npm,pnpm,yarn} → npm), and
 * a single per-package failure or registry read-after-write lag can leave a
 * SUBSET published. TWICE the `@getknext/*` fixed group went out partial —
 * `@getknext/core` + the `kn-next` alias landed at the target version but
 * `@getknext/lib`/`@getknext/db` did NOT — leaving `npm install @getknext/core`
 * broken (ETARGET on an unresolvable sibling). The `--post` guard DETECTS that
 * but cannot PREVENT it: `core` is already published and npm versions are
 * immutable. Both times a manual RE-RUN published the missing members and the
 * group became coherent — so the partial is transient/per-package, not a
 * systematic block (the token + config are fine).
 *
 * WHAT THIS DOES
 * --------------
 * Recover the partial WITHIN the run so it can never leave a broken `@latest`.
 * For every fixed-group member NOT yet resolvable on the registry at the target
 * version, publish JUST that member's already-built + workspace-rewritten
 * tarball (the same package dir `changeset publish` published, so its manifest
 * already carries `^<version>` sibling ranges from
 * scripts/rewrite-workspace-ranges.mjs — never a `workspace:` spec), with
 * bounded retries + backoff for read-after-write lag.
 *
 * HEAL NEVER *DELIBERATELY* RE-PUBLISHES an existing version. But it can race
 * read-after-write lag: a member the UPSTREAM `changeset publish` step already
 * shipped may still be registry-invisible at round 0, so heal — which cannot
 * tell "never published" from "published-but-not-yet-visible" — will attempt a
 * publish and npm answers with a conflict — 403 "cannot publish over the
 * previously published versions" OR 409 "Cannot publish over previously staged
 * version" (both observed live, #1360) — that is POSITIVE PROOF the member is
 * on the registry: it is ABSORBED as proof-of-publication (marked published,
 * never a failure, never a retry) and, per #1360, is TERMINAL — once absorbed,
 * a member is never re-submitted to the "still missing" registry read again for
 * the rest of THIS run, no matter how long read-after-write lag takes to clear.
 *
 * #1360 (the bug this closes): the group of four went out, but `core`/`kn-next`
 * lagged worse than `lib`/`db` at round 0. All four were correctly absorbed via
 * the 409, but the OLD final check re-ran `npm view` on every member regardless
 * of absorption, and `core`/`kn-next`'s lag outlasted the whole bounded-retry
 * budget (~90s) — so a run that had, in fact, fully and correctly published
 * ended red. A conflict this specific ("cannot publish over" / "previously
 * published/staged version") cannot be caused by anything OTHER than the
 * version already existing — npm will not say it for auth/network/quota errors
 * — so trusting it as terminal, rather than re-litigating it against a possibly
 * still-lagging read, is the fix. A conflict for ANY OTHER reason (auth/
 * forbidden) is a real error and still fails closed, still retried every round.
 * A member already resolvable at the target is skipped outright. If the group is
 * still incoherent after the bounded retries, it FAILS CLOSED (exit 1), and
 * `verify-published-group.mjs --post` remains the final assertion after it —
 * that guard has no retry of its own, so `ensureGroupPublished` spends a
 * best-effort, NON-gating confirmation poll on every absorbed member before
 * returning (see `pollResolves`), giving the registry more time to catch up
 * before `--post` runs, without making success depend on it.
 *
 * The "still missing" read itself is ALSO polled (`pollResolves`, a few quick
 * attempts with short backoff) before a member is even offered to `publish()` —
 * a single racy read reported the just-shipped, not-yet-visible member as
 * missing in the first place, which is what triggered the whole conflict/
 * absorb dance every round; retrying briefly first cuts that down.
 *
 * FAIL-CLOSED ON AN UNREACHABLE REGISTRY, mirroring publish-preflight.mjs and
 * verify-published-group.mjs: an unanswerable "is it published?" is never read
 * as "coherent". The reachability probe hits a package that certainly exists.
 *
 * The pure retry logic is exported and unit-tested with an INJECTED resolver +
 * publish spawn (no network, no real publish); main() supplies the process
 * spawns. Every verdict is a return value or a thrown error the CLI maps to an
 * EXIT CODE — nothing reads command output.
 *
 * Usage: node scripts/ensure-published-group.mjs
 * Env:   PUBLISH_PREFLIGHT_REGISTRY (default https://registry.npmjs.org/),
 *        NODE_AUTH_TOKEN (npm auth for the re-publish)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { workspaceRoots } from './lib/workspace-globs.mjs';
import {
  DEFAULT_REGISTRY,
  REACHABILITY_PROBE,
  RegistryUnreachableError,
} from './verify-published-group.mjs';

export { RegistryUnreachableError, DEFAULT_REGISTRY };

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Bounded retry budget for read-after-write lag / a transient per-package fail. */
export const DEFAULT_MAX_ATTEMPTS = 6;

/** Exponential backoff, capped — deterministic so main() and tests agree. */
export function defaultBackoffMs(attempt) {
  return Math.min(30_000, 2_000 * 2 ** attempt);
}

/** Thrown when the group is STILL incoherent after the bounded retries. */
export class GroupStillIncoherentError extends Error {}

/**
 * TRUE iff a FAILED publish was rejected because the version already exists —
 * npm's immutable-version conflict, observed as BOTH a 403 (message "cannot
 * publish over the previously published versions") and a 409 (message "Cannot
 * publish over previously staged version", #1360 — a real production run hit
 * this exact wording). Either rejection is positive proof the member IS on the
 * registry (read-after-write lag from the upstream publish step), so heal
 * absorbs it as published rather than a failure. ANY OTHER 403/409
 * (auth/forbidden/network) returns FALSE and stays a real, fail-closed error —
 * npm does not use "cannot publish over" / "previously published or staged
 * version" / `EPUBLISHCONFLICT` for those.
 */
export function isAlreadyPublishedConflict(result) {
  if (!result || result.ok) return false;
  const text = String(result.stderr ?? result.message ?? '').toLowerCase();
  return (
    text.includes('cannot publish over') ||
    text.includes('previously published version') ||
    text.includes('previously staged version') ||
    text.includes('epublishconflict')
  );
}

/** Bounded, quick retry budget for a single registry read (not a whole round). */
export const DEFAULT_RESOLVE_POLL_ATTEMPTS = 3;

/** Short linear backoff for the inner resolve poll — distinct from the outer round backoff. */
export function defaultResolvePollBackoffMs(attempt) {
  return Math.min(5_000, 1_000 * (attempt + 1));
}

/**
 * Poll `resolves(name, version)` with bounded retries + backoff, returning
 * TRUE as soon as it resolves. Used in two places (#1360):
 *   - BEFORE deciding a member is "missing" — a single racy `npm view` can
 *     report a just-shipped, not-yet-visible member as missing, which is what
 *     drives the unnecessary publish → benign-conflict churn in the first
 *     place;
 *   - AFTER absorbing an already-published conflict — a best-effort,
 *     NON-GATING confirmation that spends real time letting the registry catch
 *     up before this step exits, since `verify-published-group.mjs --post`
 *     (which runs right after) has no retry of its own.
 * Pure — `resolves` and `sleep` are injected, matching `ensureGroupPublished`.
 *
 * @param {{
 *   resolves: (name: string, version: string) => boolean,
 *   sleep: (ms: number) => Promise<void>,
 *   name: string,
 *   version: string,
 *   maxAttempts?: number,
 *   backoffMs?: (attempt: number) => number,
 * }} input
 */
export async function pollResolves({
  resolves,
  sleep,
  name,
  version,
  maxAttempts = DEFAULT_RESOLVE_POLL_ATTEMPTS,
  backoffMs = defaultResolvePollBackoffMs,
}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (resolves(name, version)) return true;
    if (attempt < maxAttempts - 1) await sleep(backoffMs(attempt));
  }
  return false;
}

/**
 * Re-publish every fixed-group member missing at the target version until the
 * whole group resolves, or fail closed. Pure — the registry reads, the publish
 * spawn and the sleep are all injected.
 *
 * Contract:
 *   - THROWS `RegistryUnreachableError` if the probe fails at any check — an
 *     unreachable registry never certifies coherence.
 *   - Publishes a member AT MOST ONCE per run: once we have published it (or
 *     absorbed npm's already-published conflict for it), it is TERMINAL — never
 *     submitted to a "still missing" registry read again this run, no matter
 *     how long read-after-write lag takes to clear (#1360 — the OLD behaviour
 *     re-checked every member's resolution unconditionally on the final read,
 *     so a member that was genuinely and correctly absorbed could still fail
 *     the run if its OWN lag happened to outlast every other member's).
 *   - Absorbs an already-published 403/409 (see `isAlreadyPublishedConflict`)
 *     as proof-of-publication: heal never DELIBERATELY re-publishes, but a
 *     member the upstream publish step shipped can still lag at round 0, and
 *     npm's conflict proves it is on the registry — not a failure.
 *   - The "still missing" read for a NOT-yet-absorbed member is itself polled
 *     (`pollResolves`, a few quick attempts) before it is offered to `publish`
 *     — cuts down on racy single-read false negatives triggering an
 *     unnecessary publish/conflict round-trip.
 *   - Never publishes a member already resolvable at the target (present member).
 *   - THROWS `GroupStillIncoherentError` only for a member that was NEVER
 *     absorbed (no real success, no benign conflict) and still does not
 *     resolve after `maxAttempts` rounds.
 *   - After success, spends a best-effort (non-throwing) confirmation poll on
 *     every absorbed member — see `pollResolves` — so `verify-published-group
 *     --post` (no retry of its own) has more time for the registry to catch up.
 *
 * @param {{
 *   members: string[],
 *   targetVersion: string,
 *   probe: () => boolean,
 *   resolves: (name: string, version: string) => boolean,
 *   publish: (name: string) => { ok: boolean, stderr?: string },
 *   sleep: (ms: number) => Promise<void>,
 *   maxAttempts?: number,
 *   backoffMs?: (attempt: number) => number,
 *   resolvePollAttempts?: number,
 *   resolvePollBackoffMs?: (attempt: number) => number,
 * }} input
 * @returns {Promise<{published: string[], confirmed: string[], attempts: number}>}
 */
export async function ensureGroupPublished({
  members,
  targetVersion,
  probe,
  resolves,
  publish,
  sleep,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoffMs = defaultBackoffMs,
  resolvePollAttempts = DEFAULT_RESOLVE_POLL_ATTEMPTS,
  resolvePollBackoffMs = defaultResolvePollBackoffMs,
}) {
  const publishedThisRun = new Set();

  const probeOrThrow = () => {
    if (!probe()) {
      throw new RegistryUnreachableError(
        'cannot reach the registry — refusing to certify the published group from an ' +
          'unreachable registry',
      );
    }
  };

  // Members already proven this run (real publish success or an absorbed
  // conflict) are TERMINAL — excluded from every subsequent registry read, so
  // their OWN lag can never flip a correct absorption back into "missing".
  const stillMissing = async () => {
    probeOrThrow();
    const missing = [];
    for (const name of members) {
      if (publishedThisRun.has(name)) continue;
      const present = await pollResolves({
        resolves,
        sleep,
        name,
        version: targetVersion,
        maxAttempts: resolvePollAttempts,
        backoffMs: resolvePollBackoffMs,
      });
      if (!present) missing.push(name);
    }
    return missing;
  };

  let roundsUsed = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    roundsUsed = attempt + 1;
    const missing = await stillMissing();
    if (missing.length === 0) break;
    for (const name of missing) {
      // Already published this run but not yet resolvable → read-after-write
      // lag. Do NOT publish again (immutable conflict); the backoff below
      // waits it out — unreachable in practice since `stillMissing` already
      // excludes `publishedThisRun`, kept as a defensive no-op.
      if (publishedThisRun.has(name)) continue;
      const result = publish(name);
      // A benign already-published conflict (isAlreadyPublishedConflict) is
      // the upstream publish step's lag surfacing: absorb it as
      // proof-of-publication — mark published, TERMINAL, never a failure,
      // never a retry. A real failure (incl. a NON-benign 403/409 like auth)
      // leaves it unpublished so a later round retries and, if it never
      // lands, the run fails closed below.
      if (result?.ok || isAlreadyPublishedConflict(result)) publishedThisRun.add(name);
    }
    await sleep(backoffMs(attempt));
  }

  // Final authority read after the last backoff — `stillMissing` already
  // excludes every absorbed member, so this can only fail a member with NO
  // proof of publication at all.
  const remaining = await stillMissing();
  if (remaining.length > 0) {
    throw new GroupStillIncoherentError(
      `after ${maxAttempts} attempts these fixed-group members still do not resolve to ` +
        `${targetVersion} on the registry: ${remaining.join(', ')} — a partial publish could ` +
        'not be healed in-run. Re-run the release once the underlying registry issue clears.',
    );
  }

  // Best-effort, NON-GATING: for members proven only via an absorbed conflict
  // (never actually observed resolving), spend a little more time confirming
  // — helps `verify-published-group.mjs --post`, which has no retry of its
  // own, without making THIS step's success depend on the read ever clearing.
  const confirmed = new Set();
  for (const name of publishedThisRun) {
    const present = await pollResolves({ resolves, sleep, name, version: targetVersion });
    if (present) confirmed.add(name);
  }

  return { published: [...publishedThisRun], confirmed: [...confirmed], attempts: roundsUsed };
}

// ── process wiring ─────────────────────────────────────────────────────────

/** Read every workspace manifest as `{ dir, name, version }`. */
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
      manifests.push({ dir: join(base, entry.name), name: pkg.name, version: pkg.version });
    }
  }
  return manifests;
}

function readChangesetConfig() {
  return JSON.parse(readFileSync(join(REPO_ROOT, '.changeset/config.json'), 'utf8'));
}

/**
 * `npm view <name>@<version> version` — TRUE iff npm exited 0 (branch on exit
 * code). Exported so a test can exercise the REAL spawnSync + exit-code
 * boundary against a fake `npm` on PATH, not just the pure retry logic above.
 */
export function npmResolvesAt(name, version, registry) {
  const run = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['view', `${name}@${version}`, 'version', '--registry', registry],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (run.error) return false;
  return run.status === 0;
}

export function npmProbe(registry) {
  const run = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['view', REACHABILITY_PROBE, 'version', '--registry', registry],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return !run.error && run.status === 0;
}

/**
 * `npm publish` in the member's package dir. The dir already holds the built
 * dist/ and the workspace-rewritten manifest (`^<version>` siblings), and
 * publishConfig (`access: public`, `provenance: true`) rides along — the same
 * artifact `changeset publish` shipped, so a re-publish is byte-faithful.
 * Exported for the same fake-`npm` process-level testing as `npmResolvesAt`.
 */
export function npmPublish(dir, registry) {
  // stderr is PIPED (not inherited) so we can read npm's rejection message and
  // tell a benign already-published 403 from a real failure — then re-emitted to
  // our own stderr so the log still shows it. npm never echoes NODE_AUTH_TOKEN,
  // and we add nothing that would, so this capture leaks no secret.
  const run = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['publish', '--registry', registry],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] },
  );
  const stderr = run.stderr || '';
  if (stderr) process.stderr.write(stderr);
  return { ok: !run.error && run.status === 0, stderr };
}

function die(message) {
  console.error(`\n[ensure-published-group] FAIL: ${message}`);
  process.exit(1);
}

async function main() {
  const registry = process.env.PUBLISH_PREFLIGHT_REGISTRY || DEFAULT_REGISTRY;
  const config = readChangesetConfig();
  const fixedGroup = config.fixed?.[0] ?? [];
  if (fixedGroup.length === 0) die('no fixed group in .changeset/config.json to ensure');

  const workspace = readWorkspace();
  const dirByName = new Map(workspace.map((w) => [w.name, w.dir]));
  const versionByName = new Map(workspace.map((w) => [w.name, w.version]));

  // The fixed group is one version by construction; read it from any member.
  const targetVersion = versionByName.get(fixedGroup[0]);
  if (typeof targetVersion !== 'string') {
    die(`could not read a target version for ${fixedGroup[0]}`);
  }

  for (const name of fixedGroup) {
    if (!dirByName.has(name)) {
      die(`fixed-group member ${name} has no workspace directory — cannot re-publish it`);
    }
  }

  let result;
  try {
    result = await ensureGroupPublished({
      members: fixedGroup,
      targetVersion,
      probe: () => npmProbe(registry),
      resolves: (name, version) => npmResolvesAt(name, version, registry),
      publish: (name) => {
        console.log(
          `[ensure-published-group] ${name} is missing at ${targetVersion} — re-publishing ` +
            `from ${dirByName.get(name)}…`,
        );
        return npmPublish(dirByName.get(name), registry);
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
  } catch (err) {
    if (err instanceof RegistryUnreachableError || err instanceof GroupStillIncoherentError) {
      die(`${registry}: ${err.message}`);
    }
    throw err;
  }

  if (result.published.length === 0) {
    console.log(
      `\n[ensure-published-group] PASS: the whole fixed group already resolves to ` +
        `${targetVersion} — nothing to heal.`,
    );
  } else {
    const unconfirmed = result.published.filter((n) => !result.confirmed.includes(n));
    console.log(
      `\n[ensure-published-group] PASS: healed a partial publish — re-published ` +
        `${result.published.join(', ')} and the whole group now resolves to ${targetVersion}.` +
        (unconfirmed.length > 0
          ? ` NOTE: ${unconfirmed.join(', ')} absorbed via an already-published conflict but did ` +
            'not confirm resolvable via `npm view` within the confirmation window — trusted on the ' +
            'conflict alone (npm cannot report it for any other reason); if verify-published-group ' +
            '--post reds next, it is this residual lag, not a real partial publish.'
          : ''),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
