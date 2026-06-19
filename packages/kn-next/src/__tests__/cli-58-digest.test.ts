/**
 * CLI-58: digest-pinning — metadata-file-first approach
 *
 * The operator (A1-5) rejects any image ref without @sha256:.
 * The CLI MUST resolve the real content-digest after push and emit
 * the CR image as `name@sha256:<hash>` (or `name:tag@sha256:<hash>`).
 *
 * Digest resolution priority (per CLI-58 spec):
 *   1. PRIMARY:  read `containerimage.digest` from the buildx metadata JSON file
 *                (written by `docker buildx build --metadata-file <path>`)
 *   2. FALLBACK: `docker inspect --format '{{index .RepoDigests 0}}' <ref>`
 *
 * All I/O is injected (ExecFn / ReadFileFn) so tests run without Docker.
 */

import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import type { KnativeNextConfig } from '../config';
import {
  buildNextAppCRObject,
  resolveDigest,
  resolveDigestFromMetadataFile,
  validateCRImageRef,
} from '../cli/cr-builder';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_DIGEST = 'sha256:deadbeefcafe0000111122223333444455556666777788889999aaaabbbbcccc';

/** A JSON object matching `docker buildx build --metadata-file` output format. */
const FAKE_METADATA_JSON = JSON.stringify({
  'containerimage.digest': FAKE_DIGEST,
  'containerimage.config.digest': 'sha256:aabbcc',
  'buildx.build.provenance': {},
});

const FAKE_REPO_DIGEST = `registry.example.com/my-app@${FAKE_DIGEST}`;

const baseConfig: KnativeNextConfig = {
  name: 'my-app',
  registry: 'registry.example.com',
  storage: {
    provider: 'gcs',
    bucket: 'my-bucket',
    publicUrl: 'https://storage.googleapis.com/my-bucket',
  },
  cache: {
    provider: 'redis',
    url: 'redis://redis:6379',
    keyPrefix: 'my-app',
  },
  scaling: {
    minScale: 0,
    maxScale: 5,
  },
};

// ---------------------------------------------------------------------------
// resolveDigestFromMetadataFile — pure extraction from buildx metadata JSON
// ---------------------------------------------------------------------------

describe('resolveDigestFromMetadataFile', () => {
  it('extracts containerimage.digest from a buildx metadata JSON string', () => {
    const readFileFn = vi.fn().mockReturnValue(FAKE_METADATA_JSON);
    const digest = resolveDigestFromMetadataFile('/tmp/meta.json', readFileFn);

    expect(readFileFn).toHaveBeenCalledWith('/tmp/meta.json');
    expect(digest).toBe(FAKE_DIGEST);
    expect(digest).toMatch(/^sha256:[0-9a-f]+/);
  });

  it('returns a value that starts with sha256:', () => {
    const readFileFn = vi.fn().mockReturnValue(FAKE_METADATA_JSON);
    const digest = resolveDigestFromMetadataFile('/tmp/meta.json', readFileFn);
    expect(digest.startsWith('sha256:')).toBe(true);
  });

  it('throws when containerimage.digest is absent from the JSON', () => {
    const readFileFn = vi.fn().mockReturnValue(JSON.stringify({ other: 'data' }));
    expect(() => resolveDigestFromMetadataFile('/tmp/meta.json', readFileFn)).toThrow(/digest/i);
  });

  it('throws when containerimage.digest does not start with sha256:', () => {
    const readFileFn = vi
      .fn()
      .mockReturnValue(JSON.stringify({ 'containerimage.digest': 'not-a-digest' }));
    expect(() => resolveDigestFromMetadataFile('/tmp/meta.json', readFileFn)).toThrow(/sha256/i);
  });

  it('throws when the file content is not valid JSON', () => {
    const readFileFn = vi.fn().mockReturnValue('not-json-at-all');
    expect(() => resolveDigestFromMetadataFile('/tmp/meta.json', readFileFn)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveDigest — metadata-file-first with docker-inspect fallback
// ---------------------------------------------------------------------------

describe('resolveDigest — metadata-file-first (PRIMARY path)', () => {
  it('uses metadata file when metadataFilePath + readFileFn are provided', async () => {
    const execSpy = vi.fn();
    const readFileFn = vi.fn().mockReturnValue(FAKE_METADATA_JSON);
    const taggedRef = 'registry.example.com/my-app:20240101';

    const result = await resolveDigest(taggedRef, execSpy, '/tmp/meta.json', readFileFn);

    // Should NOT fall through to docker inspect
    expect(execSpy).not.toHaveBeenCalled();
    // Result MUST contain @sha256: so the operator accepts it
    expect(result).toContain('@sha256:');
    expect(result).toContain('deadbeef');
  });

  it('emits taggedRef@sha256:<digest> preserving the original tag', async () => {
    const execSpy = vi.fn();
    const readFileFn = vi.fn().mockReturnValue(FAKE_METADATA_JSON);
    const taggedRef = 'registry.example.com/my-app:v42';

    const result = await resolveDigest(taggedRef, execSpy, '/tmp/meta.json', readFileFn);

    // The result should be `taggedRef@sha256:<digest>` so both tag and digest are present
    expect(result).toBe(`${taggedRef}@${FAKE_DIGEST}`);
  });

  it('result passes validateCRImageRef (operator accept rule)', async () => {
    const execSpy = vi.fn();
    const readFileFn = vi.fn().mockReturnValue(FAKE_METADATA_JSON);
    const taggedRef = 'registry.example.com/my-app:build-99';

    const pinnedRef = await resolveDigest(taggedRef, execSpy, '/tmp/meta.json', readFileFn);

    // The operator's validateCRImageRef must accept the result
    expect(() => validateCRImageRef(pinnedRef)).not.toThrow();
  });
});

describe('resolveDigest — docker-inspect fallback (FALLBACK path)', () => {
  it('falls back to docker inspect when metadataFilePath is not provided', async () => {
    const execSpy = vi.fn().mockResolvedValue(FAKE_REPO_DIGEST);
    const taggedRef = 'registry.example.com/my-app:1234567890';

    const result = await resolveDigest(taggedRef, execSpy);

    // docker inspect MUST have been called
    expect(execSpy).toHaveBeenCalledTimes(1);
    const cmd = execSpy.mock.calls[0][0] as string;
    expect(cmd).toMatch(/docker\s+inspect/);
    expect(cmd).toContain(taggedRef);
    expect(result).toContain('@sha256:');
  });

  it('falls back to docker inspect when metadata file read throws', async () => {
    const execSpy = vi.fn().mockResolvedValue(FAKE_REPO_DIGEST);
    const readFileFn = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });
    const taggedRef = 'registry.example.com/my-app:1234567890';

    const result = await resolveDigest(taggedRef, execSpy, '/tmp/meta.json', readFileFn);

    // Fell back to docker inspect
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(result).toContain('@sha256:');
  });

  it('falls back to docker inspect when metadata JSON is invalid', async () => {
    const execSpy = vi.fn().mockResolvedValue(FAKE_REPO_DIGEST);
    const readFileFn = vi.fn().mockReturnValue('not-json');
    const taggedRef = 'registry.example.com/my-app:1234567890';

    const result = await resolveDigest(taggedRef, execSpy, '/tmp/meta.json', readFileFn);

    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(result).toContain('@sha256:');
  });

  it('throws when both metadata and docker inspect fail', async () => {
    const execSpy = vi.fn().mockResolvedValue(''); // returns empty — bad inspect output
    const readFileFn = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT');
    });

    await expect(
      resolveDigest('registry.example.com/my-app:bad', execSpy, '/tmp/meta.json', readFileFn),
    ).rejects.toThrow(/digest/i);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: digest-pinned ref flows correctly into the NextApp CR
// ---------------------------------------------------------------------------

describe('CR image field — digest-pinned ref (CLI-58 E2E invariant)', () => {
  it('CR image contains @sha256: when metadata-file path resolves it', async () => {
    const execSpy = vi.fn();
    const readFileFn = vi.fn().mockReturnValue(FAKE_METADATA_JSON);
    const taggedRef = 'registry.example.com/my-app:1234567890';

    const pinnedRef = await resolveDigest(taggedRef, execSpy, '/tmp/meta.json', readFileFn);
    const cr = buildNextAppCRObject(baseConfig, pinnedRef, 'default');

    // Operator accept rule
    const imageInCR = (cr.spec as { image: string }).image;
    expect(imageInCR).toContain('@sha256:');
    // Must NOT be a bare tag ref
    expect(imageInCR).not.toMatch(/^[^@]+:[^@]+$/ /* tag-only, no digest */);
  });

  it('CR preserves minScale:0 (scale-to-zero invariant) with digest-pinned image', async () => {
    const readFileFn = vi.fn().mockReturnValue(FAKE_METADATA_JSON);
    const pinnedRef = await resolveDigest(
      'registry.example.com/my-app:ts',
      vi.fn(),
      '/tmp/meta.json',
      readFileFn,
    );
    const cr = buildNextAppCRObject(baseConfig, pinnedRef, 'default');
    expect((cr.spec as { scaling: { minScale: number } }).scaling.minScale).toBe(0);
  });

  it('CR preserves enableBytecodeCache=true (redis) with digest-pinned image', async () => {
    const readFileFn = vi.fn().mockReturnValue(FAKE_METADATA_JSON);
    const pinnedRef = await resolveDigest(
      'registry.example.com/my-app:ts',
      vi.fn(),
      '/tmp/meta.json',
      readFileFn,
    );
    const cr = buildNextAppCRObject(baseConfig, pinnedRef, 'default');
    expect((cr.spec as { cache: { enableBytecodeCache: boolean } }).cache.enableBytecodeCache).toBe(
      true,
    );
  });

  it('a bare tag-only ref (no @sha256:) is rejected by validateCRImageRef', () => {
    // This is what deploy used to emit — the operator rejects it
    const bareTag = 'registry.example.com/my-app:1234567890';
    expect(() => validateCRImageRef(bareTag)).toThrow(/@sha256:/);
  });
});
