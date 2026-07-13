import { describe, expect, it } from 'vitest';
import { checkLiveDbDsn } from './integration/live-dsn-guard';

/**
 * HERMETIC unit tests for the live-lane DSN host guard (plan P2 safety gate).
 *
 * The live-Postgres integration suite writes to — and drops databases on —
 * whatever `DATABASE_URL` points at. A typo'd *real* DSN (a prod CNPG service,
 * a cloud host) must therefore be REFUSED before any connection is opened:
 * only loopback hosts (localhost / 127.0.0.0/8 / ::1) and the conventional CI
 * service hostname `postgres` are allowed, unless the operator explicitly sets
 * `KNEXT_DB_LIVE_UNSAFE_HOST=1`. This is the same ownership-guard idea as the
 * e2e namespace-teardown authorization, applied to databases.
 *
 * The guard is a pure function (env read at the call site), so these tests
 * need no database and always run.
 */
describe('checkLiveDbDsn — live-lane DSN host guard', () => {
  describe('allowed hosts (safe to receive test writes)', () => {
    it.each([
      'postgres://knext:knext@localhost:5432/knext',
      'postgres://knext:knext@127.0.0.1:55432/knext',
      'postgres://knext:knext@127.0.0.53:5432/knext', // any 127/8 loopback
      'postgres://knext:knext@[::1]:5432/knext',
      'postgresql://knext:knext@localhost/knext?application_name=knext-live',
      'postgres://knext:knext@postgres:5432/knext', // CI service container hostname
    ])('accepts %s', (dsn) => {
      expect(checkLiveDbDsn(dsn)).toEqual({ ok: true });
    });

    it('accepts loopback hosts case-insensitively', () => {
      expect(checkLiveDbDsn('postgres://u:p@LOCALHOST:5432/db').ok).toBe(true);
    });
  });

  describe('refused hosts (anything that could be a real database)', () => {
    it.each([
      'postgres://u:p@db.prod.example.com:5432/app',
      'postgres://u:p@shop-db.my-apps.svc.cluster.local:5432/shop', // an in-cluster DB service
      'postgres://u:p@10.0.12.7:5432/app', // private IP is NOT loopback
      'postgres://u:p@192.168.1.10:5432/app',
      'postgres://u:p@my-postgres:5432/app', // near-miss of the service name
      'postgres://u:p@localhost.evil.com:5432/app', // suffix trick
    ])('refuses %s', (dsn) => {
      const res = checkLiveDbDsn(dsn);
      expect(res.ok).toBe(false);
      // Narrowing guard (type-only, #261): `reason` only exists on the
      // refusal arm of LiveDsnCheck; the assertion above already proved it.
      if (res.ok) throw new Error('unreachable: guard accepted an unsafe DSN');
      expect(res.reason).toMatch(/KNEXT_DB_LIVE_UNSAFE_HOST/);
    });

    it('fails closed on an unparseable DSN (e.g. libpq key=value form)', () => {
      const res = checkLiveDbDsn('host=db.prod.example.com port=5432 dbname=app');
      expect(res.ok).toBe(false);
      // Narrowing guard (type-only, #261) — see above.
      if (res.ok) throw new Error('unreachable: guard accepted an unsafe DSN');
      expect(res.reason).toMatch(/parse/i);
    });

    it('fails closed on an empty DSN', () => {
      expect(checkLiveDbDsn('').ok).toBe(false);
    });

    it('fails closed on a DSN with an empty host', () => {
      expect(checkLiveDbDsn('postgres:///knext').ok).toBe(false);
    });
  });

  describe('explicit unsafe override', () => {
    it('allows a non-loopback host only when allowUnsafeHost is set', () => {
      const dsn = 'postgres://u:p@db.staging.example.com:5432/app';
      expect(checkLiveDbDsn(dsn).ok).toBe(false);
      expect(checkLiveDbDsn(dsn, { allowUnsafeHost: true })).toEqual({ ok: true });
    });
  });
});
