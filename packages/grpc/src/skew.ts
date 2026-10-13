/**
 * The contract skew rule between a zone and one of its functions.
 *
 * A zone's generated client is built against a contract version (the
 * `(knext.v1.contract_version)` file option). The function serving that
 * contract must be at that version or newer: a newer function still serves
 * every RPC and field an older zone uses (`buf breaking` holds that), while an
 * older function may lack an RPC or a field the newer zone sends. Hence the
 * rollout order — the function first, then the zone — and the rule
 * `function version >= zone version`. A function older than its zone is skew.
 *
 * The rule is FLAGGED, not enforced: nothing here holds a rollout back, and a
 * GitOps controller applies both resources in its own order. The served
 * version comes from the deployed function's status once the operator records
 * it; `checkContractSkew` is the comparison that reading will feed.
 */

import { compareVersions, parseVersion } from './semver';

/** Roll out the function first, then the zone. */
export const ROLLOUT_ORDER = ['function', 'zone'] as const;

export interface SkewInput {
  /** The contract version the function serves. */
  readonly functionVersion: string | undefined;
  /** The contract version the zone's client was generated against. */
  readonly zoneVersion: string | undefined;
}

export type SkewVerdict =
  | { readonly skew: false }
  | { readonly skew: true; readonly reason: string };

/**
 * Compare a function's contract version against its zone's. Fails closed: if
 * either version is missing or unreadable, that is reported as skew, because
 * "cannot tell" must not read as "compatible".
 */
export function checkContractSkew({ functionVersion, zoneVersion }: SkewInput): SkewVerdict {
  const fn = functionVersion ?? '';
  const zone = zoneVersion ?? '';
  if (!parseVersion(fn) || !parseVersion(zone)) {
    return {
      skew: true,
      reason:
        `cannot compare contract versions (function "${fn}", zone "${zone}"): ` +
        'both must be MAJOR.MINOR.PATCH. Treating this as skew.',
    };
  }
  if (compareVersions(fn, zone) < 0) {
    return {
      skew: true,
      reason:
        `the function serves contract ${fn}, older than the zone's ${zone}. ` +
        'Roll out the function first, then the zone.',
    };
  }
  return { skew: false };
}
