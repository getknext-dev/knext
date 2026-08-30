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
 * `kubectl auth can-i --list` performs a SelfSubjectRulesReview and prints the
 * subject's effective rules in the namespace. Asking the CLUSTER is the point:
 * a kubeconfig does not state its own permissions, so reading the file would
 * tell us nothing about what it can actually do.
 */
function effectiveRules() {
  const out = execFileSync('kubectl', ['auth', 'can-i', '--list', '-n', namespace, '-o', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(out);
  // `can-i --list -o json` returns a SelfSubjectRulesReview.
  const rules = parsed?.status?.resourceRules;
  if (!Array.isArray(rules)) {
    throw new Error('SelfSubjectRulesReview returned no resourceRules');
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

// Resolved from the installed CLI so there is exactly one copy of the rules.
const { classifyCredentialScope } = await import('@getknext/core/internal/credential-scope');

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
