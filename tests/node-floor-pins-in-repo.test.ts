import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * GUARD: every Node version this repo pins is at or above the Node 24 floor.
 *
 * The CLI refuses to start below Node 24 (the `engines` range and the start-up
 * check say so), so a CI lane, a base image or a manifest that still pins Node
 * 22 either tests a runtime the product no longer supports or ships one. The
 * scan reads the tracked tree instead of listing files, so a new workflow,
 * Dockerfile or package is covered the moment it lands, and a value that cannot
 * be parsed FAILS rather than passes.
 *
 * Surfaces: `engines.node` in every tracked package.json; every
 * `actions/setup-node` step's `node-version` (and any matrix key naming a node
 * version); `.nvmrc` / `.node-version` / `.tool-versions` files; every
 * `FROM node:` base image in a Dockerfile; every `image: node:` in a workflow,
 * manifest or generated-CI template.
 *
 * The one exemption is not ours: recorded benchmark evidence under
 * docs/benchmarks/data, which documents what was measured on Node 22 at the
 * time. The exemption is asserted real (the file exists and still pins Node 22),
 * so it cannot rot into a blanket skip.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const FLOOR = 24;

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\0')
  .filter(Boolean)
  .filter((f) => existsSync(resolve(REPO_ROOT, f)));

const read = (f: string): string => readFileSync(resolve(REPO_ROOT, f), 'utf8');

/** Recorded measurements, not a pin. Each entry is asserted to exist and still say node:22. */
const EXEMPT = ['docs/benchmarks/data/issue-2080-oke-repro-2026-10-09/scripts/setup.yaml'];
const isExempt = (f: string): boolean => EXEMPT.includes(f);

/** The major of a Node version spec ("24", "24.x", "v24.1.0", ">=24", "24-alpine"); undefined if unreadable. */
export function majorOf(spec: unknown): number | undefined {
  if (typeof spec === 'number') return Number.isInteger(spec) ? spec : Math.trunc(spec);
  if (typeof spec !== 'string') return undefined;
  const m = spec.trim().match(/^(?:>=|\^|~)?\s*v?(\d+)(?:[.\-x*]|$)/);
  return m ? Number(m[1]) : undefined;
}

describe('majorOf (the parser the scan relies on)', () => {
  it('reads the supported spellings', () => {
    expect(majorOf('24')).toBe(24);
    expect(majorOf(24)).toBe(24);
    expect(majorOf('24.x')).toBe(24);
    expect(majorOf('v22.18.0')).toBe(22);
    expect(majorOf('>=22.18')).toBe(22);
    expect(majorOf('22-alpine')).toBe(22);
  });
  it('returns undefined for anything it cannot read', () => {
    for (const v of ['lts/*', 'lts', 'latest', '${{ matrix.node }}', '', 'node', undefined, null]) {
      expect(majorOf(v)).toBeUndefined();
    }
  });
});

describe('the exemption is real', () => {
  for (const f of EXEMPT) {
    it(`${f} exists, is tracked, and records Node 22`, () => {
      expect(tracked).toContain(f);
      expect(read(f)).toMatch(/node:22/);
    });
  }
});

describe('engines.node', () => {
  const manifests = tracked.filter((f) => basename(f) === 'package.json');

  it('scans a non-trivial number of manifests', () => {
    expect(manifests.length).toBeGreaterThan(5);
  });

  const withEngines = manifests
    .map((f) => ({
      f,
      json: JSON.parse(read(f)) as { private?: boolean; engines?: { node?: string } },
    }))
    .filter((m) => m.json.engines?.node !== undefined);

  it('finds the publishable packages declaring it', () => {
    const publishable = manifests
      .map((f) => ({
        f,
        json: JSON.parse(read(f)) as {
          private?: boolean;
          name?: string;
          engines?: { node?: string };
        },
      }))
      .filter(
        (m) =>
          m.json.private !== true && m.f.startsWith('packages/') && m.f.split('/').length === 3,
      );
    expect(publishable.length).toBeGreaterThanOrEqual(3);
    // Every publishable package a user installs carries the floor, not just core.
    const missing = publishable.filter(
      (m) => m.json.engines?.node === undefined && /kn-next|core/.test(m.f),
    );
    expect(missing.map((m) => m.f)).toEqual([]);
    expect(withEngines.map((m) => m.f)).toContain('packages/kn-next/package.json');
    expect(withEngines.map((m) => m.f)).toContain('packages/kn-next-alias/package.json');
  });

  for (const { f, json } of withEngines) {
    it(`${f} declares engines.node >=${FLOOR}`, () => {
      const range = json.engines?.node as string;
      expect(range, `${f}: unreadable engines.node ${JSON.stringify(range)}`).toMatch(/^>=\s*\d/);
      const major = majorOf(range);
      expect(major, `${f}: unreadable engines.node ${JSON.stringify(range)}`).toBeDefined();
      expect(major as number).toBeGreaterThanOrEqual(FLOOR);
    });
  }
});

describe('workflows', () => {
  const workflows = tracked.filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f));
  let setupNodeSteps = 0;

  it('scans the workflows', () => {
    expect(workflows.length).toBeGreaterThan(10);
  });

  for (const f of workflows) {
    const doc = parseYaml(read(f)) as {
      jobs?: Record<string, { steps?: unknown[]; strategy?: { matrix?: Record<string, unknown> } }>;
    };
    for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
      // Matrix keys that name a node version.
      for (const [key, values] of Object.entries(job?.strategy?.matrix ?? {})) {
        if (/^node/i.test(key) && Array.isArray(values)) {
          for (const v of values) {
            it(`${f} job ${jobName}: matrix.${key} entry ${JSON.stringify(v)} is >=${FLOOR}`, () => {
              const major = majorOf(v);
              expect(major, `unreadable matrix node version ${JSON.stringify(v)}`).toBeDefined();
              expect(major as number).toBeGreaterThanOrEqual(FLOOR);
            });
          }
        }
      }
      for (const step of (job?.steps ?? []) as Array<{
        uses?: string;
        with?: Record<string, unknown>;
      }>) {
        if (typeof step?.uses === 'string' && /^actions\/setup-node@/.test(step.uses)) {
          setupNodeSteps++;
          it(`${f} job ${jobName}: setup-node pins node-version >=${FLOOR}`, () => {
            const v = step.with?.['node-version'];
            expect(
              v,
              'a setup-node step with no node-version silently uses whatever the runner ships',
            ).toBeDefined();
            const major = majorOf(v);
            expect(major, `unreadable node-version ${JSON.stringify(v)}`).toBeDefined();
            expect(major as number).toBeGreaterThanOrEqual(FLOOR);
          });
        }
      }
    }
  }

  it('found setup-node steps (the scan is not vacuous)', () => {
    expect(setupNodeSteps).toBeGreaterThan(30);
  });
});

describe('version files', () => {
  const files = tracked.filter((f) =>
    /(^|\/)(\.nvmrc|\.node-version|\.tool-versions|mise\.toml)$/.test(f),
  );
  for (const f of files) {
    it(`${f} pins node >=${FLOOR}`, () => {
      const text = read(f);
      const line =
        basename(f) === '.nvmrc' || basename(f) === '.node-version'
          ? text.trim()
          : (text.match(/^\s*node\s*[= ]\s*["']?([^\s"']+)/m)?.[1] ?? '');
      const major = majorOf(line);
      expect(major, `${f}: unreadable ${JSON.stringify(line)}`).toBeDefined();
      expect(major as number).toBeGreaterThanOrEqual(FLOOR);
    });
  }
});

describe('base images', () => {
  const dockerfiles = tracked.filter(
    (f) => /(^|\/)Dockerfile[^/]*$|\.Dockerfile$/i.test(f) && !f.includes('__tests__'),
  );
  const FROM_RE = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i;
  const nodeRepo = (ref: string) =>
    /^(?:(?:docker\.io|index\.docker\.io)\/(?:library\/)?|library\/)?node(?::|@|$)/.test(ref);
  let nodeFroms = 0;

  for (const f of dockerfiles) {
    const stages = new Set<string>();
    read(f)
      .split('\n')
      .forEach((line, i) => {
        const m = line.match(FROM_RE);
        if (!m) return;
        const ref = m[1];
        const alias = line.match(/\bAS\s+(\S+)/i)?.[1];
        const isStage = stages.has(ref);
        if (alias) stages.add(alias);
        if (isStage || ref === 'scratch') return;
        if (ref.includes('$')) {
          it(`${f}:${i + 1} FROM ${ref} cannot be resolved statically`, () => {
            throw new Error(
              'a FROM that interpolates a variable cannot be proven to meet the Node floor',
            );
          });
          return;
        }
        if (!nodeRepo(ref)) return;
        nodeFroms++;
        it(`${f}:${i + 1} FROM ${ref.slice(0, 40)} is Node >=${FLOOR}`, () => {
          const tag = ref
            .replace(/^[^:@]*\/?node/, '')
            .replace(/^:/, '')
            .split('@')[0];
          const major = majorOf(tag);
          expect(major, `unreadable node tag in ${ref}`).toBeDefined();
          expect(major as number).toBeGreaterThanOrEqual(FLOOR);
        });
      });
  }

  it('found node base images (the scan is not vacuous)', () => {
    expect(nodeFroms).toBeGreaterThanOrEqual(6);
  });

  // `image: node:NN` in workflows, k8s manifests and the CI templates the CLI generates.
  const IMAGE_RE = /\bimage:\s*["']?(?:docker\.io\/(?:library\/)?)?node:([^\s"'@\\`]+)/;
  const imageFiles = tracked.filter(
    (f) =>
      !isExempt(f) &&
      !f.includes('__tests__') &&
      !f.startsWith('docs/') &&
      (/\.ya?ml$/.test(f) || /\.hbs$/.test(f) || /^packages\/kn-next\/src\/cli\/.+\.ts$/.test(f)),
  );
  let imageRefs = 0;
  for (const f of imageFiles) {
    read(f)
      .split('\n')
      .forEach((line, i) => {
        const m = line.match(IMAGE_RE);
        if (!m) return;
        imageRefs++;
        it(`${f}:${i + 1} image node:${m[1]} is Node >=${FLOOR}`, () => {
          const major = majorOf(m[1]);
          expect(major, `unreadable node tag ${m[1]}`).toBeDefined();
          expect(major as number).toBeGreaterThanOrEqual(FLOOR);
        });
      });
  }

  it('found `image: node:` references (the scan is not vacuous)', () => {
    expect(imageRefs).toBeGreaterThanOrEqual(5);
  });
});
