import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The shared @knext/lib logger (`../logger`) builds a pino instance at module
// load. In production it writes raw JSON (no pino-pretty worker); we pin its
// real, observable contract:
//   - constructs/exports without throwing,
//   - honors LOG_LEVEL,
//   - carries the load-bearing base fields (app/env),
//   - and — the security-relevant part — is configured to redact secrets and
//     serialize the level as a string label.
//
// Level/redact serialization is verified by capturing a REAL emitted line from
// a pino instance built with the exact options the module passes to pino().

function forceProdEnv() {
  // Force the raw-JSON branch — no pino-pretty transport worker under vitest.
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('LOG_LEVEL', undefined);
  vi.stubEnv('KN_APP_NAME', undefined);
}

describe('@knext/lib logger — instance contract', () => {
  beforeEach(() => {
    vi.resetModules();
    forceProdEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('constructs and exports a usable logger without throwing', async () => {
    const { logger } = await import('../logger');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    // Emitting must not throw (writes structured JSON to the default dest).
    expect(() => logger.info({ hello: 'world' }, 'ping')).not.toThrow();
  });

  it('honors LOG_LEVEL from the environment', async () => {
    vi.stubEnv('LOG_LEVEL', 'warn');
    const { logger } = await import('../logger');
    expect(logger.level).toBe('warn');
    // Level filtering is real: info is below the configured floor.
    expect(logger.isLevelEnabled('warn')).toBe(true);
    expect(logger.isLevelEnabled('info')).toBe(false);
  });

  it('defaults to info level when LOG_LEVEL is unset', async () => {
    const { logger } = await import('../logger');
    expect(logger.level).toBe('info');
  });

  it('carries the load-bearing base fields (app, env)', async () => {
    vi.stubEnv('KN_APP_NAME', 'zone-checkout');
    const { logger } = await import('../logger');
    const base = logger.bindings();
    expect(base.app).toBe('zone-checkout');
    expect(base.env).toBe('production');
  });

  it('falls back to app="kn-next" when KN_APP_NAME is unset', async () => {
    const { logger } = await import('../logger');
    expect(logger.bindings().app).toBe('kn-next');
  });
});

describe('@knext/lib logger — serialization + redaction contract', () => {
  beforeEach(() => {
    vi.resetModules();
    forceProdEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('emits structured JSON with a string level label and redacts secrets', async () => {
    // Capture the exact options the module hands to pino(), then replay them
    // against a real pino wired to a capture stream — this pins the actual
    // wire contract (string level, base fields, [Redacted] secrets) rather
    // than snapshotting formatted lines.
    const realPino = (await import('pino')).default;
    const lines: string[] = [];
    let capturedOptions: Record<string, unknown> | undefined;

    vi.doMock('pino', () => ({
      default: (options: Record<string, unknown>) => {
        capturedOptions = options;
        return realPino(options, { write: (s: string) => lines.push(s) });
      },
    }));

    const { logger } = await import('../logger');
    logger.info({ password: 'hunter2', token: 'abc', keep: 'visible' }, 'hello');

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.redact).toEqual(expect.arrayContaining(['password', 'token']));

    const record = JSON.parse(lines.at(-1) as string);
    // Level serialized as a human/ingest-friendly string, not a pino number.
    expect(record.level).toBe('info');
    // Base fields present on every line.
    expect(record.app).toBe('kn-next');
    // Secrets scrubbed; non-secret fields preserved.
    expect(record.password).toBe('[Redacted]');
    expect(record.token).toBe('[Redacted]');
    expect(record.keep).toBe('visible');

    vi.doUnmock('pino');
  });
});
