import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isAlreadyPublishedConflict,
  npmProbe,
  npmPublish,
  npmResolvesAt,
} from '../scripts/ensure-published-group.mjs';

/**
 * `scripts/ensure-published-group.mjs`'s PROCESS-WIRING layer
 * (`npmResolvesAt` / `npmPublish` / `npmProbe`) — the `spawnSync('npm', …)` +
 * exit-code + stderr-capture boundary the pure retry logic in
 * `ensure-published-group.test.ts` never exercises (that suite injects
 * `resolves`/`publish` directly). A FAKE `npm` executable on `PATH` drives the
 * three real-world shapes from #1360:
 *
 *   1. registry read-after-write LAG then present (`npm view` exits non-zero a
 *      few times, then 0) — proves `npmResolvesAt` reads the exit code, not
 *      output text, and recovers once the fake registry catches up.
 *   2. the exact E409 "Cannot publish over previously staged version" this
 *      issue is about — proves `npmPublish`'s captured stderr feeds
 *      `isAlreadyPublishedConflict` correctly end-to-end (real spawnSync
 *      stderr, not a hand-written string).
 *   3. a REAL auth error (401/403, "Are you logged in?") — proves it does NOT
 *      get misread as the benign conflict.
 *
 * No network: the fake `npm` is a local Node script prepended to `PATH`.
 */

const REAL_PATH = process.env.PATH;

function fakeNpmScript(): string {
  // Reads two env knobs the individual tests set:
  //   FAKE_NPM_VIEW_STATE     path to a JSON counter file for `npm view` calls
  //   FAKE_NPM_PUBLISH_MODE   'success' | '409' | 'auth'
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);

if (argv[0] === 'view') {
  const target = argv[1]; // "<pkg>@<version>" or "<pkg>" (reachability probe)
  const statePath = process.env.FAKE_NPM_VIEW_STATE;
  const lagRounds = Number(process.env.FAKE_NPM_LAG_ROUNDS ?? '0');
  let state = {};
  if (statePath && existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  }
  const count = (state[target] ?? 0) + 1;
  state[target] = count;
  if (statePath) writeFileSync(statePath, JSON.stringify(state));
  if (count > lagRounds) {
    process.stdout.write((target.split('@').pop() || '0.0.0') + '\\n');
    process.exit(0);
  }
  process.stderr.write('npm error code E404\\nnpm error 404 Not Found - GET ' + target + '\\n');
  process.exit(1);
}

if (argv[0] === 'publish') {
  const mode = process.env.FAKE_NPM_PUBLISH_MODE ?? 'success';
  if (mode === 'success') {
    process.stdout.write('+ fake-package@0.0.0\\n');
    process.exit(0);
  }
  if (mode === '409') {
    process.stderr.write(
      'npm error code E409\\n' +
        'npm error 409 Conflict - PUT https://registry.npmjs.org/fake-package - ' +
        'Cannot publish over previously staged version "0.0.0".\\n' +
        'npm error A complete log of this run can be found in: /tmp/fake-debug.log\\n',
    );
    process.exit(1);
  }
  if (mode === 'auth') {
    process.stderr.write(
      'npm error code E403\\n' +
        'npm error 403 403 Forbidden - PUT https://registry.npmjs.org/fake-package - ' +
        'Forbidden: you do not have permission to publish "fake-package". Are you logged in?\\n',
    );
    process.exit(1);
  }
  process.stderr.write('unknown FAKE_NPM_PUBLISH_MODE: ' + mode + '\\n');
  process.exit(1);
}

process.stderr.write('fake npm: unsupported command ' + JSON.stringify(argv) + '\\n');
process.exit(1);
`;
}

let binDir: string;
let pkgDir: string;

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'knext-fake-npm-bin-'));
  const npmPath = join(binDir, 'npm');
  writeFileSync(npmPath, fakeNpmScript());
  chmodSync(npmPath, 0o755);
  process.env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${REAL_PATH}`;

  pkgDir = mkdtempSync(join(tmpdir(), 'knext-fake-npm-pkg-'));
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'fake-package', version: '0.0.0' }),
  );
});

afterEach(() => {
  process.env.PATH = REAL_PATH;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(pkgDir, { recursive: true, force: true });
});

describe('npmResolvesAt / npmProbe — real spawnSync against a fake npm', () => {
  it('reads the exit code, not output text: 0 = resolves, non-zero = does not', () => {
    const state = mkdtempSync(join(tmpdir(), 'knext-fake-npm-state-'));
    const statePath = join(state, 'view.json');
    process.env.FAKE_NPM_VIEW_STATE = statePath;
    process.env.FAKE_NPM_LAG_ROUNDS = '0'; // resolves immediately
    try {
      expect(npmResolvesAt('fake-package', '0.0.0', 'http://127.0.0.1:1/')).toBe(true);
    } finally {
      delete process.env.FAKE_NPM_VIEW_STATE;
      delete process.env.FAKE_NPM_LAG_ROUNDS;
      rmSync(state, { recursive: true, force: true });
    }
  });

  it('registry read-after-write LAG then present: false for N calls, then true', () => {
    const state = mkdtempSync(join(tmpdir(), 'knext-fake-npm-state-'));
    const statePath = join(state, 'view.json');
    process.env.FAKE_NPM_VIEW_STATE = statePath;
    process.env.FAKE_NPM_LAG_ROUNDS = '2'; // first 2 calls miss, 3rd hits
    try {
      const reads = [
        npmResolvesAt('fake-package', '0.0.0', 'http://127.0.0.1:1/'),
        npmResolvesAt('fake-package', '0.0.0', 'http://127.0.0.1:1/'),
        npmResolvesAt('fake-package', '0.0.0', 'http://127.0.0.1:1/'),
      ];
      expect(reads).toEqual([false, false, true]);
    } finally {
      delete process.env.FAKE_NPM_VIEW_STATE;
      delete process.env.FAKE_NPM_LAG_ROUNDS;
      rmSync(state, { recursive: true, force: true });
    }
  });

  it('npmProbe mirrors the same exit-code contract for the reachability probe', () => {
    const state = mkdtempSync(join(tmpdir(), 'knext-fake-npm-state-'));
    const statePath = join(state, 'view.json');
    process.env.FAKE_NPM_VIEW_STATE = statePath;
    process.env.FAKE_NPM_LAG_ROUNDS = '0';
    try {
      expect(npmProbe('http://127.0.0.1:1/')).toBe(true);
    } finally {
      delete process.env.FAKE_NPM_VIEW_STATE;
      delete process.env.FAKE_NPM_LAG_ROUNDS;
      rmSync(state, { recursive: true, force: true });
    }
  });
});

describe('npmPublish — real spawnSync stderr capture feeds isAlreadyPublishedConflict', () => {
  it('a REAL E409 "Cannot publish over previously staged version" is captured and absorbed (#1360)', () => {
    process.env.FAKE_NPM_PUBLISH_MODE = '409';
    try {
      const result = npmPublish(pkgDir, 'http://127.0.0.1:1/');
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('Cannot publish over previously staged version');
      // The exact bug: this real, spawnSync-captured result must be absorbed.
      expect(isAlreadyPublishedConflict(result)).toBe(true);
    } finally {
      delete process.env.FAKE_NPM_PUBLISH_MODE;
    }
  });

  it('a REAL auth error (403, "Are you logged in?") is captured and NOT absorbed', () => {
    process.env.FAKE_NPM_PUBLISH_MODE = 'auth';
    try {
      const result = npmPublish(pkgDir, 'http://127.0.0.1:1/');
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('Are you logged in?');
      expect(isAlreadyPublishedConflict(result)).toBe(false);
    } finally {
      delete process.env.FAKE_NPM_PUBLISH_MODE;
    }
  });

  it('a successful publish reports ok:true', () => {
    process.env.FAKE_NPM_PUBLISH_MODE = 'success';
    try {
      const result = npmPublish(pkgDir, 'http://127.0.0.1:1/');
      expect(result.ok).toBe(true);
    } finally {
      delete process.env.FAKE_NPM_PUBLISH_MODE;
    }
  });
});
