/**
 * Real config-validation test for the knext-docs dogfood config.
 *
 * This is the quality gate for the docs app (alongside `next build`):
 * the deploy config must pass the SAME validator `kn-next deploy` runs
 * (the public @knext/core/validate surface), and a known-bad config must be rejected.
 *
 * Ported to vitest so the root `vitest run` (apps/** glob) covers it inside the
 * monorepo — no separate `tsx --test` runner. Resolves @knext/core/validate
 * against the built workspace package (dist), which is what the switch to
 * `workspace:*` locks in.
 */
import type { KnativeNextConfig } from '@knext/core';
import { ConfigValidationError, validateConfig } from '@knext/core/validate';
import { describe, expect, it } from 'vitest';
import config from '../kn-next.config';

describe('knext-docs dogfood kn-next.config.ts', () => {
  it('passes the real validateConfig', () => {
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('uses scale-to-zero (minScale 0)', () => {
    expect(config.scaling?.minScale).toBe(0);
  });

  it('uses a storage provider the validator accepts (gcs|s3|minio|azure)', () => {
    expect(['gcs', 's3', 'minio', 'azure']).toContain(config.storage.provider);
  });

  it('accepts the azure storage provider (multi-cloud/AKS support)', () => {
    // azure is a supported provider — it shells out to the `az` CLI, matching the
    // multi-cloud page. This guards against a regression back to rejecting it.
    const azureCfg = {
      ...config,
      storage: { ...config.storage, provider: 'azure' },
    } as unknown as KnativeNextConfig;
    expect(() => validateConfig(azureCfg)).not.toThrow(ConfigValidationError);
  });
});
