/**
 * Dependabot reads `.github/dependabot.yml` from the DEFAULT branch only, so the
 * docker entry that keeps the Go builder-image digests moving lives here on main
 * and points at integration/v2 with `target-branch`, where those Dockerfiles are.
 * (integration/v2 carries a copy of the entry too; it becomes live there once v2
 * merges to main.) The directories are checked against the target branch by
 * Dependabot itself, so they need not exist in this tree.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const REPO_ROOT = resolve(import.meta.dirname, '..');
type Entry = {
  'package-ecosystem': string;
  directories?: string[];
  directory?: string;
  'target-branch'?: string;
  schedule?: { interval?: string };
  cooldown?: { 'default-days'?: number };
  groups?: Record<string, { patterns?: string[] }>;
  labels?: string[];
};
const config = parse(readFileSync(resolve(REPO_ROOT, '.github/dependabot.yml'), 'utf8')) as {
  updates: Entry[];
};
const docker = config.updates.filter((u) => u['package-ecosystem'] === 'docker');

describe('dependabot.yml: docker base images for integration/v2', () => {
  it('has exactly one docker entry', () => {
    expect(docker).toHaveLength(1);
  });

  it('targets integration/v2', () => {
    expect(docker[0]['target-branch']).toBe('integration/v2');
  });

  it('covers the gateway, the operator and the Go template', () => {
    expect([...(docker[0].directories ?? [])].sort()).toEqual([
      '/packages/kn-next-operator',
      '/packages/scale-zero-pg/gateway',
      '/templates/go',
    ]);
  });

  it('is weekly, grouped, labelled and carries the 3-day release-age cooldown', () => {
    expect(docker[0].schedule?.interval).toBe('weekly');
    expect(docker[0].cooldown?.['default-days']).toBe(3);
    expect(Object.keys(docker[0].groups ?? {}).length).toBeGreaterThan(0);
    expect(docker[0].labels).toContain('dependencies');
  });
});
