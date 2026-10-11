import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { auditPublishLanes, type NonLane } from './helpers/publish-lane-supply-chain';
import { WORKFLOW_DIR } from './helpers/release-workflow';

/**
 * SUPPLY-CHAIN GUARD for every npm publish lane (#2044, v2 task R8 — today's
 * lanes only).
 *
 * `security.md` makes the npm audit (`npm audit --omit=dev` over the packed
 * production closure) and the CycloneDX SBOM (`scripts/audit-published.mjs`)
 * PUBLISH-BLOCKING. `release.yml` honours that today because its `release` job
 * `needs` the `audit` job. Nothing stopped the NEXT publish lane — a second
 * workflow, a second job — from shipping without either. This file is that
 * stop.
 *
 * FAIL-CLOSED DISCOVERY (round 2). Round 1 enumerated command forms and the
 * review bypassed every form it did not list. Discovery is now INVERTED: any job
 * whose parsed text says `publish` (run statement, `uses:`, `with:`, `env:`, a
 * local composite action), whose `<pm> run` alias says it, or that holds the npm
 * credential, is a lane CANDIDATE and must pass the gates unless it is named in
 * `NON_LANES` below. A new candidate therefore fails until a human reads it and
 * either gates it or writes down why it is not a lane.
 *
 * FAIL CLOSED on what cannot be read: a workflow or composite action that is
 * unreadable or unparseable fails the guard.
 *
 * Mutation-proved by `scripts/mutation-prove-publish-lane-supply-chain.mjs`
 * (graded on exit codes).
 */

/**
 * The reviewed allowlist: candidates that are NOT publish lanes. Each entry is
 * keyed by workflow + job and carries a reason a reviewer can check. An entry
 * that matches no candidate is a failure (the engine reds on stale entries), so
 * this list cannot quietly outlive the job it excuses.
 */
const NON_LANES: readonly NonLane[] = [
  {
    file: 'action-pin-resolution-nightly.yml',
    job: 'nightly-red-alert',
    reason: 'opens a GitHub issue; the body prose says "npm publish credential"; no npm access',
  },
  {
    file: 'anonymous-install-nightly.yml',
    job: 'nightly-red-alert',
    reason: 'opens a GitHub issue; the body prose mentions publish; no npm access',
  },
  {
    file: 'npm-publish-drift-nightly.yml',
    job: 'npm-publish-drift-red-alert',
    reason: 'opens a GitHub issue titled about npm-publish protection drift; publishes nothing',
  },
  {
    file: 'scaffold-install-nightly.yml',
    job: 'nightly-red-alert',
    reason: 'opens a GitHub issue; the body prose mentions publish; no npm access',
  },
  {
    file: 'release.yml',
    job: 'publish-lane-guard',
    reason:
      'the ref/major guard itself ($PUBLISH_REF): holds no credential and is the root every job hangs from, so it cannot need the audit',
  },
];

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
  workflowDir: string;
  packageJsonPath: string;
  repoRoot: string;
}

/**
 * A throwaway repo: `<root>/.github/workflows`, `<root>/package.json`, and any
 * `extra` files (path under root -> text). `files` maps workflow name -> raw
 * text, or null for a directory entry.
 */
function fixture(
  files: Record<string, string | null>,
  rootScripts?: Record<string, string>,
  extra: Record<string, string> = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'publish-lane-'));
  tmpDirs.push(root);
  const dir = join(root, '.github', 'workflows');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    if (text === null) mkdirSync(join(dir, name));
    else writeFileSync(join(dir, name), text);
  }
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const pkg = join(root, 'package.json');
  writeFileSync(pkg, JSON.stringify({ name: 'root', scripts: rootScripts ?? {} }));
  return { workflowDir: dir, packageJsonPath: pkg, repoRoot: root };
}

const AUDIT_JOB = `
  audit:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/audit-published.mjs
      - uses: actions/upload-artifact@v7
        with:
          name: npm-sbom
          path: sbom/*.cdx.json
`;

const auditJobWith = (runBody: string, stepExtra = '') => `
  audit:
    runs-on: ubuntu-latest
    steps:
      - ${stepExtra}run: |
${runBody
  .split('\n')
  .map((l) => `          ${l}`)
  .join('\n')}
      - uses: actions/upload-artifact@v7
        with:
          name: npm-sbom
          path: sbom/*.cdx.json
`;

const wf = (jobsYaml: string) => `name: t\non: push\njobs:${jobsYaml}`;

/** A lane job running `run` (a block scalar, so `{ ...; }` and `for` parse as shell). */
const publishJob = (needs: string, run = 'npm publish --access public', jobExtra = '') => `
  release:
    runs-on: ubuntu-latest
    needs: ${needs}
${jobExtra}    steps:
      - run: |
${run
  .split('\n')
  .map((l) => `          ${l}`)
  .join('\n')}
`;

const laneIds = (a: { lanes: Array<{ file: string; jobId: string }> }) =>
  a.lanes.map((l) => `${l.file}#${l.jobId}`);

describe('publish-lane supply-chain guard: the real workflows', () => {
  const audit = auditPublishLanes({ workflowDir: WORKFLOW_DIR, nonLanes: NON_LANES });

  it('every npm publish lane transitively needs the audit gate and the SBOM job', () => {
    expect(audit.problems).toEqual([]);
  });

  it('is not vacuous: the scan read workflows, found release.yml#release and an audit+SBOM job', () => {
    expect(audit.workflowsSeen).toBeGreaterThan(10);
    expect(laneIds(audit)).toContain('release.yml#release');
    expect(audit.auditJobs.map((j) => j.replace(/^.*#/, ''))).toContain('audit');
    expect(audit.sbomJobs.map((j) => j.replace(/^.*#/, ''))).toContain('audit');
  });

  it('every allowlisted non-lane is really a candidate (the allowlist cannot go stale)', () => {
    expect([...audit.excused].sort()).toEqual(NON_LANES.map((e) => `${e.file}#${e.job}`).sort());
  });

  it('without the allowlist the real tree is NOT clean (the allowlist is load-bearing)', () => {
    const bare = auditPublishLanes({ workflowDir: WORKFLOW_DIR });
    expect(bare.problems.length).toBeGreaterThan(0);
  });
});

describe('publish-lane supply-chain guard: discovery over-matches, it does not enumerate', () => {
  /** Every one of these was a GREEN bypass of the round-1 enumerating scan. */
  const BYPASSES: Array<[string, string]> = [
    ['plain npm publish', 'npm publish --access public'],
    ['pnpm publish', 'pnpm publish --no-git-checks'],
    ['bunx changeset publish', 'bunx changeset publish'],
    ['bun publish', 'bun publish'],
    ['yarn npm publish', 'yarn npm publish'],
    ['env-prefixed + wrapped', 'NODE_AUTH_TOKEN=$T npx --yes changeset publish'],
    // shell compound keywords
    ['for loop', 'for d in core lib db; do npm publish packages/$d; done'],
    ['if/then', 'if [ -n "$X" ]; then npm publish; fi'],
    ['subshell', '(npm publish)'],
    ['brace group', '{ npm publish; }'],
    // wide flag windows before the subcommand
    ['long flags before publish', 'npm --workspace=a --tag next --access public publish'],
    ['repeated -w', 'npm -w a -w b publish'],
    ['pnpm --filter x2', 'pnpm --filter a --filter b publish'],
    // launcher / head forms
    ['npx scoped cli', 'npx @changesets/cli publish'],
    ['npx versioned', 'npx changeset@2 publish'],
    ['npx -p', 'npx -p @changesets/cli changeset publish'],
    ['npx npm@10', 'npx npm@10 publish'],
    ['node_modules/.bin path', './node_modules/.bin/changeset publish'],
    ['node + bin path', 'node node_modules/.bin/changeset publish'],
    ['absolute path', '/usr/bin/npm publish'],
    ['lerna', 'npx lerna publish'],
    ['timeout', 'timeout 60 npm publish'],
    ['xargs', 'echo pkgs | xargs npm publish'],
    ['make target', 'make publish'],
    // env / script indirection that still SAYS publish
    ['variable named PUBLISH_CMD', '$PUBLISH_CMD'],
    ['script named publish.sh', 'bash ./publish.sh'],
    ['expression naming publish', '${{ inputs.publish_cmd }}'],
    ['eval of a publish variable', 'eval "$PUBLISH_COMMAND"'],
  ];

  for (const [label, run] of BYPASSES) {
    it(`a brand-new workflow with \`${label}\` and no gate reds`, () => {
      const audit = auditPublishLanes(fixture({ 'zz-new.yml': wf(publishJob('[]', run)) }));
      expect(laneIds(audit)).toEqual(['zz-new.yml#release']);
      expect(audit.problems.length).toBeGreaterThan(0);
    });
  }

  it('a line-continued publish is found (continuations are joined first)', () => {
    const audit = auditPublishLanes(
      fixture({ 'a.yml': wf(publishJob('[]', 'npm \\\n  --tag next \\\n  publish')) }),
    );
    expect(laneIds(audit)).toEqual(['a.yml#release']);
  });

  it('a changesets/action step with a `publish-script` (or v1 `publish`) input is a lane', () => {
    for (const key of ['publish-script', 'publish']) {
      const yml = wf(`
  ship:
    runs-on: ubuntu-latest
    steps:
      - uses: changesets/action@ae32849d5ba541f9ae29e40e22a623bc13562f51 # v2.1.2
        with:
          ${key}: \${{ steps.gate.outputs.out }}
`);
      const audit = auditPublishLanes(fixture({ 'a.yml': yml }));
      expect(audit.lanes.map((l) => l.jobId)).toEqual(['ship']);
      expect(audit.problems.length).toBeGreaterThan(0);
    }
  });

  it('a changesets/action step with only `version-script` is NOT a candidate', () => {
    const yml = wf(`
  vpr:
    runs-on: ubuntu-latest
    steps:
      - uses: changesets/action@ae32849d5ba541f9ae29e40e22a623bc13562f51 # v2.1.2
        with:
          version-script: bun run changeset:version
`);
    const audit = auditPublishLanes(fixture({ 'a.yml': yml }));
    expect(audit.lanes).toEqual([]);
    expect(audit.problems).toEqual([]);
  });

  it('third-party publish actions are candidates (by name, and by a wrapped command)', () => {
    const named = wf(`
  ship:
    runs-on: ubuntu-latest
    steps:
      - uses: JS-DevTools/npm-publish@v3
        with:
          token: \${{ secrets.X }}
`);
    const wrapped = wf(`
  ship:
    runs-on: ubuntu-latest
    steps:
      - uses: nick-fields/retry@v3
        with:
          max_attempts: 3
          command: npm publish
`);
    for (const yml of [named, wrapped]) {
      const audit = auditPublishLanes(fixture({ 'a.yml': yml }));
      expect(laneIds(audit)).toEqual(['a.yml#ship']);
      expect(audit.problems.length).toBeGreaterThan(0);
    }
  });

  it('a local composite action that publishes makes its caller a candidate', () => {
    const composite = `name: c\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: npm publish\n`;
    const caller = wf(`
  ship:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/pub
`);
    const audit = auditPublishLanes(
      fixture({ 'a.yml': caller }, {}, { '.github/actions/pub/action.yml': composite }),
    );
    expect(laneIds(audit)).toEqual(['a.yml#ship']);
    expect(audit.problems.length).toBeGreaterThan(0);
  });

  it('a local composite action that cannot be read fails closed', () => {
    const caller = wf(`
  ship:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/ghost
`);
    const audit = auditPublishLanes(fixture({ 'a.yml': caller }));
    expect(audit.problems.join('\n')).toMatch(/ghost/);
  });

  it('a harmless local composite action is not a candidate', () => {
    const composite = `name: c\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo hi\n`;
    const caller = wf(`
  ok:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/hi
`);
    const audit = auditPublishLanes(
      fixture({ 'a.yml': caller }, {}, { '.github/actions/hi/action.yml': composite }),
    );
    expect(audit.lanes).toEqual([]);
    expect(audit.problems).toEqual([]);
  });

  it('an env value that says publish is a candidate, even when the run is opaque', () => {
    const yml = wf(`
  ship:
    runs-on: ubuntu-latest
    steps:
      - env:
          CMD: npm publish
        run: $CMD
`);
    const audit = auditPublishLanes(fixture({ 'a.yml': yml }));
    expect(laneIds(audit)).toEqual(['a.yml#ship']);
  });

  it('`<pm> run <script>` is a candidate when the root package.json script says publish', () => {
    const files = { 'a.yml': wf(publishJob('[]', 'bun run release')) };
    const aliased = auditPublishLanes(fixture(files, { release: 'changeset publish' }));
    expect(laneIds(aliased)).toEqual(['a.yml#release']);
    const nested = auditPublishLanes(
      fixture(files, { release: 'bun run ship', ship: 'npm publish' }),
    );
    expect(laneIds(nested)).toEqual(['a.yml#release']);
    const harmless = auditPublishLanes(fixture(files, { release: 'echo hi' }));
    expect(harmless.lanes).toEqual([]);
  });

  it('comments and cat/tee heredoc prose are not candidates; a quoted echo IS (over-match)', () => {
    const prose = `name: t
on: push
jobs:
  alert:
    runs-on: ubuntu-latest
    steps:
      # npm publish is described here only
      - run: |
          cat <<EOF
          - release.yml holds a live npm publish credential.
          EOF
          echo done
`;
    const quiet = auditPublishLanes(fixture({ 'a.yml': prose }));
    expect(quiet.lanes).toEqual([]);
    expect(quiet.problems).toEqual([]);

    const echoed = prose.replace('echo done', 'echo "see npm publish docs"');
    const loud = auditPublishLanes(fixture({ 'a.yml': echoed }));
    expect(laneIds(loud)).toEqual(['a.yml#alert']);
  });

  it('a heredoc fed to a SHELL is code, not prose', () => {
    const yml = `name: t
on: push
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - run: |
          cat <<EOF | bash
          npm publish
          EOF
`;
    const audit = auditPublishLanes(fixture({ 'a.yml': yml }));
    expect(laneIds(audit)).toEqual(['a.yml#ship']);
  });

  it('near-miss words are NOT candidates (published, publishes, publish-lane-guard.mjs)', () => {
    const yml = wf(
      publishJob(
        '[]',
        'echo published\nnode scripts/publish-lane-guard.mjs ref\nnode scripts/check-published-digest.mjs',
      ),
    );
    const audit = auditPublishLanes(fixture({ 'a.yml': yml }));
    expect(audit.lanes).toEqual([]);
  });
});

describe('publish-lane supply-chain guard: credential-keyed backstop for indirection', () => {
  /** Opaque commands that NEVER say publish — only the credential gives them away. */
  const OPAQUE: Array<[string, string]> = [
    ['bare $CMD', '$CMD'],
    ['eval', 'eval "$X"'],
    ['expression head', '${{ inputs.cmd }}'],
    ['script run', 'bash ./deploy.sh'],
  ];
  const CREDENTIALS: Array<[string, string]> = [
    ['NODE_AUTH_TOKEN env', '    env:\n      NODE_AUTH_TOKEN: ${{ secrets.TOKEN }}\n'],
    ['secrets.NPM_TOKEN', '    env:\n      T: ${{ secrets.NPM_TOKEN }}\n'],
    ["secrets['NPM_TOKEN']", "    env:\n      T: ${{ secrets['NPM_TOKEN'] }}\n"],
    ['npm-publish environment', '    environment: npm-publish\n'],
    ['expression environment', '    environment: ${{ inputs.target }}\n'],
  ];

  for (const [opaqueLabel, run] of OPAQUE) {
    for (const [credLabel, cred] of CREDENTIALS) {
      it(`a credentialed job running ${opaqueLabel} (${credLabel}) is a candidate`, () => {
        const audit = auditPublishLanes(fixture({ 'a.yml': wf(publishJob('[]', run, cred)) }));
        expect(laneIds(audit)).toEqual(['a.yml#release']);
        expect(audit.problems.length).toBeGreaterThan(0);
      });
    }
  }

  it('the same opaque command WITHOUT a credential and without the word is the documented blind spot', () => {
    const audit = auditPublishLanes(fixture({ 'a.yml': wf(publishJob('[]', 'bash ./deploy.sh')) }));
    expect(audit.lanes).toEqual([]);
  });
});

describe('publish-lane supply-chain guard: the reviewed allowlist', () => {
  const lane = wf(publishJob('[]', 'echo "npm publish is documented elsewhere"'));

  it('an allowlisted candidate is excused, and reported as excused', () => {
    const audit = auditPublishLanes({
      ...fixture({ 'a.yml': lane }),
      nonLanes: [{ file: 'a.yml', job: 'release', reason: 'prose only, no npm access' }],
    });
    expect(audit.problems).toEqual([]);
    expect(audit.excused).toEqual(['a.yml#release']);
    expect(audit.lanes).toEqual([]);
  });

  it('an unknown candidate fails (the allowlist keys on workflow AND job)', () => {
    const audit = auditPublishLanes({
      ...fixture({ 'a.yml': lane }),
      nonLanes: [
        { file: 'a.yml', job: 'other', reason: 'a different job entirely' },
        { file: 'b.yml', job: 'release', reason: 'a different file entirely' },
      ],
    });
    expect(laneIds(audit)).toEqual(['a.yml#release']);
    expect(audit.problems.join('\n')).toMatch(/stale allowlist entry a\.yml#other/);
    expect(audit.problems.join('\n')).toMatch(/stale allowlist entry b\.yml#release/);
  });

  it('a stale entry (matches no candidate) fails', () => {
    const audit = auditPublishLanes({
      ...fixture({ 'a.yml': wf(AUDIT_JOB) }),
      nonLanes: [{ file: 'a.yml', job: 'audit', reason: 'not actually a candidate at all' }],
    });
    expect(audit.problems.join('\n')).toMatch(/stale allowlist entry a\.yml#audit/);
  });

  it('an entry without a real reason fails', () => {
    const audit = auditPublishLanes({
      ...fixture({ 'a.yml': lane }),
      nonLanes: [{ file: 'a.yml', job: 'release', reason: '' }],
    });
    expect(audit.problems.join('\n')).toMatch(/real reason/);
  });
});

describe('publish-lane supply-chain guard: the needs graph', () => {
  it('passes a lane that needs the audit/SBOM job directly', () => {
    const audit = auditPublishLanes(fixture({ 'a.yml': wf(`${AUDIT_JOB}${publishJob('audit')}`) }));
    expect(audit.problems).toEqual([]);
    expect(audit.lanes).toHaveLength(1);
  });

  it('passes a lane that reaches the audit transitively', () => {
    const mid = `
  mid:
    runs-on: ubuntu-latest
    needs: audit
    steps:
      - run: echo mid
`;
    const audit = auditPublishLanes(
      fixture({ 'a.yml': wf(`${AUDIT_JOB}${mid}${publishJob('mid')}`) }),
    );
    expect(audit.problems).toEqual([]);
  });

  it('reds a lane that does not need the audit job (drop-the-audit-need)', () => {
    const audit = auditPublishLanes(fixture({ 'a.yml': wf(`${AUDIT_JOB}${publishJob('[]')}`) }));
    expect(audit.problems.join('\n')).toMatch(/audit/i);
  });

  it('reds a lane that has the audit gate but no SBOM job', () => {
    const noSbom = `
  audit:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/audit-published.mjs
`;
    const audit = auditPublishLanes(fixture({ 'a.yml': wf(`${noSbom}${publishJob('audit')}`) }));
    expect(audit.problems.join('\n')).toMatch(/SBOM job/);
    expect(audit.problems.join('\n')).not.toMatch(
      /does not transitively `needs` an npm-audit gate/,
    );
  });

  it('reds a lane that has an SBOM job but not the audit gate', () => {
    const sbomOnly = `
  sbom:
    runs-on: ubuntu-latest
    steps:
      - run: npx @cyclonedx/cyclonedx-npm --output-file sbom/x.cdx.json
      - uses: actions/upload-artifact@v7
        with:
          path: sbom/*.cdx.json
`;
    const audit = auditPublishLanes(fixture({ 'a.yml': wf(`${sbomOnly}${publishJob('sbom')}`) }));
    expect(audit.problems.join('\n')).toMatch(/npm-audit gate/);
  });

  it('gives no credit to an audit job in ANOTHER workflow file', () => {
    const audit = auditPublishLanes(
      fixture({
        'gate.yml': wf(AUDIT_JOB),
        'lane.yml': wf(publishJob('audit')),
      }),
    );
    expect(audit.problems.length).toBeGreaterThan(0);
  });

  it('a needs edge out of a job with an always()/failure()/cancelled() `if` does not count', () => {
    for (const cond of ['always()', 'failure()', '!cancelled()', 'cancelled() || success()']) {
      const lane = publishJob('audit', 'npm publish', `    if: \${{ ${cond} }}\n`);
      const audit = auditPublishLanes(fixture({ 'a.yml': wf(`${AUDIT_JOB}${lane}`) }));
      expect(audit.problems.length).toBeGreaterThan(0);
    }
  });

  it('an intermediate job with a bypassing `if` severs the transitive path', () => {
    const mid = `
  mid:
    runs-on: ubuntu-latest
    needs: audit
    if: always()
    steps:
      - run: echo mid
`;
    const audit = auditPublishLanes(
      fixture({ 'a.yml': wf(`${AUDIT_JOB}${mid}${publishJob('mid')}`) }),
    );
    expect(audit.problems.length).toBeGreaterThan(0);
  });

  it('a needs entry naming a job that does not exist fails closed', () => {
    const audit = auditPublishLanes(
      fixture({ 'a.yml': wf(`${AUDIT_JOB}${publishJob('[audit, ghost]')}`) }),
    );
    expect(audit.problems.join('\n')).toMatch(/ghost/);
  });
});

describe('publish-lane supply-chain guard: an audit that cannot fail the run is not a gate', () => {
  const NEUTRALISED: Array<[string, string, string?]> = [
    ['`|| true` on the line', 'node scripts/audit-published.mjs || true'],
    ['continuation-split `|| true`', 'node scripts/audit-published.mjs \\\n  || true'],
    ['`; true`', 'node scripts/audit-published.mjs; true'],
    ['continuation-split `; true`', 'node scripts/audit-published.mjs \\\n  ; true'],
    ['`|| :`', 'node scripts/audit-published.mjs || :'],
    ['trailing `&` (backgrounded)', 'node scripts/audit-published.mjs &'],
    ['a later `exit 0`', 'node scripts/audit-published.mjs\nexit 0'],
    ['a later `true`', 'node scripts/audit-published.mjs\ntrue'],
    ['`set +e` before it', 'set +e\nnode scripts/audit-published.mjs'],
    ['inside a subshell', '(node scripts/audit-published.mjs)'],
    ['inside a brace group', '{ node scripts/audit-published.mjs; }'],
    ['preceded by `false &&`', 'false && node scripts/audit-published.mjs'],
    ['preceded by `x ||`', 'x || node scripts/audit-published.mjs'],
    ['negated with `!`', '! node scripts/audit-published.mjs'],
    ['piped to something', 'node scripts/audit-published.mjs | tee audit.log'],
    ['--help', 'node scripts/audit-published.mjs --help'],
    ['an unknown argument', 'node scripts/audit-published.mjs --dry-run'],
    ['an unknown argument after continuation', 'node scripts/audit-published.mjs \\\n  --version'],
  ];

  for (const [label, body] of NEUTRALISED) {
    it(`${label} does not count as the audit gate`, () => {
      const audit = auditPublishLanes(
        fixture({ 'a.yml': wf(`${auditJobWith(body)}${publishJob('audit')}`) }),
      );
      expect(audit.problems.length).toBeGreaterThan(0);
      expect(audit.auditJobs).toEqual([]);
    });
  }

  it('step/job level softening does not count either', () => {
    const variants = [
      AUDIT_JOB.replace(
        '    runs-on: ubuntu-latest\n',
        '    runs-on: ubuntu-latest\n    continue-on-error: true\n',
      ),
      AUDIT_JOB.replace(
        '- run: node scripts/audit-published.mjs',
        '- continue-on-error: true\n        run: node scripts/audit-published.mjs',
      ),
      AUDIT_JOB.replace(
        '- run: node scripts/audit-published.mjs',
        '- if: false\n        run: node scripts/audit-published.mjs',
      ),
      AUDIT_JOB.replace(
        '- run: node scripts/audit-published.mjs',
        '- shell: bash {0}\n        run: node scripts/audit-published.mjs',
      ),
    ];
    for (const job of variants) {
      const audit = auditPublishLanes(fixture({ 'a.yml': wf(`${job}${publishJob('audit')}`) }));
      expect(audit.problems.length).toBeGreaterThan(0);
    }
  });

  it('a same-named script at another path is not the gate', () => {
    const audit = auditPublishLanes(
      fixture({
        'a.yml': wf(`${auditJobWith('node tools/audit-published.mjs')}${publishJob('audit')}`),
      }),
    );
    expect(audit.problems.length).toBeGreaterThan(0);
  });

  it('does not count `|| true`, `|| exit 0`, `|| :` / `|| exit` variants as the gate (precision fix keeps them red)', () => {
    for (const body of [
      'node scripts/audit-published.mjs || true',
      'node scripts/audit-published.mjs || exit 0',
      'node scripts/audit-published.mjs || exit',
      'node scripts/audit-published.mjs || exit "0"',
      'node scripts/audit-published.mjs || :',
      'node scripts/audit-published.mjs; true',
      'node scripts/audit-published.mjs && true',
      'node scripts/audit-published.mjs && :',
      'node scripts/audit-published.mjs && echo ok\nexit 0',
      'node scripts/audit-published.mjs && echo ok\necho later',
      'node scripts/audit-published.mjs && echo ok || true',
      'node scripts/audit-published.mjs && echo ok; true',
    ]) {
      const audit = auditPublishLanes(
        fixture({ 'a.yml': wf(`${auditJobWith(body)}${publishJob('audit')}`) }),
      );
      expect(audit.problems.length, body).toBeGreaterThan(0);
    }
  });

  it('accepts a prose heredoc earlier in the audit step (heredoc spans computed on the original text)', () => {
    for (const body of [
      'cat <<EOF >> "$GITHUB_STEP_SUMMARY"\nauditing\nEOF\nnode scripts/audit-published.mjs',
      'cat <<\'EOF\' >> "$GITHUB_STEP_SUMMARY"\n## Audit\nline two\nEOF\nnode scripts/audit-published.mjs',
    ]) {
      const audit = auditPublishLanes(
        fixture({ 'a.yml': wf(`${auditJobWith(body)}${publishJob('audit')}`) }),
      );
      expect(audit.problems, body).toEqual([]);
    }
  });

  it('still rejects the audit line inside an EXECUTABLE heredoc body', () => {
    const body = 'cat > r.sh <<EOF\nnode scripts/audit-published.mjs\nEOF';
    const audit = auditPublishLanes(
      fixture({ 'a.yml': wf(`${auditJobWith(body)}${publishJob('audit')}`) }),
    );
    expect(audit.problems.length).toBeGreaterThan(0);
  });

  it('rejects exit literals that wrap to 0 modulo 256, accepts 1 and 255', () => {
    for (const lit of ['256', '512', '0256', '1024']) {
      for (const body of [
        `node scripts/audit-published.mjs || exit ${lit}`,
        `node scripts/audit-published.mjs\nexit ${lit}`,
      ]) {
        const audit = auditPublishLanes(
          fixture({ 'a.yml': wf(`${auditJobWith(body)}${publishJob('audit')}`) }),
        );
        expect(audit.problems.length, body).toBeGreaterThan(0);
      }
    }
    for (const lit of ['1', '255']) {
      const body = `node scripts/audit-published.mjs || exit ${lit}`;
      const audit = auditPublishLanes(
        fixture({ 'a.yml': wf(`${auditJobWith(body)}${publishJob('audit')}`) }),
      );
      expect(audit.problems, body).toEqual([]);
    }
  });

  it('heredoc terminators match bash exactly: indented terminator of a plain << does not end the body', () => {
    // bash keeps reading: the "audit" line below is still heredoc text and never runs.
    const body = 'cat > r.sh <<EOF\nx\n  EOF\nnode scripts/audit-published.mjs\nEOF';
    const audit = auditPublishLanes(
      fixture({ 'a.yml': wf(`${auditJobWith(body)}${publishJob('audit')}`) }),
    );
    expect(audit.problems.length).toBeGreaterThan(0);
    const proseBody =
      'cat <<EOF >> "$GITHUB_STEP_SUMMARY"\nx\n  EOF\nnode scripts/audit-published.mjs\nEOF';
    const audit2 = auditPublishLanes(
      fixture({ 'a.yml': wf(`${auditJobWith(proseBody)}${publishJob('audit')}`) }),
    );
    expect(audit2.problems.length).toBeGreaterThan(0);
  });

  it('<<- strips leading TABS only: a tab-indented terminator ends the body, a space-indented one does not', () => {
    const tabbed =
      'cat <<-EOF >> "$GITHUB_STEP_SUMMARY"\nx\n\tEOF\nnode scripts/audit-published.mjs';
    const ok = auditPublishLanes(
      fixture({ 'a.yml': wf(`${auditJobWith(tabbed)}${publishJob('audit')}`) }),
    );
    expect(ok.problems).toEqual([]);
    const spaced =
      'cat <<-EOF >> "$GITHUB_STEP_SUMMARY"\nx\n  EOF\nnode scripts/audit-published.mjs\nEOF';
    const bad = auditPublishLanes(
      fixture({ 'a.yml': wf(`${auditJobWith(spaced)}${publishJob('audit')}`) }),
    );
    expect(bad.problems.length).toBeGreaterThan(0);
  });

  it('an EXIT/ERR trap that can override the status neutralises the audit', () => {
    for (const trap of [
      "trap 'exit 0' EXIT",
      "trap 'true' EXIT",
      "trap ':' EXIT",
      'trap "exit 0" EXIT',
      "trap 'exit 0' ERR",
      "trap 'exit 0' 0",
      "trap 'exit 0' SIGEXIT INT EXIT",
      'trap "$H" EXIT',
      "trap 'echo x; exit 0' EXIT",
    ]) {
      const body = `${trap}\nnode scripts/audit-published.mjs`;
      const audit = auditPublishLanes(
        fixture({ 'a.yml': wf(`${auditJobWith(body)}${publishJob('audit')}`) }),
      );
      expect(audit.problems.length, body).toBeGreaterThan(0);
    }
  });

  it('harmless traps do not neutralise the audit', () => {
    for (const trap of [
      "trap 'echo bye' EXIT",
      "trap 'exit 1' EXIT",
      "trap 'exit 0' INT",
      'trap - EXIT',
    ]) {
      const body = `${trap}\nnode scripts/audit-published.mjs`;
      const audit = auditPublishLanes(
        fixture({ 'a.yml': wf(`${auditJobWith(body)}${publishJob('audit')}`) }),
      );
      expect(audit.problems, body).toEqual([]);
    }
  });

  it('accepts `|| exit <non-zero>` and a trailing `&& <cmd>` on the audit line', () => {
    for (const body of [
      'node scripts/audit-published.mjs || exit 1',
      'node scripts/audit-published.mjs || exit 2 # fail',
      'node scripts/audit-published.mjs && echo ok',
      'echo start\nnode scripts/audit-published.mjs || exit 1\necho after',
    ]) {
      const audit = auditPublishLanes(
        fixture({ 'a.yml': wf(`${auditJobWith(body)}${publishJob('audit')}`) }),
      );
      expect(audit.problems, body).toEqual([]);
    }
  });

  it('the bare forms DO count: ./-prefixed, env-prefixed, node flags, trailing comment', () => {
    for (const body of [
      'node scripts/audit-published.mjs',
      'node ./scripts/audit-published.mjs',
      'NODE_OPTIONS=--max-old-space-size=4096 node scripts/audit-published.mjs',
      'node --max-old-space-size=4096 scripts/audit-published.mjs',
      'echo start\nnode scripts/audit-published.mjs # the gate',
      'node scripts/audit-published.mjs \\\n  # nothing else',
    ]) {
      const audit = auditPublishLanes(
        fixture({ 'a.yml': wf(`${auditJobWith(body)}${publishJob('audit')}`) }),
      );
      expect(audit.problems, body).toEqual([]);
    }
  });
});

/** A workflow with extra TOP-LEVEL keys (env, defaults, permissions) before `jobs:`. */
const wfTop = (top: string, jobsYaml: string) => `name: t\non: push\n${top}\njobs:${jobsYaml}`;

const stepJob = (stepYaml: string, jobExtra = '') => `
  ship:
    runs-on: ubuntu-latest
${jobExtra}    steps:
${stepYaml}
`;

describe('publish-lane supply-chain guard (round 3): workflow-level env / permissions are inherited', () => {
  const OPAQUE = `      - run: |\n          bash ./r.sh\n`;

  it('a top-level env carrying the npm credential makes every job a candidate', () => {
    for (const env of [
      'env:\n  NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n',
      'env:\n  T: ${{ secrets.NPM_TOKEN }}\n',
      "env:\n  T: ${{ secrets['NPM_TOKEN'] }}\n",
    ]) {
      const audit = auditPublishLanes(fixture({ 'a.yml': wfTop(env, stepJob(OPAQUE)) }));
      expect(laneIds(audit)).toEqual(['a.yml#ship']);
      expect(audit.problems.length).toBeGreaterThan(0);
    }
  });

  it('a top-level env value that says publish makes the jobs candidates', () => {
    const audit = auditPublishLanes(
      fixture({
        'a.yml': wfTop('env:\n  CMD: npm publish\n', stepJob('      - run: |\n          $CMD\n')),
      }),
    );
    expect(laneIds(audit)).toEqual(['a.yml#ship']);
  });

  it('id-token: write (job or workflow level) in a job that runs npm/pnpm/yarn/changeset is a candidate', () => {
    const cases: Array<[string, string, string]> = [
      ['job-level', '', '    permissions:\n      id-token: write\n'],
      ['workflow-level', 'permissions:\n  id-token: write\n', ''],
      ['write-all', 'permissions: write-all\n', ''],
    ];
    for (const [label, top, jobExtra] of cases) {
      for (const run of ['npm run deploy', 'pnpm run deploy', 'yarn deploy', 'npx changeset-x']) {
        const audit = auditPublishLanes(
          fixture({
            'a.yml': wfTop(top, stepJob(`      - run: ${run}\n`, jobExtra)),
          }),
        );
        expect(laneIds(audit), `${label}: ${run}`).toEqual(['a.yml#ship']);
      }
    }
  });

  it('id-token: write alone (cosign, OIDC deploys) with no npm-family command is NOT a candidate', () => {
    const audit = auditPublishLanes(
      fixture({
        'a.yml': wfTop(
          'permissions:\n  id-token: write\n',
          stepJob('      - run: cosign sign --yes "$IMG"\n'),
        ),
      }),
    );
    expect(audit.lanes).toEqual([]);
  });

  it('a job-level permissions block overrides the workflow-level id-token grant', () => {
    const audit = auditPublishLanes(
      fixture({
        'a.yml': wfTop(
          'permissions:\n  id-token: write\n',
          stepJob('      - run: npm run deploy\n', '    permissions:\n      contents: read\n'),
        ),
      }),
    );
    expect(audit.lanes).toEqual([]);
  });

  it('quote-split commands (`npm pub""lish`) are the documented blind spot, caught only with a credential', () => {
    const run = 'npm pub""lish';
    const bare = auditPublishLanes(fixture({ 'a.yml': wf(publishJob('[]', run)) }));
    expect(bare.lanes).toEqual([]);
    const cred = auditPublishLanes(
      fixture({ 'a.yml': wf(publishJob('[]', run, '    environment: npm-publish\n')) }),
    );
    expect(laneIds(cred)).toEqual(['a.yml#release']);
  });
});

describe('publish-lane supply-chain guard (round 3): heredocs are code unless they provably go to prose', () => {
  const lane = (run: string) => auditPublishLanes(fixture({ 'a.yml': wf(publishJob('[]', run)) }));

  it('a heredoc WRITTEN TO A FILE is executable content, not prose', () => {
    for (const run of [
      "cat > r.sh <<'EOF'\nnpm publish\nEOF\nbash r.sh",
      'cat >r.sh <<EOF\nnpm publish\nEOF\nbash r.sh',
      'cat >> r.sh <<EOF\nnpm publish\nEOF\nbash r.sh',
      "tee r.sh <<'EOF'\nnpm publish\nEOF\nbash r.sh",
      'tee -a r.sh <<EOF >/dev/null\nnpm publish\nEOF\nbash r.sh',
      'cat <<EOF > r.sh\nnpm publish\nEOF\nbash r.sh',
      'cat <<EOF | tee r.sh\nnpm publish\nEOF\nbash r.sh',
      'cat <<EOF | bash\nnpm publish\nEOF',
      'cat <<EOF | node\nnpm publish\nEOF',
    ]) {
      expect(laneIds(lane(run)), run).toEqual(['a.yml#release']);
    }
  });

  it('a heredoc to stdout / the step summary / an issue body is still prose', () => {
    for (const run of [
      'cat <<EOF\nnpm publish is documented\nEOF\necho done',
      'cat <<EOF >> "$GITHUB_STEP_SUMMARY"\nnpm publish is documented\nEOF\necho done',
      'cat <<EOF >> $GITHUB_STEP_SUMMARY\nnpm publish is documented\nEOF\necho done',
      'cat <<EOF | gh issue create --title t --body-file -\nnpm publish is documented\nEOF\necho done',
      'tee -a "$GITHUB_STEP_SUMMARY" <<EOF\nnpm publish is documented\nEOF\necho done',
    ]) {
      expect(lane(run).lanes, run).toEqual([]);
    }
  });

  it('`<<WORD` inside a quoted echo/printf string or $((…)) does not swallow the rest of the script', () => {
    for (const run of [
      'echo "v $((1<<SHIFT))"\nnpm publish',
      'printf "see <<EOF\\n"\nnpm publish',
      "echo 'a <<EOF b'\nnpm publish",
      'x=$((1<<EOF))\nnpm publish',
      // a terminator-looking line later in the script must not let a quoted `<<EOF` swallow the publish
      'printf "see <<EOF\\n"\nnpm publish\nEOF',
      "echo 'a <<EOF b'\nnpm publish\nEOF\necho done",
    ]) {
      expect(laneIds(lane(run)), run).toEqual(['a.yml#release']);
    }
  });

  it('an unterminated heredoc keeps its body (fail closed)', () => {
    expect(laneIds(lane('cat <<EOF\nnpm publish'))).toEqual(['a.yml#release']);
  });

  it('two heredocs on one line are not stripped (fail closed)', () => {
    expect(laneIds(lane('cat <<A <<B\nx\nA\nnpm publish\nB')), 'both bodies stay visible').toEqual([
      'a.yml#release',
    ]);
  });
});

describe('publish-lane supply-chain guard (round 3): audit neutralisers are a RULE, not a list', () => {
  const NEUTRALISED: Array<[string, string]> = [
    ['exit "0"', 'node scripts/audit-published.mjs\nexit "0"'],
    ['exit 00', 'node scripts/audit-published.mjs\nexit 00'],
    ['exit $((0))', 'node scripts/audit-published.mjs\nexit $((0))'],
    ['exit $?', 'node scripts/audit-published.mjs\nexit $?'],
    ['bare exit', 'node scripts/audit-published.mjs\nexit'],
    ['exit $code (unknown status)', 'node scripts/audit-published.mjs\nexit $code'],
    ['exit ${CODE:-0}', 'node scripts/audit-published.mjs\nexit ${CODE:-0}'],
    [
      '`exit 0` in a branch',
      'node scripts/audit-published.mjs\nif [ -n "$X" ]; then\n  exit 0\nfi',
    ],
    [
      'a one-line `then exit 0`',
      'node scripts/audit-published.mjs\nif [ -n "$X" ]; then exit 0; fi',
    ],
    [
      'a one-line `then set +e`',
      'if [ -n "$X" ]; then set +e; fi\nnode scripts/audit-published.mjs',
    ],
    ['an exit BEFORE the audit', 'exit 0\nnode scripts/audit-published.mjs'],
    ['set +eu', 'set +eu\nnode scripts/audit-published.mjs'],
    ['set +ue', 'set +ue\nnode scripts/audit-published.mjs'],
    ['set +o errexit', 'set +o errexit\nnode scripts/audit-published.mjs'],
    ['set +e AFTER', 'node scripts/audit-published.mjs\nset +e'],
    ['set +euo pipefail', 'set +euo pipefail\nnode scripts/audit-published.mjs'],
    ['a trailing `:`', 'node scripts/audit-published.mjs\n:'],
    ['a trailing `true`', 'node scripts/audit-published.mjs\ntrue'],
    ['a trailing `return 0`', 'node scripts/audit-published.mjs\nreturn 0'],
  ];
  for (const [label, body] of NEUTRALISED) {
    it(`${label} does not count as the audit gate`, () => {
      const audit = auditPublishLanes(
        fixture({ 'a.yml': wf(`${auditJobWith(body)}${publishJob('audit')}`) }),
      );
      expect(audit.problems.length).toBeGreaterThan(0);
      expect(audit.auditJobs).toEqual([]);
    });
  }

  it('benign shell around the audit still counts: set -euo pipefail, set +x, echo after', () => {
    for (const body of [
      'set -euo pipefail\nnode scripts/audit-published.mjs',
      'set +x\nnode scripts/audit-published.mjs\necho done',
      'set -x\nnode scripts/audit-published.mjs',
      'node scripts/audit-published.mjs\necho "audit passed"',
    ]) {
      const audit = auditPublishLanes(
        fixture({ 'a.yml': wf(`${auditJobWith(body)}${publishJob('audit')}`) }),
      );
      expect(audit.problems, body).toEqual([]);
    }
  });
});

describe('publish-lane supply-chain guard (round 3): defaults.run.shell is read', () => {
  const run = (top: string, jobExtra: string, stepExtra = '') =>
    auditPublishLanes(
      fixture({
        'a.yml': wfTop(
          top,
          `${AUDIT_JOB.replace(
            '    runs-on: ubuntu-latest\n',
            `    runs-on: ubuntu-latest\n${jobExtra}`,
          ).replace(
            '- run: node scripts/audit-published.mjs',
            `- ${stepExtra}run: node scripts/audit-published.mjs`,
          )}${publishJob('audit')}`,
        ),
      }),
    );

  it('a workflow-level or job-level shell without errexit neutralises the audit', () => {
    for (const shell of ['bash {0}', 'pwsh', 'python', 'cmd', 'sh {0}']) {
      const wfLevel = run(`defaults:\n  run:\n    shell: ${shell}\n`, '');
      expect(wfLevel.problems.length, `workflow ${shell}`).toBeGreaterThan(0);
      const jobLevel = run('', `    defaults:\n      run:\n        shell: ${shell}\n`);
      expect(jobLevel.problems.length, `job ${shell}`).toBeGreaterThan(0);
    }
  });

  it('shells that keep errexit count: bash, bash -e {0}, sh -e {0}', () => {
    for (const shell of [
      'bash',
      'bash -e {0}',
      'bash --noprofile --norc -eo pipefail {0}',
      'sh -e {0}',
    ]) {
      const audit = run(`defaults:\n  run:\n    shell: ${shell}\n`, '');
      expect(audit.problems, shell).toEqual([]);
    }
  });

  it('a step-level shell overrides the default in both directions', () => {
    const rescued = run('defaults:\n  run:\n    shell: bash {0}\n', '', 'shell: bash\n        ');
    expect(rescued.problems).toEqual([]);
    const broken = run('defaults:\n  run:\n    shell: bash\n', '', 'shell: bash {0}\n        ');
    expect(broken.problems.length).toBeGreaterThan(0);
  });
});

describe('publish-lane supply-chain guard (round 3): the allowlist is keyed on the property that excused it', () => {
  const excuse = (job: string) => ({
    ...fixture({ 'a.yml': wf(job) }),
    nonLanes: [{ file: 'a.yml', job: 'release', reason: 'documented as holding no credential' }],
  });

  it('an excused job that gains the npm credential fails', () => {
    for (const cred of [
      '    environment: npm-publish\n',
      '    env:\n      NODE_AUTH_TOKEN: ${{ secrets.X }}\n',
      '    env:\n      T: ${{ secrets.NPM_TOKEN }}\n',
    ]) {
      const audit = auditPublishLanes(
        excuse(publishJob('[]', 'echo "npm publish is documented elsewhere"', cred)),
      );
      expect(audit.problems.join('\n'), cred).toMatch(/allowlisted .* (holds|runs)/i);
    }
  });

  it('an excused job inheriting a workflow-level credential fails', () => {
    const f = fixture({
      'a.yml': wfTop(
        'env:\n  NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n',
        publishJob('[]', 'echo "npm publish is documented elsewhere"'),
      ),
    });
    const audit = auditPublishLanes({
      ...f,
      nonLanes: [{ file: 'a.yml', job: 'release', reason: 'documented as holding no credential' }],
    });
    expect(audit.problems.join('\n')).toMatch(/allowlisted .* (holds|runs)/i);
  });

  it('an excused job that runs a real publish command fails', () => {
    for (const run of [
      'npm publish',
      'for d in a b; do npm publish $d; done',
      'xargs npm publish',
      'make publish',
    ]) {
      const audit = auditPublishLanes(excuse(publishJob('[]', run)));
      expect(audit.problems.join('\n'), run).toMatch(/allowlisted .* (holds|runs)/i);
    }
  });

  it('an excused job that uses a publish action, or a changesets/action publish input, fails', () => {
    const action = wf(`
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: JS-DevTools/npm-publish@v3
`);
    const audit = auditPublishLanes({
      ...fixture({ 'a.yml': action }),
      nonLanes: [{ file: 'a.yml', job: 'release', reason: 'documented as holding no credential' }],
    });
    expect(audit.problems.join('\n')).toMatch(/allowlisted .* (holds|runs)/i);
  });

  it('prose-only excused jobs (assignments and echoes that mention publish) stay excused', () => {
    const audit = auditPublishLanes(
      excuse(publishJob('[]', 'body="the npm publish credential is described here"\necho "$body"')),
    );
    expect(audit.problems).toEqual([]);
    expect(audit.excused).toEqual(['a.yml#release']);
  });
});

describe('publish-lane supply-chain guard (round 3): the SBOM upload must itself be reliable', () => {
  const sbomJob = (uploadExtra: string) => `
  audit:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/audit-published.mjs
      - ${uploadExtra}uses: actions/upload-artifact@v7
        with:
          name: npm-sbom
          path: sbom/*.cdx.json
`;

  for (const [label, extra] of [
    ['if: false', 'if: false\n        '],
    ['if: always()', 'if: always()\n        '],
    ["if: github.ref == 'refs/heads/never'", "if: github.ref == 'refs/heads/never'\n        "],
    ['continue-on-error: true', 'continue-on-error: true\n        '],
    ['continue-on-error: ${{ true }}', 'continue-on-error: ${{ true }}\n        '],
  ] as const) {
    it(`an SBOM upload step with ${label} does not count (the audit gate still does)`, () => {
      const audit = auditPublishLanes(
        fixture({ 'a.yml': wf(`${sbomJob(extra)}${publishJob('audit')}`) }),
      );
      expect(audit.sbomJobs).toEqual([]);
      expect(audit.auditJobs.length).toBe(1);
      expect(audit.problems.join('\n')).toMatch(/SBOM job/);
    });
  }

  it('a trivially-true `if: success()` upload step still counts', () => {
    const audit = auditPublishLanes(
      fixture({ 'a.yml': wf(`${sbomJob('if: success()\n        ')}${publishJob('audit')}`) }),
    );
    expect(audit.problems).toEqual([]);
  });
});

describe('publish-lane supply-chain guard (round 4): the audit must be a TOP-LEVEL simple command', () => {
  const gate = (body: string) =>
    auditPublishLanes(fixture({ 'a.yml': wf(`${auditJobWith(body)}${publishJob('audit')}`) }));

  const NEVER_RUNS: Array<[string, string]> = [
    ['inside if/then/fi', 'if [ "$SKIP" != 1 ]; then\n  node scripts/audit-published.mjs\nfi'],
    [
      'in the else branch',
      'if [ -z "$X" ]; then\n  echo skipped\nelse\n  node scripts/audit-published.mjs\nfi',
    ],
    [
      'in an elif branch',
      'if [ -z "$X" ]; then\n  :\nelif [ -n "$Y" ]; then\n  node scripts/audit-published.mjs\nfi',
    ],
    ['inside while false', 'while false; do\n  node scripts/audit-published.mjs\ndone'],
    ['inside until true', 'until true; do\n  node scripts/audit-published.mjs\ndone'],
    ['inside a for over nothing', 'for f in; do\n  node scripts/audit-published.mjs\ndone'],
    ['inside an uncalled function', 'run_audit() {\n  node scripts/audit-published.mjs\n}'],
    [
      'inside an uncalled `function` keyword',
      'function run_audit {\n  node scripts/audit-published.mjs\n}',
    ],
    ['inside a case arm', 'case "$X" in\n  a)\n    node scripts/audit-published.mjs\n    ;;\nesac'],
    ['inside a brace group', '{\n  node scripts/audit-published.mjs\n}'],
    ['inside a multi-line subshell', '(\n  node scripts/audit-published.mjs\n)'],
    ['after a dangling `&&`', '[ "$X" = 1 ] &&\nnode scripts/audit-published.mjs'],
    ['after a dangling `||`', '[ "$X" = 1 ] ||\nnode scripts/audit-published.mjs'],
    ['after a dangling `|`', 'echo hi |\nnode scripts/audit-published.mjs'],
    ['inside a `: <<` comment heredoc', ": <<'X'\nnode scripts/audit-published.mjs\nX"],
    [
      'inside a `cat <<` heredoc written to a file',
      'cat > x.sh <<EOF\nnode scripts/audit-published.mjs\nEOF',
    ],
    ['a one-line if', 'if true; then node scripts/audit-published.mjs; fi'],
    ['unbalanced structure (a stray fi before it)', 'fi\nnode scripts/audit-published.mjs'],
  ];
  for (const [label, body] of NEVER_RUNS) {
    it(`${label} does not count as the audit gate`, () => {
      const audit = gate(body);
      expect(audit.problems.length).toBeGreaterThan(0);
      expect(audit.auditJobs).toEqual([]);
    });
  }

  it('compound statements that do NOT enclose the audit leave it a gate', () => {
    for (const body of [
      'helper() {\n  echo hi\n}\nnode scripts/audit-published.mjs',
      'if [ -n "$X" ]; then echo a; fi\nnode scripts/audit-published.mjs\nfor f in a b; do echo $f; done',
      'for f in a b; do\n  echo $f\ndone\nnode scripts/audit-published.mjs',
      'case "$X" in\n  a) echo a ;;\nesac\nnode scripts/audit-published.mjs',
      'node scripts/audit-published.mjs\nif [ -f x ]; then\n  echo bad\n  exit 1\nfi',
    ]) {
      expect(gate(body).problems, body).toEqual([]);
    }
  });

  it('a non-zero literal exit (an error branch) does NOT neutralise the audit', () => {
    for (const code of ['1', '2', '"1"', "'3'", '127']) {
      const body = `node scripts/audit-published.mjs\nif [ -f broken ]; then\n  echo error\n  exit ${code}\nfi`;
      expect(gate(body).problems, code).toEqual([]);
    }
  });

  it('an unconditional zero / unknown exit still neutralises it', () => {
    for (const code of ['0', '"0"', '00', '$((0))', '$?', '$code', '', '-0']) {
      const audit = gate(`node scripts/audit-published.mjs\nexit ${code}`);
      expect(audit.problems.length, `exit ${code}`).toBeGreaterThan(0);
    }
  });
});

describe('publish-lane supply-chain guard (round 4): prose heredocs, the issue-body forms', () => {
  const lane = (run: string) => auditPublishLanes(fixture({ 'a.yml': wf(publishJob('[]', run)) }));

  it('`gh issue create -F -` / `--body-file -` with a heredoc is prose', () => {
    for (const run of [
      "gh issue create --title t -F - <<'EOF'\nnpm publish is documented\nEOF\necho done",
      'gh issue create --title t --body-file - <<EOF\nnpm publish is documented\nEOF',
      'gh pr comment 3 --body-file - <<EOF\nnpm publish is documented\nEOF',
    ]) {
      expect(lane(run).lanes, run).toEqual([]);
    }
  });

  it('`--body "$(cat <<EOF … EOF)"` is prose when the outer command is gh/echo/printf', () => {
    for (const run of [
      'gh issue create --title t --body "$(cat <<\'EOF\'\nnpm publish is documented\nEOF\n)"',
      'gh pr comment 3 --body "$(cat <<EOF\nnpm publish is documented\nEOF\n)"',
      'echo "$(cat <<EOF\nnpm publish is documented\nEOF\n)"',
    ]) {
      expect(lane(run).lanes, run).toEqual([]);
    }
  });

  it('the same `$(cat <<EOF …)` under a shell, eval, an assignment or gh WITHOUT a stdin flag is code', () => {
    for (const run of [
      'bash -c "$(cat <<\'EOF\'\nnpm publish\nEOF\n)"',
      'eval "$(cat <<EOF\nnpm publish\nEOF\n)"',
      'x="$(cat <<EOF\nnpm publish\nEOF\n)"',
      "gh issue create --title t <<'EOF'\nnpm publish\nEOF",
      "gh issue create --title t -F body.md <<'EOF'\nnpm publish\nEOF",
      'gh extension exec sh -F - <<EOF\nnpm publish\nEOF',
    ]) {
      expect(laneIds(lane(run)), run).toEqual(['a.yml#release']);
    }
  });

  it('code AFTER a prose heredoc is still scanned (the operator must not swallow what follows)', () => {
    for (const run of [
      'cat <<EOF\nprose\nEOF\nnpm publish',
      'cat <<EOF >> "$GITHUB_STEP_SUMMARY"\nprose\nEOF\nnpm publish',
      "gh issue create --title t -F - <<'EOF'\nprose\nEOF\nnpm publish",
      'gh issue create --body "$(cat <<EOF\nprose\nEOF\n)"\nnpm publish',
    ]) {
      expect(laneIds(lane(run)), run).toEqual(['a.yml#release']);
    }
  });
});

describe('publish-lane supply-chain guard (round 4): `_authToken` is a credential signal', () => {
  it('a job that writes an npmrc auth token is a candidate even if nothing says publish', () => {
    for (const run of [
      'echo "//registry.npmjs.org/:_authToken=${NPM_AUTOMATION}" > .npmrc\npnpm -r ship',
      'npm config set //registry.npmjs.org/:_authToken "$T"\nbash ./ship.sh',
    ]) {
      const audit = auditPublishLanes(fixture({ 'a.yml': wf(publishJob('[]', run)) }));
      expect(laneIds(audit), run).toEqual(['a.yml#release']);
    }
  });

  it('an env KEY or workflow-level env carrying _authToken counts too', () => {
    const job = publishJob(
      '[]',
      'bash ./ship.sh',
      '    env:\n      "//registry.npmjs.org/:_authToken": ${{ secrets.AUTOMATION }}\n',
    );
    expect(laneIds(auditPublishLanes(fixture({ 'a.yml': wf(job) })))).toEqual(['a.yml#release']);
    const wfLevel = auditPublishLanes(
      fixture({
        'a.yml': wfTop(
          'env:\n  NPM_CONFIG: "//registry.npmjs.org/:_authToken=${{ secrets.AUTOMATION }}"\n',
          publishJob('[]', 'bash ./ship.sh'),
        ),
      }),
    );
    expect(laneIds(wfLevel)).toEqual(['a.yml#release']);
  });
});

describe('publish-lane supply-chain guard: fail closed on what it cannot read', () => {
  it('an unparseable workflow fails the guard', () => {
    const audit = auditPublishLanes(fixture({ 'broken.yml': 'jobs: [unclosed\n  - : :\n' }));
    expect(audit.problems.join('\n')).toMatch(/broken\.yml/);
  });

  it('an unreadable workflow (a directory named *.yml) fails the guard', () => {
    const audit = auditPublishLanes(fixture({ 'dir.yml': null }));
    expect(audit.problems.join('\n')).toMatch(/dir\.yml/);
  });

  it('an empty or jobs-less workflow fails the guard rather than reading as "no lanes"', () => {
    for (const text of ['', 'name: nothing\non: push\n', '- just\n- a list\n']) {
      const audit = auditPublishLanes(fixture({ 'odd.yml': text }));
      expect(audit.problems.join('\n')).toMatch(/odd\.yml/);
    }
  });

  it('a missing workflow directory fails the guard', () => {
    const f = fixture({});
    const audit = auditPublishLanes({ ...f, workflowDir: join(f.workflowDir, 'nope') });
    expect(audit.problems.length).toBeGreaterThan(0);
  });

  it('.yaml files are scanned too', () => {
    const audit = auditPublishLanes(fixture({ 'lane.yaml': wf(publishJob('[]')) }));
    expect(audit.lanes.map((l) => l.file)).toEqual(['lane.yaml']);
    expect(audit.problems.length).toBeGreaterThan(0);
  });
});
