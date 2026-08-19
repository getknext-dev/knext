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
 * DELIBERATELY NOT SCANNED — stated explicitly so the list above reads as a decision
 * rather than as an exhaustive claim. Each is a real unrooted host; each is out of
 * scope for a reason, not by oversight:
 *
 * - `apps/file-manager/kn-next.config.ts` (redis default, `…default.svc.cluster.local`)
 *   — APP-level config, not a platform-minted Secret. The ledger measures ioredis
 *   `connect ETIMEDOUT` as the other half of the fresh-pod tail, so the same lever
 *   applies, but changing an app's own default is a separate call with a separate
 *   blast radius. Deferred, not dismissed.
 * - `gateway/cmd/zone-operator/main.go` + `deploy/87-zone-operator.yaml`
 *   (`ZONE_GATEWAY_HOST`) — embedded in Postgres subscription/FDW conninfo and
 *   resolved by the COMPUTE's libpq on a long-lived replication connection, not by a
 *   fresh app pod. Different consumer, different lever; both sites carry an in-tree
 *   comment saying so.
 * - `gateway/internal/wake/*` targets and `deploy/_verify-*.sh` drill scripts —
 *   gateway-internal dial targets and drill-time psql hosts; never inside an
 *   app-consumed Secret.
 * - `docs/adr-*.md` — historical decision records; they describe what was decided
 *   then, and rewriting them would falsify the record.
 */

/**
 * A gateway hostname in HOST POSITION — immediately after a URL's `@`, an `=`
 * assignment, or a `: "` YAML value. Anchoring on position (rather than on any
 * mention of the word) is what lets the predicate below be uniform: prose like
 * "the apps-gateway (`pggw-apps`)" is not a host reference and must not be audited,
 * while every real DSN/env host is.
 *
 * Host characters include `$`/`{`/`}` so shell-interpolated forms
 * (`pggw-apps.$NS.svc.cluster.local.`) are caught rather than skipped, the dotted
 * tail is OPTIONAL so the bare single-label form (`@pggw-apps:55432`) is matched
 * too, and a trailing dot is captured so rooted is distinguishable from unrooted.
 */
const GATEWAY_HOST_IN_POSITION = /(?:@|=|:\s*")(pggw[A-Za-z0-9-]*(?:\.[A-Za-z0-9_${}-]+)*\.?)/g;

/** Every gateway host reference, in host position, in `text`. */
export function gatewayHostsInText(text: string): string[] {
  return [...text.matchAll(GATEWAY_HOST_IN_POSITION)].map((m) => m[1]);
}

/**
 * The violations: every gateway host that is not ROOTED.
 *
 * The predicate is deliberately uniform — "must end in `.`" — rather than
 * "contains `.svc` and does not end in `.cluster.local.`". The earlier `.svc`-gated
 * form audited only the hosts that happened to contain `.svc`, so the BARE
 * single-label form (`@pggw-apps:55432`) sailed through while being STRICTLY WORSE:
 * one label is furthest below ndots:5, so it walks all five search suffixes. That is
 * this repo's most-repeated defect class — a guard that enumerates a substring
 * condition while its docstring promises a scan — and `_verify-scale-ceiling.sh:141`
 * already contains that exact bare form, so it was one copy-paste from the mint.
 */
export function unrootedGatewayHostsInText(text: string): string[] {
  return gatewayHostsInText(text).filter(
    (h) => h.includes('.svc') && !h.endsWith('.cluster.local.'),
  );
}

function gatewayHostsIn(relPath: string): string[] {
  return gatewayHostsInText(readFileSync(join(REPO_ROOT, relPath), 'utf8'));
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

    // One predicate, shared with the unit cases below — so strengthening it there
    // strengthens the file scan here, and the two can never drift apart.
    const unrooted = unrootedGatewayHostsInText(readFileSync(join(REPO_ROOT, relPath), 'utf8'));
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

/**
 * The predicate itself, pinned directly. These cases exist because a mutation proof
 * is transient — it demonstrates a hole once, then evaporates. Encoding the same
 * cases as tests makes the bare-form rejection permanent.
 */
describe('the rooted-host predicate', () => {
  const dsn = (host: string) => `postgres://app_shop:pw@${host}:55432/shop?sslmode=disable`;

  it.each([
    ['bare single label — the worst form: furthest below ndots:5, walks all five', 'pggw-apps'],
    ['short 2-dot service name', 'pggw-apps.scale-zero-pg.svc'],
    [
      'qualified but UNROOTED (4 dots — still below ndots:5)',
      'pggw-apps.scale-zero-pg.svc.cluster.local',
    ],
    ['shell-interpolated namespace, unrooted', 'pggw-apps.$NS.svc'],
  ])('flags %s', (_label, host) => {
    expect(unrootedGatewayHostsInText(dsn(host))).toEqual([host]);
  });

  it.each([
    ['rooted FQDN', 'pggw-apps.scale-zero-pg.svc.cluster.local.'],
    ['rooted shell-interpolated form', 'pggw-apps.$NS.svc.cluster.local.'],
    // A rooted SHORT name is absolute too — the invariant is the root label, not length.
    ['rooted short name', 'pggw-apps.scale-zero-pg.svc.'],
  ])('accepts %s', (_label, host) => {
    expect(unrootedGatewayHostsInText(dsn(host))).toEqual([]);
  });

  it('audits hosts in env-assignment and YAML-value position too, not just DSNs', () => {
    expect(unrootedGatewayHostsInText('DBHOST=pggw.scale-zero-pg.svc.cluster.local')).toEqual([
      'pggw.scale-zero-pg.svc.cluster.local',
    ]);
    expect(
      unrootedGatewayHostsInText('- { name: APPDB_GATEWAY_HOST, value: "pggw-apps.ns.svc" }'),
    ).toEqual(['pggw-apps.ns.svc']);
  });

  it('does not audit prose mentions, which are not host references', () => {
    // Position-anchoring is what keeps the uniform "must end in ." predicate from
    // firing on comments; without it, strengthening the predicate would have forced
    // an exclusion list — the enumeration this guard exists to avoid.
    expect(unrootedGatewayHostsInText('the apps-gateway (pggw-apps) fronts every app')).toEqual([]);
    expect(
      unrootedGatewayHostsInText('# routes through pggw-apps, the multi-tenant plane'),
    ).toEqual([]);
  });

  it('is exactly the in-repo bare form that made this reachable', () => {
    // deploy/_verify-scale-ceiling.sh:141 — one copy-paste from a minting path.
    const realLine = `psql 'postgres://app_$app:$pw@pggw-apps:55432/$app?sslmode=disable' -tAw -c 'select 1'`;
    expect(unrootedGatewayHostsInText(realLine)).toEqual(['pggw-apps']);
  });
});
