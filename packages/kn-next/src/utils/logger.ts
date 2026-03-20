/**
 * Centralized logging service for kn-next framework.
 *
 * Uses Pino for structured JSON logging in production
 * and pretty-printed output in development / CLI contexts.
 */

import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Framework logger instance.
 *
 * - Production: structured JSON (12-factor compliant, machine-parseable)
 * - Development/CLI: pretty-printed with timestamps and colors
 */
export const logger = pino({
    name: "kn-next",
    level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
    transport: isProduction
        ? undefined
        : {
              target: "pino-pretty",
              options: {
                  colorize: true,
                  translateTime: "HH:MM:ss",
                  ignore: "pid,hostname",
              },
          },
});

/**
 * Creates a child logger with additional context bindings.
 * Useful for scoping logs to a specific module or operation.
 *
 * @example
 * ```ts
 * const log = createLogger({ module: 'deploy' });
 * log.info({ imageTag: 'v1.0.0' }, 'Starting deployment');
 * ```
 */
export function createLogger(bindings: Record<string, string>): pino.Logger {
    return logger.child(bindings);
}
