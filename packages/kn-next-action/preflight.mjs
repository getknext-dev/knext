#!/usr/bin/env node
/**
 * ADR-0049 credential preflight (#874) — refuse a credential broader than the
 * one stage 1 asks for.
 *
 * The classification logic is NOT here. It lives in `@getknext/core`
 * (`cli/ci/credential-scope.ts`), beside the Role definition that
 * `kn-next init-ci` generates from — so what the client is told to apply and
 * what this refuses cannot drift apart. This file is the thin part: ask the
 * cluster what the credential can do, hand the answer over, print the verdict.
 *
 * Fails CLOSED. If the review cannot be performed, that is a refusal, not a
 * pass: a check that goes green when it cannot see is worse than no check,
 * because it reports safety it never established.
 */
import { execFileSync } from 'node:child_process';
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
 * Ask the cluster for a `SelfSubjectRulesReview` — a virtual resource: the
 * apiserver evaluates it against the caller's own identity and returns the
 * answer, nothing is persisted. Asking the CLUSTER is the point: a kubeconfig
 * does not state its own permissions, so reading the file would tell us
 * nothing about what it can actually do.
 *
 * `kubectl auth can-i --list` performs this exact review but does NOT accept
 * `-o`/`--output` on any kubectl release (checked 1.25 through 1.37; the
 * flag has never existed for that subcommand) — #1493 was this preflight
 * shipping `-o json` on that command and refusing on every runner. `kubectl
 * create -o json -f -`, by contrast, supports `-o json` on every kubectl
 * release, so submitting the review object directly is version-independent
 * where scraping `can-i`'s table output never was. `kubectl get --raw` is not
 * an option here: a review is created (POST), not read (GET).
 */
function effectiveRules() {
  const review = JSON.stringify({
    apiVersion: 'authorization.k8s.io/v1',
    kind: 'SelfSubjectRulesReview',
    spec: { namespace },
  });
  const out = execFileSync('kubectl', ['create', '-o', 'json', '-f', '-'], {
    encoding: 'utf8',
    input: review,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(out);
  const status = parsed?.status;
  const rules = status?.resourceRules;
  if (!status || !Array.isArray(rules)) {
    throw new Error('SelfSubjectRulesReview returned no resourceRules');
  }
  // `status.incomplete` means the authorizer could not fully resolve the
  // caller's rules — the normal answer from a webhook authorizer (OKE/GKE IAM
  // backends say "webhook authorizer does not support user rule resolution").
  // Warn, don't fail closed: refusing here would refuse every credential on a
  // webhook-authorized cluster, including a correctly-scoped one — not just an
  // over-broad one. A SelfSubjectAccessReview spot-check of the hazardous
  // verbs would close this gap; that is tracked as separate security
  // tech-debt (#1495), not fixed here.
  if (status.incomplete) {
    console.error(
      '::warning::The cluster reports this SelfSubjectRulesReview as incomplete ' +
        '(it could not fully resolve what this credential can do — common on ' +
        'webhook-authorized clusters such as OKE or GKE with IAM). Evaluating the ' +
        'rules it did return rather than failing closed, because failing closed ' +
        'here would refuse the scoped credential this check exists to allow, not ' +
        `just an over-broad one.${status.evaluationError ? ` Cluster said: ${status.evaluationError}` : ''}`,
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

// Resolved from the installed CLI so there is exactly one copy of the rules —
// and resolved from the APP, not from this file. The action step runs in the
// app's working directory, which is where `@getknext/core` is installed. A bare
// `import('@getknext/core/…')` here would resolve relative to THIS file, i.e.
// the action's own checkout, which has no node_modules — so it failed for every
// consumer. Fails closed like everything above: no classifier, no pass.
let classifyCredentialScope;
try {
  const fromApp = createRequire(join(process.cwd(), 'package.json'));
  const entry = fromApp.resolve('@getknext/core/internal/credential-scope');
  ({ classifyCredentialScope } = await import(pathToFileURL(entry).href));
} catch (err) {
  console.error('::error::Could not load the credential classifier from @getknext/core.');
  console.error(
    `Looked from ${process.cwd()}. Install your app's dependencies (e.g. \`npm ci\`) ` +
      'before this action, so `@getknext/core` is resolvable from `working-directory`.',
  );
  console.error(`\nunderlying error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const verdict = classifyCredentialScope(rules);
if (verdict.ok) {
  console.log(`preflight: credential is correctly scoped for namespace "${namespace}".`);
  process.exit(0);
}

console.error('::error::This kubeconfig grants more than knext needs. Refusing to use it.');
console.error('\nFound:');
for (const f of verdict.findings) console.error(`  - ${f}`);
console.error(`\n${verdict.remedy}`);
process.exit(1);
