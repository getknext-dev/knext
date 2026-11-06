import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * GUARD: npm provenance is requested explicitly, and the OIDC token that makes
 * it possible is held by the publish job and nothing else in `release.yml`.
 *
 * `release.yml` used to grant `id-token: write` (plus `contents: write` and
 * `pull-requests: write`) at WORKFLOW level, so every job in the lane inherited
 * the OIDC token-request credential: the ref guard, the pack job, the audit job,
 * the preflight. Only the publish job needs it, to mint the Sigstore identity
 * that `npm publish --provenance` attests with.
 *
 * Provenance itself was already on through each package's
 * `publishConfig.provenance: true`. That is a per-package opt-in a newly
 * publishable package can forget, and `changeset publish` drops no flag of its
 * own, so the publish steps now also export `NPM_CONFIG_PROVENANCE=true`, which
 * npm reads as `--provenance` for every package the step publishes.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github/workflows');

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, unknown> };
type Job = {
  environment?: unknown;
  permissions?: unknown;
  steps?: Step[];
  [k: string]: unknown;
};
type Doc = { permissions?: unknown; jobs: Record<string, Job> };

function readDoc(file: string): Doc {
  return parse(readFileSync(resolve(WORKFLOW_DIR, file), 'utf8')) as Doc;
}

function has(perms: unknown, scope: string, level: string): boolean {
  if (perms === 'write-all') return level === 'write';
  return (
    !!perms && typeof perms === 'object' && (perms as Record<string, unknown>)[scope] === level
  );
}

const release = readDoc('release.yml');
const PUBLISH_JOB = 'release';

describe('release.yml: id-token is scoped to the publish job', () => {
  it('the workflow-level grant is read-only', () => {
    expect(release.permissions).toEqual({ contents: 'read' });
  });

  it('exactly one job holds id-token: write, and it is the publish job', () => {
    const holders = Object.entries(release.jobs)
      .filter(([, job]) => has(job.permissions ?? release.permissions, 'id-token', 'write'))
      .map(([id]) => id);
    expect(holders).toEqual([PUBLISH_JOB]);
  });

  it('the publish job is the job that holds the npm credential', () => {
    const job = release.jobs[PUBLISH_JOB];
    expect(job.environment).toBe('npm-publish');
    expect(JSON.stringify(job.steps)).toContain('secrets.NPM_TOKEN');
  });

  it('no job other than the publish job names the npm credential or the npm-publish environment', () => {
    for (const [id, job] of Object.entries(release.jobs)) {
      if (id === PUBLISH_JOB) continue;
      expect(job.environment, `job ${id}`).toBeUndefined();
      expect(JSON.stringify(job.steps ?? []), `job ${id}`).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
    }
  });

  it('no job that is not the publish job holds contents or pull-requests write unless it needs it', () => {
    // The two jobs that legitimately write: the Version PR job (branch + PR) and
    // the GitHub-release job (release object). The publish job pushes tags.
    const MAY_WRITE_CONTENTS = new Set([PUBLISH_JOB, 'version-pr', 'github-release']);
    for (const [id, job] of Object.entries(release.jobs)) {
      const perms = job.permissions ?? release.permissions;
      if (MAY_WRITE_CONTENTS.has(id)) continue;
      expect(has(perms, 'contents', 'write'), `job ${id} contents`).toBe(false);
      expect(has(perms, 'pull-requests', 'write'), `job ${id} pull-requests`).toBe(false);
    }
  });
});

describe('release.yml: every step that publishes to npm requests provenance', () => {
  const steps = release.jobs[PUBLISH_JOB].steps ?? [];
  // A step that carries the publish credential is a step that publishes (or
  // heals a publish). `npm whoami` only validates the token.
  const credentialed = steps.filter((s) => JSON.stringify(s.env ?? {}).includes('NPM_TOKEN'));
  const publishing = credentialed.filter((s) => !/npm whoami/.test(s.run ?? ''));

  it('finds the Publish and Heal steps (non-vacuity)', () => {
    expect(publishing.map((s) => s.name)).toEqual([
      'Publish',
      'Heal a partial publish in-run (re-publish only missing members)',
    ]);
  });

  for (const step of publishing) {
    it(`"${step.name}" sets NPM_CONFIG_PROVENANCE to true`, () => {
      expect(String(step.env?.NPM_CONFIG_PROVENANCE)).toBe('true');
    });
  }
});

describe('workflows: nothing outside release.yml holds the npm credential', () => {
  const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml'));
  it('scans the workflows (non-vacuity)', () => {
    expect(files.length).toBeGreaterThan(40);
  });
  it('only release.yml references secrets.NPM_TOKEN or the npm-publish environment', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === 'release.yml') continue;
      const text = readFileSync(resolve(WORKFLOW_DIR, file), 'utf8');
      const code = text
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
      if (/secrets\.NPM_TOKEN|environment:\s*npm-publish/.test(code)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe('published packages: provenance is on in the manifest too', () => {
  const pkgRoot = resolve(REPO_ROOT, 'packages');
  const manifests = readdirSync(pkgRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      try {
        return JSON.parse(readFileSync(resolve(pkgRoot, d.name, 'package.json'), 'utf8')) as {
          name: string;
          private?: boolean;
          publishConfig?: { provenance?: boolean };
        };
      } catch {
        return null;
      }
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  it('finds the publishable packages (non-vacuity)', () => {
    const names = manifests.filter((m) => m.private !== true).map((m) => m.name);
    expect(names).toContain('@getknext/core');
    expect(names).toContain('@getknext/lib');
    expect(names).toContain('@getknext/db');
  });

  it('every non-private package under packages/ sets publishConfig.provenance: true', () => {
    const missing = manifests
      .filter((m) => m.private !== true && m.publishConfig?.provenance !== true)
      .map((m) => m.name);
    expect(missing).toEqual([]);
  });
});
