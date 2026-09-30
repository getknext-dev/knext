#!/usr/bin/env node
/**
 * break-crd — deliberately remove a known field from the NextApp CRD, for
 * mutation-proving the operator upgrade-under-load e2e's own assertions
 * (#1668's acceptance criterion: "a deliberately broken upgrade (CRD removed
 * field) reds it").
 *
 * Run ONLY via `BREAK_CRD_UPGRADE=1 scripts/upgrade-e2e/run.sh` locally, NEVER
 * in the scheduled/dispatch workflow (run.sh gates this behind that env var
 * and logs loudly when it fires). Removing `spec.properties.image` — a
 * required field on every real NextApp, including the one this e2e already
 * deployed — from the CRD makes the apiserver either reject the operator's
 * next reconcile write or prune the field, so the running CR's stored spec
 * no longer matches what phase 2 applied. That must turn phase 5's
 * `cr-diff` assertion red instead of green.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [, , crdPath] = process.argv;
if (!crdPath) {
  console.error('usage: break-crd.mjs <crd.yaml>');
  process.exit(2);
}

const text = readFileSync(crdPath, 'utf8');
const anchor = '              image:\n';
const occurrences = text.split(anchor).length - 1;
if (occurrences !== 1) {
  console.error(
    `break-crd: expected exactly one 'image:' anchor in ${crdPath}, found ${occurrences} — refusing to mutate blind`,
  );
  process.exit(1);
}

// Remove the `image:` field block (its description + `type: string` line)
// entirely, so this stays a single, precise field removal rather than a
// blind global edit.
const idx = text.indexOf(anchor);
const after = text.slice(idx + anchor.length);
const blockMatch = after.match(/^ {16}description: .*\n {16}type: string\n/);
if (!blockMatch) {
  console.error(
    "break-crd: expected a one-line 'description:' + 'type: string' block immediately after the anchor — refusing to mutate",
  );
  process.exit(1);
}
const mutated = text.slice(0, idx) + after.slice(blockMatch[0].length);

writeFileSync(crdPath, mutated);
console.error(`break-crd: removed spec.properties.image from ${crdPath} (mutation-proof run only)`);
