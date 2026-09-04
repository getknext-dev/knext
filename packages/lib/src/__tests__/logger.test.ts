import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { stubEnv, unstubAllEnvs } from '../../../../tests/helpers/bun-test-helpers';
import { resetClients } from '../clients';

// The shared @getknext/lib logger (`../logger`) builds a pino instance at module
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
  stubEnv('NODE_ENV', 'production');
  stubEnv('LOG_LEVEL', undefined);
  stubEnv('KN_APP_NAME', undefined);
}

describe('@getknext/lib logger — instance contract', () => {
  beforeEach(() => {
    resetClients();
    forceProdEnv();
  });

  afterEach(() => {
    unstubAllEnvs();
  });

  it('constructs and exports a usable logger without throwing', async () => {
    // `buildLogger()`, not the `logger` singleton: the singleton is built once at
    // module evaluation, and bun cannot re-evaluate a module the way
    // `vi.resetModules()` did. Reading the singleton here would assert against
    // whatever env the FIRST test in the file happened to set.
    const logger = (await import('../logger')).buildLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    // Emitting must not throw (writes structured JSON to the default dest).
    expect(() => logger.info({ hello: 'world' }, 'ping')).not.toThrow();
  });

  it('honors LOG_LEVEL from the environment', async () => {
    stubEnv('LOG_LEVEL', 'warn');
    const logger = (await import('../logger')).buildLogger();
    expect(logger.level).toBe('warn');
    // Level filtering is real: info is below the configured floor.
    expect(logger.isLevelEnabled('warn')).toBe(true);
    expect(logger.isLevelEnabled('info')).toBe(false);
  });

  it('defaults to info level when LOG_LEVEL is unset', async () => {
    const logger = (await import('../logger')).buildLogger();
    expect(logger.level).toBe('info');
  });

  it('carries the load-bearing base fields (app, env)', async () => {
    stubEnv('KN_APP_NAME', 'zone-checkout');
    const logger = (await import('../logger')).buildLogger();
    const base = logger.bindings();
    expect(base.app).toBe('zone-checkout');
    expect(base.env).toBe('production');
  });

  it('falls back to app="kn-next" when KN_APP_NAME is unset', async () => {
    const logger = (await import('../logger')).buildLogger();
    expect(logger.bindings().app).toBe('kn-next');
  });
});

describe('@getknext/lib logger — serialization + redaction contract', () => {
  beforeEach(() => {
    resetClients();
    forceProdEnv();
  });

  afterEach(() => {
    unstubAllEnvs();
    jest.restoreAllMocks();
  });

  it('emits structured JSON with a string level label and redacts secrets', async () => {
    // Capture the exact options the module hands to pino(), then replay them
    // against a real pino wired to a capture stream — this pins the actual
    // wire contract (string level, base fields, [Redacted] secrets) rather
    // than snapshotting formatted lines.
    const realPino = (await import('pino')).default;
    const lines: string[] = [];
    let capturedOptions: Record<string, unknown> | undefined;

    mock.module('pino', () => ({
      default: (options: Record<string, unknown>) => {
        capturedOptions = options;
        return realPino(options, { write: (s: string) => lines.push(s) });
      },
    }));

    const logger = (await import('../logger')).buildLogger();
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

    // No `doUnmock`: bun registers module mocks for the whole run and cannot
    // unregister them (`mock.restore()` restores spies only). Safe here because
    // the runner gives each FILE its own process and nothing in this one runs
    // after this test — the mock dies with the process.
  });
});
