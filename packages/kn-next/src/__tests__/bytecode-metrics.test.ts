import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Bytecode Cache Metrics', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bytecode-metrics-test-'));
    originalEnv = { ...process.env };
    // Reset modules so each test gets a fresh import
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should detect cold start when cache directory is empty', async () => {
    process.env.NODE_COMPILE_CACHE = join(tempDir, 'cache');
    mkdirSync(join(tempDir, 'cache'), { recursive: true });

    const { initBytecodeCacheMetrics, metricsRegistry } = await import(
      '../adapters/bytecode-metrics'
    );

    initBytecodeCacheMetrics();

    const metrics = await metricsRegistry.getMetricsAsJSON();
    const warmStartMetric = metrics.find((m) => m.name === 'kn_next_bytecode_cache_warm_start');
    expect(warmStartMetric).toBeDefined();

    // With empty dir, should be cold (0)
    const warmValue = (warmStartMetric as any)?.values?.[0]?.value;
    expect(warmValue).toBe(0);
  });

  it('should detect warm start when cache files exist', async () => {
    const cacheDir = join(tempDir, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'module1.cache'), 'fake-bytecode-data-1');
    writeFileSync(join(cacheDir, 'module2.cache'), 'fake-bytecode-data-2');

    process.env.NODE_COMPILE_CACHE = cacheDir;

    const { initBytecodeCacheMetrics, metricsRegistry } = await import(
      '../adapters/bytecode-metrics'
    );

    initBytecodeCacheMetrics();

    const metrics = await metricsRegistry.getMetricsAsJSON();
    const warmStartMetric = metrics.find((m) => m.name === 'kn_next_bytecode_cache_warm_start');
    const filesMetric = metrics.find((m) => m.name === 'kn_next_bytecode_cache_files_total');

    expect((warmStartMetric as any)?.values?.[0]?.value).toBe(1);
    expect((filesMetric as any)?.values?.[0]?.value).toBe(2);
  });

  it('should measure cache size in bytes', async () => {
    const cacheDir = join(tempDir, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const data = 'x'.repeat(1024); // 1KB
    writeFileSync(join(cacheDir, 'module.cache'), data);

    process.env.NODE_COMPILE_CACHE = cacheDir;

    const { initBytecodeCacheMetrics, metricsRegistry } = await import(
      '../adapters/bytecode-metrics'
    );

    initBytecodeCacheMetrics();

    const metrics = await metricsRegistry.getMetricsAsJSON();
    const sizeMetric = metrics.find((m) => m.name === 'kn_next_bytecode_cache_size_bytes');

    expect((sizeMetric as any)?.values?.[0]?.value).toBeGreaterThanOrEqual(1024);
  });

  it('should skip metrics when NODE_COMPILE_CACHE is not set', async () => {
    process.env.NODE_COMPILE_CACHE = undefined;

    const { initBytecodeCacheMetrics, metricsRegistry } = await import(
      '../adapters/bytecode-metrics'
    );

    initBytecodeCacheMetrics();

    const metrics = await metricsRegistry.getMetricsAsJSON();
    const warmStartMetric = metrics.find((m) => m.name === 'kn_next_bytecode_cache_warm_start');

    // Should still set the metric (to 0)
    expect(warmStartMetric).toBeDefined();
    expect((warmStartMetric as any)?.values?.[0]?.value).toBe(0);
  });

  it('should record startup duration when recordServerReady is called', async () => {
    process.env.NODE_COMPILE_CACHE = undefined;

    const { recordServerReady, metricsRegistry } = await import('../adapters/bytecode-metrics');

    recordServerReady();

    const metrics = await metricsRegistry.getMetricsAsJSON();
    const durationMetric = metrics.find((m) => m.name === 'kn_next_startup_duration_seconds');

    expect(durationMetric).toBeDefined();
  });

  it('should expose metrics in Prometheus text format', async () => {
    process.env.NODE_COMPILE_CACHE = undefined;

    const { initBytecodeCacheMetrics, recordServerReady, metricsRegistry } = await import(
      '../adapters/bytecode-metrics'
    );

    initBytecodeCacheMetrics();
    recordServerReady();

    const output = await metricsRegistry.metrics();

    expect(output).toContain('kn_next_bytecode_cache_warm_start');
    expect(output).toContain('kn_next_startup_duration_seconds');
    expect(output).toContain('process_cpu_user_seconds_total'); // default metrics
  });
});
