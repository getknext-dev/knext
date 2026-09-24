#!/usr/bin/env node
/**
 * Mutation proof for `tests/nextjs-credential-lockstep.test.ts` (#1376,
 * rev-1379 rounds 2 and 3).
 *
 * Round 2: the original test read only `test-e2e-deploy.yml`'s `NEXTJS_REF`
 * env fallback, so a bump to `test-e2e-deploy.yml`'s workflow_dispatch
 * DEFAULT, or to EITHER `nextjsRef` site in `compat-vinext.yml`, stayed
 * green. This proof mutates each of those four real sites plus the two docs
 * citations (and the plain-language divergence explanation) added in round
 * 2, and requires every one to turn the spec red.
 *
 * Round 3 (first pass): the round-2 scan only recognised the trusted
 * env-fallback EXPRESSION, so a job/step-level `env: NEXTJS_REF: ...`
 * override, an `export NEXTJS_REF=`, or a `$GITHUB_ENV` write all stayed
 * green. This proof also (a) adds each of those three forms to a real
 * workflow and requires red, (b) mutates the scaffold pin + manifest
 * together to a version the docs' divergence paragraph does NOT cite, and
 * requires red (the docs check must be DERIVED, not hardcoded), and (c)
 * adds a `lockstepExceptions` entry with an empty `reason` and requires red.
 *
 * Round 3 (second pass): three more gaps. (d) `DEFAULT_NEXTJS_REF` in
 * `scripts/compat-vinext-ledger.mjs` used to be a hardcoded THIRD copy —
 * reverting it to a literal (rather than reading the manifest) must red;
 * (e) the YAML-key scan anchored to a line's start, missing flow-style
 * (`env: { NEXTJS_REF: ... } `) and quoted-key (`"NEXTJS_REF": ...`) forms —
 * adding either to a real workflow must red; (f) the
 * `NEXT_NPM_VERSION="${NEXTJS_REF#v}"` derivation count (6) must catch a
 * literal replacement of just ONE of the six sites.
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise —
 *     a silently-failed substitution would certify a decorative guard green;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from
 *     M-of-M;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-nextjs-credential-lockstep.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/nextjs-credential-lockstep.test.ts';

/** The files the mutations land in, repo-relative. */
const PROOF = {
  subjects: {
    testE2eDeploy: '.github/workflows/test-e2e-deploy.yml',
    compatVinext: '.github/workflows/compat-vinext.yml',
    docsMatrixMd: 'docs/compat-matrix.md',
    docsMatrixMdx: 'apps/docs/content/docs/compat-matrix.mdx',
    manifest: '.github/compat-credentialed-next-version.json',
    scaffoldPkg: 'packages/kn-next/templates/app/package.json.hbs',
    ledger: 'scripts/compat-vinext-ledger.mjs',
  },
};

/** `.mdx`/`.hbs` need an explicit comment prefix — `COMMENT_PREFIX` only maps
 * their underlying syntax's usual extension (`.md`, `.json`), not these. */
function mutateOptions(subject) {
  if (subject === 'docsMatrixMdx') return { commentPrefix: '<!--' };
  if (subject === 'scaffoldPkg') return { commentPrefix: '//' };
  return {};
}

/** Every mutation normalises to a list of `{ subject, anchor, replacement }`
 * edits — most are one file, but the round-3 docs-derivation proof needs
 * the scaffold pin and the manifest bumped TOGETHER in one mutation. */
function editsOf(m) {
  return m.edits ?? [{ subject: m.subject, anchor: m.anchor, replacement: m.replacement }];
}

const MUTATIONS = [
  // ── Finding 1: the scan must catch every dispatch-default and env-fallback ──
  {
    label: 'test-e2e-deploy.yml: bump the workflow_dispatch nextjsRef DEFAULT to the shipped pin',
    subject: 'testE2eDeploy',
    anchor:
      "        description: 'vercel/next.js git ref to test against (pinned tag ≥ v16.2.0; do NOT use canary)'\n        required: false\n        default: 'v16.2.0'",
    replacement:
      "        description: 'vercel/next.js git ref to test against (pinned tag ≥ v16.2.0; do NOT use canary)'\n        required: false\n        default: 'v16.3.3'",
  },
  {
    label: 'compat-vinext.yml: bump the workflow_dispatch nextjsRef DEFAULT to the shipped pin',
    subject: 'compatVinext',
    anchor:
      "        description: 'vercel/next.js git ref to test against (pinned tag >= v16.2.0; do NOT use canary)'\n        required: false\n        default: 'v16.2.0'",
    replacement:
      "        description: 'vercel/next.js git ref to test against (pinned tag >= v16.2.0; do NOT use canary)'\n        required: false\n        default: 'v16.3.3'",
  },
  {
    label: 'compat-vinext.yml: bump the NEXTJS_REF env FALLBACK to the shipped pin',
    subject: 'compatVinext',
    anchor: "  NEXTJS_REF: ${{ github.event.inputs.nextjsRef || 'v16.2.0' }}",
    replacement: "  NEXTJS_REF: ${{ github.event.inputs.nextjsRef || 'v16.3.3' }}",
  },

  // ── Finding 2: docs must track the manifest, and explain the divergence ────
  {
    label: 'docs/compat-matrix.md: drift the cited vercel/next.js version from the manifest',
    subject: 'docsMatrixMd',
    anchor: 'against `vercel/next.js` **v16.2.0**, Node runtime.',
    replacement: 'against `vercel/next.js` **v16.3.3**, Node runtime.',
  },
  {
    label: 'compat-matrix.mdx: drift the cited Next.js version from the manifest',
    subject: 'docsMatrixMdx',
    anchor:
      'nightly most recently observed **778 tests passed, 0 failed**, against Next.js v16.2.0.',
    replacement:
      'nightly most recently observed **778 tests passed, 0 failed**, against Next.js v16.3.3.',
  },
  {
    label: 'compat-matrix.mdx: delete the newer-Next-release divergence explanation',
    subject: 'docsMatrixMdx',
    anchor:
      '\n**New apps pin a newer Next.js release than the version measured above.** The scaffold ships\nNext.js 16.3.x, while the numbers on this page were measured against an older pinned release. The\nnewer release currently trips a build-tool bug that is being tracked upstream, so re-measuring\nagainst it would take every Turbopack-based row on this page to zero rather than show real\nprogress. The credentialed numbers will move forward once that is fixed.\n',
    replacement: '\n',
  },
  {
    label: "compat-matrix.mdx: drop the '16.3.x' version from the divergence explanation",
    subject: 'docsMatrixMdx',
    anchor:
      '**New apps pin a newer Next.js release than the version measured above.** The scaffold ships\nNext.js 16.3.x, while',
    replacement:
      '**New apps pin a newer Next.js release than the version measured above.** The scaffold ships\na newer Next.js line, while',
  },

  // ── Round 3, finding 1: every NEXTJS_REF assignment form, not just the ──
  // ── one trusted expression ───────────────────────────────────────────────
  {
    label: 'test-e2e-deploy.yml: add a job-level env: NEXTJS_REF override (bare YAML key)',
    subject: 'testE2eDeploy',
    anchor:
      '  build-next:\n    name: Prepare prebuilt next + harness\n    needs: credential-ref\n    runs-on: ubuntu-latest\n',
    replacement:
      '  build-next:\n    name: Prepare prebuilt next + harness\n    needs: credential-ref\n    runs-on: ubuntu-latest\n    env:\n      NEXTJS_REF: v16.3.3\n',
  },
  {
    label: 'test-e2e-deploy.yml: add an `export NEXTJS_REF=` in a run: step',
    subject: 'testE2eDeploy',
    anchor:
      '  build-next:\n    name: Prepare prebuilt next + harness\n    needs: credential-ref\n    runs-on: ubuntu-latest\n',
    replacement:
      '  build-next:\n    name: Prepare prebuilt next + harness\n    needs: credential-ref\n    runs-on: ubuntu-latest\n          export NEXTJS_REF=v16.3.3\n',
  },
  {
    label: 'test-e2e-deploy.yml: add a `NEXTJS_REF=` write to $GITHUB_ENV',
    subject: 'testE2eDeploy',
    anchor:
      '  build-next:\n    name: Prepare prebuilt next + harness\n    needs: credential-ref\n    runs-on: ubuntu-latest\n',
    replacement:
      '  build-next:\n    name: Prepare prebuilt next + harness\n    needs: credential-ref\n    runs-on: ubuntu-latest\n    # mutation-prover probe: a REAL (uncommented) shell assignment line.\n          echo "NEXTJS_REF=v16.3.3" >> "$GITHUB_ENV"\n',
  },

  // ── Round 3, finding 2: the docs check must be DERIVED, and exceptions ──
  // ── must carry a reason ──────────────────────────────────────────────────
  {
    label:
      'scaffold pin + manifest bumped TOGETHER to 16.4.0: the docs still cite 16.3.x -> the DERIVED check must catch it',
    edits: [
      {
        subject: 'scaffoldPkg',
        anchor: '"next": "16.3.3",',
        replacement: '"next": "16.4.0",',
      },
      {
        subject: 'manifest',
        anchor: '"shippedNextPin": "16.3.3",',
        replacement: '"shippedNextPin": "16.4.0",',
      },
    ],
  },
  {
    label: "manifest: empty out the existing lockstepExceptions entry's reason",
    subject: 'manifest',
    anchor:
      '"reason": "The #1376 option-(b) shipped-pin early-warning lane (founder-approved 2026-09-25): a non-credential, informational-only lane that tests the SHIPPED pin (currently v16.3.3), not the credentialed v16.2.0 — by design, since its whole point is forecasting what the shipped pin looks like on the real compat suite. It reads shippedNextPin from THIS manifest at dispatch time (scripts/lib/dispatch-poll.mjs\'s shippedPinRef, never a hardcoded literal in the workflow), so this entry documents the intended divergence rather than excusing a static drift the round-3 scan would otherwise catch — tests/compat-shipped-pin-early-warning.test.ts proves the tie directly. Every dispatched run runs via workflow_dispatch (never schedule), so KNEXT_COMPAT_MODE in test-e2e-deploy.yml is unconditionally early-warning and this lane can never advance a v1.0 credential count."',
    replacement: '"reason": ""',
  },

  // ── Round 3, second pass, finding 1: the ledger's THIRD copy of the ref ──
  {
    label: 'compat-vinext-ledger.mjs: revert DEFAULT_NEXTJS_REF to a hardcoded (drifted) literal',
    subject: 'ledger',
    anchor:
      "export const DEFAULT_NEXTJS_REF = JSON.parse(\n  readFileSync(CREDENTIAL_MANIFEST_PATH, 'utf8'),\n).credentialedNextRef;",
    replacement: "export const DEFAULT_NEXTJS_REF = 'v16.3.3';",
  },

  // ── Round 3, second pass, finding 2: flow-style / quoted-key forms ───────
  {
    label: 'test-e2e-deploy.yml: add a FLOW-STYLE `env: { NEXTJS_REF: v16.3.3 }` override',
    subject: 'testE2eDeploy',
    anchor:
      '  build-next:\n    name: Prepare prebuilt next + harness\n    needs: credential-ref\n    runs-on: ubuntu-latest\n',
    replacement:
      '  build-next:\n    name: Prepare prebuilt next + harness\n    needs: credential-ref\n    runs-on: ubuntu-latest\n    env: { NEXTJS_REF: v16.3.3 }\n',
  },
  {
    label: 'test-e2e-deploy.yml: add a QUOTED-KEY `"NEXTJS_REF": v16.3.3` override',
    subject: 'testE2eDeploy',
    anchor:
      '  build-next:\n    name: Prepare prebuilt next + harness\n    needs: credential-ref\n    runs-on: ubuntu-latest\n',
    replacement:
      '  build-next:\n    name: Prepare prebuilt next + harness\n    needs: credential-ref\n    runs-on: ubuntu-latest\n    env:\n      "NEXTJS_REF": v16.3.3\n',
  },

  // ── Round 3, second pass, finding 3: the NEXT_NPM_VERSION exact count ───
  {
    label:
      'test-e2e-deploy.yml: replace ONE of the six NEXT_NPM_VERSION derivations with a literal',
    subject: 'testE2eDeploy',
    anchor:
      '      - name: Acquire prebuilt next (npm pack)\n        id: prebuilt\n        run: |\n          NEXT_NPM_VERSION="${NEXTJS_REF#v}"\n',
    replacement:
      '      - name: Acquire prebuilt next (npm pack)\n        id: prebuilt\n        run: |\n          NEXT_NPM_VERSION="16.2.0"\n',
  },
];

declareMutations(16);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

/** True when the spec PASSED. Exit code only — never the output. */
function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

if (MUTATIONS.length !== 16) {
  console.error(`FATAL: declared 16 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error(`FATAL: ${SPEC} is not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const edits = editsOf(m);
  // Snapshot every file involved BEFORE mutating any of them, so a failure
  // partway through never leaves an earlier edit un-restorable.
  const snaps = edits.map((e) => snapshot(resolve(REPO_ROOT, PROOF.subjects[e.subject])));
  try {
    edits.forEach((e, i) => {
      mutate(snaps[i], e.anchor, e.replacement, mutateOptions(e.subject));
    });
    if (specPasses()) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    // Restore in REVERSE order — matches the mutate order's dependency
    // direction and is the harness's own documented restore convention.
    for (const snap of [...snaps].reverse()) restore(snap);
  }
  if (!specPasses()) {
    console.error(`   FATAL: ${SPEC} did not go green again after restore`);
    process.exit(1);
  }
}

console.log(
  `\n${MUTATIONS.length - decorative.length} caught, ${decorative.length} decorative, of ${MUTATIONS.length}.`,
);
if (decorative.length > 0) {
  for (const label of decorative) console.error(`DECORATIVE: ${label}`);
  process.exit(1);
}
