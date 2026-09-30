import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CREDENTIAL_CELLS } from '../scripts/compat-window-audit.mjs';

/**
 * #1620 — the Next.js version pinned for the compat credential must resolve to
 * a sharp that has a COMMITTED, FROZEN musl lockfile (plus the libvips that
 * sharp pins). The rc.2 bun credential cells went 16/16 red because the
 * re-credential to Next 16.3.5 moved sharp to 0.35.5 while only the 0.34.5 /
 * libvips 1.2.4 lockfiles existed, and credential mode refuses the
 * non-reproducible fallback install. This guard makes the next Next bump red
 * at PR time instead of on the first bun credential night.
 *
 * The Next→sharp mapping lives in scripts/musl-native-lockfiles/
 * next-sharp-resolution.json (Next pins sharp only as a range, so which
 * version the harness installs is a registry fact, not derivable offline).
 * Every other link is checked against the real files: the credentialed Next
 * ref, the range bun.lock records for that Next, the lockfiles on disk (found
 * with the real lookup helper), their contents, the freeze list and git.
 */
const REPO_ROOT = resolve(import.meta.dir, '..');
const LOCKFILES = resolve(REPO_ROOT, 'scripts/musl-native-lockfiles');
const LIB_SH = resolve(REPO_ROOT, 'scripts/lib/musl-lockfile-lookup.sh');
const REL = 'scripts/musl-native-lockfiles';

const record = JSON.parse(readFileSync(join(LOCKFILES, 'next-sharp-resolution.json'), 'utf8'));
const credentialed = JSON.parse(
  readFileSync(resolve(REPO_ROOT, '.github/compat-credentialed-next-version.json'), 'utf8'),
);
const workflow = readFileSync(resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml'), 'utf8');

function lookup(name: string, version: string): string {
  return execFileSync(
    'sh',
    ['-c', `. "${LIB_SH}"; pinned_lockfile_dir_for "$1" "$2"`, 'sh', name, version],
    { encoding: 'utf8', env: { ...process.env, LOCKFILES_DIR: LOCKFILES } },
  );
}

function lockVersion(
  dir: string,
  name: string,
): { version: string; optional: Record<string, string> } {
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  const entry = lock.packages?.[`node_modules/${name}`];
  expect(entry, `${dir}/package-lock.json has no node_modules/${name} entry`).toBeDefined();
  return { version: entry.version, optional: entry.optionalDependencies ?? {} };
}

function bunCellMuslFiles(): string[][] {
  return CREDENTIAL_CELLS.filter((c) => c.runtime === 'bun' && c.workflowFile).map((c) =>
    c.extraFiles.filter((f: string) => f.startsWith(`${REL}/`)).sort(),
  );
}

describe('the credentialed Next.js version has a committed musl lockfile for its sharp (#1620)', () => {
  it('the resolution record names the Next version the credential actually runs', () => {
    expect(credentialed.credentialedNextRef).toBe(`v${record.nextVersion}`);
    const env = workflow.match(
      /NEXTJS_REF: \$\{\{ github\.event\.inputs\.nextjsRef \|\| '(v[^']+)' \}\}/g,
    );
    expect(env, 'exactly one NEXTJS_REF env fallback in test-e2e-deploy.yml').toHaveLength(1);
    expect(env?.[0]).toContain(`'v${record.nextVersion}'`);
  });

  it('the recorded sharp range is the one that Next version declares (bun.lock), and the sharp satisfies it', () => {
    const bunLock = readFileSync(resolve(REPO_ROOT, 'bun.lock'), 'utf8');
    const m = bunLock.match(/"next": \["next@([^"]+)", .*?"sharp": "([^"]+)"/);
    expect(m, 'bun.lock records next and its sharp optional dependency').not.toBeNull();
    // bun.lock is the only offline record of Next's own sharp range; it is
    // authoritative when the repo's next IS the credentialed version (today).
    if (m?.[1] === record.nextVersion) expect(m?.[2]).toBe(record.sharpRange);
    expect(Bun.semver.satisfies(record.sharp, record.sharpRange)).toBe(true);
  });

  it('a committed lockfile for @img/sharp-linuxmusl-x64@<sharp> exists and pins exactly that sharp + libvips', () => {
    const dir = lookup('@img/sharp-linuxmusl-x64', record.sharp);
    expect(dir, `missing ${REL}/img-sharp-linuxmusl-x64-${record.sharp}/`).toBe(
      join(LOCKFILES, `img-sharp-linuxmusl-x64-${record.sharp}`),
    );
    const got = lockVersion(dir, '@img/sharp-linuxmusl-x64');
    expect(got.version).toBe(record.sharp);
    expect(got.optional['@img/sharp-libvips-linuxmusl-x64']).toBe(record.libvips);
  });

  it('a committed lockfile for @img/sharp-libvips-linuxmusl-x64@<libvips> exists and pins exactly it', () => {
    const dir = lookup('@img/sharp-libvips-linuxmusl-x64', record.libvips);
    expect(dir, `missing ${REL}/img-sharp-libvips-linuxmusl-x64-${record.libvips}/`).toBe(
      join(LOCKFILES, `img-sharp-libvips-linuxmusl-x64-${record.libvips}`),
    );
    expect(lockVersion(dir, '@img/sharp-libvips-linuxmusl-x64').version).toBe(record.libvips);
  });

  it('both lockfile pairs are frozen for every bun credential cell and tracked by git', () => {
    const want = [
      `img-sharp-linuxmusl-x64-${record.sharp}`,
      `img-sharp-libvips-linuxmusl-x64-${record.libvips}`,
    ].flatMap((d) => [`${REL}/${d}/package.json`, `${REL}/${d}/package-lock.json`]);
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
    expect(tracked).toEqual([...want].sort());
  });
});

describe('every committed musl lockfile is frozen, and every frozen one exists (lockstep)', () => {
  it('the lockfile dirs on disk are exactly MUSL_NATIVE_LOCKFILE_FILES', () => {
    const onDisk = readdirSync(LOCKFILES)
      .filter((d) => statSync(join(LOCKFILES, d)).isDirectory())
      .flatMap((d) => [`${REL}/${d}/package.json`, `${REL}/${d}/package-lock.json`])
      .sort();
    for (const files of bunCellMuslFiles()) expect(files).toEqual(onDisk);
    for (const f of onDisk) expect(existsSync(resolve(REPO_ROOT, f)), f).toBe(true);
  });
});
