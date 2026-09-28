import { describe, expect, it } from 'bun:test';
import {
  decide,
  derivePackageRoots,
  fixedGroupNames,
  hasChangesetEntry,
  hasNoChangesetLabel,
  isTestOrDocsOnly,
  NO_CHANGESET_LABEL,
  touchedPackages,
} from '../scripts/check-changeset-required.mjs';

/**
 * Guard for #1615: a PR that changes a published package's shipped surface
 * (packages/kn-next/src, packages/kn-next/templates, packages/lib/src,
 * packages/db/src, the kn-next-alias bin, or any of those package.json's
 * bin/exports/files) must carry a `.changeset/*.md` file or the `no-changeset`
 * label. Mirrors `check-escalation-triggers.mjs`'s "fires when it must / stays
 * quiet on ordinary work" split — a guard that cries wolf gets worked around.
 */

const CHANGESET_CONFIG = {
  fixed: [['@getknext/core', '@getknext/lib', '@getknext/db', 'kn-next']],
  ignore: ['@getknext/ui', 'file-manager', 'spike-bun-bytecode'],
};

const MANIFESTS = {
  'packages/kn-next': { name: '@getknext/core', files: ['dist', 'templates'] },
  'packages/lib': { name: '@getknext/lib', files: ['dist'] },
  'packages/db': { name: '@getknext/db', files: ['dist'] },
  'packages/kn-next-alias': { name: 'kn-next', files: ['bin', 'README.md', 'LICENSE'] },
  'packages/ui': { name: '@getknext/ui', files: ['dist'] }, // NOT in the fixed group
};

const ROOTS = derivePackageRoots(CHANGESET_CONFIG, MANIFESTS);
const NO_MANIFEST_CHANGES = {};

describe('fixedGroupNames', () => {
  it('flattens the nested fixed group', () => {
    expect(fixedGroupNames(CHANGESET_CONFIG).sort()).toEqual(
      ['@getknext/core', '@getknext/db', '@getknext/lib', 'kn-next'].sort(),
    );
  });
});

describe('derivePackageRoots', () => {
  it('watches src/, not dist/, for a package whose files include "dist" (dist is build output, not committed)', () => {
    const root = ROOTS.find((r) => r.name === '@getknext/core' && r.watchDir);
    expect(ROOTS.some((r) => r.watchDir === 'packages/kn-next/src/')).toBe(true);
    expect(ROOTS.some((r) => r.watchDir === 'packages/kn-next/dist/')).toBe(false);
    void root;
  });

  it('watches a non-dist files entry (templates, bin) directly', () => {
    expect(ROOTS.some((r) => r.watchDir === 'packages/kn-next/templates/')).toBe(true);
    expect(ROOTS.some((r) => r.watchDir === 'packages/kn-next-alias/bin/')).toBe(true);
  });

  it('always includes the manifest path for a fixed-group package', () => {
    expect(
      ROOTS.some(
        (r) => r.name === '@getknext/core' && r.manifestPath === 'packages/kn-next/package.json',
      ),
    ).toBe(true);
  });

  it('excludes a package not in the fixed group, even if it has a manifest', () => {
    expect(ROOTS.some((r) => r.name === '@getknext/ui')).toBe(false);
  });
});

describe('isTestOrDocsOnly', () => {
  it('a __tests__ file', () => {
    expect(isTestOrDocsOnly('packages/kn-next/src/__tests__/deploy.test.ts')).toBe(true);
  });
  it('a *.test.ts / *.spec.ts file outside __tests__', () => {
    expect(isTestOrDocsOnly('packages/kn-next/src/cli/deploy.test.ts')).toBe(true);
    expect(isTestOrDocsOnly('packages/lib/src/health.spec.ts')).toBe(true);
  });
  it('a markdown file', () => {
    expect(isTestOrDocsOnly('packages/kn-next/src/adapters/README.md')).toBe(true);
  });
  it('a __tests__ fixture whose own filename does not match *.test.*', () => {
    expect(isTestOrDocsOnly('packages/kn-next/src/__tests__/fixtures/sample-cr.ts')).toBe(true);
  });
  it('ordinary source is not test-or-docs-only', () => {
    expect(isTestOrDocsOnly('packages/kn-next/src/cli/deploy.ts')).toBe(false);
  });
});

describe('touchedPackages', () => {
  it('a CLI source file touches @getknext/core', () => {
    const hit = touchedPackages(['packages/kn-next/src/cli/deploy.ts'], ROOTS, NO_MANIFEST_CHANGES);
    expect([...hit]).toEqual(['@getknext/core']);
  });

  it('a template file touches @getknext/core', () => {
    const hit = touchedPackages(
      ['packages/kn-next/templates/app/next.config.ts.hbs'],
      ROOTS,
      NO_MANIFEST_CHANGES,
    );
    expect([...hit]).toEqual(['@getknext/core']);
  });

  it('a lib source file touches @getknext/lib', () => {
    const hit = touchedPackages(['packages/lib/src/clients.ts'], ROOTS, NO_MANIFEST_CHANGES);
    expect([...hit]).toEqual(['@getknext/lib']);
  });

  it('a db source file touches @getknext/db', () => {
    const hit = touchedPackages(['packages/db/src/schema.ts'], ROOTS, NO_MANIFEST_CHANGES);
    expect([...hit]).toEqual(['@getknext/db']);
  });

  it('a kn-next-alias bin file touches "kn-next"', () => {
    const hit = touchedPackages(
      ['packages/kn-next-alias/bin/kn-next.js'],
      ROOTS,
      NO_MANIFEST_CHANGES,
    );
    expect([...hit]).toEqual(['kn-next']);
  });

  it('reports every distinct touched package, not just the first', () => {
    const hit = touchedPackages(
      ['packages/kn-next/src/cli/deploy.ts', 'packages/lib/src/health.ts'],
      ROOTS,
      NO_MANIFEST_CHANGES,
    );
    expect([...hit].sort()).toEqual(['@getknext/core', '@getknext/lib']);
  });

  it('a package.json public-surface change touches the package, with no src edit at all', () => {
    const hit = touchedPackages([], ROOTS, { '@getknext/core': true });
    expect([...hit]).toEqual(['@getknext/core']);
  });

  it('a package.json change that is NOT a public-surface change does not touch the package', () => {
    const hit = touchedPackages([], ROOTS, { '@getknext/core': false });
    expect([...hit]).toEqual([]);
  });

  it('stays quiet: dist/ output itself does not count (it is build output, not source)', () => {
    const hit = touchedPackages(
      ['packages/kn-next/dist/cli/deploy.js'],
      ROOTS,
      NO_MANIFEST_CHANGES,
    );
    expect([...hit]).toEqual([]);
  });

  it('stays quiet: a __tests__ file under a watched root', () => {
    const hit = touchedPackages(
      ['packages/kn-next/src/__tests__/deploy-cr.test.ts'],
      ROOTS,
      NO_MANIFEST_CHANGES,
    );
    expect([...hit]).toEqual([]);
  });

  it('stays quiet: CHANGELOG.md at the package root (not under any watched root)', () => {
    const hit = touchedPackages(['packages/kn-next/CHANGELOG.md'], ROOTS, NO_MANIFEST_CHANGES);
    expect([...hit]).toEqual([]);
  });

  it('stays quiet: a package outside the fixed group (e.g. @getknext/ui)', () => {
    const hit = touchedPackages(
      ['packages/ui/src/components/button.tsx'],
      ROOTS,
      NO_MANIFEST_CHANGES,
    );
    expect([...hit]).toEqual([]);
  });

  it('stays quiet: docs/ or the repo README are not package source', () => {
    const hit = touchedPackages(['docs/ARCHITECTURE.md', 'README.md'], ROOTS, NO_MANIFEST_CHANGES);
    expect([...hit]).toEqual([]);
  });
});

describe('hasChangesetEntry', () => {
  it('recognizes a real changeset file', () => {
    expect(hasChangesetEntry(['.changeset/fix-1615-changeset-check.md'])).toBe(true);
  });
  it('does not count .changeset/README.md', () => {
    expect(hasChangesetEntry(['.changeset/README.md'])).toBe(false);
  });
  it('does not count .changeset/config.json', () => {
    expect(hasChangesetEntry(['.changeset/config.json'])).toBe(false);
  });
  it('does not count a nested path under .changeset/', () => {
    expect(hasChangesetEntry(['.changeset/sub/dir.md'])).toBe(false);
  });
  it('false when no .changeset path is in the diff at all', () => {
    expect(hasChangesetEntry(['packages/kn-next/src/cli/deploy.ts'])).toBe(false);
  });
});

describe('hasNoChangesetLabel', () => {
  it('recognizes the label, case-insensitively and trimmed', () => {
    expect(hasNoChangesetLabel([NO_CHANGESET_LABEL])).toBe(true);
    expect(hasNoChangesetLabel([NO_CHANGESET_LABEL.toUpperCase()])).toBe(true);
    expect(hasNoChangesetLabel([` ${NO_CHANGESET_LABEL} `])).toBe(true);
  });
  it('false without the label', () => {
    expect(hasNoChangesetLabel([])).toBe(false);
    expect(hasNoChangesetLabel(['tier-A', 'bug'])).toBe(false);
  });
});

describe('decide — the whole check', () => {
  it('required=false when no fixed-group package is touched', () => {
    const v = decide({
      changedPaths: ['docs/ARCHITECTURE.md'],
      roots: ROOTS,
      manifestChanged: {},
      labels: [],
      hasChangeset: false,
    });
    expect(v).toMatchObject({ required: false, ok: true, packages: [] });
  });

  it('required=true, ok=false when a package is touched with no changeset and no label', () => {
    const v = decide({
      changedPaths: ['packages/kn-next/src/cli/deploy.ts'],
      roots: ROOTS,
      manifestChanged: {},
      labels: [],
      hasChangeset: false,
    });
    expect(v).toMatchObject({ required: true, ok: false, packages: ['@getknext/core'] });
  });

  it('required=true, ok=true, via=changeset when a .changeset/*.md is present', () => {
    const v = decide({
      changedPaths: ['packages/kn-next/src/cli/deploy.ts', '.changeset/fix-1615.md'],
      roots: ROOTS,
      manifestChanged: {},
      labels: [],
      hasChangeset: true,
    });
    expect(v).toMatchObject({ required: true, ok: true, via: 'changeset' });
  });

  it('required=true, ok=true, via=label when the no-changeset label is present', () => {
    const v = decide({
      changedPaths: ['packages/kn-next/src/cli/deploy.ts'],
      roots: ROOTS,
      manifestChanged: {},
      labels: [NO_CHANGESET_LABEL],
      hasChangeset: false,
    });
    expect(v).toMatchObject({ required: true, ok: true, via: 'label' });
  });

  it('lists every touched package, sorted', () => {
    const v = decide({
      changedPaths: ['packages/kn-next/src/cli/deploy.ts', 'packages/lib/src/health.ts'],
      roots: ROOTS,
      manifestChanged: {},
      labels: [],
      hasChangeset: false,
    });
    expect(v.packages).toEqual(['@getknext/core', '@getknext/lib']);
  });

  it('a tests-only diff under a watched root never requires a changeset', () => {
    const v = decide({
      changedPaths: ['packages/kn-next/src/__tests__/deploy-cr.test.ts'],
      roots: ROOTS,
      manifestChanged: {},
      labels: [],
      hasChangeset: false,
    });
    expect(v).toMatchObject({ required: false, ok: true, packages: [] });
  });
});
