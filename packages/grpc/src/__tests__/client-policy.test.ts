import { afterAll, describe, expect, it } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateFiles } from '../generate';
import { checkBudget, DEFAULT_DEADLINE_MS, DEFAULT_GATEWAY_TIMEOUT_SECONDS } from '../policy';
import { copyFixtureZone, FIXTURE_ZONE, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);

const CLIENT = 'orders/v1/orders_knext.ts';

function generatedClient(zone = FIXTURE_ZONE): string {
  const text = generateFiles(zone).get(CLIENT);
  if (text === undefined) throw new Error(`${CLIENT} was not generated`);
  return text;
}

/** The generated policy line for one method, e.g. `placeOrder: { ... },`. */
function methodLine(text: string, method: string): string {
  const lines = text.split('\n').filter((l) => l.trimStart().startsWith(`${method}:`));
  expect(lines, `exactly one policy line for ${method}`).toHaveLength(1);
  return lines[0] as string;
}

describe('generated client policy', () => {
  const text = generatedClient();

  it('is server-only', () => {
    expect(text).toContain('import "server-only";');
  });

  it('emits NO retry for a mutating method, and requires an idempotency key', () => {
    const line = methodLine(text, 'placeOrder');
    expect(line).toContain('kind: "mutation"');
    expect(line).not.toContain('retry');
    expect(line).toContain('idempotencyKey: "required"');
  });

  it('treats IDEMPOTENT as a write: no retry, idempotency key required', () => {
    const line = methodLine(text, 'cancelOrder');
    expect(line).toContain('kind: "mutation"');
    expect(line).not.toContain('retry');
    expect(line).toContain('idempotencyKey: "required"');
  });

  it('retries only the NO_SIDE_EFFECTS unary method', () => {
    const line = methodLine(text, 'getOrder');
    expect(line).toContain('kind: "read"');
    expect(line).toContain('retry: { maxAttempts: 3 }');
    // Across the whole file, the read is the only method with a retry.
    expect(text.match(/retry:/g)).toHaveLength(1);
  });

  it('never retries a stream, even a NO_SIDE_EFFECTS one', () => {
    const line = methodLine(text, 'watchOrders');
    expect(line).toContain('kind: "stream"');
    expect(line).not.toContain('retry');
  });

  it('carries an explicit deadline shorter than the gateway timeout', () => {
    expect(text).toContain(`deadlineMs: ${DEFAULT_DEADLINE_MS},`);
    expect(text).toContain(`gatewayTimeoutMs: ${DEFAULT_GATEWAY_TIMEOUT_SECONDS * 1000},`);
    expect(DEFAULT_DEADLINE_MS).toBeLessThan(DEFAULT_GATEWAY_TIMEOUT_SECONDS * 1000);
  });

  it('reads the endpoint from the operator-injected env var at call time, never a baked URL', () => {
    expect(text).toContain('urlEnv: "ORDERS_SERVICE_URL",');
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('records the contract version the zone was generated against', () => {
    expect(text).toContain('contractVersion: "1.2.0",');
  });

  it('follows a configured deadline', () => {
    const zone = copyFixtureZone('deadline');
    const cfgPath = join(zone, 'knext.grpc.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.deadlineMs = 4500;
    cfg.gatewayTimeoutSeconds = 60;
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const t = generatedClient(zone);
    expect(t).toContain('deadlineMs: 4500,');
    expect(t).toContain('gatewayTimeoutMs: 60000,');
  });
});

describe('deadline budget', () => {
  it('the default deadline covers a measured cold function start (~1.4 s) with headroom', () => {
    expect(DEFAULT_DEADLINE_MS).toBeGreaterThanOrEqual(5000);
  });

  it('accepts a deadline shorter than the gateway timeout', () => {
    expect(checkBudget(10_000, 300_000)).toBeUndefined();
  });

  it('refuses a deadline equal to or longer than the gateway timeout', () => {
    expect(checkBudget(300_000, 300_000)).toContain('shorter than the gateway timeout');
    expect(checkBudget(400_000, 300_000)).toContain('shorter than the gateway timeout');
  });

  it('refuses a non-positive or fractional deadline', () => {
    expect(checkBudget(0, 300_000)).toBeDefined();
    expect(checkBudget(-1, 300_000)).toBeDefined();
    expect(checkBudget(1.5, 300_000)).toBeDefined();
    expect(checkBudget(Number.NaN, 300_000)).toBeDefined();
  });
});
