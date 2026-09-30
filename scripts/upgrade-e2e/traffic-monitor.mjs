#!/usr/bin/env node
/**
 * traffic-monitor — light continuous HTTP traffic driver for the operator
 * upgrade-under-load e2e (#1668).
 *
 * Polls a target URL on an interval for the process lifetime and appends one
 * JSON line per attempt to a log file: `{ts, ok, status}` — `ts` is
 * `Date.now()`, `ok` is true for a 2xx/3xx response, `status` is the HTTP
 * status code or an error string (a genuine connection failure counts
 * against the error budget the same as a bad status — both are "the request
 * did not succeed"). `scripts/upgrade-e2e/error-budget.mjs` consumes that
 * log to decide pass/fail; this file owns only the driving loop, kept
 * separate so the pass/fail decision stays a pure, unit-tested function
 * with no network dependency.
 *
 * Reaches the target through the Kourier gateway (round 3, #1668/#1671):
 * a Knative ksvc's own Service is an ExternalName pointing at the shared
 * internal gateway, which `kubectl port-forward` cannot target directly (no
 * backing pod IP) — confirmed by the first live run, where port-forwarding
 * `svc/<app>` directly produced 100% connection failures. The proven pattern
 * already in this repo (`standalone-self-contained-operator-e2e.yml`, "Reach
 * the cluster (kourier-internal port-forward)") is: port-forward
 * `svc/kourier-internal` in `kourier-system`, then send every request with a
 * `Host:` header naming the app's real route host — run.sh resolves that
 * host once (from the NextApp's `status.url`) and passes it here.
 *
 * SIGTERM/SIGINT stop the loop cleanly (used by the workflow to end the
 * traffic window without losing the last few in-flight attempts).
 */

import { appendFileSync } from 'node:fs';

/**
 * @param {string} url - the Kourier gateway's loopback address (e.g. http://127.0.0.1:8080/).
 * @param {string} hostHeader - the app's real route host, e.g. `upgrade-e2e-app.upgrade-e2e-app.example.com`.
 * @returns {Promise<{ok: boolean, status: number|string}>}
 */
export async function attempt(url, hostHeader, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, {
      headers: hostHeader ? { Host: hostHeader } : {},
      signal: AbortSignal.timeout(5000),
    });
    return { ok: res.status >= 200 && res.status < 400, status: res.status };
  } catch (err) {
    return { ok: false, status: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const [, , url, logPath, intervalMsArg, hostHeader] = process.argv;
  if (!url || !logPath) {
    console.error('usage: traffic-monitor.mjs <url> <logPath> [intervalMs=500] [hostHeader]');
    process.exit(2);
  }
  const intervalMs = Number(intervalMsArg ?? 500);

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (!stopping) {
    const start = Date.now();
    const result = await attempt(url, hostHeader);
    appendFileSync(logPath, `${JSON.stringify({ ts: start, ...result })}\n`);
    const elapsed = Date.now() - start;
    const wait = Math.max(0, intervalMs - elapsed);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}
