#!/usr/bin/env node
/**
 * Mutation proof for the PUBLISH-LANE SUPPLY-CHAIN GUARD (#2044, v2 task R8).
 *
 * `tests/publish-lane-supply-chain.test.ts` claims that every workflow job that
 * publishes to npm transitively `needs` the npm-audit gate and the SBOM job, and
 * that it finds lanes by SCANNING (a newly added one is covered) and fails
 * closed on a workflow it cannot read. A guard that stays green when its subject
 * is removed is decoration, so each mutation below removes or loosens one piece
 * of that protection and REQUIRES the spec to go red.
 *
 * Four classes, all graded on the spec's EXIT CODE (never on its output — a grep
 * over coloured test output once certified fourteen decorative mutations red):
 *
 *   1. the real `release.yml` loses a gate (audit need dropped, SBOM upload
 *      dropped, audit softened, `always()` on the lane);
 *   2. a NEW workflow appears with a publish lane and neither gate (one per
 *      discovery path), or a workflow the scan cannot read appears;
 *   3. the engine itself is weakened (transitivity, status-bypass, discovery of
 *      `changesets/action`, the unparseable-file branch) — proves the fixture
 *      tests, not just the real-tree test, have teeth;
 *   4. controls that must stay GREEN: dropping only the DIRECT audit need (the
 *      transitive path still gates), a comment edit, and a harmless new workflow.
 *      Without them every red above is equally explained by a harness that can
 *      only see red.
 *
 * Anchors are asserted to occur exactly once by scripts/lib/mutation-harness.mjs
 * (it refuses otherwise), the snapshot restores byte-identically, and every
 * mutation carries the residue marker. Injected files (class 2) are written by
 * this script alone, refused if they already exist, and removed in `finally`.
 *
 * Usage:  node scripts/mutation-prove-publish-lane-supply-chain.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { MUTATION_MARKER, mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github/workflows');
const WORKFLOW = resolve(WORKFLOW_DIR, 'release.yml');
const ENGINE = resolve(REPO_ROOT, 'tests/helpers/publish-lane-supply-chain.ts');
const SPEC = 'tests/publish-lane-supply-chain.test.ts';
const SPEC_FILE = resolve(REPO_ROOT, SPEC);

/**
 * The files mutated, keyed by the `subject` each mutation names. Spelled as a
 * `subjects:` map so `tests/mutation-prover-lane.test.ts` can resolve every
 * anchor below against its file at PR time.
 */
const LANE = { subjects: { workflow: WORKFLOW, engine: ENGINE, spec: SPEC_FILE } };

const DIRECT_NEEDS =
  '    needs: [publish-lane-guard, audit, version-pr, publish-preflight, ga-tarball-diff, pack]\n';
const VERSION_PR_NEEDS = '    needs: [publish-lane-guard, audit]\n';
const RELEASE_IF =
  "    if: >-\n      github.repository == 'getknext-dev/knext'\n" +
  "      && needs.version-pr.outputs.has_changesets == 'false'\n" +
  "      && needs.publish-preflight.outputs.should_publish == 'true'\n";
const AUDIT_RUN = '        run: node scripts/audit-published.mjs\n';

const NEW_WF = (top, publishStep) =>
  `# ${MUTATION_MARKER}\nname: mutation-injected\non: workflow_dispatch\n${top}jobs:\n  ship:\n    runs-on: ubuntu-latest\n    steps:\n${publishStep}`;

const NEW_LANE = (publishStep, jobExtra = '') =>
  `# ${MUTATION_MARKER}\nname: mutation-injected publish lane\non: workflow_dispatch\njobs:\n  ship:\n    runs-on: ubuntu-latest\n${jobExtra}    steps:\n${publishStep}`;

const MUTATIONS = [
  // ── 1. the real release.yml loses a gate ────────────────────────────────
  {
    id: 'M1',
    claim:
      'the audit need is dropped EVERYWHERE (release direct + version-pr), so no path reaches it',
    subject: 'workflow',
    anchor: DIRECT_NEEDS,
    replacement:
      '    needs: [publish-lane-guard, version-pr, publish-preflight, ga-tarball-diff, pack]\n',
    expect: 'red',
  },
  {
    id: 'M1',
    claim: '(second edit of M1: version-pr stops needing the audit too)',
    subject: 'workflow',
    anchor: VERSION_PR_NEEDS,
    replacement: '    needs: [publish-lane-guard]\n',
    expect: 'red',
  },
  {
    id: 'M2',
    claim: 'the SBOM is no longer uploaded (the job keeps running the audit script)',
    subject: 'workflow',
    anchor: '          path: sbom/*.cdx.json\n',
    replacement: '          path: sbom/*.txt\n',
    expect: 'red',
  },
  {
    id: 'M3',
    claim: 'the audit step is softened with continue-on-error',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement: `        continue-on-error: true\n${AUDIT_RUN}`,
    expect: 'red',
  },
  {
    id: 'M4',
    claim: "the credentialed `release` job's if: gains always(), so it starts after a FAILED audit",
    subject: 'workflow',
    anchor: RELEASE_IF,
    replacement: RELEASE_IF.replace('    if: >-\n', '    if: >-\n      always()\n      && '),
    expect: 'red',
  },
  {
    id: 'M5',
    claim: 'the audit job no longer runs scripts/audit-published.mjs at all',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement: '        run: echo skipped-the-audit\n',
    expect: 'red',
  },
  {
    id: 'M6',
    claim: 'the audit invocation is followed by `|| true`',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement: `${AUDIT_RUN.trimEnd()} || true\n`,
    expect: 'red',
  },

  // ── 2. a workflow the scan has never seen ───────────────────────────────
  {
    id: 'M7',
    claim: 'a NEW workflow adds an `npm publish` lane with neither gate',
    inject: {
      name: 'zz-mutation-new-npm-publish.yml',
      content: NEW_LANE('      - run: npm publish --access public\n'),
    },
    expect: 'red',
  },
  {
    id: 'M8',
    claim: 'a NEW workflow adds a `changeset publish` lane with neither gate',
    inject: {
      name: 'zz-mutation-new-changeset-publish.yml',
      content: NEW_LANE('      - run: bunx changeset publish\n'),
    },
    expect: 'red',
  },
  {
    id: 'M9',
    claim: 'a NEW workflow adds a `pnpm publish` lane with neither gate',
    inject: {
      name: 'zz-mutation-new-pnpm-publish.yml',
      content: NEW_LANE('      - run: pnpm publish --no-git-checks\n'),
    },
    expect: 'red',
  },
  {
    id: 'M10',
    claim: 'a NEW workflow publishes through a changesets/action `publish-script` input',
    inject: {
      name: 'zz-mutation-new-changesets-action.yml',
      content: NEW_LANE(
        '      - uses: changesets/action@ae32849d5ba541f9ae29e40e22a623bc13562f51 # v2.1.2\n        with:\n          publish-script: bun run release\n',
      ),
    },
    expect: 'red',
  },
  {
    id: 'M11',
    claim: 'a workflow file that does not parse is injected (fail closed)',
    inject: {
      name: 'zz-mutation-unparseable.yml',
      content: `# ${MUTATION_MARKER}\njobs: [unclosed\n  - : :\n`,
    },
    expect: 'red',
  },
  {
    id: 'M12',
    claim: 'a workflow entry that cannot be read (a directory named *.yml) is injected',
    inject: { name: 'zz-mutation-unreadable.yml', directory: true },
    expect: 'red',
  },

  // ── 3. the engine is weakened ───────────────────────────────────────────
  {
    id: 'M13',
    claim: 'the `needs` closure stops being transitive',
    subject: 'engine',
    anchor: '        stack.push(dep);\n',
    replacement: '        void dep;\n',
    expect: 'red',
  },
  {
    id: 'M14',
    claim: 'a status-bypassing `if` (always()/failure()/cancelled()) no longer severs an edge',
    subject: 'engine',
    anchor:
      "    if (STATUS_BYPASS.test(String(job.if ?? ''))) continue; // starts after a FAILED need\n",
    replacement: "    if (STATUS_BYPASS.test('')) continue;\n",
    expect: 'red',
  },
  {
    id: 'M15',
    claim: 'discovery stops recognising a changesets/action publish input',
    subject: 'engine',
    anchor: '    const changesets = /^changesets\\/action(@|$)/.test(uses);\n',
    replacement: '    const changesets = /^changesets-disabled\\/action(@|$)/.test(uses);\n',
    expect: 'red',
  },
  {
    id: 'M16',
    claim: 'an unparseable workflow is skipped silently instead of failing the guard',
    subject: 'engine',
    anchor:
      "      problems.push(`${file}: cannot be read/parsed (${String(err).split('\\n')[0]})`);\n",
    replacement: '      void err;\n',
    expect: 'red',
  },
  {
    id: 'M17',
    claim: 'a softened audit step (continue-on-error / `||`) still counts as a gate',
    subject: 'engine',
    anchor: '      runsAudit = true;\n',
    replacement: '      runsAudit = true;\n      continue;\n',
    expect: 'red',
  },
  {
    id: 'M18',
    claim: '`.yaml` workflow files are no longer scanned',
    subject: 'engine',
    anchor: ".filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))\n",
    replacement: ".filter((f) => f.endsWith('.yml'))\n",
    expect: 'red',
  },

  // ── 5. round 2: the inverted discovery and the tightened audit gate ──────
  {
    id: 'M19',
    claim: 'the audit step runs under shell: bash {0} (no errexit)',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement: `        shell: bash {0}\n${AUDIT_RUN}`,
    expect: 'red',
  },
  {
    id: 'M20',
    claim: 'the audit invocation is followed by a CONTINUATION-split || true',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement:
      '        run: |\n          node scripts/audit-published.mjs \\\n            || true\n',
    expect: 'red',
  },
  {
    id: 'M21',
    claim: 'the audit invocation carries --help (the script would exit 0 without auditing)',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement: '        run: node scripts/audit-published.mjs --help\n',
    expect: 'red',
  },
  {
    id: 'M22',
    claim: 'a trailing exit 0 follows the audit invocation',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement: '        run: |\n          node scripts/audit-published.mjs\n          exit 0\n',
    expect: 'red',
  },
  {
    id: 'M23',
    claim: 'a NEW workflow publishes from inside a for loop',
    inject: {
      name: 'zz-mutation-new-for-loop.yml',
      content: NEW_LANE(
        '      - run: |\n          for d in core lib db; do npm publish packages/$d; done\n',
      ),
    },
    expect: 'red',
  },
  {
    id: 'M24',
    claim: 'a NEW workflow publishes through xargs',
    inject: {
      name: 'zz-mutation-new-xargs.yml',
      content: NEW_LANE('      - run: echo pkgs | xargs npm publish\n'),
    },
    expect: 'red',
  },
  {
    id: 'M25',
    claim: 'a NEW workflow publishes through a third-party publish action',
    inject: {
      name: 'zz-mutation-new-publish-action.yml',
      content: NEW_LANE('      - uses: JS-DevTools/npm-publish@v3\n'),
    },
    expect: 'red',
  },
  {
    id: 'M26',
    claim: 'a NEW workflow publishes through npx @changesets/cli with flags first',
    inject: {
      name: 'zz-mutation-new-npx-scoped.yml',
      content: NEW_LANE('      - run: npx @changesets/cli publish\n'),
    },
    expect: 'red',
  },
  {
    id: 'M27',
    claim: 'a NEW credentialed job runs an opaque script that never says publish',
    inject: {
      name: 'zz-mutation-new-opaque.yml',
      content: NEW_LANE('      - run: bash ./deploy.sh\n', '    environment: npm-publish\n'),
    },
    expect: 'red',
  },
  {
    id: 'M28',
    claim: 'discovery only recognises the literal `npm publish` (the round-1 shape)',
    subject: 'engine',
    anchor: 'const PUBLISH_WORD = /(?<![A-Za-z0-9])publish(?![A-Za-z0-9-])/i;\n',
    replacement: 'const PUBLISH_WORD = /\\bnpm publish\\b/i;\n',
    expect: 'red',
  },
  {
    id: 'M29',
    claim: 'the credential rule is switched off (opaque commands are invisible again)',
    subject: 'engine',
    anchor: '  if (candidate === null && holdsNpmCredential(job, ctx.wf)) {\n',
    replacement: '  if (false && candidate === null && holdsNpmCredential(job, ctx.wf)) {\n',
    expect: 'red',
  },
  {
    id: 'M30',
    claim: 'line continuations are no longer joined before scanning',
    subject: 'engine',
    anchor: "source.replace(/\\\\\\r?\\n[ \\t]*/g, ' ');\n",
    replacement: 'source;\n',
    expect: 'red',
  },
  {
    id: 'M31',
    claim: 'a stale allowlist entry no longer fails',
    subject: 'engine',
    anchor: '    if (!usedAllowlist.has(e)) {\n',
    replacement: '    if (false) {\n',
    expect: 'red',
  },
  {
    id: 'M32',
    claim: '--help becomes an allowed argument of the audit script',
    subject: 'engine',
    anchor: 'const AUDIT_ALLOWED_ARGS: readonly string[] = [];\n',
    replacement:
      "const AUDIT_ALLOWED_ARGS: readonly string[] = ['--help', '--version', '--dry-run'];\n",
    expect: 'red',
  },
  {
    id: 'M33',
    claim: 'an exit/return with a zero or unknown status no longer neutralises the audit',
    subject: 'engine',
    anchor: "    if ((head === 'exit' || head === 'return') && !isNonZeroLiteral(cmd[1])) {\n",
    replacement: '    if (false) {\n',
    expect: 'red',
  },
  {
    id: 'M34',
    claim: 'the allowlist is keyed on the job id alone (any workflow can borrow an entry)',
    subject: 'engine',
    anchor: 'nonLanes.find((e) => e.file === file && e.job === id)',
    replacement: 'nonLanes.find((e) => e.job === id)',
    expect: 'red',
  },
  {
    id: 'M35',
    claim: 'a custom shell template (bash {0}) is treated as keeping errexit',
    subject: 'engine',
    anchor:
      '  /^(ba)?sh$/.test(shell.trim()) || /^(ba)?sh\\b.*\\s-[A-Za-z]*e/.test(shell.trim());\n',
    replacement: '  /^(ba)?sh$/.test(shell.trim()) || /^(ba)?sh\\b/.test(shell.trim());\n',
    expect: 'red',
  },
  {
    id: 'M36',
    claim: 'every single heredoc is stripped as prose (files and shells included)',
    subject: 'engine',
    anchor: '    if (ops.length !== 1 || !isProseHeredoc(ops[0])) continue;\n',
    replacement: '    if (ops.length !== 1) continue;\n',
    expect: 'red',
  },
  {
    id: 'M37',
    claim: 'the spec allowlist gains an entry that matches no candidate (stale)',
    subject: 'spec',
    anchor: 'const NON_LANES: readonly NonLane[] = [\n',
    replacement:
      "const NON_LANES: readonly NonLane[] = [\n  { file: 'release.yml', job: 'no-such-job', reason: 'mutation: stale entry' },\n",
    expect: 'red',
  },
  {
    id: 'M38',
    claim: 'the spec allowlist loses the entry for the lane guard (an unknown candidate)',
    subject: 'spec',
    anchor: "    job: 'publish-lane-guard',\n",
    replacement: "    job: 'publish-lane-guard-renamed',\n",
    expect: 'red',
  },

  // ── 6. round 3: workflow env, heredoc content, shell defaults, rules ─────
  {
    id: 'M39',
    claim:
      'a NEW workflow carries the npm credential at WORKFLOW level (job runs an opaque script)',
    inject: {
      name: 'zz-mutation-wf-env-cred.yml',
      content: NEW_WF(
        'env:\n  NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n',
        '      - run: bash ./r.sh\n',
      ),
    },
    expect: 'red',
  },
  {
    id: 'M40',
    claim: 'a NEW workflow writes its publish into a heredoc FILE and runs it',
    inject: {
      name: 'zz-mutation-heredoc-file.yml',
      content: NEW_LANE(
        "      - run: |\n          cat > r.sh <<'EOF'\n          npm publish\n          EOF\n          bash r.sh\n",
      ),
    },
    expect: 'red',
  },
  {
    id: 'M41',
    claim: 'a NEW workflow hides its publish behind a quoted <<EOF in an echo',
    inject: {
      name: 'zz-mutation-quoted-heredoc.yml',
      content: NEW_LANE(
        '      - run: |\n          echo "v $((1<<SHIFT))"\n          npm publish\n',
      ),
    },
    expect: 'red',
  },
  {
    id: 'M42',
    claim: 'a NEW workflow publishes by OIDC (id-token: write, no token, no publish word)',
    inject: {
      name: 'zz-mutation-oidc.yml',
      content: NEW_LANE(
        '      - run: npm run deploy\n',
        '    permissions:\n      id-token: write\n',
      ),
    },
    expect: 'red',
  },
  {
    id: 'M43',
    claim: 'workflow-level defaults.run.shell is bash {0} for the audit step',
    subject: 'workflow',
    anchor: '\njobs:\n',
    replacement: '\ndefaults:\n  run:\n    shell: bash {0}\n\njobs:\n',
    expect: 'red',
  },
  {
    id: 'M44',
    claim: 'the audit step is followed by exit "0" (a spelling no regex listed)',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement: '        run: |\n          node scripts/audit-published.mjs\n          exit "0"\n',
    expect: 'red',
  },
  {
    id: 'M45',
    claim: 'the audit step runs under set +eu',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement: '        run: |\n          set +eu\n          node scripts/audit-published.mjs\n',
    expect: 'red',
  },
  {
    id: 'M46',
    claim: 'the SBOM upload step is skipped with if: false',
    subject: 'workflow',
    anchor: '          path: sbom/*.cdx.json\n',
    replacement: '          path: sbom/*.cdx.json\n        if: false\n',
    expect: 'red',
  },
  {
    id: 'M47',
    claim: 'the workflow-level env is no longer inherited by jobs',
    subject: 'engine',
    anchor: "  const text = allStrings([job, wf.env]).join('\\n');\n",
    replacement: "  const text = allStrings([job]).join('\\n');\n",
    expect: 'red',
  },
  {
    id: 'M48',
    claim: 'the id-token rule is switched off',
    subject: 'engine',
    anchor: '  if (candidate === null && grantsIdToken(job, ctx.wf) && runsNpmFamily(steps)) {\n',
    replacement:
      '  if (false && candidate === null && grantsIdToken(job, ctx.wf) && runsNpmFamily(steps)) {\n',
    expect: 'red',
  },
  {
    id: 'M49',
    claim: 'an allowlisted job is excused even after it gains the credential or a real publish',
    subject: 'engine',
    anchor: '        if (f.excusal) {\n',
    replacement: '        if (false) {\n',
    expect: 'red',
  },
  {
    id: 'M50',
    claim: 'a quoted <<WORD is treated as a heredoc operator again',
    subject: 'engine',
    anchor: '    if (quote) {\n',
    replacement: '    if (false) {\n',
    expect: 'red',
  },
  {
    id: 'M51',
    claim: 'the workflow-level defaults.run.shell is no longer consulted',
    subject: 'engine',
    anchor:
      "typeof step.shell === 'string' ? step.shell : (defaultShellOf(job) ?? ctx.wf.shell);\n",
    replacement: "typeof step.shell === 'string' ? step.shell : undefined;\n",
    expect: 'red',
  },
  {
    id: 'M52',
    claim: 'set +o errexit no longer neutralises the audit',
    subject: 'engine',
    anchor:
      "      const offOption = rest.some((t, i) => t === '+o' && rest[i + 1] === 'errexit');\n",
    replacement: '      const offOption = false;\n',
    expect: 'red',
  },
  {
    id: 'M53',
    claim: 'an SBOM upload under continue-on-error / a conditional still counts',
    subject: 'engine',
    anchor: '      !softensFailure(step) &&\n',
    replacement: '      true &&\n',
    expect: 'red',
  },

  // ── 7. round 4: the audit must be a top-level simple command ─────────────
  {
    id: 'M54',
    claim: 'the audit step wraps the audit in if [ -z "$SKIP_AUDIT" ]; then … fi',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement:
      '        run: |\n          if [ -z "$SKIP_AUDIT" ]; then\n            node scripts/audit-published.mjs\n          fi\n',
    expect: 'red',
  },
  {
    id: 'M55',
    claim: 'the audit step puts the audit behind a dangling && line',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement:
      '        run: |\n          [ -z "$SKIP_AUDIT" ] &&\n          node scripts/audit-published.mjs\n',
    expect: 'red',
  },
  {
    id: 'M56',
    claim: 'the audit step buries the audit in a : <<X comment heredoc',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement:
      "        run: |\n          : <<'X'\n          node scripts/audit-published.mjs\n          X\n",
    expect: 'red',
  },
  {
    id: 'M57',
    claim: 'the audit step defines the audit as a function it never calls',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement:
      '        run: |\n          run_audit() {\n            node scripts/audit-published.mjs\n          }\n',
    expect: 'red',
  },
  {
    id: 'M58',
    claim: 'the audit step runs the audit inside while false',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement:
      '        run: |\n          while false; do\n            node scripts/audit-published.mjs\n          done\n',
    expect: 'red',
  },
  {
    id: 'M59',
    claim: 'the structural (top-level simple command) check is switched off',
    subject: 'engine',
    anchor: '  const structural = bareIdx.map((i) => structureProblem(joined, i));\n',
    replacement: '  const structural = bareIdx.map(() => null);\n',
    expect: 'red',
  },
  {
    id: 'M60',
    claim: 'a dangling && / || / | no longer disqualifies the audit',
    subject: 'engine',
    anchor: '    if (/(&&|\\|\\||\\|)$/.test(t)) {\n',
    replacement: '    if (false) {\n',
    expect: 'red',
  },
  {
    id: 'M61',
    claim: 'an audit inside a heredoc body is accepted again',
    subject: 'engine',
    anchor:
      "  if (heredocBodyLines(lines)[lineIdx]) return 'it sits inside a heredoc body, not as a command';\n",
    replacement: '  void heredocBodyLines;\n',
    expect: 'red',
  },
  {
    id: 'M62',
    claim: 'an enclosing compound statement (depth != 0) no longer disqualifies the audit',
    subject: 'engine',
    anchor: '  if (depth !== 0) {\n',
    replacement: '  if (false) {\n',
    expect: 'red',
  },
  {
    id: 'M63',
    claim: 'if/while/until/for/case/select/function stop opening a compound statement',
    subject: 'engine',
    anchor:
      "const OPENERS = new Set(['if', 'while', 'until', 'for', 'case', 'select', 'function']);\n",
    replacement: 'const OPENERS = new Set<string>([]);\n',
    expect: 'red',
  },
  {
    id: 'M64',
    claim:
      'exit 0 / unknown statuses are accepted as literal non-zero (an exit no longer neutralises)',
    subject: 'engine',
    anchor: '  arg !== undefined && /^[1-9][0-9]*$/.test(arg);\n',
    replacement: '  arg !== undefined || arg === undefined;\n',
    expect: 'red',
  },
  {
    id: 'M65',
    claim: 'leading then/do/else keywords are no longer stripped (then exit 0 hides)',
    subject: 'engine',
    anchor: "const LEAD_KEYWORDS = new Set(['then', 'do', 'else', '{', '!', 'time']);\n",
    replacement: 'const LEAD_KEYWORDS = new Set<string>([]);\n',
    expect: 'red',
  },
  {
    id: 'M66',
    claim: 'gh issue create -F - heredocs stop counting as prose',
    subject: 'engine',
    anchor:
      "  if (tokens[0] !== 'gh' || !['issue', 'pr'].includes(tokens[1] ?? '')) return false;\n",
    replacement: "  if (tokens[0] !== 'gh') return false;\n  return false;\n",
    expect: 'red',
  },
  {
    id: 'M67',
    claim: '$(cat <<EOF) inside a double-quoted string is no longer a command context',
    subject: 'engine',
    anchor:
      "      else if (quote === '\"' && c === '$' && line[i + 1] === '(' && line[i + 2] !== '(') {\n",
    replacement: '      else if (false) {\n',
    expect: 'red',
  },
  {
    id: 'M68',
    claim:
      'the outer command of $(cat <<EOF) is no longer checked (bash -c "$(cat <<EOF)" is prose)',
    subject: 'engine',
    anchor: "    if (!outerOk || head !== 'cat') return false;\n",
    replacement: "    if (head !== 'cat') return false;\n",
    expect: 'red',
  },
  {
    id: 'M69',
    claim: 'an _authToken line is no longer a credential signal',
    subject: 'engine',
    anchor: "    text.includes('_authToken') ||\n",
    replacement: '    false ||\n',
    expect: 'red',
  },
  {
    id: 'M70',
    claim: 'a NEW workflow writes an .npmrc _authToken and ships with an opaque command',
    inject: {
      name: 'zz-mutation-authtoken.yml',
      content: NEW_LANE(
        '      - run: |\n          echo "//registry.npmjs.org/:_authToken=$T" > .npmrc\n          pnpm -r ship\n',
      ),
    },
    expect: 'red',
  },
  {
    id: 'M71',
    claim: 'a NEW workflow publishes inside bash -c "$(cat <<EOF …)"',
    inject: {
      name: 'zz-mutation-subst-heredoc.yml',
      content: NEW_LANE(
        '      - run: |\n          bash -c "$(cat <<\'EOF\'\n          npm publish\n          EOF\n          )"\n',
      ),
    },
    expect: 'red',
  },

  // ── 4. controls: these must stay GREEN ──────────────────────────────────
  {
    id: 'NEG1',
    claim:
      'NEGATIVE CONTROL: only the DIRECT audit need is dropped (still reached via version-pr) — must stay GREEN',
    subject: 'workflow',
    anchor: DIRECT_NEEDS,
    replacement:
      '    needs: [publish-lane-guard, version-pr, publish-preflight, ga-tarball-diff, pack]\n',
    expect: 'green',
  },
  {
    id: 'NEG2',
    claim:
      'NEGATIVE CONTROL: a doc-comment sentence in the audit job is reworded — must stay GREEN',
    subject: 'workflow',
    anchor: '  # npm/JS supply-chain gate (v4-P3). The image Trivy gate scans containers; this\n',
    replacement:
      '  # npm/JS supply-chain gate (v4-P3). The image Trivy gate scans containers, while this\n',
    expect: 'green',
  },
  {
    id: 'NEG3',
    claim: 'NEGATIVE CONTROL: a NEW workflow with no publish at all — must stay GREEN',
    inject: {
      name: 'zz-mutation-harmless.yml',
      content: NEW_LANE('      - run: echo nothing is published here\n'),
    },
    expect: 'green',
  },
  {
    id: 'NEG4',
    claim:
      'NEGATIVE CONTROL: a NEW workflow with near-miss words (published, publish-lane-guard.mjs) — must stay GREEN',
    inject: {
      name: 'zz-mutation-near-miss.yml',
      content: NEW_LANE(
        '      - run: |\n          echo published\n          node scripts/publish-lane-guard.mjs ref\n',
      ),
    },
    expect: 'green',
  },
  {
    id: 'NEG5',
    claim:
      'NEGATIVE CONTROL: a NEW workflow with comment-only and cat-heredoc prose about publishing — must stay GREEN',
    inject: {
      name: 'zz-mutation-prose.yml',
      content: NEW_LANE(
        '      # npm publish is only described here\n      - run: |\n          cat <<EOF\n          npm publish credential\n          EOF\n',
      ),
    },
    expect: 'green',
  },
  {
    id: 'NEG6',
    claim:
      'NEGATIVE CONTROL: the real audit step followed by an error branch with exit 1 — must stay GREEN',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement:
      '        run: |\n          node scripts/audit-published.mjs\n          if [ -f audit-error.log ]; then\n            echo "audit left errors"\n            exit 1\n          fi\n',
    expect: 'green',
  },
  {
    id: 'NEG7',
    claim:
      'NEGATIVE CONTROL: a NEW workflow whose issue body (gh issue create -F - heredoc) mentions npm publish — must stay GREEN',
    inject: {
      name: 'zz-mutation-gh-body.yml',
      content: NEW_LANE(
        "      - run: |\n          gh issue create --title t -F - <<'EOF'\n          npm publish is documented elsewhere\n          EOF\n",
      ),
    },
    expect: 'green',
  },
  {
    id: 'NEG8',
    claim:
      'NEGATIVE CONTROL: a NEW workflow with --body "$(cat <<EOF)" prose about npm publish — must stay GREEN',
    inject: {
      name: 'zz-mutation-gh-subst.yml',
      content: NEW_LANE(
        '      - run: |\n          gh issue create --title t --body "$(cat <<\'EOF\'\n          npm publish is documented elsewhere\n          EOF\n          )"\n',
      ),
    },
    expect: 'green',
  },
];

/**
 * A mutation is one or more table rows sharing an `id` (M1 must cut two `needs`
 * edges before the audit becomes unreachable). The rows stay flat, one anchor
 * each, so tests/mutation-prover-lane.test.ts can resolve every anchor.
 */
const CASES = new Map();
for (const row of MUTATIONS) CASES.set(row.id, [...(CASES.get(row.id) ?? []), row]);

declareMutations(CASES.size);

/** The spec's exit code — the only signal graded. */
function specExit() {
  const runner = resolveSpecRunner(REPO_ROOT, SPEC);
  const result = spawnSync(process.execPath, [...runner.args, ...runner.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return result.status ?? 1;
}

/** Run `fn` with the injected workflow present, and remove it no matter what. */
function withInjected(inject, fn) {
  const target = resolve(WORKFLOW_DIR, inject.name);
  if (existsSync(target)) {
    console.error(`FATAL: ${target} already exists — refusing to overwrite or later delete it`);
    process.exit(1);
  }
  try {
    if (inject.directory) mkdirSync(target);
    else writeFileSync(target, inject.content, 'utf8');
    return fn();
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

/** Apply every edit to one file, run the spec, and restore the bytes in `finally`. */
function withEdits(file, rows, fn) {
  const snap = snapshot(file);
  try {
    for (const { anchor, replacement } of rows) mutate(snap, anchor, replacement);
    return fn();
  } finally {
    restore(snap);
  }
}

const baseline = specExit();
console.log(`Baseline ${SPEC}: exit=${baseline}`);
if (baseline !== 0) {
  console.error(`FATAL: ${SPEC} is not green before anything is mutated`);
  process.exit(1);
}

let pass = 0;
let fail = 0;
for (const rows of CASES.values()) {
  const m = rows[0];
  let code;
  if (m.inject) {
    code = withInjected(m.inject, specExit);
  } else {
    const file = LANE.subjects[m.subject];
    if (file === undefined) {
      console.error(`FATAL: ${m.id} names an unknown subject ${JSON.stringify(m.subject)}`);
      process.exit(1);
    }
    code = withEdits(file, rows, specExit);
  }
  const red = code !== 0;
  const ok = m.expect === 'red' ? red : !red;
  console.log(`${m.id} ${ok ? 'ok  ' : 'FAIL'} exit=${code} (expected ${m.expect}) — ${m.claim}`);
  if (ok) pass += 1;
  else fail += 1;
  recordMutation();
  const after = specExit();
  if (after !== 0) {
    console.error(`FATAL: ${SPEC} exit=${after} after restoring ${m.id}`);
    process.exit(1);
  }
}

console.log(`\n${pass} of ${CASES.size} graded as expected, ${fail} not.`);
process.exit(fail === 0 ? 0 : 1);
