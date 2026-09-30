/**
 * GUARD TESTS for scripts/publish-verify-alert.mjs (#1639c).
 *
 * Nothing previously alerted when a version bump landed on `main` and did NOT
 * end up published (crash, red CI, environment never approved, registry
 * outage). This re-asks `publish-preflight.mjs`'s exact question a second
 * time, after the release run, and files/updates the standing dedup-by-title
 * alert issue when the answer is still "yes, something is unpublished".
 *
 * `viewSucceeds` and `gh` are both injected — no network, no real `gh` calls.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegistryUnreachableError } from '../scripts/publish-preflight.mjs';
import { verifyAndAlert } from '../scripts/publish-verify-alert.mjs';

function writeJson(path: string, obj: unknown) {
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

function buildFixtureRoot(packages: Array<{ name: string; version: string; private?: boolean }>) {
  const root = mkdtempSync(join(tmpdir(), 'publish-verify-alert-fixture-'));
  mkdirSync(join(root, '.changeset'), { recursive: true });
  writeJson(join(root, '.changeset', 'config.json'), { ignore: [] });
  for (const pkg of packages) {
    const dir = join(root, 'packages', pkg.name.replace('@getknext/', ''));
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'package.json'), {
      name: pkg.name,
      version: pkg.version,
      private: pkg.private ?? false,
    });
  }
  return root;
}

const trio = (version: string) => [
  { name: '@getknext/core', version },
  { name: '@getknext/lib', version },
  { name: '@getknext/db', version },
];

describe('verifyAndAlert — GREEN: the registry already has everything', () => {
  it('does not create/update an alert when nothing is lagging', () => {
    const root = buildFixtureRoot(trio('1.0.0'));
    try {
      const ghCalls: string[][] = [];
      const result = verifyAndAlert({
        repoRoot: root,
        repo: 'getknext-dev/knext',
        viewSucceeds: () => true, // registry has every spec
        gh: (args) => {
          ghCalls.push(args);
          throw new Error('gh must not be called when nothing is lagging');
        },
      });
      expect(result.lagging).toBe(false);
      expect(ghCalls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('verifyAndAlert — RED: main is still ahead of the registry (the #1639c fixture)', () => {
  it('files a new alert issue naming the lagging package(s), by version, not by name alone', () => {
    const root = buildFixtureRoot(trio('1.0.0'));
    try {
      const ghCalls: string[][] = [];
      const result = verifyAndAlert({
        repoRoot: root,
        repo: 'getknext-dev/knext',
        // The reachability probe (REACHABILITY_PROBE = 'npm') succeeds, but
        // every @getknext/* spec 404s — exactly "registry lags main".
        viewSucceeds: (spec) => !spec.startsWith('@getknext/'),
        gh: (args) => {
          ghCalls.push(args);
          if (args[0] === 'issue' && args[1] === 'list') return '[]';
          if (args[0] === 'issue' && args[1] === 'create') {
            return 'https://github.com/getknext-dev/knext/issues/9999\n';
          }
          throw new Error(`unexpected gh call: ${args.join(' ')}`);
        },
      });
      expect(result.lagging).toBe(true);
      expect(result.alert).toEqual({ number: 9999, created: true });
      // The dedup-by-title lookup happened before the create, per ensureAlertIssue.
      expect(ghCalls[0]?.[0]).toBe('issue');
      expect(ghCalls[0]?.[1]).toBe('list');
      const createCall = ghCalls.find((c) => c[0] === 'issue' && c[1] === 'create');
      expect(createCall).toBeDefined();
      const bodyIndex = createCall?.indexOf('--body') ?? -1;
      expect(bodyIndex).toBeGreaterThan(-1);
      const body = createCall?.[bodyIndex + 1] ?? '';
      expect(body).toContain('@getknext/core@1.0.0');
      expect(body).toContain('@getknext/lib@1.0.0');
      expect(body).toContain('@getknext/db@1.0.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('updates (comments on) an EXISTING alert issue rather than filing a duplicate', () => {
    const root = buildFixtureRoot(trio('2.0.0'));
    try {
      const ghCalls: string[][] = [];
      const result = verifyAndAlert({
        repoRoot: root,
        repo: 'getknext-dev/knext',
        viewSucceeds: (spec) => !spec.startsWith('@getknext/'),
        gh: (args) => {
          ghCalls.push(args);
          if (args[0] === 'issue' && args[1] === 'list') {
            return JSON.stringify([
              { number: 42, title: 'main is ahead of the npm registry after a release run' },
            ]);
          }
          if (args[0] === 'issue' && args[1] === 'comment') return '';
          throw new Error(`unexpected gh call: ${args.join(' ')}`);
        },
      });
      expect(result.alert).toEqual({ number: 42, created: false });
      expect(ghCalls.some((c) => c[0] === 'issue' && c[1] === 'comment' && c[2] === '42')).toBe(
        true,
      );
      expect(ghCalls.some((c) => c[0] === 'issue' && c[1] === 'create')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('only names the ACTUALLY-lagging package(s), not every publishable one', () => {
    const root = buildFixtureRoot(trio('1.5.0'));
    try {
      let body = '';
      verifyAndAlert({
        repoRoot: root,
        repo: 'getknext-dev/knext',
        // Only @getknext/lib is missing from the registry; core + db made it.
        viewSucceeds: (spec) => spec !== '@getknext/lib@1.5.0',
        gh: (args) => {
          if (args[0] === 'issue' && args[1] === 'list') return '[]';
          if (args[0] === 'issue' && args[1] === 'create') {
            body = args[args.indexOf('--body') + 1] ?? '';
            return 'https://github.com/getknext-dev/knext/issues/1\n';
          }
          return '';
        },
      });
      expect(body).toContain('@getknext/lib@1.5.0');
      expect(body).not.toContain('@getknext/core@1.5.0');
      expect(body).not.toContain('@getknext/db@1.5.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('verifyAndAlert — fails closed on an unreachable registry', () => {
  it('throws RegistryUnreachableError rather than silently treating outage as "published"', () => {
    const root = buildFixtureRoot(trio('1.0.0'));
    try {
      expect(() =>
        verifyAndAlert({
          repoRoot: root,
          repo: 'getknext-dev/knext',
          viewSucceeds: () => false, // even the reachability probe fails
          gh: () => {
            throw new Error('gh must not be called when the registry is unreachable');
          },
        }),
      ).toThrow(RegistryUnreachableError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('verifyAndAlert — non-vacuity: no publishable packages is a hard error, not a silent pass', () => {
  it('throws when the fixture has nothing publishable', () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-verify-alert-empty-'));
    mkdirSync(join(root, '.changeset'), { recursive: true });
    writeJson(join(root, '.changeset', 'config.json'), { ignore: [] });
    try {
      expect(() =>
        verifyAndAlert({
          repoRoot: root,
          repo: 'getknext-dev/knext',
          viewSucceeds: () => true,
          gh: () => '',
        }),
      ).toThrow(/no publishable packages/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
