import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { workspaceGlobs as sharedWorkspaceGlobs } from '../scripts/lib/workspace-globs.mjs';

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
const ADR_0064_PATH = resolve(REPO_ROOT, 'docs/adr/0064-knext-platform-layer.md');
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
// Read through the shared helper rather than parsed here.
//
// Three guards make this same "a hardcoded list still matches the workspace"
// check, and each parsed the declaration its own way — so removing pnpm broke
// all three separately, and nothing stopped them disagreeing about what the
// workspace IS. The careful `overrides:`-vs-`packages:` distinction the old
// parser needed is gone with the YAML: `package.json`'s `workspaces` array
// contains globs and nothing else.
function workspaceGlobs(): string[] {
  return sharedWorkspaceGlobs();
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
 * The platform layer's CRD (`KnextPlatform`, its own API group) is a SECOND served
 * CRD. It is declared by ADR-0064's own anchor, so a further group added without a
 * declaration still reds this guard: the matrix describes the `NextApp` CRD the CLI
 * emits, and every other served group must be named somewhere that can be read.
 */
function declaredPlatformCrdApiVersion(): string {
  const adr = readFileSync(ADR_0064_PATH, 'utf8');
  const matches = [...adr.matchAll(/<!--\s*PLATFORM_CRD_API_VERSION:\s*(\S+)\s*-->/g)];
  expect(
    matches.length,
    `ADR-0064 must carry exactly ONE <!-- PLATFORM_CRD_API_VERSION: … --> anchor; found ${matches.length}`,
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

  it('the operator SERVES exactly the declared apiVersions (scanned from the CRD manifests)', () => {
    // The NextApp CRD the matrix rows describe, plus the platform layer's own CRD.
    const declared = [declaredCrdApiVersion(), declaredPlatformCrdApiVersion()].sort();
    const served = servedApiVersions();
    expect(served.length).toBeGreaterThan(0);
    expect(
      [...new Set(served)].sort(),
      'the matrix would be wrong the moment the operator served a different version, or an undeclared group',
    ).toEqual(declared);
    // The rows describe the NextApp CRD, which stays the one the CLI emits.
    expect(served).toContain(declaredCrdApiVersion());
  });

  it("the operator's Go API packages agree too", () => {
    const declared = [declaredCrdApiVersion(), declaredPlatformCrdApiVersion()].sort();
    const go = goGroupVersions();
    expect(go.length).toBeGreaterThan(0);
    expect([...new Set(go)].sort()).toEqual(declared);
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
/**
 * The support window and the runtime floors, stated in three places (the user-facing
 * page, the maintainer matrix, the policy) and checked against the source they
 * describe. The floors are never typed here: they are read from the core manifest,
 * and each doc carries them inside a marker block so a prose mention elsewhere
 * cannot satisfy the check.
 */
describe('support window and runtime floors agree across the docs and the manifest', () => {
  const page = readFileSync(DOCS_PAGE_PATH, 'utf8');
  const core = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'packages/kn-next/package.json'), 'utf8'),
  ) as { engines?: { node?: string }; peerDependencies?: { next?: string } };

  /** The text between exactly one pair of `runtime-floors` markers (mdx or html comments). */
  function floorsBlock(text: string, label: string): string {
    const starts = [...text.matchAll(/runtime-floors:start/g)];
    const ends = [...text.matchAll(/runtime-floors:end/g)];
    expect(starts.length, `${label}: exactly one runtime-floors:start marker`).toBe(1);
    expect(ends.length, `${label}: exactly one runtime-floors:end marker`).toBe(1);
    const s = starts[0].index as number;
    const e = ends[0].index as number;
    expect(e, `${label}: end marker after start`).toBeGreaterThan(s);
    return text.slice(s, e);
  }

  /** The backticked range that follows a "Node.js" / "Next.js" label inside the block. */
  function floor(block: string, label: 'Node.js' | 'Next.js'): string | undefined {
    return block.match(new RegExp(`${label}[^\\n\`]*\`([^\`]+)\``))?.[1];
  }

  for (const [label, path] of [
    ['versioning page', DOCS_PAGE_PATH],
    ['COMPATIBILITY.md', MATRIX_PATH],
  ] as const) {
    it(`${label} states the Node and Next floors the manifest declares`, () => {
      const block = floorsBlock(readFileSync(path, 'utf8'), label);
      expect(core.engines?.node, 'manifest declares engines.node').toBeTruthy();
      expect(core.peerDependencies?.next, 'manifest declares a next peer range').toBeTruthy();
      expect(floor(block, 'Node.js')).toBe(core.engines?.node);
      expect(floor(block, 'Next.js')).toBe(core.peerDependencies?.next);
    });
  }

  for (const [label, text] of [
    ['versioning page', page],
    ['COMPATIBILITY.md', matrix],
    ['RELEASE_POLICY.md', policy],
    ['SECURITY.md', readFileSync(resolve(REPO_ROOT, 'SECURITY.md'), 'utf8')],
  ] as const) {
    it(`${label} states the 1.x maintenance window: security only, six months, latest-1`, () => {
      const f = flat(text);
      expect(f).toContain('latest-1');
      // One claim, not two: "security-only" and "six months" must sit together, so a
      // doc that drops the qualifier cannot be rescued by a heading elsewhere.
      expect(f).toMatch(/(security fixes only|security-only)[\s\S]{0,80}six months/i);
    });
  }

  /** The body of one `## heading` section, so a Beta mention in a table row elsewhere cannot satisfy it. */
  function section(text: string, heading: string): string {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.trim() === heading);
    expect(start, `missing section "${heading}"`).toBeGreaterThan(-1);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^## /.test(l));
    return (end === -1 ? rest : rest.slice(0, end)).join('\n');
  }

  for (const [label, text] of [
    ['versioning page', section(page, '## Supported runtimes on 1.x')],
    ['COMPATIBILITY.md', section(matrix, '## Support window and runtime floors')],
  ] as const) {
    it(`${label} says the vinext / Bun single-executable target is Beta on 1.x`, () => {
      const f = flat(text);
      expect(f).toMatch(/vinext[^.]*Beta/i);
      expect(f).toMatch(/Bun[^.]*single-exec/i);
    });
  }

  it('the versioning page says what 2.0 changes, and marks it as not yet released', () => {
    const f = flat(page);
    const idx = f.indexOf('## What 2.0 changes');
    expect(idx, 'missing "## What 2.0 changes" section').toBeGreaterThan(-1);
    const section = f.slice(idx, idx + 2500);
    expect(section).toMatch(/not yet released|not released yet|has not shipped/i);
    expect(section).toMatch(/Node\.js/);
    expect(section).toMatch(/Next\.js/);
    expect(section).toMatch(/alias|second name/i);
    expect(section).toMatch(/operator/i);
  });

  it('all four anchor the window at 2.0 general availability', () => {
    for (const text of [
      page,
      matrix,
      policy,
      readFileSync(resolve(REPO_ROOT, 'SECURITY.md'), 'utf8'),
    ]) {
      expect(flat(text)).toMatch(/2\.0[^.]*generally available|2\.0 GA/);
    }
  });

  it('the operator pairing rule is by CRD API version, in both docs, and no longer by package major', () => {
    const crd = declaredCrdApiVersion();
    // The declared version must be what the operator's Go types register (not re-typed here).
    expect(goGroupVersions()).toContain(crd);
    const pageRule = flat(section(page, '### Operator versions'));
    const matrixRule = flat(section(matrix, '### Operator versions'));
    for (const [label, rule] of [
      ['versioning page', pageRule],
      ['COMPATIBILITY.md', matrixRule],
    ] as const) {
      expect(rule, `${label}: pairing rule names the CRD apiVersion`).toContain(crd);
      // Every apiVersion the rule names must be the declared one, so a single stale row cannot hide.
      const named = [...rule.matchAll(/apps\.kn-next\.dev\/v\w+/g)].map((m) => m[0]);
      expect(named.length, `${label}: pairing rule names the apiVersion`).toBeGreaterThan(0);
      for (const n of named) expect(n, `${label}`).toBe(crd);
      expect(rule, `${label}: still the "major must match" rule`).not.toMatch(
        /Different major|operator MAJOR must equal|Same major/i,
      );
    }
  });

  it('both docs say `knext doctor` checks the CRD-version pairing, and describe the operator-version row as informational', () => {
    // Doctor reads the served versions of the installed NextApp CRD and fails when the
    // apiVersion the CLI emits is not among them. The operator-version row is a secondary,
    // informational note: it never decides the pairing, and a differing major is no warning.
    for (const [label, text] of [
      ['versioning page', section(page, '### Operator versions')],
      ['COMPATIBILITY.md', section(matrix, '### Operator versions')],
    ] as const) {
      const f = flat(text);
      expect(f, `${label}: says doctor checks the CRD-version pairing`).toMatch(
        /doctor[^.]*(checks|reads|compares)[^.]*(served|CRD)[^.]*(API )?versions?/i,
      );
      expect(f, `${label}: says doctor fails when the emitted version is not served`).toMatch(
        /(fails|failing)[^.]*(not serve|does not serve|unserved)|(not serve|does not serve|unserved)[^.]*fail/i,
      );
      expect(f, `${label}: says the operator-version row is informational`).toMatch(
        /informational/i,
      );
      expect(f, `${label}: must no longer call doctor coarser than the rule`).not.toMatch(
        /coarser/i,
      );
      expect(f, `${label}: must no longer say doctor does not read CRD/API versions`).not.toMatch(
        /does not read[^.]*(API|CRD)[^.]*versions/i,
      );
    }
  });

  it('nothing says the operator major or MAJOR.MINOR tracks the package set (2.0 leaves the operator on its line)', () => {
    for (const [label, text] of [
      ['versioning page', page],
      ['COMPATIBILITY.md', matrix],
    ] as const) {
      expect(flat(text), label).not.toMatch(/MAJOR\.MINOR tracks|major and minor track/i);
    }
    expect(flat(page)).toMatch(/does not get a new major/);
  });

  it('the 2.0 section promises no announcement or prior deprecation that has not shipped', () => {
    const f = flat(page);
    const sec = f.slice(f.indexOf('## What 2.0 changes'), f.indexOf('## The cluster side'));
    expect(sec.length).toBeGreaterThan(200);
    expect(sec).not.toMatch(/announced in the changelog|deprecated in a 1\.x minor first/i);
  });
});
