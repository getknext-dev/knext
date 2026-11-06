#!/usr/bin/env node
/**
 * Mutation proof for the image half of the R8 supply-chain guard (#2044): every
 * workflow that publishes an image (found by behaviour, under any trigger) needs
 * an enforcing HIGH+CRITICAL Trivy gate, an SBOM and cosign that cannot be
 * disabled and are tied to the image; function template images need an SBOM and
 * cosign.
 *
 * `.claude/rules/workflow.md`: "a guard that stays green when its subject is
 * removed is decoration." Each row removes one thing the guard protects, in the
 * real workflows or in the guard's own engine, and REQUIRES
 * `tests/image-supply-chain.test.ts` to go red. The shared driver
 * (`scripts/lib/guard-prover.mjs`) owns the discipline: verdicts by EXIT CODE
 * only, baseline green first, a canary that must go red, anchors that must occur
 * exactly once (else abort), byte-exact restore.
 *
 * The template `cosign` rows are the stale-gap direction: today the template
 * workflows have a NAMED known gap (no cosign), so ADDING a cosign step must red
 * the guard until the known-gap entry is deleted.
 *
 * Usage: node scripts/mutation-prove-2044-image-supply-chain.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/image-supply-chain.test.ts';

const COSIGN_STEP = (title) =>
  `      - name: cosign mutant\n        run: cosign sign --yes "$IMG@$DIGEST"\n\n      - name: ${title}`;

const MUTATIONS = [
  // ── operator workflow ────────────────────────────────────────────────────
  {
    id: 'O1',
    subject: 'operator',
    claim: 'the operator tag lane loses its Trivy scan',
    anchor: 'uses: aquasecurity/trivy-action@',
    replacement: 'uses: aquasecurity/trivy-actio@',
  },
  {
    id: 'O2',
    subject: 'operator',
    claim: 'the operator Trivy scan stops failing the build (exit-code 0)',
    anchor: '          exit-code: "1"',
    replacement: '          exit-code: "0"',
  },
  {
    id: 'O3',
    subject: 'operator',
    claim: 'the operator tag lane loses its SBOM step',
    anchor: 'uses: anchore/sbom-action@',
    replacement: 'uses: anchore/sbom-actio@',
  },
  {
    id: 'O4',
    subject: 'operator',
    claim: 'the signing/publish job stops waiting for the Trivy + SBOM job',
    anchor: '    needs: [operator-image-supply-chain]',
    replacement: '    needs: []',
  },
  {
    id: 'O5',
    subject: 'operator',
    claim: 'a path filter lands on the push trigger (a tag from some branch could be skipped)',
    anchor: '    branches: [main]\n    tags:',
    replacement: "    branches: [main]\n    paths: ['packages/**']\n    tags:",
  },
  {
    id: 'O6',
    subject: 'operator',
    claim: 'the publish job is confined to main (operator tags from other branches unpublished)',
    // One plain-scalar line: the harness appends its residue marker as a YAML
    // comment, which would corrupt a folded (>-) scalar's text instead.
    anchor:
      "if: >-\n      (github.event_name == 'push' || github.event_name == 'workflow_dispatch') &&\n      needs.operator-image-supply-chain.outputs.ready == 'true'",
    replacement:
      "if: github.ref == 'refs/heads/main' && needs.operator-image-supply-chain.outputs.ready == 'true'",
  },
  {
    id: 'O7',
    subject: 'operator',
    claim: 'the operator Trivy gate becomes continue-on-error: true',
    anchor: "continue-on-error: ${{ steps.channel.outputs.publish != 'true' }}",
    replacement: 'continue-on-error: true',
  },
  {
    id: 'O8',
    subject: 'operator',
    claim: 'the operator Trivy gate narrows to LOW severity',
    anchor: '          severity: HIGH,CRITICAL',
    replacement: '          severity: LOW',
  },
  {
    id: 'O9',
    subject: 'operator',
    claim: 'the operator pushes a layout Trivy never scanned',
    anchor: 'crane push operator-oci "',
    replacement: 'crane push operator-oci-other "',
  },
  // ── the app image lane (supply-chain.yml), found by behaviour ────────────
  {
    id: 'S1',
    subject: 'app',
    claim: 'the app image Trivy gate becomes continue-on-error: true',
    anchor:
      "while every line stays gated.\n        continue-on-error: ${{ github.ref != 'refs/heads/main' && !startsWith(github.ref, 'refs/heads/integration/') }}",
    replacement: 'while every line stays gated.\n        continue-on-error: true',
  },
  {
    id: 'S2',
    subject: 'app',
    claim: 'the app image Trivy gate narrows to LOW severity',
    anchor:
      "repo's OIDC identity. v0.36.0.\n        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0\n        with:\n          input: image-oci\n          severity: HIGH,CRITICAL",
    replacement:
      "repo's OIDC identity. v0.36.0.\n        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0\n        with:\n          input: image-oci\n          severity: LOW",
  },
  {
    id: 'S3',
    subject: 'app',
    claim: 'the app image pushes a layout Trivy never scanned',
    anchor: 'crane push image-oci "',
    replacement: 'crane push image-oci-other "',
  },
  {
    id: 'S4',
    subject: 'app',
    claim: 'the app image is signed by mutable tag instead of digest',
    anchor: 'cosign sign --yes "${IMAGE}@${DIGEST}"',
    replacement: 'cosign sign --yes "${IMAGE}:${GITHUB_SHA}"',
  },
  {
    id: 'S5',
    subject: 'app',
    claim: 'the app image Trivy gate becomes a filesystem scan (scan-type fs)',
    anchor:
      "repo's OIDC identity. v0.36.0.\n        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0\n        with:\n          input: image-oci\n          severity: HIGH,CRITICAL",
    replacement:
      "repo's OIDC identity. v0.36.0.\n        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0\n        with:\n          scan-type: fs\n          input: image-oci\n          severity: HIGH,CRITICAL",
  },
  // ── function templates ───────────────────────────────────────────────────
  {
    id: 'T1',
    subject: 'gotpl',
    claim: 'the Go template image loses its SBOM step',
    anchor: 'uses: anchore/sbom-action@',
    replacement: 'uses: anchore/sbom-actio@',
  },
  {
    id: 'T2',
    subject: 'rusttpl',
    claim: 'the Rust template image loses its SBOM step',
    anchor: 'uses: anchore/sbom-action@',
    replacement: 'uses: anchore/sbom-actio@',
  },
  {
    id: 'T3',
    subject: 'gotpl',
    claim: 'the Go template image job stops building templates/go (the scan finds no image)',
    anchor: 'run: docker build -t "${IMAGE}:${GITHUB_SHA}" templates/go',
    replacement: 'run: docker build -t "${IMAGE}:${GITHUB_SHA}" templates/gx',
  },
  {
    id: 'T4',
    subject: 'gotpl',
    claim: 'cosign lands on the Go template: the known gap goes STALE and must be deleted',
    anchor: '      - name: Trivy scan — FAIL on HIGH/CRITICAL',
    replacement: COSIGN_STEP('Trivy scan — FAIL on HIGH/CRITICAL'),
  },
  {
    id: 'T5',
    subject: 'rusttpl',
    claim: 'cosign lands on the Rust template: the known gap goes STALE and must be deleted',
    anchor: '      - name: Trivy scan — FAIL on HIGH/CRITICAL',
    replacement: COSIGN_STEP('Trivy scan — FAIL on HIGH/CRITICAL'),
  },
  // ── the guard's own engine ───────────────────────────────────────────────
  {
    id: 'E1',
    subject: 'engine',
    claim: 'the cosign matcher stops recognising `cosign sign`/`attest`',
    anchor: '!fromScript(s) && /\\bcosign\\s+(?:sign|attest)(?![\\w-])/.test(code(s));',
    replacement: '!fromScript(s) && /\\bcosign\\s+(?:nothing)(?![\\w-])/.test(code(s));',
  },
  {
    id: 'E2',
    subject: 'engine',
    claim: 'Trivy exit-code enforcement is not checked',
    anchor: 'if (!enforced) out.push',
    replacement: 'if (false) out.push',
  },
  {
    id: 'E3',
    subject: 'engine',
    claim: 'continue-on-error is never judged',
    anchor: 'if (v !== false) {',
    replacement: 'if (false) {',
  },
  {
    id: 'E4',
    subject: 'engine',
    claim: 'a step `if` is never judged',
    anchor: 'if (evalExpr(step.if, ctx) !== true) {',
    replacement: 'if (false) {',
  },
  {
    id: 'E5',
    subject: 'engine',
    claim: 'the Trivy severity floor is not checked',
    anchor: 'if (sev && !(sev.includes',
    replacement: 'if (false && sev && !(sev.includes',
  },
  {
    id: 'E6',
    subject: 'engine',
    claim: 'the upstream ordering walk is cut (a push job need not wait for the scan)',
    anchor: '? needsOf(jobs[cur] ?? {})',
    replacement: '? []',
  },
  {
    id: 'E7',
    subject: 'engine',
    claim: 'template gate steps are accepted without being judged',
    anchor: 'if (valid.length) continue;',
    replacement: 'continue;',
  },
  {
    id: 'E8',
    subject: 'engine',
    claim: 'the "no workflow builds this template" check is removed',
    anchor: 'if (!builders.length) {',
    replacement: 'if (false) {',
  },
  {
    id: 'E9',
    subject: 'engine',
    claim: 'an empty workflow directory stops failing closed',
    anchor: 'if (files.length === 0) throw new Error(`no workflows found in ${dir}`);',
    replacement: 'void 0;',
  },
  {
    id: 'E10',
    subject: 'engine',
    claim: 'an unresolvable reusable workflow is skipped instead of failing',
    anchor: 'if (!local || !wfs.some((w) => w.file === local[1]))',
    replacement: 'if (false)',
  },
  {
    id: 'E11',
    subject: 'engine',
    claim: 'an unresolvable local action is skipped instead of failing',
    anchor: 'if (inner === null)',
    replacement: 'if (false)',
  },
  {
    id: 'E15',
    subject: 'engine',
    claim: 'cosign-before-push ordering is not checked',
    anchor: 'if (signAt !== -1 && signAt < pushAt)',
    replacement: 'if (false)',
  },
  {
    id: 'E18',
    subject: 'engine',
    claim: 'a vacuous scan (no operator lane discovered) stops failing',
    anchor: 'if (lanes.length === 0)',
    replacement: 'if (false)',
  },
  {
    id: 'E20',
    subject: 'engine',
    claim: 'the operator tag-from-any-branch job check is removed',
    anchor: 'if (tagCtx && evalExpr(job.if ?? true, tagCtx) === false)',
    replacement: 'if (false)',
  },
  {
    id: 'E21',
    subject: 'engine',
    claim: 'the evaluator treats an unknown operand as false (an unprovable gate passes as safe)',
    anchor: 'if (x === UNKNOWN || y === UNKNOWN) return UNKNOWN;\n    return true;',
    replacement: 'if (x === UNKNOWN || y === UNKNOWN) return false;\n    return true;',
  },
  {
    id: 'E12',
    subject: 'engine',
    claim: 'a push to the local registry is no longer exempted (a local crane copy becomes a lane)',
    anchor: 'return refs.filter((r) => !(r.name !== undefined && localDestination(r.name, text)));',
    replacement: 'return refs;',
  },
  {
    id: 'E13',
    subject: 'engine',
    claim: 'build-push-action / bake-action pushes are no longer discovered',
    anchor: 'if (/^docker\\/build-push-action@/.test(u) || /^docker\\/bake-action@/.test(u)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'E14',
    subject: 'engine',
    claim: 'the pushed-layout tie to the Trivy scan is removed',
    anchor: 'if (scanned.length > 0 && !scanned.includes(layout) && !derived)',
    replacement: 'if (false)',
  },
  {
    id: 'E16',
    subject: 'engine',
    claim: 'the cosign-by-digest tie is removed',
    anchor: 'if (!/@\\S*(?:digest|DIGEST|sha256)/i.test(l))',
    replacement: 'if (false)',
  },
  {
    id: 'E17',
    subject: 'engine',
    claim: 'the pushed-NAME tie to the Trivy scan (docker push / build-push-action) is removed',
    anchor:
      'if (literalName(n) && names.length > 0 && names.every(literalName) && !names.includes(n))',
    replacement: 'if (false)',
  },
  {
    id: 'E19',
    subject: 'engine',
    claim: 'a job-level `if` that is not provably true is not judged',
    anchor: 'if (evalExpr(job.if, ctx) !== true) {',
    replacement: 'if (false) {',
  },
  {
    id: 'E22',
    subject: 'engine',
    claim: 'an unfiltered `on: push` no longer samples a tag ref',
    anchor: "if (unfiltered || 'tags-ignore' in filters) add('push', TAG_SAMPLE);",
    replacement: 'void 0;',
  },
  {
    id: 'E23',
    subject: 'engine',
    claim: 'schedule is no longer a sampled context',
    anchor: "if ('schedule' in on) add('schedule', 'refs/heads/main');",
    replacement: 'void 0;',
  },
  {
    id: 'E24',
    subject: 'engine',
    claim: 'release is no longer a sampled context',
    anchor: "if ('release' in on) add('release', TAG_SAMPLE);",
    replacement: 'void 0;',
  },
  {
    id: 'E25',
    subject: 'engine',
    claim: '`trivy ... || true` / `; true` no longer counts as a discarded exit status',
    anchor: 'if (/\\|\\|/.test(rest) || /;\\s*(?:true|:|exit\\s+0)\\b/.test(rest)) return true;',
    replacement: 'void 0;',
  },
  {
    id: 'E26',
    subject: 'engine',
    claim: 'a trivy pipe with no pipefail no longer counts as a discarded exit status',
    anchor: 'if (piped && /[^|]\\|[^|]/.test(rest)) return true;',
    replacement: 'void 0;',
  },
  {
    id: 'E27',
    subject: 'engine',
    claim: '`set +e` before trivy no longer counts as a discarded exit status',
    anchor: 'if (/\\bset\\s+\\+e\\b/.test(text)) return true;',
    replacement: 'void 0;',
  },
  {
    id: 'E28',
    subject: 'engine',
    claim: 'trivy-action scan-type fs/config/repo satisfies "image scanned"',
    anchor: "return t === undefined || String(t).trim().toLowerCase() === 'image';",
    replacement: 'return true;',
  },
  {
    id: 'E29',
    subject: 'engine',
    claim: '`trivy fs` / `trivy config` CLI satisfies "image scanned"',
    anchor: 'return /\\btrivy\\s+image\\b/.test(code(s));',
    replacement: 'return /\\btrivy\\s+(image|fs|config|repo|rootfs)\\b/.test(code(s));',
  },
  {
    id: 'E30',
    subject: 'engine',
    claim: '`cosign sign-blob` counts as signing an image',
    anchor: '!fromScript(s) && /\\bcosign\\s+(?:sign|attest)(?![\\w-])/.test(code(s));',
    replacement: '!fromScript(s) && /\\bcosign\\s+(?:sign|attest)/.test(code(s));',
  },
  {
    id: 'E31',
    subject: 'engine',
    claim: 'a cosign command may sign a name the lane never pushed',
    anchor: 'if (!pushedNames.includes(sn))',
    replacement: 'if (false)',
  },
  {
    id: 'E32',
    subject: 'engine',
    claim: 'a pushed name may go unsigned',
    anchor: 'if (!signedNames.includes(pn))',
    replacement: 'if (false)',
  },
  {
    id: 'E33',
    subject: 'engine',
    claim: 'a printed `docker push` in an echo counts as a push',
    anchor: 'if (/^\\s*(?:echo|printf|logger)\\b/.test(line)) continue;',
    replacement: 'void 0;',
  },
  {
    id: 'E34',
    subject: 'engine',
    claim: '`ko publish` / `ko build` are no longer discovered',
    anchor: 'String.raw`\\bko\\s+(?:publish|build|apply|resolve)\\b`,',
    replacement: 'String.raw`\\bnoko\\b`,',
  },
  {
    id: 'E35',
    subject: 'engine',
    claim: 'repo-local scripts are no longer read for pushes',
    anchor: "if (typeof s.run === 'string' && depth < 5) {",
    replacement: 'if (false) {',
  },
  {
    id: 'E36',
    subject: 'engine',
    claim: 'an unreadable script in a credentialed job is no longer reported',
    anchor:
      'const scriptProblems = credentialed(job, wfDoc, resolveAction, inheritedSecrets) ? problems : [];',
    replacement: 'const scriptProblems: Finding[] = [];',
  },
  {
    id: 'E37',
    subject: 'engine',
    claim: "scripts inside another repository's checkout are read as this repo's",
    anchor: 'if (checkouts.get(first) === true) return;',
    replacement: 'void 0;',
  },
  {
    id: 'E38',
    subject: 'engine',
    claim: 'an unprovable job `if` on a gate job is never judged',
    anchor: 'if (job.if !== undefined && !jobIfIrrelevant) {',
    replacement: 'if (false) {',
  },
  {
    id: 'E39',
    subject: 'engine',
    claim: 'a push job that opts in with always() no longer defeats the upstream-skip assumption',
    anchor: '(upstreamIds.has(jid) && !pushIfSurvivesFailure)',
    replacement: '(upstreamIds.has(jid))',
  },
  {
    id: 'E40',
    subject: 'engine',
    claim: 'a Cloud Build config listing images: is no longer a push',
    anchor: '/^images:/m.test(body) ||',
    replacement: 'false ||',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    operator: '.github/workflows/operator-supply-chain.yml',
    app: '.github/workflows/supply-chain.yml',
    gotpl: '.github/workflows/go-template.yml',
    rusttpl: '.github/workflows/rust-template.yml',
    engine: 'tests/helpers/image-supply-chain.ts',
  },
});

console.log('=== mutation proof: image supply-chain guard (#2044) ===');
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'engine',
  anchor: 'export const REPO_ROOT = resolve(import.meta.dirname',
  replacement: 'export const REPO_ROOT = resolve(import.meta.dirnamx',
});
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
