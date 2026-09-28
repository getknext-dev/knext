#!/usr/bin/env node
/**
 * compat-operator-digest-check — the pre-run half of #1530's operator-digest
 * guard.
 *
 * WHY. A credential night (ADR-0056) proves something about the knext REF
 * under test — the RC tag `scripts/compat-credential-ref.mjs` resolves. It
 * proves nothing about the OKE cluster's operator if that operator is running
 * a DIFFERENT image than the one the release actually shipped: a stale or
 * ahead-of-release operator could pass or fail shards for reasons that have
 * nothing to do with the knext ref under test, and a night graded on that
 * evidence would credential (or blame) the wrong thing.
 *
 * So before a single shard runs, this compares:
 *   * the LIVE digest — what the OKE operator Deployment is actually running
 *     right now (`kubectl get deployment ... -o jsonpath='{...image}'`);
 *   * the RELEASE digest — the digest recorded in the digest-pinned
 *     `install.yaml` GitHub Release asset for the RC tag the credential ref
 *     resolved (`packages/kn-next-operator/hack/check-published-digest.sh`
 *     is what pins that file to a real, non-placeholder digest at publish
 *     time; `.github/workflows/operator-supply-chain.yml` is what produces
 *     it, main-only, from the cosign-verified pushed digest).
 *
 * A MISMATCH marks the run INVALID — see
 * `scripts/compat-window-audit.mjs`'s `INVALID_REASONS` doc comment for why
 * that is a different, deliberately gentler outcome than a red night: the
 * run never produced a single shard of evidence, so it must not COST the
 * streak either. It must also never PASS: this script's CLI exits non-zero
 * on a mismatch precisely so a workflow step cannot accidentally treat
 * `state=mismatch` as "continue as normal" by forgetting to branch on it —
 * the workflow's own `if:` must route a non-zero exit to the invalid-ledger
 * path, never to the deploy path.
 *
 * Usage:
 *   node scripts/compat-operator-digest-check.mjs \
 *     --tag v1.0.0-rc.1 --repo getknext-dev/knext \
 *     --namespace knext-system --deployment kn-next-operator-controller-manager \
 *     [--kube-context knext-oke-sa]
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** `sha256:` followed by 64 lowercase hex chars. */
const DIGEST_RE = /sha256:[0-9a-f]{64}/;

/**
 * Pull the first `sha256:<hex>` digest out of an image reference string, e.g.
 * `ghcr.io/getknext-dev/kn-next-operator:v1.0.0@sha256:abc...`. Returns `null`
 * when the string carries no digest (a bare tag, `:latest`, or garbage) —
 * NEVER guesses one.
 *
 * @param {string|null|undefined} ref
 * @returns {string|null}
 */
export function extractDigest(ref) {
  if (typeof ref !== 'string') return null;
  const m = ref.match(DIGEST_RE);
  return m ? m[0] : null;
}

/**
 * Pull the operator's digest out of a rendered `install.yaml` bundle's text.
 * Scoped to `image:` lines only, so a digest appearing elsewhere in the
 * document (an annotation, a comment) is never mistaken for the shipped one.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function extractDigestFromInstallYaml(text) {
  if (typeof text !== 'string') return null;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:-\s*)?image:\s*(\S+)/);
    if (m) {
      const digest = extractDigest(m[1]);
      if (digest) return digest;
    }
  }
  return null;
}

/**
 * @typedef {object} DigestVerdict
 * @property {boolean} ok            true only when the digests match
 * @property {'match'|'mismatch'|'live-digest-missing'|'release-digest-missing'} state
 * @property {string} message
 */

/**
 * The pure decision: does the LIVE operator digest match the RELEASE digest
 * the credential ref resolved? Fails closed on either side being unreadable —
 * an unreadable digest is never treated as a match.
 *
 * @param {{ liveDigest: string|null, releaseDigest: string|null }} input
 * @returns {DigestVerdict}
 */
export function evaluateOperatorDigest({ liveDigest, releaseDigest }) {
  if (!liveDigest) {
    return {
      ok: false,
      state: 'live-digest-missing',
      message: 'could not read the OKE operator Deployment image digest',
    };
  }
  if (!releaseDigest) {
    return {
      ok: false,
      state: 'release-digest-missing',
      message: 'could not read the operator digest recorded for the resolved release',
    };
  }
  if (liveDigest !== releaseDigest) {
    return {
      ok: false,
      state: 'mismatch',
      message: `OKE operator is running ${liveDigest}, the release recorded ${releaseDigest} — the night is INVALID, not failed`,
    };
  }
  return { ok: true, state: 'match', message: 'OKE operator digest matches the release digest' };
}

/**
 * Read the live OKE operator Deployment's image digest via `kubectl`.
 *
 * @param {{ namespace: string, deployment: string, kubeContext?: string, container?: string }} opts
 * @returns {string|null}
 */
export function getLiveOperatorDigest(opts) {
  const args = [
    'get',
    'deployment',
    opts.deployment,
    '-n',
    opts.namespace,
    '-o',
    `jsonpath={.spec.template.spec.containers[?(@.name=="${opts.container ?? 'manager'}")].image}`,
  ];
  if (opts.kubeContext) args.splice(1, 0, '--context', opts.kubeContext);
  const r = spawnSync('kubectl', args, { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return extractDigest(String(r.stdout).trim());
}

/**
 * Read the operator digest recorded in the `install.yaml` GitHub Release
 * asset for `tag`.
 *
 * @param {{ repo: string, tag: string }} opts
 * @returns {string|null}
 */
export function getReleaseOperatorDigest(opts) {
  const r = spawnSync(
    'gh',
    ['release', 'download', opts.tag, '--repo', opts.repo, '-p', 'install.yaml', '-O', '-'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return null;
  return extractDigestFromInstallYaml(String(r.stdout));
}

/* c8 ignore start — CLI wrapper */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };

  const liveDigest = getLiveOperatorDigest({
    namespace: arg('namespace', 'knext-system'),
    deployment: arg('deployment', 'kn-next-operator-controller-manager'),
    kubeContext: arg('kube-context'),
    container: arg('container', 'manager'),
  });
  const releaseDigest = getReleaseOperatorDigest({
    repo: arg('repo', 'getknext-dev/knext'),
    tag: arg('tag'),
  });

  const verdict = evaluateOperatorDigest({ liveDigest, releaseDigest });

  const lines = [
    `state=${verdict.state}`,
    `ok=${verdict.ok ? 'true' : 'false'}`,
    `live_digest=${liveDigest ?? ''}`,
    `release_digest=${releaseDigest ?? ''}`,
  ];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### OKE operator digest pre-check\n\n| | |\n|---|---|\n| state | \`${verdict.state}\` |\n| live | \`${liveDigest ?? '—'}\` |\n| release | \`${releaseDigest ?? '—'}\` |\n\n${verdict.message}\n`,
    );
  }
  console.log(lines.join('\n'));
  if (!verdict.ok) {
    // Non-zero, ALWAYS — see the header comment on why this must never be
    // conflated with "continue". The workflow step that invokes this is
    // responsible for routing a non-zero exit to the invalid-ledger path,
    // never to the deploy path.
    console.error(`::warning::operator digest check: ${verdict.state} — ${verdict.message}`);
    process.exit(1);
  }
}
/* c8 ignore stop */
