import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * REPO-WIDE scan: no in-cluster Postgres-gateway host may be written UNROOTED, in any
 * tracked file, unless it is covered by an explicit, justified deferral below.
 *
 * Why this exists as well as `rooted-minted-hosts.test.ts`: that guard reads an
 * enumerated four-file list, inside a docblock promising "SCAN, don't enumerate". It
 * therefore checked the VALUES the platform mints but could never see a fifth minting
 * artifact, and scanned no documentation at all. The consequence was measured, not
 * theorised — after two rounds of fixes, three app-consumed `DATABASE_URL` recipes
 * were still teaching the short host, each one contradicting a file this very change
 * had already rooted. Enumeration is how the second instance gets missed; this file is
 * the scan.
 *
 * Division of labour, kept deliberately separate:
 *   - `rooted-minted-hosts.test.ts` asserts the minting VALUES (per writer, per file).
 *   - this file asserts every REFERENCE, everywhere, including prose and docs.
 *
 * The deferral list is fail-closed in BOTH directions (the #784 allowlist pattern):
 * an unrooted host that matches no rule FAILS, and a rule that matches nothing also
 * FAILS. Without the second half a deferral silently outlives the thing it excused —
 * the exact way an allowlist rots into a blanket exemption.
 */

const REPO_ROOT = join(import.meta.dirname, '..');

/** Hosts written inside a `postgres://` / `redis://` URL authority. */
const CONNECTION_URL = /(?:postgres|postgresql|redis|rediss):\/\/([^\s'"`)\]\\]+)/g;

/**
 * A Postgres-gateway cluster-DNS name written OUTSIDE a URL — e.g. prose like
 * "the DATABASE_URL Secret → `pggw.scale-zero-pg.svc:55432`", which carries no scheme
 * and so is invisible to the pattern above. That form is precisely one of the three
 * survivors this scan was written to catch.
 */
const BARE_GATEWAY_DNS = /\bpggw[a-z0-9-]*(?:\.[A-Za-z0-9_${}-]+)*\.svc(?:\.cluster\.local)?\.?/g;

function hostOfAuthority(authority: string): string {
  let a = authority.split('/')[0];
  const at = a.lastIndexOf('@');
  if (at >= 0) a = a.slice(at + 1);
  // strip the port, whether literal, ${VAR} or $VAR
  return a.replace(/:(\d+|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*).*$/, '');
}

/** In-cluster = a Kubernetes DNS name, or a bare gateway Service name. */
const isInClusterHost = (h: string) => /\.svc(\.|$)/.test(h) || /^pggw[a-z0-9-]*$/.test(h);

function unrootedClusterHostsInText(text: string): string[] {
  const fromUrls = [...text.matchAll(CONNECTION_URL)]
    .map((m) => hostOfAuthority(m[1]))
    .filter(isInClusterHost);
  const bare = [...text.matchAll(BARE_GATEWAY_DNS)].map((m) => m[0]);
  return [...fromUrls, ...bare].filter((h) => !h.endsWith('.'));
}

type Deferral = { id: string; reason: string; match: (file: string, host: string) => boolean };

/**
 * Deferrals. Each is a decision with a reason, not an exhaustiveness claim — and each
 * is asserted below to still cover something real.
 */
const DEFERRALS: Deferral[] = [
  {
    id: 'measurement-records-quote-evidence',
    reason:
      'benchmark/ledger records quote OBSERVED hostnames verbatim — error strings (EAI_AGAIN pggw-apps.scale-zero-pg.svc), resolv.conf walks, and pre-fix DSNs are evidence of what happened, not recipes; rooting a quoted observation would falsify the record.',
    match: (f) => /^docs\/benchmarks\//.test(f),
  },
  {
    id: 'gateway-internal-compute-targets',
    reason:
      'compute-* hosts are dialled gateway-internally (wake targets, per-app computes), never written into an app-consumed Secret.',
    match: (_f, h) => /^compute[-.]/.test(h),
  },
  {
    id: 'documentation-placeholder-hosts',
    reason:
      "placeholder hostnames in EXPLANATORY PROSE (acme-*, shop-*, byo-*, my-*) stand for a reader's own service. Copy-paste RECIPE lines are NOT covered any more: since the fm-redis rooting, recipes teach the rooted form (the README now does), so an unrooted placeholder in a config/yaml/env recipe is a defect, not a placeholder convention. Narrowed to .md/.mdx prose files only; recipe-bearing config samples and skills must root.",
    match: (f, h) => /^(acme|shop|byo|my)[-.]/.test(h) && /\.(md|mdx)$/.test(f),
  },
  {
    id: 'drill-scripts',
    reason:
      'drill and bakeoff scripts dial the gateway from a throwaway psql pod to verify wake behaviour. They are not minting paths, and their DSNs never reach an app Secret.',
    match: (f) =>
      /packages\/scale-zero-pg\/deploy\/(_verify-|_lib-drill|test_verify-)/.test(f) ||
      /packages\/scale-zero-pg\/(bakeoff|demo)\/.*\.sh$/.test(f),
  },
  {
    id: 'zone-operator-compute-side-conninfo',
    reason:
      "ZONE_GATEWAY_HOST is embedded in Postgres subscription/FDW conninfo and resolved by the COMPUTE's libpq on a long-lived replication connection, not by a fresh app pod's first flows. Different consumer, different lever; both sites carry an in-tree comment saying so.",
    match: (f) =>
      /gateway\/cmd\/zone-operator\/main\.go$/.test(f) ||
      /gateway\/internal\/zone\/ports\.go$/.test(f) ||
      /deploy\/87-zone-operator\.yaml$/.test(f),
  },
  {
    id: 'tls-san-list',
    reason:
      'gen-tls.sh SANs are certificate DNS names, where a trailing dot is not conventional. Every minted DSN is sslmode=disable today, so no cert-name comparison is in play. FOLLOW-UP, not silently accepted: under verify-full a rooted host would not match these SANs — that mismatch predates this change (it already failed for the 4-dot FQDN) and belongs with whoever owns the TLS story.',
    match: (f) => /deploy\/gen-tls\.sh$/.test(f),
  },
  {
    id: 'platform-internal-dial-targets',
    reason:
      'hosts a platform component dials internally (e.g. the warm compute scraping the gateway metrics port), never written into an app-consumed Secret. Same lever, different consumer and blast radius.',
    match: (f) => /deploy\/25-compute-warm\.yaml$/.test(f),
  },
  {
    id: 'rooting-explainer-prose',
    reason:
      'these texts EXPLAIN the rooting rule and must name the unrooted forms to contrast them — the const docblock, the API doc paragraph, and the agent working notes. Narrow by design: only files that document the lever itself.',
    match: (f) =>
      /gateway\/internal\/appdb\/ports\.go$/.test(f) ||
      /packages\/scale-zero-pg\/docs\/appdatabase-api\.md$/.test(f) ||
      // .claude agent notes may quote unrooted forms as evidence — but NOT
      // .claude/skills/: those carry copy-paste templates users deploy from,
      // so they must root (the knext-deploy CR template was exactly that).
      (/^\.claude\//.test(f) && !/^\.claude\/skills\//.test(f)),
  },
  {
    id: 'test-fixtures',
    reason:
      'fixture DSNs inside test files; they assert behaviour against a literal, and rooting them would only move the literal.',
    match: (f) => /(_test\.go|__tests__\/|\/test\/e2e\/)/.test(f),
  },
  {
    id: 'historical-records',
    reason:
      'ADRs and benchmark records state what was decided/measured at the time. Rewriting them would falsify the record.',
    match: (f) => /packages\/scale-zero-pg\/docs\/(adr-|BENCHMARKS\.md)/.test(f),
  },
  {
    id: 'operator-runbook-dial-targets',
    reason:
      'operations.md hosts are psql/kubectl commands an operator runs interactively against the gateway — dial targets, not minted values.',
    match: (f) => /packages\/scale-zero-pg\/docs\/operations\.md$/.test(f),
  },
  {
    id: 'this-guards-own-fixtures',
    reason:
      'the rooted-host guards must contain unrooted literals — they are the negative cases the predicates are tested against.',
    match: (f) => /^tests\/rooted-/.test(f),
  },
];

function trackedTextFiles(): string[] {
  return execSync('git ls-files', { cwd: REPO_ROOT, maxBuffer: 1e8 }).toString().trim().split('\n');
}

type Violation = { file: string; host: string };

function scanRepo(): Violation[] {
  const out: Violation[] = [];
  for (const file of trackedTextFiles()) {
    let text: string;
    try {
      text = readFileSync(join(REPO_ROOT, file), 'utf8');
    } catch {
      continue; // unreadable/binary — nothing to assert
    }
    if (text.includes('\0')) continue;
    for (const host of new Set(unrootedClusterHostsInText(text))) out.push({ file, host });
  }
  return out;
}

describe('no unrooted in-cluster gateway host anywhere in the repo', () => {
  const violations = scanRepo();

  it('finds gateway hosts at all (the scan is not silently empty)', () => {
    // Vacuity guard: if `git ls-files` or the regexes broke, "no violations" would be
    // a green that proves nothing. There is always at least one deferred literal.
    expect(
      violations.length,
      'the repo-wide scan matched nothing — regex or git ls-files is broken',
    ).toBeGreaterThan(0);
  });

  it('has no unrooted host outside the deferral list', () => {
    const undeferred = violations.filter((v) => !DEFERRALS.some((d) => d.match(v.file, v.host)));
    const rendered = undeferred.map((v) => `${v.file} -> ${v.host}`).sort();
    expect(
      rendered,
      `these in-cluster hosts are written UNROOTED and match no deferral. Either root them (add the trailing dot) or add a justified deferral:\n  ${rendered.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has no stale deferral (every rule still covers something)', () => {
    const stale = DEFERRALS.filter((d) => !violations.some((v) => d.match(v.file, v.host))).map(
      (d) => d.id,
    );
    expect(
      stale,
      `these deferrals no longer match anything — delete them rather than leaving a standing exemption: ${stale.join(', ')}`,
    ).toEqual([]);
  });
});
