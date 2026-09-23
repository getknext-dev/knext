#!/usr/bin/env node
/**
 * e2e-bytecode-liveness — the ONE definition of "bytecode caching is LIVE" for the
 * official-suite harness, shared by the deploy script (per deploy), the shard
 * workflow check (per shard) and the compat window audit (per night).
 *
 * THE RULE (founder, #1218): bytecode caching is mandatory in every supported
 * runtime×builder cell, and a cell may only credential on nights where caching
 * is proven LIVE at runtime — not merely configured. So "live" is a property of
 * the process that served the tests, observed, never inferred from config:
 *
 *   * bun  — the deploy booted the compiled single executable
 *            (`mode=compiled-exec`), and that file passed the fail-closed
 *            build-time bytecode verifier (`bytecode_verified=true`). The boot
 *            target IS the verified file: the compile step deletes the artifact
 *            and exits 1 when verification fails, so no other binary can be
 *            booted under that mode.
 *   * node — the booted server's V8 ACCEPTED cached code. Counted from the
 *            server's OWN `NODE_DEBUG_NATIVE=COMPILE_CACHE` output at
 *            readiness: at least NODE_CACHE_ACCEPTED_FLOOR accepted entries AND
 *            a hit ratio accepted/(accepted+missed+rejected) of at least
 *            NODE_CACHE_HIT_RATIO_FLOOR. A populated cache directory proves
 *            nothing — Node writes it on exit, so a cold boot leaves one too.
 *
 * MEASURED (real Next 16.2 standalone server, node 24): harness-baked boot =
 * 416 accepted / ~9 missed / 0 rejected; cold boot = 0 accepted / 426 missed.
 * The floors sit far from both, so neither a fixture-size difference nor a
 * Next.js refactor that moves a few modules flips a live deploy to not-live.
 *
 * EVIDENCE SHAPE. The deploy script appends one `key=value …` line per deploy
 * to the boot ledger; `summarizeBootLedger` folds a shard's lines into
 * `{runtime, deploys, live, notLive, reasons}`, which `e2e-summary.mjs` puts in
 * the shard summary (`bytecode`). That rides unchanged into the run ledger, and
 * `isShardBytecodeLive` is what the audit grades — recomputed from the counts,
 * fail closed on anything missing or malformed.
 *
 * The rule is keyed on RUNTIME, not builder or lane, so a runtime×builder lane
 * wired later inherits it by writing the same evidence lines.
 *
 * CLI
 *   node scripts/e2e-bytecode-liveness.mjs --count-node-log <debug.log>
 *       → prints `compile_cache_accepted=N compile_cache_missed=M compile_cache_rejected=R`
 *         (zeros when the log is absent — that reads as NOT live, never fails the deploy)
 *   node scripts/e2e-bytecode-liveness.mjs --live-node-log <debug.log>
 *       → exit 0 iff the counts so far already satisfy the node floors (the
 *         deploy script's settle loop; it never decides the verdict itself)
 *   node scripts/e2e-bytecode-liveness.mjs --check --runtime <node|bun> --ledger <boot-ledger>
 *       → exit 0 iff the shard proves every deploy live; 1 otherwise (missing/empty = 1)
 *   node scripts/e2e-bytecode-liveness.mjs --summarize --runtime <node|bun> --ledger <boot-ledger>
 *       → prints the shard's evidence block as JSON (never fails)
 */

import { existsSync, readFileSync } from 'node:fs';

/** Minimum accepted V8 code-cache entries for a node deploy to be live. */
export const NODE_CACHE_ACCEPTED_FLOOR = 100;

/** Minimum accepted / (accepted + missed + rejected) for a node deploy to be live. */
export const NODE_CACHE_HIT_RATIO_FLOOR = 0.5;

/** The runtimes that have a liveness definition. Anything else is not live. */
export const LIVENESS_RUNTIMES = Object.freeze(['node', 'bun']);

/** How many per-deploy reasons a shard summary keeps (the counts are exact regardless). */
const MAX_REASONS = 10;

const DEBUG_PREFIX = '[compile cache] ';

/**
 * Count V8 compile-cache outcomes in NODE_DEBUG_NATIVE=COMPILE_CACHE output.
 * Only lines carrying Node's own `[compile cache]` prefix count, so an app that
 * happens to log the phrase cannot manufacture a hit.
 *
 * @param {string} text
 * @returns {{accepted: number, missed: number, rejected: number}}
 */
export function countNodeCompileCache(text) {
  const out = { accepted: 0, missed: 0, rejected: 0 };
  for (const line of String(text ?? '').split('\n')) {
    if (!line.startsWith(DEBUG_PREFIX) || !line.includes('V8 code cache for ')) continue;
    if (/ was accepted\b/.test(line)) out.accepted += 1;
    else if (/ was not initialized\b/.test(line)) out.missed += 1;
    else if (/ was rejected\b/.test(line)) out.rejected += 1;
  }
  return out;
}

/**
 * Parse one boot-ledger line into its key=value fields. Splits each token on
 * its FIRST `=`, so an image digest (`…@sha256:…`) survives intact.
 *
 * @param {string} line
 * @returns {Record<string, string>}
 */
export function parseBootLine(line) {
  /** @type {Record<string, string>} */
  const fields = {};
  for (const token of String(line ?? '')
    .trim()
    .split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    fields[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return fields;
}

/** A non-negative integer from a ledger field, or null. */
function intField(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/**
 * Is ONE deploy's bytecode caching live?
 *
 * @param {Record<string, string>} fields a parsed boot-ledger line
 * @returns {{live: boolean, reason: string|null}}
 */
export function deployIsLive(fields) {
  const runtime = fields?.runtime;
  if (runtime === 'bun') {
    if (fields.mode !== 'compiled-exec') {
      return {
        live: false,
        reason: `booted ${String(fields.mode)} — a bun cell must boot the compiled-exec (bytecode) artifact`,
      };
    }
    if (fields.bytecode_verified !== 'true') {
      return {
        live: false,
        reason: `compiled exec with bytecode_verified=${String(fields.bytecode_verified)} — the build-time verifier did not prove its bytecode`,
      };
    }
    return { live: true, reason: null };
  }
  if (runtime === 'node') {
    if (fields.mode !== 'server-js') {
      return {
        live: false,
        reason: `booted ${String(fields.mode)} on node — the node cell boots server.js with a V8 compile cache`,
      };
    }
    const accepted = intField(fields.compile_cache_accepted);
    const missed = intField(fields.compile_cache_missed);
    const rejected = intField(fields.compile_cache_rejected);
    if (accepted === null || missed === null || rejected === null) {
      return {
        live: false,
        reason: 'no compile-cache counts recorded — liveness was never measured',
      };
    }
    if (accepted < NODE_CACHE_ACCEPTED_FLOOR) {
      return {
        live: false,
        reason: `V8 accepted ${accepted} cached entries (< ${NODE_CACHE_ACCEPTED_FLOOR}); missed=${missed} rejected=${rejected}`,
      };
    }
    const ratio = accepted / (accepted + missed + rejected);
    if (ratio < NODE_CACHE_HIT_RATIO_FLOOR) {
      return {
        live: false,
        reason: `hit ratio ${ratio.toFixed(2)} < ${NODE_CACHE_HIT_RATIO_FLOOR} (accepted=${accepted} missed=${missed} rejected=${rejected})`,
      };
    }
    return { live: true, reason: null };
  }
  return { live: false, reason: `runtime ${String(runtime)} has no bytecode-liveness definition` };
}

/**
 * Fold one shard's boot ledger into its evidence block. A line whose runtime is
 * not the lane's is not live (a node boot on the bun lane is exactly the
 * non-bytecode fallback this exists to catch).
 *
 * @param {string} text the boot ledger's contents
 * @param {string} runtime the lane's runtime
 */
export function summarizeBootLedger(text, runtime) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  let live = 0;
  /** @type {string[]} */
  const reasons = [];
  lines.forEach((line, i) => {
    const fields = parseBootLine(line);
    const verdict =
      fields.runtime !== runtime
        ? {
            live: false,
            reason: `runtime ${String(fields.runtime)} is not the lane runtime ${runtime}`,
          }
        : deployIsLive(fields);
    if (verdict.live) live += 1;
    else if (reasons.length < MAX_REASONS) reasons.push(`deploy ${i + 1}: ${verdict.reason}`);
  });
  return { runtime, deploys: lines.length, live, notLive: lines.length - live, reasons };
}

/**
 * The AUDIT rule for one shard: does its evidence prove every deploy live, on
 * the cell's runtime? Recomputed from the counts — a forged or half-written
 * block fails, and so does a missing one.
 *
 * @param {unknown} evidence the shard summary's `bytecode` block
 * @param {string} runtime the credential cell's runtime
 * @returns {{live: boolean, reason: string|null}}
 */
export function isShardBytecodeLive(evidence, runtime) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { live: false, reason: 'no bytecode-liveness evidence recorded' };
  }
  const e = /** @type {Record<string, unknown>} */ (evidence);
  if (!LIVENESS_RUNTIMES.includes(runtime)) {
    return { live: false, reason: `cell runtime ${String(runtime)} has no liveness definition` };
  }
  if (e.runtime !== runtime) {
    return {
      live: false,
      reason: `evidence is for runtime ${String(e.runtime)}, the cell runs ${runtime}`,
    };
  }
  const isCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  if (!isCount(e.deploys) || !isCount(e.live) || !isCount(e.notLive)) {
    return { live: false, reason: 'evidence counts are missing or malformed' };
  }
  if (e.deploys === 0) return { live: false, reason: 'zero deploys recorded' };
  if (e.live !== e.deploys || e.notLive !== 0) {
    return { live: false, reason: `${e.live} of ${e.deploys} deploy(s) live` };
  }
  return { live: true, reason: null };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function readOrEmpty(path) {
  if (!path || !existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function main(argv) {
  const debugLog = arg(argv, '--count-node-log');
  if (debugLog !== undefined) {
    const c = countNodeCompileCache(readOrEmpty(debugLog));
    console.log(
      `compile_cache_accepted=${c.accepted} compile_cache_missed=${c.missed} compile_cache_rejected=${c.rejected}`,
    );
    return 0;
  }
  const liveLog = arg(argv, '--live-node-log');
  if (liveLog !== undefined) {
    // The deploy script's settle loop: are the counts SO FAR already live?
    const c = countNodeCompileCache(readOrEmpty(liveLog));
    const verdict = deployIsLive({
      mode: 'server-js',
      runtime: 'node',
      compile_cache_accepted: String(c.accepted),
      compile_cache_missed: String(c.missed),
      compile_cache_rejected: String(c.rejected),
    });
    return verdict.live ? 0 : 1;
  }
  const runtime = arg(argv, '--runtime') ?? '';
  const ledger = arg(argv, '--ledger');
  const summary = summarizeBootLedger(readOrEmpty(ledger), runtime);
  if (argv.includes('--summarize')) {
    console.log(JSON.stringify(summary));
    return 0;
  }
  if (argv.includes('--check')) {
    const verdict = isShardBytecodeLive(summary, runtime);
    console.log(
      `bytecode liveness (${runtime}): ${summary.live}/${summary.deploys} deploy(s) live — ${verdict.live ? 'LIVE' : `NOT LIVE (${verdict.reason})`}`,
    );
    for (const r of summary.reasons) console.log(`  ${r}`);
    return verdict.live ? 0 : 1;
  }
  console.error(
    'usage: e2e-bytecode-liveness.mjs --count-node-log <log> | --check|--summarize --runtime <node|bun> --ledger <file>',
  );
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
