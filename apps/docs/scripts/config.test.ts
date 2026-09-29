/**
 * Real config-validation test for the knext-docs dogfood config.
 *
 * This is the quality gate for the docs app (alongside `next build`):
 * the deploy config must pass the SAME validator `kn-next deploy` runs
 * (the public @getknext/core/validate surface), and a known-bad config must be rejected.
 *
 * Ported to vitest so the root `vitest run` (apps/** glob) covers it inside the
 * monorepo — no separate `tsx --test` runner. Resolves @getknext/core/validate
 * against the built workspace package (dist), which is what the switch to
 * `workspace:*` locks in.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnativeNextConfig } from '@getknext/core';
import { ConfigValidationError, validateConfig } from '@getknext/core/validate';
import config from '../knext.config';

describe('knext-docs dogfood knext.config.ts', () => {
  it('passes the real validateConfig', () => {
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('uses scale-to-zero (minScale 0)', () => {
    expect(config.scaling?.minScale).toBe(0);
  });

  it('deploys without object storage — assets are served from the image', () => {
    // The OKE deploy passes --skip-upload and has no bucket yet. A storage block
    // here would make a bare `kn-next deploy` try to upload to a bucket that
    // does not exist.
    expect(config.storage).toBeUndefined();
  });

  it('pushes to the public OCIR repository (the CLI appends the app name)', () => {
    expect(`${config.registry}/${config.name}`).toBe(
      'me-abudhabi-1.ocir.io/axfqznklsd2t/knext-docs',
    );
  });

  it('is named what the DomainMappings point at — renaming would orphan the domains', () => {
    // The operator names the Knative Service after the NextApp, and the NextApp
    // after `name`. The custom domains reference that ksvc by name.
    const mappings = readFileSync(
      join(import.meta.dirname, '../deploy/oke/domainmapping.yaml'),
      'utf8',
    );
    const refs = [...mappings.matchAll(/kind: Service\n\s+name: (\S+)/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toBe(config.name);
  });

  it('accepts the azure storage provider (multi-cloud/AKS support)', () => {
    // azure is a supported provider — it shells out to the `az` CLI, matching the
    // multi-cloud page. This guards against a regression back to rejecting it.
    const azureCfg = {
      ...config,
      storage: { provider: 'azure', bucket: 'knext-docs-assets' },
    } as unknown as KnativeNextConfig;
    expect(() => validateConfig(azureCfg)).not.toThrow(ConfigValidationError);
  });
});
