import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  decide,
  preflight,
  publishablePackages,
  REACHABILITY_PROBE,
  RegistryUnreachableError,
  readWorkspaceManifests,
  WORKSPACE_ROOTS,
} from '../scripts/publish-preflight.mjs';

/**
 * `scripts/publish-preflight.mjs` answers one question — is there a version in
 * the tree the registry does not have? — and `release.yml`'s publish job is
 * skipped when the answer is no.
 *
 * That makes a WRONG "no" invisible: the job does not fail, it does not run, and
 * nothing anywhere says a publish was skipped. So the decision is a pure
 * function here, tested without a network, and the registry probe is the only
 * part left to trust.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

describe('publishablePackages — the same set `changeset publish` considers', () => {
  const manifests = [
    { dir: 'packages/a', name: '@getknext/core', version: '0.3.0', private: false },
    { dir: 'packages/b', name: '@getknext/ui', version: '0.1.0', private: true },
    { dir: 'packages/c', name: 'kn-next', version: '0.3.0', private: false },
    { dir: 'packages/d', name: 'spike-bun-bytecode', version: '0.0.0', private: false },
    { dir: 'apps/e', name: 'file-manager', version: '', private: false },
  ];

  it('excludes private packages', () => {
    const names = publishablePackages(manifests, []).map((p) => p.name);
    expect(names).not.toContain('@getknext/ui');
  });

  it('excludes changeset-ignored packages, read from the config rather than re-listed', () => {
    const names = publishablePackages(manifests, ['spike-bun-bytecode']).map((p) => p.name);
    expect(names).not.toContain('spike-bun-bytecode');
    // Both halves: the filter must not be so eager it empties the set.
    expect(names).toContain('@getknext/core');
    expect(names).toContain('kn-next');
  });

  it('excludes an unversioned manifest rather than asking the registry for `name@`', () => {
    expect(publishablePackages(manifests, []).map((p) => p.name)).not.toContain('file-manager');
  });
});

describe('decide — the gate that skips the publish job', () => {
  const pkgs = [
    { name: '@getknext/core', version: '0.3.0' },
    { name: '@getknext/lib', version: '0.3.0' },
  ];

  it('says publish when ANY version is absent from the registry', () => {
    const { shouldPublish, rows } = decide(pkgs, (name) => name === '@getknext/core');
    expect(shouldPublish).toBe(true);
    expect(rows.find((r) => r.name === '@getknext/lib')?.published).toBe(false);
  });

  it('says nothing-to-publish only when EVERY version is already there', () => {
    expect(decide(pkgs, () => true).shouldPublish).toBe(false);
  });

  it('says publish when none of them are there', () => {
    expect(decide(pkgs, () => false).shouldPublish).toBe(true);
  });

  it('reports a row per package, so a skipped publish is explicable', () => {
    // The `false` verdict is silent by construction — the job is skipped. The
    // table is the only record of WHY, so its completeness is asserted.
    const { rows } = decide(pkgs, () => true);
    expect(rows.map((r) => r.name)).toEqual(['@getknext/core', '@getknext/lib']);
  });
});

describe('preflight — fails closed when the registry cannot be reached', () => {
  const pkgs = [{ name: '@getknext/core', version: '0.3.0' }];

  it('THROWS rather than reporting "nothing to publish" when the probe fails', () => {
    // THE CASE THAT MATTERS. `npm view` exits non-zero for BOTH "no such
    // version" and "the network is down". Without the probe, a registry outage
    // makes every package look UNpublished — or, with the opposite polarity, a
    // fallthrough would make it look published and SKIP the publish job, which
    // reports nothing because a skipped job is not a failed job.
    expect(() => preflight({ packages: pkgs, viewSucceeds: () => false })).toThrow(
      RegistryUnreachableError,
    );
  });

  it('the probe is a package that certainly exists, and it is asked FIRST', () => {
    const asked: string[] = [];
    preflight({
      packages: pkgs,
      viewSucceeds: (spec: string) => {
        asked.push(spec);
        return true;
      },
    });
    expect(asked[0]).toBe(REACHABILITY_PROBE);
    // Both halves: the probe runs AND the real questions still get asked.
    expect(asked).toContain('@getknext/core@0.3.0');
  });

  it('a reachable registry that 404s the version still means publish', () => {
    // The polarity check the throw above cannot give: once reachability is
    // established, a non-zero `npm view` is a genuine "not published".
    const { shouldPublish } = preflight({
      packages: pkgs,
      viewSucceeds: (spec: string) => spec === REACHABILITY_PROBE,
    });
    expect(shouldPublish).toBe(true);
  });
});

describe('the preflight reads THIS repo, not a fixture', () => {
  it('its hardcoded workspace roots still match pnpm-workspace.yaml', () => {
    // The script cannot parse YAML — it runs with no dependencies installed —
    // so the roots are a literal. This is the check that keeps that literal
    // honest instead of trusting the comment beside it.
    const workspace = parse(readFileSync(resolve(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8')) as {
      packages: string[];
    };
    const roots = workspace.packages.map((glob) => glob.replace(/\/\*+$/, ''));
    expect([...WORKSPACE_ROOTS].sort()).toEqual([...roots].sort());
  });

  it('finds the four publishable packages in the real tree', () => {
    // Non-vacuity, and the specific claim the release lane rests on: `kn-next`
    // (the alias, packages/kn-next-alias) IS in scope. It is in the changesets
    // `fixed` group and not in `ignore`, and it has never been published.
    const config = JSON.parse(
      readFileSync(resolve(REPO_ROOT, '.changeset/config.json'), 'utf8'),
    ) as { ignore: string[] };
    const names = publishablePackages(readWorkspaceManifests(REPO_ROOT), config.ignore).map(
      (p) => p.name,
    );
    expect(names.sort()).toEqual(
      ['@getknext/core', '@getknext/db', '@getknext/lib', 'kn-next'].sort(),
    );
  });

  it('the publishable set matches the changesets `fixed` group exactly', () => {
    // If the two ever disagree, the gate is deciding about a different set than
    // the command it gates — and `fixed` is what makes the four move together,
    // so a member missing from one side ships a broken set (#255/#256).
    const config = JSON.parse(
      readFileSync(resolve(REPO_ROOT, '.changeset/config.json'), 'utf8'),
    ) as { ignore: string[]; fixed: string[][] };
    const names = publishablePackages(readWorkspaceManifests(REPO_ROOT), config.ignore).map(
      (p) => p.name,
    );
    expect(names.sort()).toEqual([...(config.fixed[0] ?? [])].sort());
  });
});
