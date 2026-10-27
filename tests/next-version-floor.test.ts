import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nextAdvisoriesFor } from '../packages/kn-next/src/next-advisories';
import { workspaceGlobs } from '../scripts/lib/workspace-globs.mjs';
import { REPO_ROOT, WORKSPACE_DIRS, workspaceManifests } from './helpers/workspace-manifests';

/**
 * The `next` version FLOOR across the workspace (#579).
 *
 * `next@16.2.10` shipped with 4 HIGH advisories — CVE-2026-64641 (GHSA-m99w-x7hq-7vfj),
 * CVE-2026-64642 (GHSA-6gpp-xcg3-4w24), CVE-2026-64645 (GHSA-p9j2-gv94-2wf4) and
 * CVE-2026-64649 (GHSA-89xv-2m56-2m9x) — plus 5 MODERATE, all fixed in 16.2.11.
 * Remediation discipline for this repo is BUMP, never suppress (#155/#199/#319/#320/#465).
 *
 * #2594 raised the floor to 16.4.1: GHSA-2464-fhr4-w9xw (critical, RCE in the
 * Image Optimization API with SVG), GHSA-673q-mjm6-r5xr (critical, RCE in
 * `'use cache'` functions returning typed arrays) and GHSA-p3m5-59mp-jv5r (high,
 * Server Actions DoS) affect every 16.x through 16.4.0; no 16.3.x patch exists.
 * The same PR added the REPO-WIDE scan at the bottom of this file: the workspace
 * scan above never saw the scaffold templates, the standalone e2e fixtures with
 * their own `bun.lock`, or the demo apps outside the workspace globs, and those
 * are exactly what users get and what knext deploys.
 *
 * This guard locks the floor so a later `pnpm update`, a new app, or a copy-pasted
 * pin cannot silently walk the tree back under a fixed version. It SCANS the
 * workspace globs rather than enumerating packages — an enumerated list is how the
 * second manifest gets missed, and this repo has hit that twice.
 *
 * Two deliberate exclusions, stated rather than left to be rediscovered:
 *
 *   - `peerDependencies`. `@getknext/core` declares `next: ">=16.0.0 <16.5.0"` on purpose:
 *     it is a compatibility statement about what the adapter supports, not a
 *     statement about what we install. Raising it would drop support for every
 *     16.0/16.1 consumer over a CVE in *their* tree, which they fix by upgrading
 *     `next`, not by upgrading knext.
 *   - `NEXTJS_REF` in `.github/workflows/test-e2e-deploy.yml`. That is a different
 *     knob — it is the vercel/next.js git TAG the compat suite is checked out at
 *     (and, via `NEXT_NPM_VERSION="${NEXTJS_REF#v}"`, the prebuilt `next` the
 *     fixtures install). It is inside the compat-window frozen set (ADR-0039), so
 *     moving it is a lead decision about what "green" means, not a security bump.
 */

/**
 * The lowest `next` version any workspace manifest may admit.
 *
 * A FLOOR, deliberately — this asserts `>=`, not equality, because its subject
 * is a CVE, not a pin. `template-next-pin.test.ts` (#643) is the one that
 * asserts equality, and it derives its expectation from the workspace rather
 * than from this constant for exactly that reason: a tree sitting at the floor
 * while the workspace has moved on satisfies this and is still drift.
 */
const FLOOR: [number, number, number] = [16, 4, 1];

type Version = [number, number, number];

/** Lowest version a `1.2.3`, `^1.2.3` or `>=1.2.3` style range admits. */
function floorOf(range: string): Version {
  const m = range.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`next range "${range}" has no X.Y.Z floor to check`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function gte(a: Version, b: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

describe('#579/#2594 — the workspace `next` floor is 16.4.1', () => {
  it('scans the same workspace globs the repo declares', () => {
    // Read through the shared helper, not by re-parsing the declaration here.
    // Three guards make this same "hardcoded list still matches the workspace"
    // check, and each parsed `pnpm-workspace.yaml` its own way — so removing
    // pnpm broke all three separately, and nothing stopped them disagreeing
    // about what the workspace IS.
    expect(workspaceGlobs().sort()).toEqual(WORKSPACE_DIRS.map((d) => `${d}/*`).sort());
  });

  it('finds at least one workspace member depending on next', () => {
    const withNext = workspaceManifests().filter(
      ({ pkg }) =>
        (pkg.dependencies as Record<string, string> | undefined)?.next ??
        (pkg.devDependencies as Record<string, string> | undefined)?.next,
    );
    // A guard that matches nothing is a guard over nothing.
    expect(withNext.length).toBeGreaterThan(0);
  });

  it.each(
    workspaceManifests().flatMap(({ path, pkg }) =>
      (['dependencies', 'devDependencies'] as const).flatMap((field) => {
        const range = (pkg[field] as Record<string, string> | undefined)?.next;
        return range ? [{ path, field, range }] : [];
      }),
    ),
  )('$path ($field) pins next >= 16.4.1 — got $range', ({ range }) => {
    expect(gte(floorOf(range), FLOOR)).toBe(true);
  });

  it('resolves no next below 16.4.1 anywhere in the root lockfile', () => {
    // `bun.lock` since the repo left pnpm. The scan is unchanged because both
    // formats spell a resolved dependency the same way — `name@x.y.z` — so this
    // guard's subject (no `next` below the floor resolves ANYWHERE) survives the
    // format change intact.
    const lock = readFileSync(resolve(REPO_ROOT, 'bun.lock'), 'utf8');
    const resolved = [...new Set([...lock.matchAll(/\bnext@(\d+\.\d+\.\d+)\b/g)].map((m) => m[1]))];
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.filter((v) => !gte(floorOf(v), FLOOR))).toEqual([]);
  });
});

/**
 * Every tracked manifest and lockfile outside the workspace globs, too (#2594).
 *
 * DISCOVERED from `git ls-files`, never enumerated: the scaffold templates
 * (`package.json.hbs`, `package.json.vinext.hbs`), the e2e fixtures that carry
 * their own `bun.lock`, the examples and the demo apps. The verdict comes from
 * `next-advisories.ts` — the same table `knext doctor` FAILs on — so a 15.x
 * demo pinned to the 15.x backport passes and a 16.3.x pin does not.
 *
 * HARNESS_PINS is the only way out, and each entry says why. These are
 * test-harness pins that reproduce a bug or freeze evidence at one exact
 * version; they are never built into anything a user runs or knext deploys.
 */
const HARNESS_PINS: Record<string, string> = {
  'test/bun-sandbox-fetch-ab/fixture/package.json':
    'A/B reproduction of a Bun sandbox-fetch bug, pinned to the exact Next.js it was measured on; run only by its own manual workflow, never deployed.',
  'docs/wayfinder/spike-vinext-image-intercept/fixture-app/package.json':
    'Frozen evidence for a finished spike under docs/; never installed or deployed by any workflow.',
};

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
}

/** Exact `next` pins in a manifest: every dependency field, `X.Y.Z`-anchored. */
function manifestNextPins(text: string): string[] {
  const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
  return (['dependencies', 'devDependencies', 'optionalDependencies'] as const)
    .map((field) => pkg[field]?.next)
    .filter((r): r is string => typeof r === 'string' && /\d+\.\d+\.\d+/.test(r))
    .map((r) => (r.match(/(\d+\.\d+\.\d+)/) as RegExpMatchArray)[1]);
}

describe('#2594 — no tracked manifest or lockfile pins a next with a known advisory', () => {
  const files = trackedFiles();
  const manifests = files.filter((f) => /(^|\/)package\.json(\.[a-z]+)*(\.hbs)?$/.test(f));
  const lockfiles = files.filter((f) => /(^|\/)bun\.lock$/.test(f));

  it('the harness exclusions still exist and each carries a reason', () => {
    for (const [path, reason] of Object.entries(HARNESS_PINS)) {
      expect(files, `${path} is no longer tracked; drop it from HARNESS_PINS`).toContain(path);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('the scan reaches the scaffold templates and the fixture lockfiles', () => {
    // An over-narrowed filter would pass vacuously; pin the floor of what it must see.
    for (const known of [
      'packages/kn-next/templates/app/package.json.hbs',
      'packages/kn-next/templates/app/package.json.vinext.hbs',
      'turbo/generators/templates/zone/package.json.hbs',
      'apps/file-manager/package.json',
    ]) {
      expect(manifests).toContain(known);
    }
    expect(lockfiles).toContain('bun.lock');
    expect(lockfiles.length).toBeGreaterThan(1);
  });

  it('every pinned manifest is clear of the advisories knext doctor fails on', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const path of manifests) {
      if (path in HARNESS_PINS) continue;
      for (const v of manifestNextPins(readFileSync(resolve(REPO_ROOT, path), 'utf8'))) {
        checked++;
        const hits = nextAdvisoriesFor(v).map((h) => h.id);
        if (hits.length) bad.push(`${path}: next ${v} (${hits.join(', ')})`);
      }
    }
    expect(checked).toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });

  it('every tracked bun.lock resolves only advisory-free next versions', () => {
    const bad: string[] = [];
    let resolvedAny = 0;
    for (const path of lockfiles) {
      const lock = readFileSync(resolve(REPO_ROOT, path), 'utf8');
      for (const v of new Set([...lock.matchAll(/"next@(\d+\.\d+\.\d+)"/g)].map((m) => m[1]))) {
        resolvedAny++;
        const hits = nextAdvisoriesFor(v).map((h) => h.id);
        if (hits.length) bad.push(`${path}: next@${v} (${hits.join(', ')})`);
      }
    }
    expect(resolvedAny).toBeGreaterThan(1);
    expect(bad).toEqual([]);
  });
});

/**
 * Workflows install, `npm pkg set` and assert `next` versions too (#2594 round 2).
 *
 * The kind e2e jobs stage a fixture, force its `next` with
 * `npm pkg set "dependencies.next=${NEXT_VERSION}"` and deploy it; the JS-closure
 * Trivy job pins `dependencies.next=X` before scanning. After the first round
 * bumped every manifest, three such workflow pins still put 16.3.8 back on main
 * (and 16.4.0 on v2), and v2's quoted `v !== '16.4.0'` assertions went red the
 * other way. So every NON-COMMENT workflow line is scanned for the four shapes
 * a literal `next` version takes there:
 *
 *   - `next@X.Y.Z`              (an install spec; `kn-next@`/`@next/` excluded)
 *   - `next=X.Y.Z`              (`npm pkg set dependencies.next=X`)
 *   - `NEXT_VERSION: X.Y.Z`     (the env the kind jobs install from)
 *   - a quoted `'X.Y.Z'` / `"X.Y.Z"` on a line that mentions `next`
 *     (a version assertion against `node_modules/next/package.json`)
 *
 * and each hit is judged by `next-advisories.ts`, the table doctor fails on.
 * Comment lines are history (`# previously pinned to next@16.0.3`), not pins.
 *
 * WORKFLOW_HARNESS_PINS excuses a hit only by file AND exact version AND reason.
 * The compat-suite credential harness (`NEXTJS_REF`, `credentialedNextRef`, the
 * quarantine ledgers) is tracked separately in #2602; its refs are written
 * `vX.Y.Z`, which none of the four shapes match, so it needs no entry today.
 * An entry here must name a version actually present, so a stale excuse reds.
 */
const WORKFLOW_HARNESS_PINS: { file: string; version: string; reason: string }[] = [];

type WorkflowPin = { file: string; line: number; version: string; text: string };

function workflowNextPins(file: string, text: string): WorkflowPin[] {
  const pins: WorkflowPin[] = [];
  text.split('\n').forEach((raw, i) => {
    if (/^\s*#/.test(raw)) return;
    const found = new Set<string>();
    for (const m of raw.matchAll(/(?<![\w@/-])next@(\d+\.\d+\.\d+)/g)) found.add(m[1]);
    for (const m of raw.matchAll(/(?<![\w-])next=(\d+\.\d+\.\d+)/g)) found.add(m[1]);
    for (const m of raw.matchAll(/\bNEXT_VERSION:\s*['"]?(\d+\.\d+\.\d+)/g)) found.add(m[1]);
    if (/(?<![a-z])next(?![a-z])/i.test(raw)) {
      for (const m of raw.matchAll(/(['"])(\d+\.\d+\.\d+)\1/g)) found.add(m[2]);
    }
    for (const version of found) pins.push({ file, line: i + 1, version, text: raw.trim() });
  });
  return pins;
}

describe('#2594 — no workflow pins, sets or asserts a next with a known advisory', () => {
  const workflows = trackedFiles().filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
  const pins = workflows.flatMap((f) =>
    workflowNextPins(f, readFileSync(resolve(REPO_ROOT, f), 'utf8')),
  );

  it('recognises every shape it claims to (self-test)', () => {
    const sample = [
      '      NEXT_VERSION: 16.4.0',
      '          npm pkg set "dependencies.next=16.3.8"',
      '          bun add next@16.2.10',
      "          node -e \"const v=require('./node_modules/next/package.json').version; if (v !== '16.4.0') {}\"",
      '          # previously pinned to next@16.0.3',
      '          npx kn-next@0.4.3 deploy',
      '          bun add @next/env@16.0.0',
      "          VINEXT_VERSION: '1.0.1'",
    ].join('\n');
    expect(workflowNextPins('x.yml', sample).map((p) => `${p.line}:${p.version}`)).toEqual([
      '1:16.4.0',
      '2:16.3.8',
      '3:16.2.10',
      '4:16.4.0',
    ]);
  });

  it('the scan reaches the kind e2e jobs that stage and deploy a fixture', () => {
    expect(workflows).toContain('.github/workflows/standalone-deploy-kind-e2e.yml');
    expect(workflows).toContain('.github/workflows/supply-chain.yml');
    expect(pins.length).toBeGreaterThan(0);
  });

  it('every harness exclusion names a version the scan still finds, with a reason', () => {
    for (const ex of WORKFLOW_HARNESS_PINS) {
      expect(ex.reason.length).toBeGreaterThan(20);
      expect(
        pins.some((p) => p.file === ex.file && p.version === ex.version),
        `${ex.file} no longer carries next ${ex.version}; drop the exclusion`,
      ).toBe(true);
    }
  });

  it('every non-excluded workflow pin is clear of the advisories knext doctor fails on', () => {
    const bad = pins
      .filter(
        (p) => !WORKFLOW_HARNESS_PINS.some((ex) => ex.file === p.file && ex.version === p.version),
      )
      .flatMap((p) => {
        const hits = nextAdvisoriesFor(p.version).map((h) => h.id);
        return hits.length
          ? [`${p.file}:${p.line}: next ${p.version} (${hits.join(', ')}) — ${p.text}`]
          : [];
      });
    expect(bad).toEqual([]);
  });
});
