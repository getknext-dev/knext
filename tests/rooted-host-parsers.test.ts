import IORedis from 'ioredis';
import { parse as parsePg } from 'pg-connection-string';
import { describe, expect, it } from 'vitest';

/**
 * Consumer compatibility for the ROOTED (trailing-dot) hostname, EXECUTED against the
 * real parsers rather than argued from their source.
 *
 * The spec (knext cold-start ledger, lever 1) requires trailing-dot compatibility to be
 * "verified per consumer, not assumed". The Go side is covered in the appdb module
 * (lib/pq via `pq.ParseURL`). The two node consumers the ledger actually measured —
 * node-postgres reading DATABASE_URL, and ioredis reading the Redis URL — are covered
 * here, because both parsers are installed in this repo and running them is strictly
 * stronger and cheaper than reading their source.
 *
 * What this proves: the parsers preserve the root label byte-for-byte, so the dot
 * survives to getaddrinfo (where glibc/musl both treat it as absolute and skip the
 * search walk). What it does NOT prove: the resolver saving itself — that is an
 * on-cluster measurement, not a unit test.
 */

const ROOTED_PG_HOST = 'pggw-apps.scale-zero-pg.svc.cluster.local.';
const ROOTED_REDIS_HOST = 'file-manager-redis.default.svc.cluster.local.';

describe('rooted hostnames survive the node consumers that read minted URLs', () => {
  it('pg-connection-string (node-postgres) preserves the trailing dot', () => {
    const parsed = parsePg(`postgres://app_shop:pw@${ROOTED_PG_HOST}:55432/shop?sslmode=disable`);

    expect(parsed.host).toBe(ROOTED_PG_HOST);
    expect(parsed.port).toBe('55432');
    expect(parsed.database).toBe('shop');
  });

  it('ioredis preserves the trailing dot', () => {
    // lazyConnect: parse only — this test must never open a socket.
    const redis = new IORedis(`redis://${ROOTED_REDIS_HOST}:6379`, { lazyConnect: true });
    try {
      expect(redis.options.host).toBe(ROOTED_REDIS_HOST);
      expect(redis.options.port).toBe(6379);
    } finally {
      redis.disconnect();
    }
  });

  it('the WHATWG URL parser preserves the trailing dot', () => {
    // Anything reading DATABASE_URL via `new URL(...)` rather than a pg parser.
    expect(new URL(`postgres://${ROOTED_PG_HOST}:55432/shop`).hostname).toBe(ROOTED_PG_HOST);
  });

  it('the unrooted forms are what the rooted host is distinguished FROM', () => {
    // Guards the assertions above against being trivially true: an unrooted host
    // parses just as happily, so "it parsed" is not the property under test — the
    // preserved ROOT LABEL is.
    const unrooted = parsePg(
      `postgres://app_shop:pw@pggw-apps.scale-zero-pg.svc.cluster.local:55432/shop`,
    );
    expect(unrooted.host).toBe('pggw-apps.scale-zero-pg.svc.cluster.local');
    expect(unrooted.host).not.toBe(ROOTED_PG_HOST);
  });
});
