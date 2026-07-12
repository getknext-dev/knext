/**
 * live-dsn-guard — the SAFETY gate of the `@knext/db` live-Postgres lane
 * (plan P2). Test infrastructure, not SDK API: it ships in no `exports`
 * subpath and never reaches `dist/`.
 *
 * The live suite writes rows to — and CREATE/DROPs databases on — whatever
 * `DATABASE_URL` points at. A typo'd *real* DSN (a prod CNPG service, a cloud
 * host) must never receive test writes, so before ANY connection is opened the
 * suite refuses every host that is not:
 *
 *   - loopback — `localhost`, any `127.0.0.0/8` IPv4, or `::1`; or
 *   - the conventional CI service-container hostname `postgres`.
 *
 * Anything else (cluster `*.svc` names, private IPs, cloud hosts, near-miss
 * hostnames) is refused unless `KNEXT_DB_LIVE_UNSAFE_HOST=1` is set explicitly
 * — the teardown-ownership-guard idea applied to databases. The check is
 * fail-closed: an unparseable DSN (e.g. libpq `key=value` form) is refused too.
 *
 * Pure function — the caller reads the env (`allowUnsafeHost`) so unit tests
 * stay hermetic.
 */

/** Result of {@link checkLiveDbDsn}: `ok`, or a refusal with a loud reason. */
export type LiveDsnCheck = { ok: true } | { ok: false; reason: string };

/** Options for {@link checkLiveDbDsn}. */
export interface CheckLiveDbDsnOptions {
  /**
   * Explicit operator override (`KNEXT_DB_LIVE_UNSAFE_HOST=1` at the call
   * site): accept any host. For deliberately pointing the lane at a
   * non-loopback throwaway database — never set in CI.
   */
  allowUnsafeHost?: boolean;
}

/** Exact (case-insensitive) hostnames the live lane may write to. */
export const LIVE_ALLOWED_HOSTS = ['localhost', '::1', 'postgres'] as const;

/** Is `host` an IPv4 loopback address (127.0.0.0/8)? */
function isIpv4Loopback(host: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function refuse(host: string): LiveDsnCheck {
  return {
    ok: false,
    reason:
      `refusing to run the live @knext/db suite against host "${host}" — it is not ` +
      `loopback (localhost / 127.0.0.0/8 / ::1) or the CI service hostname "postgres", ` +
      `so it could be a REAL database. The suite creates, writes to, and DROPs ` +
      `databases. If this throwaway host is intentional, set KNEXT_DB_LIVE_UNSAFE_HOST=1.`,
  };
}

/**
 * Decide whether the live lane may connect to `dsn`. Fail-closed: only a
 * URL-parseable DSN whose host is loopback or `postgres` passes without the
 * explicit `allowUnsafeHost` override.
 */
export function checkLiveDbDsn(dsn: string, opts: CheckLiveDbDsnOptions = {}): LiveDsnCheck {
  if (opts.allowUnsafeHost) {
    return { ok: true };
  }
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return {
      ok: false,
      reason:
        `refusing to run the live @knext/db suite: DATABASE_URL is not a parseable URL DSN ` +
        `(use postgres://user:pass@host:port/db — the libpq key=value form is not accepted ` +
        `here), so its host cannot be verified as loopback. Set KNEXT_DB_LIVE_UNSAFE_HOST=1 ` +
        `only if you are certain it targets a throwaway database.`,
    };
  }
  // Node's URL keeps brackets on IPv6 hostnames ("[::1]") — strip for compare.
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '') {
    return refuse('<empty>');
  }
  if ((LIVE_ALLOWED_HOSTS as readonly string[]).includes(host) || isIpv4Loopback(host)) {
    return { ok: true };
  }
  return refuse(host);
}
