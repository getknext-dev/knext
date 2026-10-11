import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditPublishLanes } from './helpers/publish-lane-supply-chain';
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
 * SCANNED, NOT ENUMERATED. The publish lanes are discovered from the parsed
 * form of EVERY `.github/workflows/*.yml` (`npm publish`, `pnpm publish`,
 * `changeset publish`, `bun publish`, `yarn publish`, a `changesets/action`
 * step carrying a `publish`/`publish-script` input, or a `<pm> run <script>`
 * whose root `package.json` script is itself a publish), so a lane added next
 * month is covered without anyone remembering to list it here. The audit and
 * SBOM jobs are found the same way: by what they RUN, never by their ids.
 *
 * FAIL CLOSED. A workflow that cannot be read or parsed fails the guard — a
 * file the scan cannot see is a file that could hold an ungated lane.
 *
 * Mutation-proved by `scripts/mutation-prove-publish-lane-supply-chain.mjs`
 * (graded on exit codes).
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway workflows dir; `files` maps file name -> raw text (or null = a directory). */
function fixture(files: Record<string, string | null>, rootScripts?: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'publish-lane-'));
  tmpDirs.push(root);
  const dir = join(root, 'workflows');
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) {
    if (text === null) mkdirSync(join(dir, name));
    else writeFileSync(join(dir, name), text);
  }
  const pkg = join(root, 'package.json');
  writeFileSync(pkg, JSON.stringify({ name: 'root', scripts: rootScripts ?? {} }));
  return { workflowDir: dir, packageJsonPath: pkg };
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

const wf = (jobsYaml: string) => `name: t\non: push\njobs:${jobsYaml}`;

const publishJob = (needs: string, run = 'npm publish --access public') => `
  release:
    runs-on: ubuntu-latest
    needs: ${needs}
    steps:
      - run: ${run}
`;

describe('publish-lane supply-chain guard: the real workflows', () => {
  const audit = auditPublishLanes({ workflowDir: WORKFLOW_DIR });

  it('every npm publish lane transitively needs the audit gate and the SBOM job', () => {
    expect(audit.problems).toEqual([]);
  });

  it('is not vacuous: the scan read workflows, found release.yml#release and an audit+SBOM job', () => {
    expect(audit.workflowsSeen).toBeGreaterThan(10);
    expect(audit.lanes.map((l) => `${l.file}#${l.jobId}`)).toContain('release.yml#release');
    expect(audit.auditJobs.map((j) => j.replace(/^.*#/, ''))).toContain('audit');
    expect(audit.sbomJobs.map((j) => j.replace(/^.*#/, ''))).toContain('audit');
  });
});

describe('publish-lane supply-chain guard: discovery scans, it does not enumerate', () => {
  for (const [label, run] of [
    ['npm publish', 'npm publish --access public'],
    ['pnpm publish', 'pnpm publish --no-git-checks'],
    ['changeset publish', 'bunx changeset publish'],
    ['bun publish', 'bun publish'],
    ['yarn npm publish', 'yarn npm publish'],
    ['env-prefixed + wrapped', 'NODE_AUTH_TOKEN=$T npx --yes changeset publish'],
  ] as const) {
    it(`a brand-new workflow with \`${label}\` and no gate reds`, () => {
      const audit = auditPublishLanes(fixture({ 'zz-new.yml': wf(publishJob('[]', run)) }));
      expect(audit.lanes.map((l) => `${l.file}#${l.jobId}`)).toEqual(['zz-new.yml#release']);
      expect(audit.problems.length).toBeGreaterThan(0);
    });
  }

  it('a changesets/action step with a `publish-script` (or v1 `publish`) input is a publish lane', () => {
    for (const key of ['publish-script', 'publish']) {
      const yml = wf(`
  ship:
    runs-on: ubuntu-latest
    steps:
      - uses: changesets/action@ae32849d5ba541f9ae29e40e22a623bc13562f51 # v2.1.2
        with:
          ${key}: \${{ steps.gate.outputs.publish }}
`);
      const audit = auditPublishLanes(fixture({ 'a.yml': yml }));
      expect(audit.lanes.map((l) => l.jobId)).toEqual(['ship']);
      expect(audit.problems.length).toBeGreaterThan(0);
    }
  });

  it('a changesets/action step with only `version-script` is NOT a publish lane', () => {
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

  it('`<pm> run <script>` is a publish lane when the root package.json script is a publish', () => {
    const files = { 'a.yml': wf(publishJob('[]', 'bun run release')) };
    const aliased = auditPublishLanes(fixture(files, { release: 'changeset publish' }));
    expect(aliased.lanes.map((l) => l.jobId)).toEqual(['release']);
    const harmless = auditPublishLanes(fixture(files, { release: 'echo hi' }));
    expect(harmless.lanes).toEqual([]);
  });

  it('prose that merely MENTIONS a publish (comments, echoed issue bodies) is not a lane', () => {
    const yml = `name: t
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
          echo "see npm publish docs"
`;
    const audit = auditPublishLanes(fixture({ 'a.yml': yml }));
    expect(audit.lanes).toEqual([]);
    expect(audit.problems).toEqual([]);
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
    expect(audit.problems.join('\n')).toMatch(/sbom/i);
    expect(audit.problems.join('\n')).not.toMatch(/does not .*audit gate/i);
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
    expect(audit.problems.join('\n')).toMatch(/audit/i);
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
      const lane = `
  release:
    runs-on: ubuntu-latest
    needs: audit
    if: \${{ ${cond} }}
    steps:
      - run: npm publish
`;
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

  it('an audit job that cannot fail the run is not a gate (continue-on-error, `|| true`, step if)', () => {
    const variants = [
      AUDIT_JOB.replace(
        '    runs-on: ubuntu-latest\n',
        '    runs-on: ubuntu-latest\n    continue-on-error: true\n',
      ),
      AUDIT_JOB.replace(
        '- run: node scripts/audit-published.mjs',
        '- run: node scripts/audit-published.mjs || true',
      ),
      AUDIT_JOB.replace(
        '- run: node scripts/audit-published.mjs',
        '- continue-on-error: true\n        run: node scripts/audit-published.mjs',
      ),
      AUDIT_JOB.replace(
        '- run: node scripts/audit-published.mjs',
        '- if: false\n        run: node scripts/audit-published.mjs',
      ),
    ];
    for (const job of variants) {
      const audit = auditPublishLanes(fixture({ 'a.yml': wf(`${job}${publishJob('audit')}`) }));
      expect(audit.problems.length).toBeGreaterThan(0);
    }
  });

  it('a needs entry naming a job that does not exist fails closed', () => {
    const audit = auditPublishLanes(
      fixture({ 'a.yml': wf(`${AUDIT_JOB}${publishJob('[audit, ghost]')}`) }),
    );
    expect(audit.problems.join('\n')).toMatch(/ghost/);
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
