#!/usr/bin/env node
/**
 * ADR-0049 credential preflight (#874) — refuse a credential broader than the
 * one stage 1 asks for. Extended by #1533 (ADR-0061) and the #1495 fix below.
 *
 * The classification logic is NOT here. It lives in `@getknext/core`
 * (`cli/ci/credential-scope.ts`, `cli/ci/kubeconfig-safety.ts`), beside the
 * Role definition that `kn-next init-ci` generates from — so what the client
 * is told to apply and what this refuses cannot drift. This file is the thin
 * part: ask the cluster (and read the local kubeconfig file) what the
 * credential is and can do, hand the answer over, print the verdict.
 *
 * Fails CLOSED, at every stage. If a check cannot be performed, that is a
 * refusal, not a pass: a check that goes green when it cannot see is worse
 * than no check, because it reports safety it never established.
 *
 * Three refusals, in order (cheapest and least cluster-dependent first):
 *
 *   0. (#1533/ADR-0061) The kubeconfig FILE carries an `exec:` or
 *      `auth-provider:` user entry — it authenticates by running a CLOUD CLI
 *      on this runner with a cloud account's credentials in scope, which is
 *      exactly what ADR-0061 says knext must never touch. Checked before any
 *      kubectl call at all — this needs no cluster contact.
 *   1. (#874, unchanged) `SelfSubjectRulesReview` reports a grant outside the
 *      published `CI_ROLE_RULES` Role.
 *   2. (#1495 fix) A `SelfSubjectAccessReview` spot-check of hazardous
 *      verbs/resources reports ANY of them allowed, or the review cannot be
 *      performed at all. This is the fail-CLOSED replacement for the old
 *      behaviour, where `status.incomplete` on the rules review (the normal
 *      answer from a webhook authorizer — OKE/GKE IAM) came back with EMPTY
 *      `resourceRules`, which the rules classifier then read as "nothing to
 *      complain about" — a credential no broader-permission check had ever
 *      actually looked at. `status.incomplete` alone no longer decides
 *      anything by itself; this spot-check is the backstop for exactly the
 *      cluster class where the rules review is blind.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { namespace: { type: 'string' } },
  allowPositionals: false,
});

const namespace = values.namespace;
if (!namespace) {
  console.error('preflight: --namespace is required');
  process.exit(1);
}

/**
 * Resolve an `@getknext/core` internal subpath from the APP's node_modules —
 * the step's working directory, where the app installed its dependencies —
 * never from this file's own location. A bare `import('@getknext/core/…')`
 * here would resolve relative to THIS file (the action's own checkout, which
 * has no node_modules), which failed for every consumer (#1481).
 */
async function loadFromCore(subpath, whatFor) {
  try {
    const fromApp = createRequire(join(process.cwd(), 'package.json'));
    const entry = fromApp.resolve(`@getknext/core/internal/${subpath}`);
    return await import(pathToFileURL(entry).href);
  } catch (err) {
    console.error(`::error::Could not load ${whatFor} from @getknext/core.`);
    console.error(
      `Looked from ${process.cwd()}. Install your app's dependencies (e.g. \`npm ci\`) ` +
        'before this action, so `@getknext/core` is resolvable from `working-directory`.',
    );
    console.error(`\nunderlying error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// ── 0. Refuse a cloud-credential kubeconfig, before any cluster call ────────
// Only runs when KUBECONFIG is actually set — the action's own "Configure
// cluster access" step always sets it before this one runs; a bare `node
// preflight.mjs` invocation with no kubeconfig configured (as in tests that
// exercise ONLY the rules/access-review behaviour) is unaffected.
if (process.env.KUBECONFIG) {
  let kubeconfigRaw;
  try {
    kubeconfigRaw = readFileSync(process.env.KUBECONFIG, 'utf8');
  } catch (err) {
    console.error(`::error::Could not read the kubeconfig at ${process.env.KUBECONFIG}.`);
    console.error(`\nunderlying error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const { classifyKubeconfigSafety } = await loadFromCore(
    'kubeconfig-safety',
    'the kubeconfig safety classifier',
  );
  const safety = classifyKubeconfigSafety(kubeconfigRaw);
  if (!safety.ok) {
    console.error(`::error::${safety.reason}`);
    process.exit(1);
  }
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

const { classifyCredentialScope } = await loadFromCore(
  'credential-scope',
  'the credential classifier',
);

const verdict = classifyCredentialScope(rules);
if (!verdict.ok) {
  console.error('::error::This kubeconfig grants more than knext needs. Refusing to use it.');
  console.error('\nFound:');
  for (const f of verdict.findings) console.error(`  - ${f}`);
  console.error(`\n${verdict.remedy}`);
  process.exit(1);
}

// ── #1495 fix: hazardous-permission spot-check ──────────────────────────────
// A webhook authorizer answers a targeted SelfSubjectAccessReview even when
// it cannot answer the broad SelfSubjectRulesReview above — this is what lets
// the fix be fail-CLOSED on exactly the cluster class the old code failed
// open on. Every one of these is a permission the published Role
// (`CI_ROLE_RULES`) never grants, so a correctly-scoped credential answers
// "not allowed" to all five.
const HAZARD_CHECKS = [
  {
    group: '*',
    resource: '*',
    verb: '*',
    namespaced: false,
    label: 'wildcard on everything (*/*/*) — cluster-admin-shaped',
  },
  { group: '', resource: 'secrets', verb: 'get', namespaced: true, label: 'get secrets' },
  {
    group: 'apps.kn-next.dev',
    resource: 'nextapps',
    verb: 'delete',
    namespaced: true,
    label: 'delete nextapps',
  },
  {
    group: 'rbac.authorization.k8s.io',
    resource: 'clusterrolebindings',
    verb: 'create',
    namespaced: false,
    label: 'create clusterrolebindings',
  },
  {
    group: '',
    resource: 'users',
    verb: 'impersonate',
    namespaced: false,
    label: 'impersonate another user',
  },
];

function checkHazard(check) {
  const review = JSON.stringify({
    apiVersion: 'authorization.k8s.io/v1',
    kind: 'SelfSubjectAccessReview',
    spec: {
      resourceAttributes: {
        ...(check.namespaced ? { namespace } : {}),
        group: check.group,
        resource: check.resource,
        verb: check.verb,
      },
    },
  });
  const out = submitRaw(ACCESS_PATH, review);
  const parsed = JSON.parse(out);
  return parsed?.status?.allowed === true;
}

let hazardsFound;
try {
  hazardsFound = HAZARD_CHECKS.filter((check) => checkHazard(check));
} catch (err) {
  console.error(
    '::error::Could not run the hazardous-permission spot-check (SelfSubjectAccessReview).',
  );
  console.error(
    'Refusing rather than proceeding: a credential check that passes when it cannot see ' +
      'is not a check. This is the fail-CLOSED replacement for the old behaviour, where an ' +
      'incomplete rules review with no resourceRules was read as "nothing to complain about".',
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
