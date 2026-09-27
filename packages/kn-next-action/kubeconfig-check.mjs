#!/usr/bin/env node
/**
 * Refuse a cloud-credential kubeconfig (ADR-0061, #1533) — the action step
 * that `skip-credential-preflight` can NOT turn off.
 *
 * A kubeconfig whose user entry carries `exec:` or `auth-provider:`
 * authenticates by running a cloud CLI on this runner with a cloud account's
 * credentials in scope — exactly what ADR-0061 says knext must never touch.
 * This is a LOCAL read of the file, independent of the cluster: the escape
 * hatch exists for authorizers that do not implement the access reviews
 * (`preflight.mjs`), and has no business switching off a check that needs no
 * authorizer at all. So it lives in its own step, which the skip input does
 * not reach (asserted by
 * `tests/kn-next-action-preflight-hazard-and-kubeconfig.test.ts`'s
 * "action.yml — the kubeconfig check is not reachable by
 * skip-credential-preflight" describe block).
 *
 * Fails CLOSED: no KUBECONFIG, an unreadable file, or an unloadable classifier
 * all refuse. The printed reason is the classifier's, which never carries
 * source text — a kubeconfig holds a credential, and this goes to a CI log.
 */
import { readFileSync } from 'node:fs';
import { loadFromCore } from './load-core.mjs';

const path = process.env.KUBECONFIG;
if (!path) {
  console.error('::error::No kubeconfig is configured (KUBECONFIG is unset). Refusing.');
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(path, 'utf8');
} catch (err) {
  // An fs error names the path and the errno — never file contents.
  console.error(`::error::Could not read the kubeconfig at ${path}.`);
  console.error(`\nunderlying error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const { classifyKubeconfigSafety } = await loadFromCore(
  'kubeconfig-safety',
  'the kubeconfig safety classifier',
);
if (typeof classifyKubeconfigSafety !== 'function') {
  console.error('::error::@getknext/core has no kubeconfig safety classifier. Refusing.');
  process.exit(1);
}

const safety = classifyKubeconfigSafety(raw);
if (!safety || safety.ok !== true) {
  console.error(
    `::error::${safety?.reason ?? 'The kubeconfig could not be classified. Refusing.'}`,
  );
  process.exit(1);
}

console.log('kubeconfig-check: the kubeconfig needs no cloud-account credentials.');
process.exit(0);
