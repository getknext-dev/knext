import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import {
  ACK_BODY_PATTERN,
  ACK_LABEL,
  classify,
  classifyContent,
  isAcknowledged,
  LEGACY_ACK_LABEL,
  mergeFired,
  parseNameStatus,
  publicSurfaceChanged,
  referencedPaths,
  releasePathClosure,
  workflowHoldsCredential,
} from '../scripts/check-escalation-triggers.mjs';

const WORKFLOW_PATH = resolve(import.meta.dirname, '../.github/workflows/escalation-triggers.yml');
function readWorkflow() {
  const raw = readFileSync(WORKFLOW_PATH, 'utf8');
  // YAML 1.1 parses the unquoted `on` key as boolean `true`; accept both, same as
  // tests/merge-queue-triggers.test.ts.
  const doc = parse(raw) as Record<string, unknown>;
  const on = (doc.on ?? (doc as Record<string, unknown>)[true as unknown as string]) as Record<
    string,
    unknown
  >;
  return { doc, on };
}

/**
 * The escalation-trigger check is a GATE, so it needs the treatment a gate gets:
 * cases that prove it fires, and cases that prove it does NOT fire on ordinary work.
 *
 * The second half is not padding. `.claude/rules/workflow.md` and this repo's own
 * history both say a guard that cries wolf gets worked around — the reader stops
 * reading the message and starts reaching for the escape hatch. Measured against 40
 * first-parent commits this fires on 15%, and every one of those is defensible, which
 * is the number these allow-cases exist to defend.
 */

const change = (path: string, status = 'M') => ({ path, status });

describe('escalation triggers — fires when it must', () => {
  it('the NextApp CRD type', () => {
    const fired = classify([change('packages/kn-next-operator/api/v1alpha1/nextapp_types.go')]);
    expect(fired.map((f: { id: string }) => f.id)).toContain('crd');
  });

  it('the knext.config.ts schema', () => {
    expect(
      classify([change('packages/kn-next/src/config.ts')]).map((f: { id: string }) => f.id),
    ).toContain('config-schema');
  });

  it('the CLI surface, anywhere under src/cli/', () => {
    expect(
      classify([change('packages/kn-next/src/cli/deploy.ts')]).map((f: { id: string }) => f.id),
    ).toContain('cli-surface');
  });

  it('a MODIFIED existing ADR', () => {
    expect(
      classify([change('docs/adr/0001-operator-single-source-of-truth.md', 'M')]).map(
        (f: { id: string }) => f.id,
      ),
    ).toContain('adr');
  });

  it('a DELETED ADR', () => {
    expect(
      classify([change('docs/adr/0010-knative-pvc-feature-flags.md', 'D')]).map(
        (f: { id: string }) => f.id,
      ),
    ).toContain('adr');
  });

  it('reports every distinct trigger, not just the first', () => {
    const fired = classify([
      change('packages/kn-next-operator/api/v1alpha1/nextapp_types.go'),
      change('packages/kn-next/src/config.ts'),
      change('packages/kn-next/src/cli/validate.ts'),
    ]);
    expect(fired.map((f: { id: string }) => f.id).sort()).toEqual([
      'cli-surface',
      'config-schema',
      'crd',
    ]);
  });
});

describe('escalation triggers — stays quiet on ordinary work', () => {
  it('ADDING a new ADR does not fire', () => {
    // Writing an ADR is the OUTPUT of an escalation. Demanding a gate for it would
    // tax the exact behaviour the rules are trying to encourage.
    expect(classify([change('docs/adr/0043-something-new.md', 'A')])).toHaveLength(0);
  });

  it('gate MEASUREMENT data does not fire', () => {
    // docs/adr/gates/*.json changes whenever someone records a benchmark.
    expect(classify([change('docs/adr/gates/adr-0042-gates.json', 'M')])).toHaveLength(0);
  });

  it('operator internals outside the CRD type do not fire', () => {
    expect(
      classify([change('packages/kn-next-operator/internal/controller/nextapp_controller.go')]),
    ).toHaveLength(0);
  });

  it('CLI TESTS do not fire — only the surface itself', () => {
    expect(classify([change('packages/kn-next/src/__tests__/deploy-cr.test.ts')])).toHaveLength(0);
  });

  it('docs, benchmarks and workflows do not fire', () => {
    expect(
      classify([
        change('docs/ARCHITECTURE.md'),
        change('benchmarks/scale-to-zero-oke/run.sh'),
        change('.github/workflows/ci.yml'),
        change('README.md'),
      ]),
    ).toHaveLength(0);
  });
});

describe('public manifest surface', () => {
  const base = {
    name: '@getknext/core',
    version: '1.0.0',
    exports: { '.': './dist/index.js' },
    bin: { 'kn-next': './dist/cli/kn-next.js' },
  };

  it('a version bump alone is NOT a public-surface change', () => {
    // package.json is edited constantly; firing on every edit would train everyone
    // to reach for the ack label reflexively, which is how a gate stops meaning anything.
    expect(publicSurfaceChanged(base, { ...base, version: '1.0.1' })).toBe(false);
  });

  it('a dependency change is NOT a public-surface change', () => {
    expect(publicSurfaceChanged(base, { ...base, dependencies: { zod: '^3' } })).toBe(false);
  });

  it('adding an exports subpath IS', () => {
    expect(
      publicSurfaceChanged(base, {
        ...base,
        exports: { '.': './dist/index.js', './adapter': './dist/adapter.js' },
      }),
    ).toBe(true);
  });

  it('removing a bin IS', () => {
    expect(publicSurfaceChanged(base, { ...base, bin: undefined })).toBe(true);
  });

  it('a manifest missing on one side is handled, not thrown on', () => {
    expect(publicSurfaceChanged(null, base)).toBe(true);
    expect(publicSurfaceChanged(null, null)).toBe(false);
  });
});

describe('diff parsing and acknowledgement', () => {
  it('parses name-status output', () => {
    expect(parseNameStatus('M\tdocs/adr/0001.md\nA\tsrc/new.ts\n')).toEqual([
      { status: 'M', path: 'docs/adr/0001.md' },
      { status: 'A', path: 'src/new.ts' },
    ]);
  });

  it('takes BOTH the source and the destination path of a rename (round 2)', () => {
    expect(parseNameStatus('R100\told/path.ts\tnew/path.ts')).toEqual([
      { status: 'R', path: 'new/path.ts' },
      { status: 'R', path: 'old/path.ts' },
    ]);
  });

  it('the ack label is recognised, case-insensitively', () => {
    expect(isAcknowledged([ACK_LABEL])).toBe(true);
    expect(isAcknowledged([ACK_LABEL.toUpperCase()])).toBe(true);
    expect(isAcknowledged(['tier-A', 'bug'])).toBe(false);
    expect(isAcknowledged([])).toBe(false);
  });

  it('the legacy design-gate:cleared label still counts (backward compatible)', () => {
    expect(isAcknowledged([LEGACY_ACK_LABEL])).toBe(true);
    expect(isAcknowledged([LEGACY_ACK_LABEL.toUpperCase()])).toBe(true);
  });

  it('a PR-body acknowledgement line counts, with no label present', () => {
    const body = [
      'Some PR description.',
      '',
      'Escalation trigger acknowledged: CLI surface — adds a new flag, no behaviour change.',
      '',
      'More text.',
    ].join('\n');
    expect(isAcknowledged([], body)).toBe(true);
  });

  it('the body line is matched case-insensitively and tolerates surrounding whitespace', () => {
    expect(
      isAcknowledged([], '  escalation TRIGGER acknowledged: adr — amends rationale only'),
    ).toBe(true);
  });

  it('an unrelated body does NOT acknowledge', () => {
    expect(isAcknowledged([], 'This PR touches the CLI surface but says nothing else.')).toBe(
      false,
    );
    expect(isAcknowledged([])).toBe(false);
    expect(isAcknowledged([], undefined)).toBe(false);
  });

  it('ACK_BODY_PATTERN matches the documented line shape directly', () => {
    expect(ACK_BODY_PATTERN.test('Escalation trigger acknowledged: CRD — reason')).toBe(true);
    expect(ACK_BODY_PATTERN.test('not an acknowledgement')).toBe(false);
  });
});

describe('escalation-triggers.yml — the workflow actually re-runs on a body edit', () => {
  /**
   * The PR-body acknowledgement line is one of the two acknowledgement mechanisms.
   * If `pull_request.types` does not include `edited`, adding that line to an
   * ALREADY-OPEN PR never retriggers this check — it stays red until an unrelated
   * push happens to retrigger it. Caught in review on #1804 round 2.
   */
  it('pull_request.types includes `edited`', () => {
    const { on } = readWorkflow();
    const pr = on.pull_request as { types?: string[] };
    expect(pr.types ?? []).toContain('edited');
  });

  it('still triggers on the mechanically-necessary PR events (no regression from the fix)', () => {
    const { on } = readWorkflow();
    const pr = on.pull_request as { types?: string[] };
    for (const t of ['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled']) {
      expect(pr.types ?? []).toContain(t);
    }
  });

  it('still triggers on merge_group (queue hang guard, unchanged by this fix)', () => {
    const { on } = readWorkflow();
    expect('merge_group' in on).toBe(true);
  });

  it('concurrency cancels a stale PR run but never a merge_group run', () => {
    const { doc } = readWorkflow();
    const concurrency = doc.concurrency as { group?: string; 'cancel-in-progress'?: unknown };
    expect(concurrency).toBeTruthy();
    // The group key must NOT include the event name, or an `edited` run and a
    // `synchronize` run on the same PR land in sibling groups and race instead of
    // cancelling each other.
    expect(String(concurrency.group)).not.toContain('event_name');
    expect(String(concurrency.group)).toContain('pull_request.number');
    // cancel-in-progress must be scoped to pull_request — a cancelled merge_group
    // run never reports its required context and hangs the queue.
    expect(String(concurrency['cancel-in-progress'])).toContain("event_name == 'pull_request'");
  });
});
/**
 * #2388 — the scope the Sprint 4 close review found missing. Each new rule gets a
 * case that proves it fires and a near miss that proves it does not.
 */
const ids = (fired: { id: string }[]) => fired.map((f) => f.id);

describe('#2388 — every CRD types file, not only nextapp_types.go', () => {
  it('a second API group types file fires', () => {
    expect(
      ids(
        classify([
          change('packages/kn-next-operator/api/platform/v1alpha1/knextplatform_types.go'),
        ]),
      ),
    ).toContain('crd');
  });

  it('a NEW types file (the Z8 case) fires on add', () => {
    expect(
      ids(classify([change('packages/kn-next-operator/api/v1alpha2/zone_types.go', 'A')])),
    ).toContain('crd');
  });

  it('near miss: generated deepcopy, types tests and non-api types files do not fire', () => {
    expect(
      classify([
        change('packages/kn-next-operator/api/v1alpha1/zz_generated.deepcopy.go'),
        change('packages/kn-next-operator/api/v1alpha1/nextapp_types_test.go'),
        change('packages/kn-next-operator/internal/controller/status_types.go'),
      ]),
    ).toHaveLength(0);
  });
});

describe('#2388 — every package CLI surface', () => {
  it('packages/*/src/cli.ts fires', () => {
    expect(ids(classify([change('packages/grpc/src/cli.ts')]))).toContain('cli-surface');
    expect(ids(classify([change('packages/ffi/src/cli.ts')]))).toContain('cli-surface');
  });

  it('packages/*/src/cli/** fires for a package other than core', () => {
    expect(ids(classify([change('packages/ffi/src/cli/generate.ts', 'A')]))).toContain(
      'cli-surface',
    );
  });

  it('near miss: files merely named like cli elsewhere do not fire', () => {
    expect(
      classify([
        change('packages/grpc/src/client.ts'),
        change('packages/grpc/src/__tests__/cli.test.ts'),
        change('apps/file-manager/src/cli.ts'),
        change('packages/ffi/src/cli/__tests__/generate.test.ts'),
      ]),
    ).toHaveLength(0);
  });
});

describe('#2388 — Rust crates', () => {
  it('anything under crates/ fires', () => {
    expect(ids(classify([change('crates/knext-ffi/src/lib.rs')]))).toContain('crates');
    expect(ids(classify([change('crates/deny.toml')]))).toContain('crates');
  });

  it('near miss: a crates-like name outside the root crates/ does not fire', () => {
    expect(
      classify([change('docs/crates/overview.md'), change('packages/ffi/crates.ts')]),
    ).toHaveLength(0);
  });
});

describe('#2388 — static supply-chain paths', () => {
  it('security/** fires', () => {
    expect(ids(classify([change('security/npm-audit-allowlist.json')]))).toContain('supply-chain');
  });

  it('a package supply-chain module fires', () => {
    expect(ids(classify([change('packages/ffi/src/supply-chain.ts')]))).toContain('supply-chain');
  });

  it('scripts/audit-published.mjs fires', () => {
    expect(ids(classify([change('scripts/audit-published.mjs')]))).toContain('supply-chain');
  });

  it('near miss: docs/security and supply-chain TESTS do not fire', () => {
    expect(
      classify([
        change('docs/security/threat-model.md'),
        change('packages/ffi/src/__tests__/supply-chain.test.ts'),
        change('packages/ffi/src/__tests__/supply-chain.ts'),
      ]),
    ).toHaveLength(0);
  });
});

/** A fake repo reader: `files[side][path]` is the content; absent = null. */
function reader(files: { base?: Record<string, string>; head?: Record<string, string> }) {
  return {
    show: (side: 'base' | 'head', path: string) => files[side]?.[path] ?? null,
    listHead: (prefix: string) => Object.keys(files.head ?? {}).filter((p) => p.startsWith(prefix)),
  };
}

const CRED_WF =
  'on: push\npermissions:\n  id-token: write\njobs:\n  a:\n    steps:\n' +
  '      - run: node scripts/pack-release-tarballs.mjs\n' +
  '      - uses: ./.github/actions/docker-hub-mirror\n';
const SECRET_WF = 'env:\n  NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n';
const PLAIN_WF =
  'on: pull_request\njobs:\n  a:\n    steps:\n      - run: node scripts/check-thing.mjs\n';
const CODECOV_WF =
  'env:\n  CODECOV_TOKEN: ${{ secrets.CODECOV_TOKEN }}\n  GH: ${{ secrets.GITHUB_TOKEN }}\n';
const sc = (fired: { id: string; paths: string[] }[]) =>
  fired.find((f) => f.id === 'supply-chain')?.paths;

describe('#2388 — credential-bearing workflows (scanned, not enumerated)', () => {
  it('detects a non-GITHUB_TOKEN secret and id-token: write', () => {
    expect(workflowHoldsCredential(SECRET_WF)).toBe(true);
    expect(workflowHoldsCredential(CRED_WF)).toBe(true);
    expect(workflowHoldsCredential('x: ${{ secrets[format("{0}", "NPM_TOKEN")] }}')).toBe(true);
  });

  it('near miss: GITHUB_TOKEN and the upload-only CODECOV_TOKEN are not credentials here', () => {
    expect(workflowHoldsCredential(CODECOV_WF)).toBe(false);
    expect(workflowHoldsCredential(PLAIN_WF)).toBe(false);
  });

  it('editing a credential-bearing workflow fires', () => {
    const r = reader({
      base: { '.github/workflows/release.yml': SECRET_WF },
      head: { '.github/workflows/release.yml': `${SECRET_WF}# edit\n` },
    });
    expect(sc(classifyContent([change('.github/workflows/release.yml')], r))).toEqual([
      '.github/workflows/release.yml',
    ]);
  });

  it('ADDING a secret to a previously plain workflow fires (head side counts)', () => {
    const r = reader({
      base: { '.github/workflows/ci.yml': CODECOV_WF },
      head: { '.github/workflows/ci.yml': `${CODECOV_WF}${SECRET_WF}` },
    });
    expect(sc(classifyContent([change('.github/workflows/ci.yml')], r))).toEqual([
      '.github/workflows/ci.yml',
    ]);
  });

  it('DELETING a credential-bearing workflow fires (base side counts)', () => {
    const r = reader({ base: { '.github/workflows/supply-chain.yml': CRED_WF }, head: {} });
    expect(sc(classifyContent([change('.github/workflows/supply-chain.yml', 'D')], r))).toEqual([
      '.github/workflows/supply-chain.yml',
    ]);
  });

  it('near miss: editing a plain workflow does not fire', () => {
    const r = reader({
      base: { '.github/workflows/ci.yml': CODECOV_WF },
      head: { '.github/workflows/ci.yml': `${CODECOV_WF}# edit\n` },
    });
    expect(classifyContent([change('.github/workflows/ci.yml')], r)).toHaveLength(0);
  });

  it('a script or local action a credential-bearing workflow runs is supply chain', () => {
    const r = reader({
      head: {
        '.github/workflows/release.yml': CRED_WF,
        '.github/workflows/lint.yml': PLAIN_WF,
      },
    });
    const fired = classifyContent(
      [
        change('scripts/pack-release-tarballs.mjs'),
        change('.github/actions/docker-hub-mirror/action.yml'),
      ],
      r,
    );
    expect(sc(fired)).toEqual([
      'scripts/pack-release-tarballs.mjs',
      '.github/actions/docker-hub-mirror/action.yml',
    ]);
  });

  it('near miss: a script only a plain workflow runs does not fire', () => {
    const r = reader({
      head: {
        '.github/workflows/release.yml': CRED_WF,
        '.github/workflows/lint.yml': PLAIN_WF,
      },
    });
    expect(classifyContent([change('scripts/check-thing.mjs')], r)).toHaveLength(0);
  });

  it('referencedPaths strips trailing prose punctuation from comment mentions', () => {
    expect(referencedPaths('# see scripts/lib/a.mjs. and ./scripts/b.mjs,')).toEqual([
      'scripts/lib/a.mjs',
      'scripts/b.mjs',
    ]);
  });
});

describe('#2388 — public surface of EVERY packages/*/package.json', () => {
  const pkg = (o: Record<string, unknown>) => JSON.stringify({ name: 'x', version: '0.1.0', ...o });
  const api = (fired: { id: string; paths: string[] }[]) =>
    fired.find((f) => f.id === 'public-api')?.paths;

  it('a private Beta package adding an export fires', () => {
    const r = reader({
      base: { 'packages/ffi/package.json': pkg({ private: true, exports: { '.': './a.js' } }) },
      head: {
        'packages/ffi/package.json': pkg({
          private: true,
          exports: { '.': './a.js', './render': './r.js' },
        }),
      },
    });
    expect(api(classifyContent([change('packages/ffi/package.json')], r))).toEqual([
      'packages/ffi/package.json',
    ]);
  });

  it('a NEW package with a bin fires', () => {
    const r = reader({ head: { 'packages/new/package.json': pkg({ bin: { x: './x.js' } }) } });
    expect(api(classifyContent([change('packages/new/package.json', 'A')], r))).toEqual([
      'packages/new/package.json',
    ]);
  });

  it('core keeps firing as before', () => {
    const r = reader({
      base: { 'packages/kn-next/package.json': pkg({ exports: { '.': './a.js' } }) },
      head: { 'packages/kn-next/package.json': pkg({ exports: { '.': './b.js' } }) },
    });
    expect(api(classifyContent([change('packages/kn-next/package.json')], r))).toEqual([
      'packages/kn-next/package.json',
    ]);
  });

  it('near miss: a version bump in a non-core package does not fire', () => {
    const r = reader({
      base: { 'packages/grpc/package.json': pkg({ exports: { '.': './a.js' } }) },
      head: {
        'packages/grpc/package.json': pkg({ version: '0.2.0', exports: { '.': './a.js' } }),
      },
    });
    expect(classifyContent([change('packages/grpc/package.json')], r)).toHaveLength(0);
  });

  it('near miss: a nested template package.json is not a package manifest', () => {
    const r = reader({
      head: { 'packages/kn-next/templates/app/package.json': pkg({ bin: { y: './y.js' } }) },
    });
    expect(
      classifyContent([change('packages/kn-next/templates/app/package.json', 'A')], r),
    ).toHaveLength(0);
  });

  it('an UNPARSEABLE manifest fails closed — it fires, never passes', () => {
    const r = reader({
      base: { 'packages/grpc/package.json': '{ not json' },
      head: { 'packages/grpc/package.json': '{ also not json' },
    });
    const fired = classifyContent([change('packages/grpc/package.json')], r);
    const hit = fired.find((f: { id: string }) => f.id === 'public-api');
    expect(hit?.paths).toEqual(['packages/grpc/package.json']);
    expect(hit?.why).toMatch(/unparseable/i);
  });
});

describe('#2388 — unknown input fails rather than passes', () => {
  it('an unknown name-status letter throws', () => {
    expect(() => parseNameStatus('Q\tpackages/x.ts')).toThrow(/status/i);
  });

  it('a status line with no path throws', () => {
    expect(() => parseNameStatus('M')).toThrow(/path/i);
  });

  it('every real git status letter is still accepted', () => {
    for (const s of ['A', 'C75', 'D', 'M', 'R100', 'T', 'U', 'X', 'B']) {
      const line = s.length > 1 ? `${s}\told\tnew` : `${s}\tp`;
      expect(() => parseNameStatus(line)).not.toThrow();
    }
  });
});

describe('#2388 — path and content triggers merge into one entry per id', () => {
  it('dedupes paths and keeps both sources', () => {
    const merged = mergeFired(
      [{ id: 'supply-chain', label: 'l', why: 'w', paths: ['security/a.json'] }],
      [
        { id: 'supply-chain', label: 'l', why: 'w', paths: ['security/a.json', 'scripts/b.mjs'] },
        { id: 'public-api', label: 'p', why: 'w', paths: ['packages/ffi/package.json'] },
      ],
    );
    expect(merged).toEqual([
      { id: 'supply-chain', label: 'l', why: 'w', paths: ['security/a.json', 'scripts/b.mjs'] },
      { id: 'public-api', label: 'p', why: 'w', paths: ['packages/ffi/package.json'] },
    ]);
  });
});
/**
 * #2388 round 2 — four misses the reviewer reproduced in a scratch repo, each of
 * which exited 0. Each block proves the miss now fires and keeps a near miss quiet.
 */
const RELEASE_WF =
  'on: push\npermissions:\n  id-token: write\njobs:\n  a:\n    steps:\n' +
  '      - run: node scripts/pack-release-tarballs.mjs\n';

describe('#2388 r2 — static relative imports of a release-path script are followed', () => {
  const head = {
    '.github/workflows/release.yml': RELEASE_WF,
    'scripts/pack-release-tarballs.mjs':
      "import { readFileSync } from 'node:fs';\nimport { parse } from 'yaml';\n" +
      "import {\n  packGroup,\n} from './lib/pack-publishable-group.mjs';\n",
    'scripts/lib/pack-publishable-group.mjs':
      'import { globs } from "./workspace-globs.mjs";\nexport * from \'./ga-tarball-diff.mjs\';\n',
    'scripts/lib/workspace-globs.mjs': 'export const globs = [];\n',
    'scripts/lib/ga-tarball-diff.mjs': 'export const diff = 1;\n',
    'scripts/lib/unrelated.mjs': 'export const u = 1;\n',
  };

  it('a direct import, a transitive import and a re-export all fire', () => {
    const fired = classifyContent(
      [
        change('scripts/lib/pack-publishable-group.mjs'),
        change('scripts/lib/workspace-globs.mjs'),
        change('scripts/lib/ga-tarball-diff.mjs'),
      ],
      reader({ head }),
    );
    expect(sc(fired)).toEqual([
      'scripts/lib/pack-publishable-group.mjs',
      'scripts/lib/workspace-globs.mjs',
      'scripts/lib/ga-tarball-diff.mjs',
    ]);
  });

  it('require() and import() with a literal string are followed too', () => {
    const r = reader({
      head: {
        ...head,
        'scripts/pack-release-tarballs.mjs':
          "const a = require('./lib/workspace-globs.mjs');\n" +
          'const b = await import(`./lib/ga-tarball-diff.mjs`);\n',
      },
    });
    const fired = classifyContent(
      [change('scripts/lib/workspace-globs.mjs'), change('scripts/lib/ga-tarball-diff.mjs')],
      r,
    );
    expect(sc(fired)).toEqual([
      'scripts/lib/workspace-globs.mjs',
      'scripts/lib/ga-tarball-diff.mjs',
    ]);
  });

  it('a DELETED import target is read from the base tree and fires', () => {
    const r = reader({
      base: { 'scripts/lib/old.mjs': "import './older.mjs';\n", 'scripts/lib/older.mjs': '' },
      head: {
        ...head,
        'scripts/pack-release-tarballs.mjs': "import './lib/old.mjs';\n",
      },
    });
    const fired = classifyContent(
      [change('scripts/lib/old.mjs', 'D'), change('scripts/lib/older.mjs', 'D')],
      r,
    );
    expect(sc(fired)).toEqual(['scripts/lib/old.mjs', 'scripts/lib/older.mjs']);
    // Followed through the base tree — NOT caught only by the fail-closed fallback,
    // which a head-only reader would also reach (an unresolvable './lib/old.mjs').
    const why = fired.find((f: { id: string }) => f.id === 'supply-chain')?.why ?? '';
    expect(why).not.toMatch(/INCOMPLETE/);
  });

  it('a shell script or composite action the workflow runs is scanned for what IT runs', () => {
    const r = reader({
      head: {
        '.github/workflows/release.yml':
          'permissions:\n  id-token: write\njobs:\n  a:\n    steps:\n' +
          '      - run: bash scripts/release.sh\n      - uses: ./.github/actions/sign\n',
        'scripts/release.sh': 'node scripts/lib/workspace-globs.mjs\n',
        '.github/actions/sign/action.yml':
          'runs:\n  steps:\n    - run: node scripts/lib/ga-tarball-diff.mjs\n',
        'scripts/lib/workspace-globs.mjs': '',
        'scripts/lib/ga-tarball-diff.mjs': '',
      },
    });
    const fired = classifyContent(
      [change('scripts/lib/workspace-globs.mjs'), change('scripts/lib/ga-tarball-diff.mjs')],
      r,
    );
    expect(sc(fired)).toEqual([
      'scripts/lib/workspace-globs.mjs',
      'scripts/lib/ga-tarball-diff.mjs',
    ]);
  });

  it('near miss: a module nothing on the release path imports does not fire', () => {
    expect(classifyContent([change('scripts/lib/unrelated.mjs')], reader({ head }))).toHaveLength(
      0,
    );
  });

  it('a NON-LITERAL dynamic import fails closed: any changed module fires, and says why', () => {
    const r = reader({
      head: { ...head, 'scripts/pack-release-tarballs.mjs': 'const m = await import(name);\n' },
    });
    const fired = classifyContent([change('scripts/lib/unrelated.mjs')], r);
    const hit = fired.find((f: { id: string }) => f.id === 'supply-chain');
    expect(hit?.paths).toEqual(['scripts/lib/unrelated.mjs']);
    expect(hit?.why).toMatch(/non-literal/i);
    expect(hit?.why).toContain('scripts/pack-release-tarballs.mjs');
  });

  it('a non-literal require() and an interpolated template also fail closed', () => {
    for (const src of [
      'const m = require(dir + "/x.mjs");\n',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text under test
      'await import(`./lib/${n}.mjs`);\n',
    ]) {
      const r = reader({ head: { ...head, 'scripts/pack-release-tarballs.mjs': src } });
      expect(sc(classifyContent([change('scripts/lib/unrelated.mjs')], r))).toEqual([
        'scripts/lib/unrelated.mjs',
      ]);
    }
  });

  it('an unresolvable relative import fails closed and says why', () => {
    const r = reader({
      head: { ...head, 'scripts/pack-release-tarballs.mjs': "import './lib/missing.mjs';\n" },
    });
    const hit = classifyContent([change('scripts/lib/unrelated.mjs')], r).find(
      (f: { id: string }) => f.id === 'supply-chain',
    );
    expect(hit?.paths).toEqual(['scripts/lib/unrelated.mjs']);
    expect(hit?.why).toMatch(/unresolv/i);
  });

  it('near miss: an incomplete closure still does not fire on a non-module file', () => {
    const r = reader({
      head: { ...head, 'scripts/pack-release-tarballs.mjs': 'await import(name);\n' },
    });
    expect(classifyContent([change('docs/RELEASING.md')], r)).toHaveLength(0);
  });

  it('near miss: import()/require() mentioned on a COMMENT line is not a gap', () => {
    // The real release path carries exactly this: a JSDoc line naming `import()`.
    // Reading it as a non-literal import would fire on every PR that touches a module.
    const r = reader({
      head: {
        ...head,
        'scripts/pack-release-tarballs.mjs':
          '/**\n * a lazy `import()`, which would bind tar\n */\n// require(x) is avoided\n' +
          "/* import('./lib/missing.mjs') */\nexport const x = 1;\n",
      },
    });
    expect(classifyContent([change('scripts/lib/unrelated.mjs')], r)).toHaveLength(0);
  });
});

describe('#2388 r2 — renames and copies classify BOTH paths', () => {
  const fromDiff = (line: string) => ids(classify(parseNameStatus(line)));

  it('moving a CRD types file out of api/ fires', () => {
    expect(
      fromDiff('R100\tpackages/kn-next-operator/api/v1alpha1/foo_types.go\tdocs/foo_types.go.txt'),
    ).toContain('crd');
  });

  it('moving a CLI file out of src/cli/ fires', () => {
    expect(
      fromDiff('R087\tpackages/kn-next/src/cli/deploy.ts\tpackages/kn-next/src/deploy.ts'),
    ).toContain('cli-surface');
  });

  it('moving a security/*.json file out fires', () => {
    expect(fromDiff('R100\tsecurity/npm-audit-allowlist.json\tdocs/allowlist.json')).toContain(
      'supply-chain',
    );
  });

  it('copying INTO scope fires on the destination', () => {
    expect(fromDiff('C075\tdocs/x.json\tsecurity/x.json')).toContain('supply-chain');
  });

  it('moving a credential-bearing workflow out of .github/workflows fires', () => {
    const r = reader({ base: { '.github/workflows/release.yml': SECRET_WF } });
    const fired = classifyContent(
      parseNameStatus('R100\t.github/workflows/release.yml\tdocs/release.yml.bak'),
      r,
    );
    expect(sc(fired)).toEqual(['.github/workflows/release.yml']);
  });

  it('parses NUL-separated (-z) output, including a rename', () => {
    expect(parseNameStatus('R100\0a b.ts\0c.ts\0M\0é.go\0')).toEqual([
      { status: 'R', path: 'c.ts' },
      { status: 'R', path: 'a b.ts' },
      { status: 'M', path: 'é.go' },
    ]);
  });

  it('a -z rename record missing its second path throws', () => {
    expect(() => parseNameStatus('R100\0a.ts\0')).toThrow(/path/i);
  });
});

describe('#2388 r2 — credential detection: write permissions and toJSON(secrets)', () => {
  it('permissions: write-all is a credential', () => {
    expect(workflowHoldsCredential('permissions: write-all\n')).toBe(true);
  });

  it('packages/contents/attestations/id-token: write are credentials, workflow or job level', () => {
    for (const scope of ['packages', 'contents', 'attestations', 'id-token']) {
      expect(workflowHoldsCredential(`permissions:\n  ${scope}: write\n`)).toBe(true);
      expect(
        workflowHoldsCredential(`jobs:\n  a:\n    permissions:\n      ${scope}: 'write'\n`),
      ).toBe(true);
    }
  });

  it('toJSON(secrets) is a credential (case-insensitive, any spacing)', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow expression text
    expect(workflowHoldsCredential('env:\n  ALL: ${{ toJSON(secrets) }}\n')).toBe(true);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow expression text
    expect(workflowHoldsCredential('env:\n  ALL: ${{ tojson( secrets ) }}\n')).toBe(true);
  });

  it('near miss: read scopes, read-all and other write scopes are not credentials here', () => {
    expect(
      workflowHoldsCredential(
        'permissions: read-all\njobs:\n  a:\n    permissions:\n' +
          '      contents: read\n      pull-requests: write\n      issues: write\n',
      ),
    ).toBe(false);
  });
});

describe('#2388 r2 — the CLI sees non-ASCII and renamed paths end to end', () => {
  const SCRIPT = resolve(import.meta.dirname, '../scripts/check-escalation-triggers.mjs');
  const tempRoots: string[] = [];
  afterAll(() => {
    for (const d of tempRoots) rmSync(d, { recursive: true, force: true });
  });

  function scratchRepo(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'knext-escalation-cli-'));
    tempRoots.push(root);
    const g = (...a: string[]) => {
      const r = spawnSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a],
        { cwd: root, encoding: 'utf8' },
      );
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    };
    g('init', '-q', '-b', 'main');
    g('config', 'core.quotepath', 'true');
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), c);
    }
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    g('switch', '-q', '-c', 'pr');
    return { root, g };
  }

  const run = (root: string) =>
    spawnSync('node', [SCRIPT, '--base', 'main', '--head', 'HEAD', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });

  it('a non-ASCII CRD types path (git would C-quote it) fires', () => {
    const { root, g } = scratchRepo({ 'README.md': 'x\n' });
    const p = 'api/v1alpha1/é_types.go';
    mkdirSync(join(root, 'api/v1alpha1'), { recursive: true });
    writeFileSync(join(root, p), 'package v1alpha1\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'add');
    const r = run(root);
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.fired.find((f: { id: string }) => f.id === 'crd')?.paths).toEqual([p]);
  });

  it('renaming a CRD types file out of api/ fires', () => {
    const body = 'package v1alpha1\n\n// a body long enough for rename detection\n'.repeat(4);
    const { root, g } = scratchRepo({ 'api/v1alpha1/foo_types.go': body });
    mkdirSync(join(root, 'docs'));
    g('mv', 'api/v1alpha1/foo_types.go', 'docs/foo.go.txt');
    g('commit', '-q', '-m', 'move');
    const r = run(root);
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.fired.find((f: { id: string }) => f.id === 'crd')?.paths).toEqual([
      'api/v1alpha1/foo_types.go',
    ]);
  });

  it('a script a local action runs, imported transitively, fires (the reader sees trees as dirs)', () => {
    // `git cat-file -e ref:dir` succeeds for a TREE, so a reader that only checks
    // existence treats the action directory as a file and never opens action.yml.
    const { root, g } = scratchRepo({
      '.github/workflows/release.yml':
        // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow expression text
        'env:\n  T: ${{ secrets.NPM_TOKEN }}\njobs:\n  a:\n    steps:\n      - uses: ./.github/actions/sign\n',
      '.github/actions/sign/action.yml': 'runs:\n  steps:\n    - run: node scripts/sign.mjs\n',
      'scripts/sign.mjs': "import './lib/key.mjs';\n",
      'scripts/lib/key.mjs': 'export const k = 1;\n',
    });
    writeFileSync(join(root, 'scripts/lib/key.mjs'), 'export const k = 2;\n');
    g('commit', '-q', '-am', 'edit');
    const r = run(root);
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.fired.find((f: { id: string }) => f.id === 'supply-chain')?.paths).toEqual([
      'scripts/lib/key.mjs',
    ]);
  });
});

/**
 * #2388 round 3 — edges a JS module on the release path creates WITHOUT an import:
 * it spawns another script, names one as string segments, or loads one through
 * `createRequire`. Each block proves the edge is followed (or, when it cannot be
 * resolved, recorded as a gap so the fallback fails closed) and keeps a near miss
 * quiet.
 */
const R3_TREE = {
  '.github/workflows/release.yml': RELEASE_WF,
  'scripts/rewrite-workspace-ranges.mjs': 'export {};\n',
  'scripts/lib/x.mjs': 'export {};\n',
  'scripts/lib/unrelated.mjs': 'export const u = 1;\n',
};
/** A tree whose release-path entry (`scripts/pack-release-tarballs.mjs`) is `src`. */
const entry = (src: string, extra: Record<string, string> = {}) =>
  reader({ head: { ...R3_TREE, 'scripts/pack-release-tarballs.mjs': src, ...extra } });
const supply = (r: ReturnType<typeof reader>, path: string) =>
  classifyContent([change(path)], r).find((f: { id: string }) => f.id === 'supply-chain');
/** `path` fires because it is ON the closure — not via the incomplete-closure fallback. */
function expectFollowed(r: ReturnType<typeof reader>, path: string) {
  const hit = supply(r, path);
  expect(hit?.paths).toEqual([path]);
  expect(hit?.why).not.toMatch(/INCOMPLETE/);
}
/** The closure is incomplete: an unrelated changed module fires, and the reason says why. */
function expectGap(r: ReturnType<typeof reader>, why: RegExp) {
  const hit = supply(r, 'scripts/lib/unrelated.mjs');
  expect(hit?.paths).toEqual(['scripts/lib/unrelated.mjs']);
  expect(hit?.why).toMatch(/INCOMPLETE/);
  expect(hit?.why).toMatch(why);
}
const expectQuiet = (r: ReturnType<typeof reader>) =>
  expect(supply(r, 'scripts/lib/unrelated.mjs')).toBeUndefined();

describe('#2388 r3 — a module that spawns or names a script creates an edge', () => {
  it('join(REPO_ROOT, "scripts", …) spawned with node is followed (pack-publishable-group)', () => {
    const r = entry(
      "import { execFileSync } from 'node:child_process';\n" +
        "execFileSync('node', [join(REPO_ROOT, 'scripts', 'rewrite-workspace-ranges.mjs')], {\n" +
        '  cwd: dir,\n});\n',
    );
    expectFollowed(r, 'scripts/rewrite-workspace-ranges.mjs');
  });

  it('a literal "scripts/…" string in a module is followed', () => {
    const r = entry("execFileSync('node', ['scripts/rewrite-workspace-ranges.mjs']);\n");
    expectFollowed(r, 'scripts/rewrite-workspace-ranges.mjs');
  });

  it('new URL("./x.mjs", import.meta.url) is followed relative to the module', () => {
    const r = entry(
      "const u = new URL('./lib/x.mjs', import.meta.url);\nspawnSync(process.execPath, [fileURLToPath(u)]);\n",
    );
    expectFollowed(r, 'scripts/lib/x.mjs');
  });

  it('join(__dirname, …) bound to a const and spawned is followed (ga-tarball-diff-gate)', () => {
    const r = entry(
      "const diffScript = join(__dirname, 'lib', 'x.mjs');\n" +
        'const result = spawnSync(process.execPath, [diffScript, ...argv], { cwd });\n',
    );
    expectFollowed(r, 'scripts/lib/x.mjs');
  });

  it('near miss: join(REPO_ROOT, "scripts") — a directory — does not pull in every script', () => {
    expectQuiet(entry("const dir = join(REPO_ROOT, 'scripts');\n"));
    expectQuiet(entry("const dir = join(REPO_ROOT, 'scripts', 'lib');\n"));
  });

  it('near miss: a release script READING package.json does not make the root manifest fire', () => {
    const r = entry("const pkg = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');\n", {
      'package.json': '{}\n',
    });
    expect(supply(r, 'package.json')).toBeUndefined();
  });

  it('near miss: a script named only in a code COMMENT is not an edge', () => {
    const r = entry('// historically ran scripts/lib/unrelated.mjs\nexport {};\n');
    expectQuiet(r);
  });
});

describe('#2388 r3 — an edge that cannot be resolved is a gap, so the fallback fails closed', () => {
  it('createRequire fails closed', () => {
    expectGap(
      entry(
        "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nreq(name);\n",
      ),
      /createRequire/,
    );
  });

  it('createRequire under an alias, and module.createRequire, fail closed', () => {
    for (const src of [
      "import { createRequire as cr } from 'node:module';\ncr(import.meta.url)('./lib/x.mjs');\n",
      "import module from 'node:module';\nmodule.createRequire(import.meta.url);\n",
    ]) {
      expectGap(entry(src), /createRequire/);
    }
  });

  it('a spawned script held in a variable fails closed', () => {
    expectGap(
      entry(
        "import { execFileSync } from 'node:child_process';\nconst script = process.argv[2];\nexecFileSync('node', [script]);\n",
      ),
      /execFileSync/,
    );
  });

  it('every child-process form with a non-literal script fails closed', () => {
    for (const src of [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text under test
      "import { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, [`scripts/${n}.mjs`]);\n",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text under test
      "import { execSync } from 'node:child_process';\nexecSync(`node ${s}`);\n",
      "import { fork } from 'node:child_process';\nfork(name);\n",
      "import { exec } from 'node:child_process';\nexec(cmd);\n",
      "import { execFile } from 'node:child_process';\nexecFile('bun', [s]);\n",
      "import { spawn } from 'node:child_process';\nspawn('bash', [s]);\n",
      "import { execFileSync as run } from 'node:child_process';\nrun('node', [s]);\n",
      "import * as cp from 'node:child_process';\ncp.spawnSync('node', [s]);\n",
      // `exec`/`fork` are ambiguous names (`regex.exec`): only the namespace binding finds these.
      "import * as cp from 'node:child_process';\ncp.exec(cmd);\n",
      "const cp = require('node:child_process');\ncp.fork(s);\n",
      "const { fork: f } = require('node:child_process');\nf(s);\n",
      "import { spawnSync } from 'node:child_process';\nspawnSync(cmd, ['scripts/lib/x.mjs']);\n",
      "import { spawnSync } from 'node:child_process';\nspawnSync('node', args);\n",
      "import { spawnSync } from 'node:child_process';\nspawnSync('node', [...extra, 'x']);\n",
      'Bun.spawn(["node", s]);\n',
    ]) {
      expectGap(entry(src), /spawn|exec|fork/);
    }
  });

  it('a non-literal new URL(…) passed to a spawn fails closed', () => {
    expectGap(
      entry(
        "import { spawnSync } from 'node:child_process';\n" +
          'spawnSync(process.execPath, [fileURLToPath(new URL(name, import.meta.url))]);\n',
      ),
      /spawnSync/,
    );
  });

  it('a wrapper whose call site passes a non-literal script fails closed', () => {
    expectGap(
      entry(
        "import { spawnSync } from 'node:child_process';\n" +
          'function run(cmd, args) {\n  return spawnSync(cmd, args);\n}\n' +
          "run('syft', ['scan']);\nrun('node', [process.argv[2]]);\n",
      ),
      /spawnSync/,
    );
  });

  it('an EXPORTED wrapper fails closed — its callers live in other files', () => {
    expectGap(
      entry(
        "import { spawnSync } from 'node:child_process';\n" +
          "export function run(cmd, args) {\n  return spawnSync(cmd, args);\n}\nrun('git', []);\n",
      ),
      /spawnSync/,
    );
  });

  it('a runner object whose script is not a literal path fails closed', () => {
    expectGap(
      entry(
        "import { spawnSync } from 'node:child_process';\nimport { mk } from './lib/runner.mjs';\n" +
          'const runner = mk();\nspawnSync(runner.command, [...runner.args, spec]);\n',
        {
          'scripts/lib/runner.mjs':
            'export function mk() {\n  return { command: process.execPath, args: [process.argv[2]] };\n}\n',
        },
      ),
      /spawnSync/,
    );
  });
});

describe('#2388 r3 — resolvable child-process calls are NOT gaps (the real release path)', () => {
  it('a literal non-interpreter command with computed arguments is quiet', () => {
    expectQuiet(
      entry(
        "import { execFileSync, spawnSync } from 'node:child_process';\n" +
          "execFileSync('git', ['worktree', 'add', '--detach', dir, ref], { cwd });\n" +
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text under test
          "spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['view', `${n}@${v}`]);\n" +
          "execFileSync('bun', ['pm', 'pack', '--destination', dest]);\n",
      ),
    );
  });

  it('regex .exec(), and spawnSync( inside a string, are not child-process calls', () => {
    expectQuiet(entry("const m = /a(b)/.exec(s);\nthrow new Error('spawnSync(x) failed');\n"));
  });

  it('a same-file wrapper whose every call site is literal is quiet (precompile-closure-audit)', () => {
    expectQuiet(
      entry(
        "import { spawnSync } from 'node:child_process';\n" +
          'function run(cmd, args) {\n  const res = spawnSync(cmd, args, { encoding: "utf8" });\n  return res;\n}\n' +
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text under test
          "run('syft', ['scan', dir]);\nconst out = run('grype', [`sbom:${p}`]);\n",
      ),
    );
  });

  it('Bun.spawn with a literal command array is quiet', () => {
    expectQuiet(entry('Bun.spawn(["node", "scripts/lib/x.mjs"]);\n'));
  });

  it('a wrapper that escapes as a value fails closed — its call sites are not visible', () => {
    expectGap(
      entry(
        "import { spawnSync } from 'node:child_process';\n" +
          'function run(cmd, args) {\n  return spawnSync(cmd, args);\n}\n' +
          "run('git', []);\n[['git', []]].map(run);\n",
      ),
      /escapes as a value/,
    );
  });

  it('a runner factory with a non-object return fails closed', () => {
    expectGap(
      entry(
        "import { spawnSync } from 'node:child_process';\nimport { mk } from './lib/runner.mjs';\n" +
          'const runner = mk();\nspawnSync(runner.command, [...runner.args]);\n',
        {
          'scripts/lib/runner.mjs':
            'export function mk() {\n  if (process.env.X) return other();\n' +
            "  return { command: process.execPath, args: ['scripts/lib/x.mjs'] };\n}\n",
        },
      ),
      /spawnSync/,
    );
  });

  it('an invoker override with a literal default resolves in the COMMAND position (bun-test)', () => {
    expectQuiet(
      entry(
        "import { spawn, execFileSync } from 'node:child_process';\n" +
          "spawn(process.env.KNEXT_BUN ?? 'bun', ['test', file]);\n" +
          'const flag = (name, fallback) => {\n' +
          '  const hit = argv.find((a) => a.startsWith(`--${name}=`));\n' +
          "  return hit ? hit.split('=')[1] : fallback;\n};\n" +
          "const bunBin = flag('bun', process.env.KNEXT_BUN || 'bun');\n" +
          "execFileSync(bunBin, ['--version']);\n",
      ),
    );
  });

  it('…but NOT in the script position: node [env ?? literal] fails closed', () => {
    expectGap(
      entry(
        "import { spawnSync } from 'node:child_process';\n" +
          "spawnSync('node', [process.env.SCRIPT ?? 'scripts/lib/x.mjs']);\n",
      ),
      /script argument/,
    );
  });

  it('a runner object built by an imported function resolves to its literal script (guard-prover)', () => {
    const r = entry(
      "import { spawnSync } from 'node:child_process';\nimport { resolveSpecRunner } from './lib/runner.mjs';\n" +
        'export function runSpecExit(repoRoot, spec) {\n  const runner = resolveSpecRunner(repoRoot, spec);\n' +
        '  const res = spawnSync(runner.command, [...runner.args, ...runner.runArgs(spec)], {\n    cwd: repoRoot,\n  });\n' +
        '  return res.status;\n}\n',
      {
        'scripts/lib/runner.mjs':
          'export function resolveSpecRunner(repoRoot, _spec) {\n  return {\n    command: process.execPath,\n' +
          "    args: [join(repoRoot, 'scripts', 'lib', 'x.mjs')],\n" +
          '    runArgs: (s) => [s],\n  };\n}\n',
      },
    );
    expectQuiet(r);
    expectFollowed(r, 'scripts/lib/x.mjs');
  });
});

describe('#2388 r3 — comments are stripped token-aware, not by whole line', () => {
  it('a block comment followed by code on the same line does not hide the import', () => {
    expectFollowed(entry("/* c */ import './lib/x.mjs';\n"), 'scripts/lib/x.mjs');
    expectGap(entry('/* c */ const m = await import(name);\n'), /non-literal/);
  });

  it('a regex containing // does not swallow the rest of the line', () => {
    expectFollowed(
      entry("const re = /^https?:\\/\\//; import './lib/x.mjs';\n"),
      'scripts/lib/x.mjs',
    );
  });

  it('a /* inside a string is not a comment', () => {
    expectFollowed(entry("const s = '/*'; import './lib/x.mjs'; // */\n"), 'scripts/lib/x.mjs');
  });

  it('near miss: import() inside a block comment that ends mid-line is still not a gap', () => {
    expectQuiet(entry('/* a lazy `import()` here */ export const x = 1;\n'));
  });
});

describe('#2388 r3 — a shell source of a non-literal path is a gap', () => {
  const SH_WF =
    'permissions:\n  id-token: write\njobs:\n  a:\n    steps:\n      - run: bash scripts/release.sh\n';
  const sh = (body: string, extra: Record<string, string> = {}) =>
    reader({
      head: {
        ...R3_TREE,
        '.github/workflows/release.yml': SH_WF,
        'scripts/release.sh': body,
        ...extra,
      },
    });

  it('. "$(dirname "$0")/lib/x.sh" and source "$DIR/…" fail closed', () => {
    for (const body of [
      '#!/usr/bin/env bash\n. "$(dirname "$0")/lib/x.sh"\n',
      'set -e\nDIR=$(cd "$(dirname "$0")" && pwd)\nsource "$DIR/lib/common.sh"\n',
      'if true; then source "$LIB"; fi\n',
    ]) {
      expectGap(sh(body), /source/);
    }
  });

  it('with a shell gap, a changed shell script under scripts/ also fails closed', () => {
    const hit = supply(sh('. "$(dirname "$0")/lib/x.sh"\n'), 'scripts/lib/other.sh');
    expect(hit?.paths).toEqual(['scripts/lib/other.sh']);
  });

  it('near miss: sourcing a literal path follows it and is not a gap', () => {
    const r = sh('source scripts/lib/common.sh\n. ./scripts/lib/more.sh\n', {
      'scripts/lib/common.sh': '',
      'scripts/lib/more.sh': '',
    });
    expectQuiet(r);
    expectFollowed(r, 'scripts/lib/common.sh');
    expectFollowed(r, 'scripts/lib/more.sh');
  });
});

describe('#2388 r3 — the real release-path closure on this tree', () => {
  const ROOT = resolve(import.meta.dirname, '..');
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .stdout.split('\0')
    .filter(Boolean);
  const files = new Set(tracked);
  const fsRepo = {
    show: (_side: 'base' | 'head', p: string) =>
      files.has(p) ? readFileSync(join(ROOT, p), 'utf8') : null,
    listHead: (prefix: string) => tracked.filter((p) => p.startsWith(prefix)),
  };

  it('has NO gaps — the fallback would otherwise fire on every module change', () => {
    expect(releasePathClosure(fsRepo).gaps).toEqual([]);
  });

  it('includes the scripts the release path SPAWNS, not only those it imports', () => {
    const { closure } = releasePathClosure(fsRepo);
    // audit-published.mjs spawns this via join(repoRoot, 'scripts', …); no workflow names it.
    expect(closure.has('scripts/scan-published-seams.mjs')).toBe(true);
    // ci-blocking-gate-proof.mjs's runner spawns this.
    expect(closure.has('scripts/bun-test.mjs')).toBe(true);
  });
});
