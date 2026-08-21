import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD TEST for the release/support policy and the compatibility matrix (#314).
 *
 * #53 owns the publish mechanics (npm auth, the first publish). This file owns the
 * OPERABILITY wrapper: the rules that make a published version mean something, and
 * the matrix a user reads before pinning one. A policy nobody enforces decays, so
 * every claim the policy makes that CAN be checked mechanically is checked here.
 *
 * Three things are asserted, and each has a failure mode this repo has already hit:
 *
 *  1. **The release set is exactly three packages, discovered by SCANNING the
 *     workspace** — never by reading a list. `@getknext/core` depends on both
 *     `@getknext/lib` and `@getknext/db`, so a partial publish 404s every consumer
 *     install (the #255/#256 incident). A newly-added public package would join the
 *     publish set silently; scanning is what makes a fourth member impossible to
 *     miss. The scan asserts its own denominator too — a scan that finds nothing
 *     passes vacuously, which is the other half of the same hole.
 *
 *  2. **The three carry ONE version, and Changesets is configured to keep it that
 *     way** (`fixed`). The versions had already drifted (core 0.3.0, db 0.2.1, lib
 *     0.2.0) despite `packages/db/CHANGELOG.md` promising "all three bump together
 *     and ship as a set" — documented intent, unenforced, decayed. `fixed` is the
 *     mechanism; this test is the proof the mechanism is wired.
 *
 *  3. **The matrix agrees with the code it describes.** The CRD `apiVersion` cell is
 *     compared against the ADR anchor (never re-typed here) AND against what the
 *     operator actually SERVES, scanned out of the CRD manifest and the Go group
 *     version. A matrix that merely agrees with itself is decoration.
 *
 * Mutation-proved (see the PR): drift a version, un-private a package, drop the
 * `fixed` group, or change the served CRD version, and this suite goes red.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

const POLICY_PATH = resolve(REPO_ROOT, 'docs/RELEASE_POLICY.md');
const MATRIX_PATH = resolve(REPO_ROOT, 'docs/COMPATIBILITY.md');
const CHANGESET_CONFIG_PATH = resolve(REPO_ROOT, '.changeset/config.json');
const ADR_0017_PATH = resolve(
  REPO_ROOT,
  'docs/adr/0017-crd-stays-v1alpha1-conversion-webhook-deferred.md',
);
const CRD_BASES_DIR = resolve(REPO_ROOT, 'packages/kn-next-operator/config/crd/bases');
const OPERATOR_API_DIR = resolve(REPO_ROOT, 'packages/kn-next-operator/api');
const DOCS_PAGE_PATH = resolve(REPO_ROOT, 'apps/docs/content/docs/versioning.mdx');
const DOCS_META_PATH = resolve(REPO_ROOT, 'apps/docs/content/docs/meta.json');

/**
 * THE POLICY, stated as an assertion. These three ship as a set; nothing else in
 * the workspace may reach the public registry. Reality is discovered by scanning
 * (below) and compared against this — so adding a fourth publishable package fails
 * here rather than surprising a consumer.
 */
const RELEASE_SET = ['@getknext/core', '@getknext/db', '@getknext/lib', 'kn-next'];

/** The canonical upgrade-order wording, shared with tests/upgrade-order-docs.test.ts. */
const ORDER_RULE = 'operator/CRD first, then CLI';

type Manifest = {
  name?: string;
  version?: string;
  private?: boolean;
  publishConfig?: { access?: string; provenance?: boolean };
};

type WorkspacePackage = { dir: string; manifest: Manifest };

/**
 * The workspace globs, read from the `packages:` block of pnpm-workspace.yaml.
 *
 * Scoped to that ONE key deliberately. Matching every YAML list item in the file
 * looks equivalent today and is a landmine: `pnpm approve-builds` writes an
 * `onlyBuiltDependencies:` stanza (pnpm 10 does this routinely, and this repo is on
 * pnpm@10.4.1), whose items are package NAMES. Those would be read as globs and the
 * scan would abort with `unsupported workspace glob "esbuild"` — CI red, on a
 * message pointing at the wrong thing entirely.
 */
function workspaceGlobs(): string[] {
  const lines = readFileSync(resolve(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8').split('\n');
  const start = lines.findIndex((l) => /^packages:\s*$/.test(l));
  if (start === -1) throw new Error('pnpm-workspace.yaml has no top-level `packages:` key');
  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // A new top-level key ends the block; blanks and comments do not.
    if (/^\S/.test(line)) break;
    const item = line.match(/^\s+-\s*['"]?([^'"#\n]+?)['"]?\s*$/);
    if (item) globs.push(item[1].trim());
  }
  return globs;
}

/**
 * Every workspace package, found by expanding the globs — NOT by listing paths.
 * Only the `<dir>/*` shape is supported, which is all the workspace uses; anything
 * else must fail loudly rather than silently shrink the scan.
 */
function workspacePackages(): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  for (const glob of workspaceGlobs()) {
    const [parent, star, ...rest] = glob.split('/');
    if (star !== '*' || rest.length > 0) {
      throw new Error(
        `unsupported workspace glob ${JSON.stringify(glob)} — this scan only expands "<dir>/*", so it would silently miss packages`,
      );
    }
    const parentDir = resolve(REPO_ROOT, parent);
    for (const entry of readdirSync(parentDir)) {
      const dir = join(parentDir, entry);
      if (!statSync(dir).isDirectory()) continue;
      let raw: string;
      try {
        raw = readFileSync(join(dir, 'package.json'), 'utf8');
      } catch {
        continue; // a directory without a manifest is not a workspace package
      }
      out.push({ dir: relative(REPO_ROOT, dir), manifest: JSON.parse(raw) as Manifest });
    }
  }
  return out;
}

const PACKAGES = workspacePackages();

/** Publishable = anything Changesets/npm would push: not `private`. */
const publishable = PACKAGES.filter((p) => p.manifest.private !== true);

const changesetConfig = JSON.parse(readFileSync(CHANGESET_CONFIG_PATH, 'utf8')) as {
  ignore?: string[];
  fixed?: string[][];
  linked?: string[][];
};

const policy = readFileSync(POLICY_PATH, 'utf8');
const matrix = readFileSync(MATRIX_PATH, 'utf8');

/** Collapse whitespace so a Markdown line wrap cannot hide a required phrase. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * The DATA rows of the table under `## The matrix`, as arrays of trimmed cells.
 *
 * Scoped to that one section on purpose: `COMPATIBILITY.md` has other tables (the
 * three-axes table), and a check that swept them all would either be vague or would
 * break every time an unrelated table gained a row.
 */
function matrixTableRows(md: string): string[][] {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^##\s+The matrix\s*$/.test(l));
  if (start === -1) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    // Skip the header row and the `| --- |` separator.
    if (cells.every((c) => /^-{2,}$/.test(c.replace(/[\s:]/g, '')))) continue;
    if (cells[0] === 'Package set') continue;
    rows.push(cells);
  }
  return rows;
}

/**
 * The version each matrix ROW is keyed by — the leading cell of a Markdown table
 * row, and only when that cell is a bare backticked version.
 *
 * Deliberately not a substring search over the whole document: a `toContain` on the
 * version string was the first shape of this check, and the mutation proof caught
 * it going green with the row deleted, because `0.3.0` also occurs inside
 * `@getknext/core@0.3.0` further down the same table. A row key must be a row key.
 */
function matrixRowVersions(md: string): string[] {
  const out: string[] = [];
  for (const row of matrixTableRows(md)) {
    for (const m of (row[0] ?? '').matchAll(/`(\d+\.\d+\.\d+(?:-[\w.]+)?)`/g)) out.push(m[1]);
  }
  return out;
}

function headingSlugs(md: string): string[] {
  return md
    .split('\n')
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => slug(l.replace(/^#{1,6}\s+/, '')));
}

/** The single machine-readable CRD-version declaration in ADR-0017. */
function declaredCrdApiVersion(): string {
  const adr = readFileSync(ADR_0017_PATH, 'utf8');
  const matches = [...adr.matchAll(/<!--\s*CRD_API_VERSION:\s*(\S+)\s*-->/g)];
  expect(
    matches.length,
    `ADR-0017 must carry exactly ONE <!-- CRD_API_VERSION: … --> anchor; found ${matches.length}`,
  ).toBe(1);
  return matches[0][1];
}

/**
 * Every `group/version` the operator's CRD manifests actually serve, scanned out of
 * the generated bases (all of them — a second CRD file must be swept in, not
 * ignored). `name:` at indent 4 is a `spec.versions[]` entry; printer-column names
 * sit at indent 6, so they are not matched.
 */
function servedApiVersions(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(CRD_BASES_DIR)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const text = readFileSync(join(CRD_BASES_DIR, file), 'utf8');
    const group = text.match(/^ {2}group:\s*(\S+)$/m)?.[1];
    expect(group, `${file} declares no spec.group`).toBeTruthy();
    const versions = [...text.matchAll(/^ {4}name:\s*(v\d+(?:alpha|beta)?\d*)\s*$/gm)].map(
      (m) => m[1],
    );
    expect(versions.length, `${file} declares no spec.versions[].name`).toBeGreaterThan(0);
    for (const v of versions) out.push(`${group}/${v}`);
  }
  return out;
}

/** Every `GroupVersion` literal in the operator's Go API packages. */
function goGroupVersions(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith('.go')) {
        const text = readFileSync(full, 'utf8');
        for (const m of text.matchAll(
          /schema\.GroupVersion\{\s*Group:\s*"([^"]+)",\s*Version:\s*"([^"]+)"/g,
        )) {
          out.push(`${m[1]}/${m[2]}`);
        }
      }
    }
  };
  walk(OPERATOR_API_DIR);
  return out;
}

describe('release set — discovered by scanning the workspace (#314)', () => {
  it('the scan sees the whole workspace (a vacuous scan proves nothing)', () => {
    // Both halves: the assertions below are only meaningful if this found packages.
    expect(PACKAGES.length).toBeGreaterThanOrEqual(8);
    expect(PACKAGES.map((p) => p.manifest.name)).toContain('@getknext/ui');
  });

  it('exactly the four policy packages are publishable — a fifth fails here', () => {
    const found = publishable.map((p) => p.manifest.name).sort();
    expect(
      found,
      'every non-released workspace package must be `"private": true`; a new public one joins the publish set silently otherwise',
    ).toEqual([...RELEASE_SET].sort());
  });

  it('each released package publishes publicly, with provenance', () => {
    for (const pkg of publishable) {
      expect(pkg.manifest.publishConfig?.access, `${pkg.manifest.name}`).toBe('public');
      expect(pkg.manifest.publishConfig?.provenance, `${pkg.manifest.name}`).toBe(true);
    }
  });

  it('Changesets ignores no released package, and ignores only real packages', () => {
    const ignore = changesetConfig.ignore ?? [];
    for (const name of RELEASE_SET) expect(ignore).not.toContain(name);
    const known = new Set(PACKAGES.map((p) => p.manifest.name));
    for (const name of ignore) {
      expect(known, `.changeset/config.json ignores unknown package ${name}`).toContain(name);
    }
  });
});

describe('the release set ships as ONE version (lockstep)', () => {
  it('all three manifests carry the same semver version', () => {
    const versions = Object.fromEntries(
      publishable.map((p) => [p.manifest.name, p.manifest.version]),
    );
    const distinct = [...new Set(Object.values(versions))];
    expect(
      distinct,
      `the three ship as a set, so they carry one version — found ${JSON.stringify(versions)}`,
    ).toHaveLength(1);
    expect(distinct[0]).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  });

  it('Changesets is configured to KEEP them in lockstep (a `fixed` group)', () => {
    const groups = changesetConfig.fixed ?? [];
    const matching = groups.filter(
      (g) => RELEASE_SET.every((n) => g.includes(n)) && g.length === RELEASE_SET.length,
    );
    expect(
      matching,
      'without a `fixed` group in .changeset/config.json the versions drift again on the next release',
    ).toHaveLength(1);
  });
});

describe('docs/RELEASE_POLICY.md — cadence, support window, deprecation', () => {
  it('covers each of the three policy areas as its own section', () => {
    const slugs = headingSlugs(policy);
    for (const required of ['release-cadence', 'support-window', 'deprecation']) {
      expect(
        slugs.some((s) => s.includes(required)),
        `missing section: ${required}`,
      ).toBe(true);
    }
  });

  it('states the ship-as-a-set rule and names all three packages', () => {
    for (const name of RELEASE_SET) expect(policy).toContain(name);
    expect(flat(policy)).toMatch(/ship (as|together)|as a set/i);
  });

  it('does not promise more CRD stability than v1alpha1 can keep', () => {
    // ADR-0017 §2.1: additive-only within v1alpha1, and a semantic change to an
    // existing field is permitted when announced in the release notes.
    expect(flat(policy)).toContain('additive-only');
    expect(flat(policy)).toMatch(/release notes/i);
  });

  it('names the matrix it governs, and who updates it when', () => {
    expect(policy).toContain('docs/COMPATIBILITY.md');
    expect(flat(policy)).toMatch(/version packages/i);
  });
});

describe('docs/COMPATIBILITY.md — the matrix agrees with the code', () => {
  it('lists every released package', () => {
    for (const name of RELEASE_SET) expect(matrix).toContain(name);
  });

  /**
   * EVERY row's apiVersion cell, not a whole-file substring.
   *
   * The first shape of this check was `expect(matrix).toContain(declared)`, which
   * the reviewer mutation-proved as decoration: `apps.kn-next.dev/v1alpha1` occurs
   * in both rows, so falsifying EITHER cell left the assertion green. Exactly the
   * defect already fixed one column to the left, in `matrixRowVersions`.
   */
  it('every matrix row names the CRD apiVersion the ADR declares', () => {
    const declared = declaredCrdApiVersion();
    const rows = matrixTableRows(matrix);
    // Both halves: a parser that finds no rows would pass the loop vacuously.
    expect(
      rows.length,
      'no data rows parsed out of the `## The matrix` table',
    ).toBeGreaterThanOrEqual(2);
    const cells = rows.map((r) => r[1]);
    expect(
      cells,
      'each row states the CRD apiVersion it is compatible with; all must be the declared one',
    ).toEqual(rows.map(() => `\`${declared}\``));
  });

  it('the operator SERVES exactly that apiVersion (scanned from the CRD manifests)', () => {
    const declared = declaredCrdApiVersion();
    const served = servedApiVersions();
    expect(served.length).toBeGreaterThan(0);
    expect(
      [...new Set(served)],
      'the matrix would be wrong the moment the operator served a different version',
    ).toEqual([declared]);
  });

  it("the operator's Go API package agrees too", () => {
    const declared = declaredCrdApiVersion();
    const go = goGroupVersions();
    expect(go.length).toBeGreaterThan(0);
    expect([...new Set(go)]).toEqual([declared]);
  });

  it('carries a row for the version currently in the tree', () => {
    const current = publishable[0]?.manifest.version;
    expect(current).toBeTruthy();
    const rows = matrixRowVersions(matrix);
    expect(
      rows.length,
      'docs/COMPATIBILITY.md has no version-keyed table rows at all',
    ).toBeGreaterThan(0);
    expect(
      rows,
      `add the ${current} row to docs/COMPATIBILITY.md — the matrix is updated in the "version packages" PR`,
    ).toContain(current as string);
  });

  it('does not contradict the upgrade order', () => {
    expect(flat(matrix)).toContain(ORDER_RULE);
  });
});

describe('the user-facing versioning page exists and is reachable', () => {
  it('is published on the docs site', () => {
    const page = readFileSync(DOCS_PAGE_PATH, 'utf8');
    expect(page).toMatch(/^---/);
    for (const name of RELEASE_SET) expect(page).toContain(name);
  });

  it('is listed in the docs navigation (an unlinked page is not documentation)', () => {
    const meta = JSON.parse(readFileSync(DOCS_META_PATH, 'utf8')) as { pages: string[] };
    expect(meta.pages).toContain('versioning');
  });
});
