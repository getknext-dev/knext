/**
 * e2e-round-config.mjs — pure arg/env construction for the local e2e round (#1331).
 *
 * Split out of e2e-round.mjs (which does the actual spawning/docker calls) so the
 * three defects fixed under #1331 are testable as DATA — the exact args/env the
 * orchestrator would pass — rather than by text-matching the orchestrator's spawn
 * calls or running Docker:
 *
 *   1. prod-image port — e2e-round.mjs used to run `docker run -p 8080:8080`
 *      against an image that listens on 3000 (Dockerfile: `ENV PORT=3000`,
 *      `EXPOSE 3000`) while prod-image-probe.mjs polls :3000 by default — the
 *      leg always failed with ECONNREFUSED. Host port, container port, and the
 *      probe's BASE_URL now all derive from the ONE `PROD_IMAGE_PORT` constant.
 *   2. compat-smoke runtime — e2e-round.mjs ran the compiled Bun single
 *      executable without RUNTIME=bun / SERVER_CMD / SERVER_PATH, so
 *      compat-smoke.mjs defaulted to RUNTIME=node while still resolving the
 *      single-exec branch (SERVER_CMD defaults to SERVER_PATH) — check (h),
 *      "bun keep-alive guard contract", failed: "Node serving must stay
 *      keep-alive — the guard must never load under Node". `buildCompatSmokeEnv`
 *      sets exactly what ci.yml's "Run knext compat-smoke (compiled single
 *      executable)" step sets.
 *   3. redis container name — the `--allow-docker` leg always started
 *      `redis:7-alpine --name knext-e2e-redis`, which collides with a
 *      still-running container from an earlier leg or an earlier round.
 *      `uniqueRedisContainerName` gives every round its own name.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// ── defect 1: prod-image port ────────────────────────────────────────────────

/**
 * The file-manager production image's listen port. Source of truth:
 * apps/file-manager/Dockerfile (`ENV PORT=3000`, `EXPOSE 3000`).
 */
export const PROD_IMAGE_PORT = 3000;

/**
 * `docker run` args for the prod-image leg. Host and container port are the
 * SAME value (derived from `PROD_IMAGE_PORT`), so they cannot drift apart —
 * the bug fixed here was `-p 8080:8080` against a :3000 listener.
 */
export function buildProdImageRunArgs({ tag, name, port = PROD_IMAGE_PORT }) {
  if (!tag) throw new Error('buildProdImageRunArgs: tag is required');
  if (!name) throw new Error('buildProdImageRunArgs: name is required');
  return ['run', '-d', '--rm', '-p', `${port}:${port}`, '--name', name, tag];
}

/**
 * Env for `scripts/prod-image-probe.mjs` — BASE_URL is set explicitly from the
 * same `PROD_IMAGE_PORT` constant used to publish the container port, instead
 * of relying on the probe's own default (which only happens to agree today).
 */
export function buildProdImageProbeEnv(baseEnv, port = PROD_IMAGE_PORT) {
  return { ...baseEnv, BASE_URL: `http://127.0.0.1:${port}` };
}

// ── defect 2: compat-smoke runtime classification ────────────────────────────

/**
 * Absolute default path to the compiled single executable — matches
 * compat-smoke.mjs's own default `SERVER_PATH` resolution, used when the
 * caller hasn't overridden it via env.
 */
export function defaultServerPath(appDir) {
  return path.resolve(appDir, 'knext-smoke-exec');
}

/**
 * Env for `node scripts/compat-smoke.mjs`, set EXACTLY as ci.yml's "Run knext
 * compat-smoke (compiled single executable)" step
 * (.github/workflows/ci.yml): RUNTIME=bun, SERVER_CMD===SERVER_PATH, both the
 * absolute path to the compiled binary — the single-exec signal compat-smoke
 * checks by realpath, not string comparison (T6c).
 */
export function buildCompatSmokeEnv({ baseEnv, redisUrl, serverPath }) {
  if (!serverPath) throw new Error('buildCompatSmokeEnv: serverPath is required');
  return {
    ...baseEnv,
    REDIS_URL: redisUrl,
    RUNTIME: 'bun',
    SERVER_CMD: serverPath,
    SERVER_PATH: serverPath,
  };
}

// ── defect 3: redis container name leaks/collides across legs ───────────────

/**
 * A redis container name unique to this invocation — never the bare
 * `knext-e2e-redis` constant, which collides with a still-running container
 * left over from an earlier leg (same round) or an earlier round.
 */
export function uniqueRedisContainerName(seed = randomUUID()) {
  return `knext-e2e-redis-${seed}`;
}

export function buildRedisRunArgs(name) {
  if (!name) throw new Error('buildRedisRunArgs: name is required');
  return ['run', '-d', '--rm', '-p', '6379:6379', '--name', name, 'redis:7-alpine'];
}

export function buildRedisStopArgs(name) {
  if (!name) throw new Error('buildRedisStopArgs: name is required');
  return ['rm', '-f', name];
}

/**
 * The round's leg-running control flow, extracted so the "cleanup runs even
 * on a failed leg" half of defect 3 is testable as data — with fake
 * `runLeg`/`cleanup`/`classifyError` — rather than only by reading
 * e2e-round.mjs's main(). `cleanup` runs in a `finally` around every leg, so
 * a docker-started redis container from an earlier leg gets stopped whether
 * the round finishes clean or breaks on a failed leg.
 *
 * @param {{
 *   legs: ReadonlyArray<{ id: string }>,
 *   runLeg: (leg: { id: string }) => Promise<void>,
 *   cleanup: () => Promise<void> | void,
 *   classifyError?: (e: unknown) => string,
 * }} opts
 * @returns {Promise<{ results: Array<{id: string, status: string, why?: string}>, failed: boolean }>}
 */
export async function runLegsWithCleanup({ legs, runLeg, cleanup, classifyError = () => 'FAIL' }) {
  const results = [];
  let failed = false;
  try {
    for (const leg of legs) {
      try {
        await runLeg(leg);
        results.push({ id: leg.id, status: 'PASS' });
      } catch (e) {
        results.push({ id: leg.id, status: classifyError(e), why: e?.message });
        failed = true;
        break;
      }
    }
  } finally {
    await cleanup();
  }
  return { results, failed };
}
