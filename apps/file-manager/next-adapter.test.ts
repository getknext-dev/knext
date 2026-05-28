/**
 * TDD: failing tests for the minimal NextAdapter spike (POC-ADAPTER-P0)
 * RED phase: these tests should fail before the adapter is implemented.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NextAdapter } from 'next';
import { beforeAll, describe, expect, it, vi } from 'vitest';

describe('next-adapter (POC-ADAPTER-P0 spike)', () => {
  it('exports a valid NextAdapter with name, modifyConfig and onBuildComplete', async () => {
    const mod = await import('./next-adapter.js');
    const adapter: NextAdapter = mod.default;

    expect(adapter).toBeDefined();
    expect(typeof adapter.name).toBe('string');
    expect(adapter.name.length).toBeGreaterThan(0);
    expect(typeof adapter.modifyConfig).toBe('function');
    expect(typeof adapter.onBuildComplete).toBe('function');
  });

  it('modifyConfig forces output:standalone and returns config unchanged otherwise', async () => {
    const mod = await import('./next-adapter.js');
    const adapter: NextAdapter = mod.default;

    const baseConfig = {
      output: undefined,
      cacheHandler: 'cache-handler.js',
      cacheMaxMemorySize: 0,
    } as any;
    const result = await adapter.modifyConfig!(baseConfig, { phase: 'phase-production-build' });

    expect(result.output).toBe('standalone');
    // cacheHandler must still be honoured
    expect(result.cacheHandler).toBe('cache-handler.js');
    expect(result.cacheMaxMemorySize).toBe(0);
  });

  it('modifyConfig is a no-op on non-build phases', async () => {
    const mod = await import('./next-adapter.js');
    const adapter: NextAdapter = mod.default;

    const baseConfig = { output: 'export' } as any;
    const result = await adapter.modifyConfig!(baseConfig, { phase: 'phase-development-server' });

    // Should return config unchanged (no output override outside build phase)
    expect(result.output).toBe('export');
  });

  it('onBuildComplete logs output counts and build metadata without throwing', async () => {
    const mod = await import('./next-adapter.js');
    const adapter: NextAdapter = mod.default;

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const fakeCtx = {
      buildId: 'test-build-id',
      distDir: '/tmp/.next',
      projectDir: '/tmp/app',
      repoRoot: '/tmp',
      nextVersion: '16.0.3',
      config: { output: 'standalone', cacheMaxMemorySize: 0 } as any,
      routes: {
        headers: [],
        redirects: [],
        rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
        dynamicRoutes: [],
      },
      outputs: {
        pages: [],
        middleware: undefined,
        appPages: [{ id: '/page', type: 'APP_PAGE' } as any],
        pagesApi: [],
        appRoutes: [{ id: '/api/health', type: 'APP_ROUTE' } as any],
        prerenders: [],
        staticFiles: [{ id: '/favicon.ico', type: 'STATIC_FILE' } as any],
      },
    };

    await adapter.onBuildComplete!(fakeCtx);

    expect(consoleSpy).toHaveBeenCalled();
    const loggedText = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    // Should log buildId, distDir, and output counts
    expect(loggedText).toContain('test-build-id');
    expect(loggedText).toContain('/tmp/.next');
    // Should mention appPages count (1)
    expect(loggedText).toMatch(/appPages.*1|1.*appPages/i);

    consoleSpy.mockRestore();
  });

  it('onBuildComplete logs ctx.routes (routing) counts — headers, redirects, rewrites, dynamicRoutes', async () => {
    const mod = await import('./next-adapter.js');
    const adapter: NextAdapter = mod.default;

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const fakeCtx = {
      buildId: 'routing-test-id',
      distDir: '/tmp/.next',
      projectDir: '/tmp/app',
      repoRoot: '/tmp',
      nextVersion: '16.0.3',
      config: { output: 'standalone', cacheMaxMemorySize: 0 } as any,
      routes: {
        headers: [{ source: '/api/*' } as any, { source: '/static/*' } as any],
        redirects: [{ source: '/old', destination: '/new', statusCode: 301 } as any],
        rewrites: {
          beforeFiles: [{ source: '/a', destination: '/b' } as any],
          afterFiles: [],
          fallback: [],
        },
        dynamicRoutes: [{ source: '/blog/[slug]' } as any, { source: '/docs/[id]' } as any],
      },
      outputs: {
        pages: [],
        middleware: undefined,
        appPages: [],
        pagesApi: [],
        appRoutes: [],
        prerenders: [],
        staticFiles: [],
      },
    };

    await adapter.onBuildComplete!(fakeCtx);

    const loggedText = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');

    // Must log routing section
    expect(loggedText).toMatch(/routing|routes/i);
    // headers: 2
    expect(loggedText).toMatch(/headers.*2|2.*headers/i);
    // redirects: 1
    expect(loggedText).toMatch(/redirects.*1|1.*redirects/i);
    // rewrites (beforeFiles: 1)
    expect(loggedText).toMatch(/rewrite|1/i);
    // dynamicRoutes: 2
    expect(loggedText).toMatch(/dynamic.*2|2.*dynamic/i);

    consoleSpy.mockRestore();
  });
});

describe('next-adapter upload (POC-ADAPTER-P1-rework)', () => {
  // Real temp dir with real files so existsSync + createReadStream work without
  // mocking node:fs (CJS interop makes node:fs hard to mock cleanly in Vitest).
  let tmpDir: string;
  let faviconPath: string;
  let mainJsPath: string;
  let prerenderPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'knext-upload-test-'));
    faviconPath = join(tmpDir, 'favicon.ico');
    mainJsPath = join(tmpDir, 'main.js');
    prerenderPath = join(tmpDir, 'time-based.html');
    writeFileSync(faviconPath, 'icon');
    writeFileSync(mainJsPath, 'js');
    writeFileSync(prerenderPath, '<html>cached</html>');
  });

  // No afterAll cleanup: temp files in /tmp are small and the OS cleans them.
  // Explicit cleanup races with lazy createReadStream open → ENOENT errors.

  const makeCtx = (overrides: Record<string, unknown> = {}) => ({
    buildId: 'upload-test-id',
    distDir: '/tmp/.next',
    projectDir: '/tmp/app',
    repoRoot: '/tmp',
    nextVersion: '16.0.3',
    config: { output: 'standalone', cacheMaxMemorySize: 0 } as any,
    routes: {
      headers: [],
      redirects: [],
      rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
      dynamicRoutes: [],
    },
    outputs: {
      pages: [],
      middleware: undefined,
      appPages: [],
      pagesApi: [],
      appRoutes: [],
      prerenders: [
        {
          id: '/cache-tests/time-based',
          filePath: '/tmp/.next/server/app/cache-tests/time-based.html',
        } as any,
      ],
      staticFiles: [
        {
          id: '/favicon.ico',
          filePath: '/tmp/.next/public/favicon.ico',
          pathname: '/favicon.ico',
        } as any,
        {
          id: '/_next/static/chunks/main.js',
          filePath: '/tmp/.next/static/chunks/main.js',
          pathname: '/_next/static/chunks/main.js',
        } as any,
      ],
    },
    ...overrides,
  });

  it('skips upload and logs clearly when STORAGE_BUCKET env var is not set', async () => {
    vi.resetModules();
    delete process.env.STORAGE_BUCKET;

    const mod = await import('./next-adapter.js');
    const adapter: NextAdapter = mod.default;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await adapter.onBuildComplete!(makeCtx());

    const loggedText = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    // Must mention skip/upload skipped with reason
    expect(loggedText).toMatch(/upload skipped|STORAGE_BUCKET/i);

    consoleSpy.mockRestore();
  });

  it('calls putObject exactly twice (2 staticFiles; prerender has no fallback.filePath)', async () => {
    vi.resetModules();
    process.env.STORAGE_BUCKET = 'test-bucket';

    // Use real on-disk files (created in beforeAll) so existsSync + createReadStream
    // work without mocking node:fs (CJS interop makes that fragile in Vitest).
    // Destroy the stream immediately so no ENOENT fires after afterAll cleanup.
    const putObjectMock = vi.fn().mockImplementation(async (_b, _k, stream: any) => {
      stream?.destroy?.();
      return { etag: 'mock-etag' };
    });
    vi.doMock('@knative-next/lib/clients', () => ({
      getMinioClient: () => ({ putObject: putObjectMock }),
    }));

    const { default: adapter } = (await import('./next-adapter.js')) as { default: NextAdapter };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // 2 staticFiles with real file paths + 1 prerender WITHOUT fallback.filePath
    // (prerenders without fallback.filePath are filtered → expect exactly 2 uploads).
    const ctx = makeCtx({
      outputs: {
        pages: [],
        middleware: undefined,
        appPages: [],
        pagesApi: [],
        appRoutes: [],
        prerenders: [{ id: '/cache-tests/time-based' } as any],
        staticFiles: [
          { id: '/favicon.ico', filePath: faviconPath, pathname: '/favicon.ico' } as any,
          {
            id: '/_next/static/chunks/main.js',
            filePath: mainJsPath,
            pathname: '/_next/static/chunks/main.js',
          } as any,
        ],
      },
    });

    await adapter.onBuildComplete!(ctx);

    // This assertion would fail if the upload loop were removed or skipped.
    expect(putObjectMock).toHaveBeenCalledTimes(2);
    expect(putObjectMock.mock.calls[0][1]).toBe('upload-test-id/favicon.ico');
    expect(putObjectMock.mock.calls[1][1]).toBe('upload-test-id/_next/static/chunks/main.js');

    consoleSpy.mockRestore();
    delete process.env.STORAGE_BUCKET;
    vi.doUnmock('@knative-next/lib/clients');
  });

  it('calls putObject 3 times when prerender has fallback.filePath', async () => {
    vi.resetModules();
    process.env.STORAGE_BUCKET = 'test-bucket';

    const putObjectMock = vi.fn().mockResolvedValue({ etag: 'mock-etag' });
    vi.doMock('@knative-next/lib/clients', () => ({
      getMinioClient: () => ({ putObject: putObjectMock }),
    }));

    const { default: adapter } = (await import('./next-adapter.js')) as { default: NextAdapter };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const ctx = makeCtx({
      outputs: {
        pages: [],
        middleware: undefined,
        appPages: [],
        pagesApi: [],
        appRoutes: [],
        prerenders: [
          {
            id: '/cache-tests/time-based',
            fallback: { filePath: prerenderPath },
          } as any,
        ],
        staticFiles: [
          { id: '/favicon.ico', filePath: faviconPath, pathname: '/favicon.ico' } as any,
          {
            id: '/_next/static/chunks/main.js',
            filePath: mainJsPath,
            pathname: '/_next/static/chunks/main.js',
          } as any,
        ],
      },
    });

    await adapter.onBuildComplete!(ctx);

    // 2 staticFiles + 1 prerender with real fallback.filePath = 3
    expect(putObjectMock).toHaveBeenCalledTimes(3);

    consoleSpy.mockRestore();
    delete process.env.STORAGE_BUCKET;
    vi.doUnmock('@knative-next/lib/clients');
  });
});
