import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every gateway hostname the PLATFORM mints into an app-consumed Secret must be
 * ROOTED (trailing dot).
 *
 * Why a trailing dot and not merely an FQDN: measured on the live plane (a running
 * pod's /etc/resolv.conf, knext cold-start ledger), the cluster runs `options ndots:5`
 * with a FIVE-entry search path — the standard three plus two OCI VCN domains. Any
 * name below 5 dots is tried against all five suffixes before the name as given:
 * 5 wasted attempts = 10 wasted queries with A+AAAA, and the two VCN misses leave the
 * cluster entirely. That covers BOTH the short `pggw-apps.<ns>.svc` (2 dots) and the
 * merely-qualified `…svc.cluster.local` (4 dots). Only the rooted form skips the walk.
 *
 * This guard lives in the root test infra ON PURPOSE: `packages/scale-zero-pg/deploy/
 * _validate.sh` carries the same contract, but it is not wired into the monorepo's
 * root .github/workflows (the packages/scale-zero-pg/.github copy is subtree residue
 * GitHub does not run — knext #797 tracks the structural half), so it would not run in
 * CI. This file does.
 *
 * SCAN, don't enumerate: the operator default was only ONE of several writers of the
 * same `app-db-<app>` Secret — provision-app.sh's `create` AND its `rotate-cred` path
 * (which silently REVERTED a rooted DSN on rotation) were both missed by a guard that
 * only knew about the operator manifest.
 */

const REPO_ROOT = join(import.meta.dirname, '..');

/**
 * Platform artifacts that mint or ship a gateway host into an app-consumed Secret.
 * Adding a new minting artifact means adding it here — the per-file "must contain at
 * least one host" assertion below is what stops a typo'd path from silently scanning
 * nothing.
 */
const MINTING_ARTIFACTS = [
  'packages/scale-zero-pg/deploy/provision-app.sh', // create + rotate-cred, both write app-db-<app>
  'packages/scale-zero-pg/deploy/gen-secrets.sh', // base myapp-database Secret (apply-reconciled)
  'packages/scale-zero-pg/deploy/83-appdb-operator.yaml', // APPDB_GATEWAY_HOST — the deployed default
  'packages/scale-zero-pg/demo/manifests/10-database-secret.yaml', // shipped pg-demo-db DSN
] as const;

/**
 * A dotted hostname beginning with the gateway service name (`pggw`, `pggw-apps`).
 * Host characters include `$`/`{`/`}` so shell-interpolated forms (`pggw-apps.$NS.svc`)
 * are caught rather than skipped, and an optional trailing dot is captured so the
 * rooted form is distinguishable from the unrooted one.
 */
const GATEWAY_HOST = /pggw[A-Za-z0-9-]*(?:\.[A-Za-z0-9_${}-]+)+\.?/g;

function gatewayHostsIn(relPath: string): string[] {
  const text = readFileSync(join(REPO_ROOT, relPath), 'utf8');
  return [...text.matchAll(GATEWAY_HOST)].map((m) => m[0]);
}

describe('platform-minted gateway hostnames are rooted', () => {
  it.each(MINTING_ARTIFACTS)('%s mints only rooted gateway hosts', (relPath) => {
    const hosts = gatewayHostsIn(relPath);

    // Both halves: the file must actually contain a gateway host, or "no unrooted
    // hosts found" would be a vacuous pass after a rename/refactor.
    expect(
      hosts.length,
      `${relPath}: no gateway host found at all — has the file moved or the mint been removed?`,
    ).toBeGreaterThan(0);

    const unrooted = hosts.filter((h) => h.includes('.svc') && !h.endsWith('.cluster.local.'));
    expect(
      unrooted,
      `${relPath}: these minted gateway hosts are NOT rooted (trailing dot). At ndots:5 with the live 5-entry search path each costs 5 wasted name attempts / 10 queries on a fresh pod's first flows: ${unrooted.join(', ')}`,
    ).toEqual([]);
  });

  it('scans every artifact it claims to (no silently-missing file)', () => {
    for (const relPath of MINTING_ARTIFACTS) {
      expect(
        () => readFileSync(join(REPO_ROOT, relPath), 'utf8'),
        `${relPath} is unreadable — the scan would skip it`,
      ).not.toThrow();
    }
  });
});
