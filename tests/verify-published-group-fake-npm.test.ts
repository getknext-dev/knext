import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { npmProbe, npmViewVersion, pollViewVersion } from '../scripts/verify-published-group.mjs';

/**
 * `scripts/verify-published-group.mjs`'s PROCESS-WIRING layer (`npmViewVersion`
 * / `npmProbe`), combined end-to-end with the `pollViewVersion` bounded-poll
 * fix (#1364 finding 1) — a fake `npm` on `PATH` drives the two real-world
 * shapes the production incident measured:
 *
 *   1. registry read-after-write LAG then present — `npm view` exits non-zero
 *      a few times, then 0 with the target version. `--post` must recover
 *      within its poll budget instead of reading the single racy miss as a
 *      partial publish.
 *   2. NEVER resolves within the budget — `--post` must still fail (a real
 *      partial publish must never be certified coherent just because a poll
 *      exists).
 *
 * No network: the fake `npm` is a local Node script prepended to `PATH`. Poll
 * budgets here are small (10s-order) real numbers so the suite stays fast —
 * `pollViewVersion`'s own unit tests (verify-published-group.test.ts) already
 * prove the DEFAULT ~5-minute budget's shape with an injected fake clock.
 */

const REAL_PATH = process.env.PATH;

function fakeNpmScript(): string {
  // FAKE_NPM_VIEW_STATE: path to a JSON counter file for `npm view <name> version` calls.
  // FAKE_NPM_LAG_ROUNDS: how many calls miss before hitting; 'never' = always misses.
  // FAKE_NPM_VERSION: the version to report once resolved.
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);

if (argv[0] === 'view') {
  const target = argv[1]; // "<name>" — this script's "npm view <name> version"
  const statePath = process.env.FAKE_NPM_VIEW_STATE;
  const lagRounds = process.env.FAKE_NPM_LAG_ROUNDS ?? '0';
  const version = process.env.FAKE_NPM_VERSION ?? '0.0.0';
  let state = {};
  if (statePath && existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  }
  const count = (state[target] ?? 0) + 1;
  state[target] = count;
  if (statePath) writeFileSync(statePath, JSON.stringify(state));
  if (lagRounds !== 'never' && count > Number(lagRounds)) {
    process.stdout.write(version + '\\n');
    process.exit(0);
  }
  process.stderr.write('npm error code E404\\nnpm error 404 Not Found - GET ' + target + '\\n');
  process.exit(1);
}

process.stderr.write('fake npm: unsupported command ' + JSON.stringify(argv) + '\\n');
process.exit(1);
`;
}

let binDir: string;
let stateDir: string;

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'knext-verify-fake-npm-bin-'));
  const npmPath = join(binDir, 'npm');
  writeFileSync(npmPath, fakeNpmScript());
  chmodSync(npmPath, 0o755);
  process.env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${REAL_PATH}`;
  stateDir = mkdtempSync(join(tmpdir(), 'knext-verify-fake-npm-state-'));
});

afterEach(() => {
  process.env.PATH = REAL_PATH;
  delete process.env.FAKE_NPM_VIEW_STATE;
  delete process.env.FAKE_NPM_LAG_ROUNDS;
  delete process.env.FAKE_NPM_VERSION;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe('npmViewVersion / npmProbe — real spawnSync against a fake npm', () => {
  it('reads the exit code and stdout, exactly as `--post` needs', () => {
    process.env.FAKE_NPM_VIEW_STATE = join(stateDir, 'view.json');
    process.env.FAKE_NPM_LAG_ROUNDS = '0';
    process.env.FAKE_NPM_VERSION = '0.4.3';
    expect(npmViewVersion('@getknext/core', 'http://127.0.0.1:1/')).toBe('0.4.3');
  });

  it('returns null (not throw) on a 404 miss', () => {
    process.env.FAKE_NPM_VIEW_STATE = join(stateDir, 'view.json');
    process.env.FAKE_NPM_LAG_ROUNDS = 'never';
    expect(npmViewVersion('@getknext/core', 'http://127.0.0.1:1/')).toBeNull();
  });

  it('npmProbe mirrors the same exit-code contract', () => {
    process.env.FAKE_NPM_VIEW_STATE = join(stateDir, 'view.json');
    process.env.FAKE_NPM_LAG_ROUNDS = '0';
    process.env.FAKE_NPM_VERSION = '9.9.9';
    expect(npmProbe('http://127.0.0.1:1/')).toBe(true);
  });
});

describe('pollViewVersion + npmViewVersion — end-to-end (#1364 finding 1)', () => {
  it('registry read-after-write LAG then present: recovers within the poll budget', async () => {
    process.env.FAKE_NPM_VIEW_STATE = join(stateDir, 'view.json');
    process.env.FAKE_NPM_LAG_ROUNDS = '2'; // first 2 real `npm view` calls miss
    process.env.FAKE_NPM_VERSION = '0.4.3';

    const version = await pollViewVersion({
      name: '@getknext/core',
      viewVersion: (name) => npmViewVersion(name, 'http://127.0.0.1:1/'),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      maxTotalMs: 2_000,
      backoffMs: () => 50, // real small delays — this test actually waits, briefly
    });
    expect(version).toBe('0.4.3');
  });

  it('NEVER resolves within the budget: still fails (returns null) — a real partial publish must not be certified coherent', async () => {
    process.env.FAKE_NPM_VIEW_STATE = join(stateDir, 'view.json');
    process.env.FAKE_NPM_LAG_ROUNDS = 'never'; // the version never appears
    process.env.FAKE_NPM_VERSION = '0.4.3';

    const version = await pollViewVersion({
      name: '@getknext/core',
      viewVersion: (name) => npmViewVersion(name, 'http://127.0.0.1:1/'),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      maxTotalMs: 300,
      backoffMs: () => 50,
    });
    expect(version).toBeNull();
  });
});
