/**
 * `knext ffi init` (ADR-0069 D3, D11, D12): writes `knext.ffi.json` and the
 * `rust/` crate from the package's templates, pinning `knext-ffi` to the git
 * revision this @getknext/ffi records; refuses to overwrite anything.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { CRATE_GIT, recordedCrateRev, runInit, TEMPLATE_DIR } from '../init';
import { capture, emptyDir, PKG_DIR, readTree, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);

const REV = 'a'.repeat(40);

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else out.push(relative(dir, join(d, e.name)));
    }
  };
  walk(dir);
  return out.sort();
}

describe('knext ffi init', () => {
  it('writes knext.ffi.json and the rust/ crate, the knext-ffi dependency pinned by full rev', () => {
    const cwd = emptyDir('init');
    const c = capture();
    expect(runInit({ cwd, io: c.io, crateRev: REV }), c.err()).toBe(0);
    expect(readFileSync(join(cwd, 'knext.ffi.json'), 'utf8')).toBe(
      '{\n  "version": 1,\n  "crate": "rust",\n  "out": "src/generated/ffi"\n}\n',
    );
    const cargo = readFileSync(join(cwd, 'rust', 'Cargo.toml'), 'utf8');
    expect(cargo).toContain(`knext-ffi = { git = "${CRATE_GIT}", rev = "${REV}" }`);
    expect(cargo).toContain('crate-type = ["cdylib"]');
    expect(cargo).not.toMatch(/panic\s*=\s*"abort"/);
    expect(cargo).not.toContain('{{');
    const lib = readFileSync(join(cwd, 'rust', 'src', 'lib.rs'), 'utf8');
    expect(lib).toContain('#[knext_ffi::export]');
    expect(lib).toContain('pub fn greet(');
    expect(readFileSync(join(cwd, 'rust', 'rust-toolchain.toml'), 'utf8')).toMatch(
      /channel = "\d+\.\d+\.\d+"/,
    );
    expect(c.out()).toContain('knext.ffi.json');
    expect(c.out()).toContain('knext ffi generate');
  });

  it('writes every template file (so a template added later ships with no code change)', () => {
    const cwd = emptyDir('init-all');
    expect(runInit({ cwd, io: capture().io, crateRev: REV })).toBe(0);
    const expected = files(TEMPLATE_DIR).map((f) => f.replace(/\.tmpl$/, ''));
    expect(files(cwd).filter((f) => f !== 'knext.ffi.json')).toEqual(expected);
    expect(expected).toContain(join('rust', 'Cargo.toml'));
  });

  for (const existing of ['knext.ffi.json', 'rust']) {
    it(`refuses to overwrite: ${existing} already exists, and nothing is written`, () => {
      const cwd = emptyDir('init-exists');
      if (existing === 'rust') mkdirSync(join(cwd, 'rust'));
      else writeFileSync(join(cwd, existing), '{}');
      const before = readTree(cwd);
      const c = capture();
      expect(runInit({ cwd, io: c.io, crateRev: REV })).toBe(1);
      expect(c.err()).toContain(`${existing} already exists`);
      expect(c.err()).toContain('nothing was written');
      expect(readTree(cwd)).toEqual(before);
    });
  }

  it('refuses when this build records no knext-ffi revision, writing nothing', () => {
    const cwd = emptyDir('init-norev');
    const c = capture();
    expect(runInit({ cwd, io: c.io, crateRev: null })).toBe(1);
    expect(c.err()).toContain('records no knext-ffi crate revision');
    expect(existsSync(join(cwd, 'knext.ffi.json'))).toBe(false);
  });

  it('refuses a revision that is not a full 40-hex commit (a tag or branch is a movable ref)', () => {
    for (const rev of ['v1.0.0', 'main', 'abc123']) {
      const c = capture();
      expect(runInit({ cwd: emptyDir('init-badrev'), io: c.io, crateRev: rev })).toBe(1);
      expect(c.err()).toContain('full 40-hex commit');
    }
  });
});

describe('the knext-ffi revision this package records (package.json knextFfi.crateRev)', () => {
  it('is recorded, as a full 40-hex commit, so `knext ffi init` writes a crate instead of refusing', () => {
    // That cargo resolves knext-ffi at this commit and the written crate
    // builds is proven in the Rust crates CI lane (crates/harness/ffi-generated.ts
    // `init`), which builds the crate exactly as written, fetching the git
    // dependency. Not here: this suite runs on a shallow checkout, which does
    // not hold the commit.
    const rev = recordedCrateRev();
    expect(rev).not.toBeNull();
    expect(rev).toMatch(/^[0-9a-f]{40}$/);
    const c = capture();
    const cwd = emptyDir('init-recorded');
    expect(runInit({ cwd, io: c.io }), c.err()).toBe(0);
    expect(readFileSync(join(cwd, 'rust', 'Cargo.toml'), 'utf8')).toContain(
      `knext-ffi = { git = "${CRATE_GIT}", rev = "${rev}" }`,
    );
  });

  it('is a commit that contains crates/knext-ffi, when this checkout holds it', () => {
    // A full clone (a developer machine, the Rust crates lane) holds the
    // commit; a shallow CI checkout may not, and then the lane's real build is
    // the proof. Never a silent pass on a full clone: a missing object there
    // fails.
    const rev = recordedCrateRev() as string;
    const repo = resolve(PKG_DIR, '..', '..');
    const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: repo,
      encoding: 'utf8',
    }).stdout.trim();
    const r = spawnSync('git', ['cat-file', '-e', `${rev}:crates/knext-ffi/Cargo.toml`], {
      cwd: repo,
    });
    if (shallow === 'true' && r.status !== 0) return;
    expect(r.status, `${rev} has no crates/knext-ffi/Cargo.toml`).toBe(0);
  });
});
