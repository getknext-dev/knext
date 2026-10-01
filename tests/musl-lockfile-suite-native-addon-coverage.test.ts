import { describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CREDENTIAL_CELLS } from '../scripts/compat-window-audit.mjs';
import { extractDeclaredDeps, nativeReasons } from '../scripts/scan-suite-native-addons.mjs';

/**
 * #1759 — generalises the #1620 sharp-only guard to EVERY native addon the
 * pinned Next.js deploy-tests suite can put into a deployed fixture's runtime
 * tree. rc.3's bun-webpack credential night redded on
 * `turbopack-reports › should render page importing sqlite3` because the
 * fixture resolves sqlite3@5.1.7 while only sqlite3-5.0.2 had a committed musl
 * lockfile, and credential mode (correctly) refuses the non-reproducible
 * fallback. This guard makes that class red at PR time.
 *
 * Which addons the suite declares is a fact about the vercel/next.js tag plus
 * the npm registry, so it is recorded in
 * scripts/musl-native-lockfiles/suite-native-addons.json (re-derived on a Next
 * bump with scripts/scan-suite-native-addons.mjs, never in CI). Everything else
 * is checked against the real files: the credentialed ref, the lockfiles found
 * by the real lookup helper, their contents, the freeze list, git, and the real
 * credential-mode mount derivation that failed on the credential night.
 */
const REPO_ROOT = resolve(import.meta.dir, '..');
const LOCKFILES = resolve(REPO_ROOT, 'scripts/musl-native-lockfiles');
const LIB_SH = resolve(REPO_ROOT, 'scripts/lib/musl-lockfile-lookup.sh');
const REL = 'scripts/musl-native-lockfiles';

type Addon = { name: string; version: string; declaredBy: string; spec?: string; reason?: string };
const record = JSON.parse(readFileSync(join(LOCKFILES, 'suite-native-addons.json'), 'utf8')) as {
  nextVersion: string;
  runtimeAddons: Addon[];
  notRuntimeAddons: Addon[];
};
const sharpRecord = JSON.parse(
  readFileSync(join(LOCKFILES, 'next-sharp-resolution.json'), 'utf8'),
) as { nextVersion: string; sharp: string; libvips: string };
const credentialed = JSON.parse(
  readFileSync(resolve(REPO_ROOT, '.github/compat-credentialed-next-version.json'), 'utf8'),
) as { credentialedNextRef: string };

const key = (name: string) => name.replace(/^@/, '').replace(/\//g, '-');
const dirOf = (a: Addon) => `${key(a.name)}-${a.version}`;

function lookup(name: string, version: string): string {
  return execFileSync(
    'sh',
    ['-c', `. "${LIB_SH}"; pinned_lockfile_dir_for "$1" "$2"`, 'sh', name, version],
    { encoding: 'utf8', env: { ...process.env, LOCKFILES_DIR: LOCKFILES } },
  );
}

function bunCellMuslFiles(): string[][] {
  return CREDENTIAL_CELLS.filter((c) => c.runtime === 'bun' && c.workflowFile).map((c) =>
    c.extraFiles.filter((f: string) =>
      /^scripts\/musl-native-lockfiles\/[^/]+\/package(-lock)?\.json$/.test(f),
    ),
  );
}

describe('the suite native-addon record tracks the credentialed Next.js version (#1759)', () => {
  it('nextVersion is the credentialed NEXTJS_REF, and agrees with next-sharp-resolution.json', () => {
    expect(`v${record.nextVersion}`).toBe(credentialed.credentialedNextRef);
    expect(sharpRecord.nextVersion).toBe(record.nextVersion);
  });

  it("Next.js's own sharp + libvips are listed as runtime addons", () => {
    const specs = record.runtimeAddons.map((a) => `${a.name}@${a.version}`);
    expect(specs).toContain(`@img/sharp-linuxmusl-x64@${sharpRecord.sharp}`);
    expect(specs).toContain(`@img/sharp-libvips-linuxmusl-x64@${sharpRecord.libvips}`);
  });

  it('every scanned addon is classified exactly once, and every exclusion carries a reason', () => {
    const all = [...record.runtimeAddons, ...record.notRuntimeAddons].map(
      (a) => `${a.name}@${a.version}`,
    );
    expect(new Set(all).size).toBe(all.length);
    for (const a of record.notRuntimeAddons) {
      expect(a.reason?.length ?? 0, `${a.name}@${a.version} needs a reason`).toBeGreaterThan(20);
    }
    for (const a of [...record.runtimeAddons, ...record.notRuntimeAddons]) {
      expect(a.version, `${a.name}: exact version`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(a.declaredBy.length, `${a.name}: declaredBy`).toBeGreaterThan(0);
    }
  });
});

describe('every runtime native addon has a committed, frozen, exact musl lockfile (#1759)', () => {
  for (const a of record.runtimeAddons) {
    it(`${a.name}@${a.version}: committed lockfile pins exactly that version`, () => {
      const dir = lookup(a.name, a.version);
      expect(
        dir,
        `missing ${REL}/${dirOf(a)}/ — add it with scripts/generate-musl-native-lockfile.sh ${a.name} ${a.version}`,
      ).toBe(join(LOCKFILES, dirOf(a)));
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      // The two oldest sharp pins predate the exact-spec rule and declare a
      // caret; npm ci installs what the lockfile records, checked below.
      expect(Bun.semver.satisfies(a.version, String(pkg.dependencies?.[a.name]))).toBe(true);
      const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
      const entry = lock.packages?.[`node_modules/${a.name}`];
      expect(entry?.version).toBe(a.version);
      expect(String(entry?.integrity)).toStartWith('sha512-');
    });
  }

  it('every runtime addon lockfile pair is frozen for every bun credential cell and tracked by git', () => {
    const want = record.runtimeAddons.flatMap((a) => [
      `${REL}/${dirOf(a)}/package.json`,
      `${REL}/${dirOf(a)}/package-lock.json`,
    ]);
    const cells = bunCellMuslFiles();
    expect(cells.length).toBeGreaterThanOrEqual(2);
    for (const files of cells) for (const f of want) expect(files).toContain(f);
    const tracked = execFileSync('git', ['ls-files', '--', ...want], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .sort();
    expect(tracked).toEqual([...new Set(want)].sort());
  });

  it('the real credential-mode mount derivation accepts a tree resolving every runtime addon', () => {
    // The exact code path that failed on the credential night: a standalone
    // tree whose *.node owners are every runtime addon, run through
    // musl_lockfile_mounts with KNEXT_COMPAT_MODE=credential. A glibc sharp
    // stands in for the musl/libvips pair the walk maps it to.
    const root = mkdtempSync(join(tmpdir(), 'suite-native-addons-'));
    try {
      const plant = (dir: string, nodeFile: string, manifest: Record<string, unknown>) => {
        mkdirSync(join(dir, 'build'), { recursive: true });
        writeFileSync(join(dir, 'build', nodeFile), '');
        writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
      };
      // One fixture dir per addon keeps two versions of one name apart, as two
      // deployed fixtures would.
      for (const [i, a] of record.runtimeAddons.entries()) {
        if (a.name === '@img/sharp-libvips-linuxmusl-x64') continue; // reached via its sharp
        const fixture = join(root, `fixture-${i}`, 'node_modules');
        if (a.name !== '@img/sharp-linuxmusl-x64') {
          plant(join(fixture, a.name), 'addon.node', { name: a.name, version: a.version });
          continue;
        }
        // The traced tree holds the GLIBC sharp; its libvips pin is whatever
        // the committed musl sharp lockfile says sharp itself pins.
        const lock = JSON.parse(
          readFileSync(join(LOCKFILES, dirOf(a), 'package-lock.json'), 'utf8'),
        );
        const vips =
          lock.packages?.[`node_modules/${a.name}`]?.optionalDependencies?.[
            '@img/sharp-libvips-linuxmusl-x64'
          ];
        expect(vips, `${dirOf(a)} lockfile names its libvips`).toBeString();
        plant(join(fixture, '@img', 'sharp-linux-x64'), 'sharp-linux-x64.node', {
          name: '@img/sharp-linux-x64',
          version: a.version,
          optionalDependencies: { '@img/sharp-libvips-linux-x64': vips },
        });
      }
      const r = spawnSync(
        'sh',
        ['-c', `. "${LIB_SH}"; musl_lockfile_mounts "$1" "$2" /m`, 'sh', root, LOCKFILES],
        { encoding: 'utf8', env: { ...process.env, KNEXT_COMPAT_MODE: 'credential' } },
      );
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const mounted = new Set(
        r.stdout
          .trim()
          .split('\n')
          .map(
            (l) =>
              l
                .split(':')[0]
                .slice(LOCKFILES.length + 1)
                .split('/')[0],
          ),
      );
      for (const a of record.runtimeAddons) expect(mounted).toContain(dirOf(a));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('scripts/scan-suite-native-addons.mjs (the contributor-run re-derivation tool)', () => {
  it('extracts dependencies declared in test files and fixture package.json files, skipping node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'scan-suite-'));
    try {
      const t = join(root, 'test/e2e/app-dir/x');
      mkdirSync(t, { recursive: true });
      writeFileSync(
        join(t, 'x.test.ts'),
        "nextTestSetup({ files: __dirname, dependencies: { sqlite3: '5.1.7', 'left-pad': '1.3.0' } })",
      );
      mkdirSync(join(root, 'test/production/y'), { recursive: true });
      writeFileSync(
        join(root, 'test/production/y/package.json'),
        JSON.stringify({ dependencies: { bufferutil: '4.0.8' } }),
      );
      mkdirSync(join(root, 'test/e2e/node_modules/z'), { recursive: true });
      writeFileSync(
        join(root, 'test/e2e/node_modules/z/package.json'),
        JSON.stringify({ dependencies: { ignored: '1.0.0' } }),
      );
      const keys = [...extractDeclaredDeps(root).keys()].sort();
      expect(keys).toEqual(['bufferutil@4.0.8', 'left-pad@1.3.0', 'sqlite3@5.1.7']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags the native shapes the suite actually uses, and not a pure-JS package', () => {
    expect(
      nativeReasons({ scripts: { install: 'prebuild-install -r napi || node-gyp rebuild' } }),
    ).not.toEqual([]);
    expect(nativeReasons({ dependencies: { 'node-gyp-build': '^4' } })).not.toEqual([]);
    expect(
      nativeReasons({ optionalDependencies: { '@img/sharp-linux-x64': '0.35.5' } }),
    ).not.toEqual([]);
    expect(nativeReasons({ gypfile: true })).not.toEqual([]);
    expect(nativeReasons({ dependencies: { 'left-pad': '1' }, scripts: { test: 'x' } })).toEqual(
      [],
    );
  });
});
