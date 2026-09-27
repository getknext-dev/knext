#!/usr/bin/env node
/**
 * ADR-0049 credential preflight (#874) — refuse a credential broader than the
 * one stage 1 asks for. Extended by the #1495 fix below.
 *
 * The classification logic is NOT here. It lives in `@getknext/core`
 * (`cli/ci/credential-scope.ts`), beside the Role definition that
 * `kn-next init-ci` generates from — so what the client is told to apply,
 * what this refuses, and which hazards it probes cannot drift. This file is
 * the thin part: ask the cluster what the credential can do, hand the answer
 * over, print the verdict.
 *
 * The cloud-credential (exec/auth-provider) refusal is NOT here either. It is
 * `kubeconfig-check.mjs`, a separate action step, because this step can be
 * switched off with `skip-credential-preflight` and that one must not be.
 *
 * Fails CLOSED, at every stage. If a check cannot be performed, that is a
 * refusal, not a pass: a check that goes green when it cannot see is worse
 * than no check, because it reports safety it never established.
 *
 * Two refusals, in order:
 *
 *   1. (#874) `SelfSubjectRulesReview` reports a grant outside the published
 *      `CI_ROLE_RULES` Role.
 *   2. (#1495) A `SelfSubjectAccessReview` spot-check — the probe set
 *      `hazardProbes()` derives from the Role plus a fixed escalation list —
 *      reports ANY probe allowed, or any review cannot be performed or comes
 *      back without a boolean verdict. On a webhook authorizer (OKE/GKE IAM)
 *      the rules review is `incomplete` and silent about IAM grants; these
 *      point queries are what still answer there.
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { loadFromCore } from './load-core.mjs';

const { values } = parseArgs({
  options: { namespace: { type: 'string' } },
  allowPositionals: false,
});

const namespace = values.namespace;
if (!namespace) {
  console.error('preflight: --namespace is required');
  process.exit(1);
}

const RULES_PATH = '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews';
const ACCESS_PATH = '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews';

/**
 * POST `body` to the apiserver at `rawPath` via `kubectl create --raw`, with
 * NO client-side validation (see the long #1493/#1500 history this preserves
 * verbatim): `kubectl auth can-i --list` never accepts `-o`/`--output` on any
 * kubectl release, and `kubectl create` WITHOUT `--raw` does client-side
 * schema validation that itself needs `list` on
 * `customresourcedefinitions.apiextensions.k8s.io` — a cluster-scoped
 * resource the scoped `knext-deployer` ServiceAccount is never granted.
 * `--raw` talks to the apiserver directly: no CRD list, no schema check.
 *
 * Falls back to `create -o json --validate=false -f -` ONLY when `--raw`
 * itself is unrecognized by this kubectl release (none checked lacked it;
 * it has shipped since well before 1.25) — never on an authorization
 * refusal, which must propagate as-is rather than being masked by a retry
 * into a differently-shaped request.
 */
function submitRaw(rawPath, body) {
  try {
    return execFileSync('kubectl', ['create', '--raw', rawPath, '-f', '-'], {
      encoding: 'utf8',
      input: body,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const looksLikeUnknownFlag =
      /unknown flag/i.test(message) || /unknown shorthand flag/i.test(message);
    if (!looksLikeUnknownFlag) throw err;
    console.error(
      "::warning::This kubectl does not recognize 'create --raw' — falling back to " +
        "'create -o json --validate=false -f -' (same request, client-side validation " +
        'disabled explicitly rather than bypassed via --raw).',
    );
    return execFileSync('kubectl', ['create', '-o', 'json', '--validate=false', '-f', '-'], {
      encoding: 'utf8',
      input: body,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}

function effectiveRules() {
  const review = JSON.stringify({
    apiVersion: 'authorization.k8s.io/v1',
    kind: 'SelfSubjectRulesReview',
    spec: { namespace },
  });
  const out = submitRaw(RULES_PATH, review);
  const parsed = JSON.parse(out);
  const status = parsed?.status;
  const rules = status?.resourceRules;
  if (!status || !Array.isArray(rules)) {
    throw new Error('SelfSubjectRulesReview returned no resourceRules');
  }
  // `status.incomplete` means the authorizer could not fully resolve the
  // caller's rules — the normal answer from a webhook authorizer (OKE/GKE
  // IAM backends say "webhook authorizer does not support user rule
  // resolution"). Warn, don't fail closed HERE: refusing on this alone would
  // refuse every credential on a webhook-authorized cluster, including a
  // correctly-scoped one. The hazardous-permission spot-check below is what
  // actually verifies safety on exactly this cluster class (#1495) — this
  // warning is informational, not a decision point by itself any more.
  if (status.incomplete) {
    console.error(
      '::warning::The cluster reports this SelfSubjectRulesReview as incomplete ' +
        '(it could not fully resolve what this credential can do — common on ' +
        'webhook-authorized clusters such as OKE or GKE with IAM). Evaluating the ' +
        'rules it did return, and relying on the hazardous-permission spot-check ' +
        '(SelfSubjectAccessReview) below rather than failing closed here, because ' +
        'failing closed on incompleteness ALONE would refuse the scoped credential ' +
        'this check exists to allow, not just an over-broad one.' +
        `${status.evaluationError ? ` Cluster said: ${status.evaluationError}` : ''}`,
    );
  }
  return rules;
}

let rules;
try {
  rules = effectiveRules();
} catch (err) {
  console.error('::error::Could not determine what this credential can do.');
  console.error(
    'The cluster did not answer a SelfSubjectRulesReview, so knext cannot ' +
      'confirm the kubeconfig is scoped rather than cluster-admin. Refusing ' +
      'rather than proceeding: a credential check that passes when it cannot ' +
      'see is not a check.',
  );
  console.error(`\nunderlying error: ${err instanceof Error ? err.message : String(err)}`);
  console.error(
    '\nIf your cluster genuinely does not implement SelfSubjectRulesReview, ' +
      'set `skip-credential-preflight: true` — and understand that you are ' +
      'turning off the check, not satisfying it.',
  );
  process.exit(1);
}

const { classifyCredentialScope, hazardProbes } = await loadFromCore(
  'credential-scope',
  'the credential classifier',
);
if (typeof classifyCredentialScope !== 'function' || typeof hazardProbes !== 'function') {
  // An older @getknext/core without the derived probe set: refusing is the
  // only answer that does not report a spot-check nobody ran.
  console.error(
    '::error::This @getknext/core does not provide the credential classifier and ' +
      'hazard probe set this action needs. Upgrade @getknext/core. Refusing.',
  );
  process.exit(1);
}

const verdict = classifyCredentialScope(rules);
if (!verdict.ok) {
  console.error('::error::This kubeconfig grants more than knext needs. Refusing to use it.');
  console.error('\nFound:');
  for (const f of verdict.findings) console.error(`  - ${f}`);
  console.error(`\n${verdict.remedy}`);
  process.exit(1);
}

// ── #1495: hazardous-permission spot-check ──────────────────────────────────
// A webhook authorizer answers a targeted SelfSubjectAccessReview even when
// it cannot answer the broad SelfSubjectRulesReview above — this is what lets
// the check be fail-CLOSED on exactly the cluster class the old code failed
// open on. `hazardProbes` never asks for anything the published Role grants
// in this namespace, so a correctly-scoped credential answers "no" to all.

/**
 * One review. Returns the verdict, or THROWS — and the caller refuses — when
 * the reply is not a completed review: non-JSON, no `status`, a non-boolean
 * `allowed` (the string "true" is not a verdict), or an `evaluationError`
 * (the authorizer did not finish deciding, whatever `allowed` says).
 */
function checkHazard(probe) {
  const review = JSON.stringify({
    apiVersion: 'authorization.k8s.io/v1',
    kind: 'SelfSubjectAccessReview',
    spec: {
      resourceAttributes: {
        ...(probe.namespace !== undefined ? { namespace: probe.namespace } : {}),
        group: probe.group,
        resource: probe.resource,
        ...(probe.subresource ? { subresource: probe.subresource } : {}),
        verb: probe.verb,
      },
    },
  });
  const out = submitRaw(ACCESS_PATH, review);
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`the review of "${probe.label}" did not return JSON`);
  }
  const status = parsed?.status;
  if (typeof status !== 'object' || status === null) {
    throw new Error(`the review of "${probe.label}" returned no status`);
  }
  if (typeof status.evaluationError === 'string' && status.evaluationError !== '') {
    throw new Error(`the review of "${probe.label}" did not complete: ${status.evaluationError}`);
  }
  if (typeof status.allowed !== 'boolean') {
    throw new Error(`the review of "${probe.label}" returned no boolean verdict`);
  }
  return status.allowed;
}

let hazardsFound;
try {
  const probes = hazardProbes(namespace);
  if (!Array.isArray(probes) || probes.length === 0) {
    throw new Error('the hazard probe set is empty');
  }
  hazardsFound = probes.filter((probe) => checkHazard(probe));
} catch (err) {
  console.error(
    '::error::Could not run the hazardous-permission spot-check (SelfSubjectAccessReview).',
  );
  console.error(
    'Refusing rather than proceeding: a credential check that passes when it cannot see ' +
      'is not a check. A review with no verdict is a review that did not run.',
  );
  console.error(`\nunderlying error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (hazardsFound.length > 0) {
  console.error(
    '::error::This kubeconfig can do things far outside what knext needs. Refusing to use it.',
  );
  console.error('\nAllowed (any ONE of these is disqualifying):');
  for (const h of hazardsFound) console.error(`  - ${h.label}`);
  console.error(`\n${verdict.remedy}`);
  process.exit(1);
}

console.log(`preflight: credential is correctly scoped for namespace "${namespace}".`);
process.exit(0);
