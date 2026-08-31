import { createRequire } from 'node:module';
import pino from 'pino';
import { correlationLogFields } from '../context';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Shared Knative Next.js JSON Logger
 * - Uses raw JSON in production for fast parsing by Datadog/Elastic/FluentBit
 * - Uses pino-pretty in local development for human-readable output
 */
/**
 * Build a logger from the CURRENT environment.
 *
 * Exported so tests can construct one without re-evaluating this module.
 * `vi.resetModules()` used to provide that, and bun has no equivalent — module
 * mocks there are registered for the whole run and a fresh module instance
 * cannot be obtained (#871). Without a factory a test that sets `LOG_LEVEL`
 * observes whatever the FIRST evaluation captured, and the failure describes
 * the wrong thing: "expected warn, received info" reads as a logger bug rather
 * than as a stale singleton.
 *
 * `logger` below remains the module singleton every caller imports. This only
 * makes construction reachable; it does not change what production uses.
 */
export function buildLogger(): ReturnType<typeof pino> {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
      level: (label) => {
        // Format level as string instead of numeric representation (e.g. "level": "info")
        return { level: label };
      },
    },
    base: {
      app: process.env.KN_APP_NAME || 'kn-next',
      env: process.env.NODE_ENV,
    },
    // Correlation (#318): stamp every line emitted DURING a request with the
    // ambient correlation_id (+ trace_id when an OTel span is active), pulled from
    // the AsyncLocalStorage request context. Returns {} outside a request, so
    // non-request logs are unchanged and no correlation field ever leaks.
    mixin() {
      return correlationLogFields();
    },
    // Automatically redact sensitive data from logs
    redact: ['req.headers.authorization', 'req.headers.cookie', 'password', 'token'],
    // Auto-prettify logic for local development — only when pino-pretty is
    // actually resolvable. See `prettyTransport`.
    ...prettyTransport(),
  });
}

export const logger = buildLogger();

/**
 * The dev-only pretty transport, or nothing.
 *
 * `pino-pretty` is a devDependency: it is deliberately absent from a production
 * install, and from any pruned tree. pino resolves `target` lazily in a worker,
 * so an unresolvable target does not degrade — it throws
 * `unable to determine transport target for "pino-pretty"` and the logger fails
 * to CONSTRUCT, taking the importing module with it.
 *
 * That went unnoticed while this package emitted CommonJS from `tsc`; moving to
 * a bundled ESM build changed the resolution base and the built entry stopped
 * loading in exactly the environment `peer-shape.test.ts` checks — a consumer
 * install with the dev tree pruned.
 *
 * So the presence of a human-readable log format is now a probe rather than an
 * assumption. Absent it, pino's default JSON output is used, which is what
 * production wants anyway. A missing optional prettifier must never be the
 * reason an application cannot log.
 */
function prettyTransport(): Record<string, unknown> {
  if (isProduction) return {};
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
  } catch {
    return {};
  }
  return {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        singleLine: true,
        translateTime: 'SYS:standard',
      },
    },
  };
}
