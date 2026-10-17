#!/usr/bin/env node
/**
 * Mutation prover for the nightly shipped-artifacts re-scan.
 *
 * The guard is `tests/shipped-scan.test.ts` over `scripts/lib/shipped-scan.mjs`,
 * `scripts/resolve-shipped-images.mjs` and
 * `.github/workflows/shipped-artifacts-nightly.yml`. Each row plants one
 * regression and requires the guard to go RED, by exit code. The rows are the ways
 * a nightly goes quietly green:
 *
 *   L1  the registry may omit the `latest` dist-tag and the scan carries on.
 *   L2  an `npm audit` error document (unreachable registry) stops throwing.
 *   L3  an audit report with no vulnerabilities map is read as clean.
 *   L4  HIGH stops failing (only CRITICAL does).
 *   L5  an advisory group is suppressed when only SOME of its advisories are allowlisted.
 *   L6  a pointer cycle is treated as suppressed.
 *   L7  an expired allowlist entry keeps suppressing.
 *   L8  a release bundle with no digest-pinned image stops throwing.
 *   L9  any registry error is read as "image not published".
 *   L10 a workflow that publishes a template image is no longer detected.
 *   L11 the Rust template image drops out of the watched set.
 *   W1  a job-level `if:` lands on a scan job (a skipped job does not fail the run).
 *   W2  a scan step gets a soft-fail flag.
 *   W3  the alert stops firing on a cancelled lockfile job.
 *   W4  the alert job's token gains a write scope.
 *   W5  a pull_request trigger is added.
 *   W6  the image matrix turns fail-fast on (one red image cancels the others).
 *   W7  the two workflows pin osv-scanner at different versions.
 *   W8  the Trivy gate is lowered to CRITICAL only.
 *   W9  the image job loses `packages: read` (the app image is private).
 *   W10 the resolver stops failing when no operator bundle can be read.
 *   N1  negative control: an error message is reworded and still matches.
 *   N2  negative control: the cron minute moves.
 *
 * Every mutated JS subject is checked to still PARSE (the shared parse-validity
 * hook) and every YAML subject to still parse as YAML, so each red is a red for
 * the reason its row claims.
 *
 * Runs on the shared driver (`lib/guard-prover.mjs`): exit codes only, anchors
 * exactly once (preflight), green baseline, a canary red first, tree checked
 * clean between rows, partial run = failure.
 *
 *   node scripts/mutation-prove-shipped-artifacts.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createGuardProver } from './lib/guard-prover.mjs';
import { jsStillParses } from './lib/parse-validity.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/shipped-scan.test.ts';

const parsesYaml = (text) => {
  try {
    parse(text);
    return undefined;
  } catch (err) {
    return `not valid YAML: ${err.message}`;
  }
};
const validators = {
  lib: jsStillParses,
  resolver: jsStillParses,
  wf: parsesYaml,
  osvwf: parsesYaml,
};

const MUTATIONS = [
  {
    id: 'L1',
    claim: 'the scan carries on without a latest dist-tag',
    subject: 'lib',
    anchor: "if (typeof distTags.latest !== 'string') {",
    replacement: 'if (false) {',
  },
  {
    id: 'L2',
    claim: 'an npm audit error document stops throwing',
    subject: 'lib',
    anchor: 'if (doc?.error) {',
    replacement: 'if (false) {',
  },
  {
    id: 'L3',
    claim: 'an audit report with no vulnerabilities map is read as clean',
    subject: 'lib',
    anchor:
      "if (!doc || typeof doc.vulnerabilities !== 'object' || doc.vulnerabilities === null) {",
    replacement: 'if (!doc) {',
  },
  {
    id: 'L4',
    claim: 'HIGH stops failing, only CRITICAL does',
    subject: 'lib',
    anchor: "if (v.severity !== 'high' && v.severity !== 'critical') continue;",
    replacement: "if (v.severity !== 'critical') continue;",
  },
  {
    id: 'L5',
    claim: 'a group is suppressed when only SOME advisories are allowlisted',
    subject: 'lib',
    anchor: 'ids.every((id) => allowedIds.has(id)) &&',
    replacement: 'ids.some((id) => allowedIds.has(id)) &&',
  },
  {
    id: 'L6',
    claim: 'a pointer cycle is treated as suppressed',
    subject: 'lib',
    anchor: 'if (visiting.has(name)) return false;',
    replacement: 'if (visiting.has(name)) return true;',
  },
  {
    id: 'L7',
    claim: 'an expired allowlist entry keeps suppressing',
    subject: 'lib',
    anchor: "if (typeof e.expires === 'string' && e.expires < today) continue;",
    replacement: 'void 0;',
  },
  {
    id: 'L8',
    claim: 'a bundle with no digest-pinned image stops throwing',
    subject: 'lib',
    anchor: 'if (refs.size === 0) {',
    replacement: 'if (false) {',
  },
  {
    id: 'L9',
    claim: 'any registry error is read as "image not published"',
    subject: 'lib',
    anchor:
      "return /MANIFEST_UNKNOWN|NAME_UNKNOWN/.test(String(stderr)) ? 'not-found' : 'unreachable';",
    replacement: "return 'not-found';",
  },
  {
    id: 'L10',
    claim: 'a workflow that publishes a template image is no longer detected',
    subject: 'lib',
    anchor: 'if (!PUBLISH_VERB.test(code)) continue;',
    replacement: 'continue;',
  },
  {
    id: 'L11',
    claim: 'the Rust template image drops out of the watched set',
    subject: 'lib',
    anchor: "export const TEMPLATE_IMAGES = ['knext-function-go', 'knext-function-rust'];",
    replacement: "export const TEMPLATE_IMAGES = ['knext-function-go'];",
  },
  {
    id: 'W1',
    claim: 'a job-level if: lands on a scan job',
    subject: 'wf',
    anchor: '  npm-published:\n    name: Published @getknext/* (npm audit, OSV, signatures)\n',
    replacement:
      "  npm-published:\n    name: Published @getknext/* (npm audit, OSV, signatures)\n    if: github.event_name == 'schedule'\n",
  },
  {
    id: 'W2',
    claim: 'a scan step gets a soft-fail flag',
    subject: 'wf',
    anchor: '      - name: Re-scan the published versions\n        run:',
    replacement:
      '      - name: Re-scan the published versions\n        continue-on-error: true\n        run:',
  },
  {
    id: 'W3',
    claim: 'the alert stops firing on a cancelled lockfile job',
    subject: 'wf',
    anchor: "needs.lockfile-malware.result == 'cancelled')",
    replacement: 'false)',
  },
  {
    id: 'W4',
    claim: "the alert job's token gains a write scope",
    subject: 'wf',
    anchor: '    permissions:\n      issues: write\n',
    replacement: '    permissions:\n      issues: write\n      contents: write\n',
  },
  {
    id: 'W5',
    claim: 'a pull_request trigger is added',
    subject: 'wf',
    anchor: '  workflow_dispatch: {}\n',
    replacement: '  workflow_dispatch: {}\n  pull_request:\n',
  },
  {
    id: 'W6',
    claim: 'the image matrix turns fail-fast on',
    subject: 'wf',
    anchor: '      fail-fast: false',
    replacement: '      fail-fast: true',
  },
  {
    id: 'W7',
    claim: 'the PR workflow pins osv-scanner at a different version',
    subject: 'osvwf',
    anchor: 'OSV_SCANNER_VERSION: v2.6.0',
    replacement: 'OSV_SCANNER_VERSION: v2.7.0',
  },
  {
    id: 'W8',
    claim: 'the Trivy gate is lowered to CRITICAL only',
    subject: 'wf',
    anchor: 'severity: HIGH,CRITICAL',
    replacement: 'severity: CRITICAL',
  },
  {
    id: 'W9',
    claim: 'the image job loses packages: read',
    subject: 'wf',
    anchor: '    permissions:\n      contents: read\n      packages: read\n    strategy:',
    replacement: '    permissions:\n      contents: read\n    strategy:',
  },
  {
    id: 'W10',
    claim: 'the resolver stops failing when no operator bundle can be read',
    subject: 'resolver',
    anchor: 'if (operatorFound === 0)',
    replacement: 'if (false)',
  },
  {
    id: 'N1',
    expect: 'green',
    claim: 'an error message is reworded and still matches',
    subject: 'lib',
    anchor: "'registry returned no dist-tags: nothing to scan'",
    replacement: "'registry returned no dist-tags at all: nothing to scan'",
  },
  {
    id: 'N2',
    expect: 'green',
    claim: 'the cron minute moves',
    subject: 'wf',
    anchor: "- cron: '47 2 * * *'",
    replacement: "- cron: '48 2 * * *'",
  },
].map((m) => ({ expect: 'red', validate: validators[m.subject], ...m }));

const CANARY = {
  subject: 'lib',
  anchor:
    "export const NPM_GROUP = ['@getknext/core', '@getknext/lib', '@getknext/db', 'kn-next'];",
  replacement: "export const NPM_GROUP = ['@getknext/core', '@getknext/lib', '@getknext/db'];",
};

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    lib: 'scripts/lib/shipped-scan.mjs',
    resolver: 'scripts/resolve-shipped-images.mjs',
    wf: '.github/workflows/shipped-artifacts-nightly.yml',
    osvwf: '.github/workflows/osv-scan.yml',
  },
});

console.log('=== mutation proof: nightly shipped-artifacts re-scan ===');
prover.preflight([...MUTATIONS, { id: 'canary', ...CANARY }]);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed(CANARY);
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);
