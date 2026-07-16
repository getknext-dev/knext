import pino from 'pino';
import { correlationLogFields } from '../context';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Shared Knative Next.js JSON Logger
 * - Uses raw JSON in production for fast parsing by Datadog/Elastic/FluentBit
 * - Uses pino-pretty in local development for human-readable output
 */
export const logger = pino({
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
  // Auto-prettify logic for local development
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            singleLine: true,
            translateTime: 'SYS:standard',
          },
        },
      }),
});
