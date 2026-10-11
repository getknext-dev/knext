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
          cat > body.md <<EOF
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
