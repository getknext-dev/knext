import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  npmProbe,
  npmResolvesAtVersion,
  npmViewVersion,
  pollViewVersion,
} from '../scripts/verify-published-group.mjs';

/**
 * `scripts/verify-published-group.mjs`'s PROCESS-WIRING layer (`npmViewVersion`
 * / `npmResolvesAtVersion` / `npmProbe`), combined end-to-end with the
 * `pollViewVersion` bounded-poll fix (#1364 findings 1 + round 2) — a fake
 * `npm` on `PATH` drives the real-world shapes the production incident and
 * its review measured:
 *
 *   1. the TARGETED read (`npm view <name>@<target> version`,
 *      `npmResolvesAtVersion`) lags then resolves — `--post` recovers within
 *      its poll budget instead of reading the single racy miss as a partial
 *      publish.
 *   2. #1364 round 2 — THE REPLAYED BUG: the UNTARGETED read
 *      (`npm view <name> version`, no `@version`) reports the OLD `latest`
 *      version throughout the lag — non-null, exit 0 — while the TARGETED
 *      read (what `pollViewVersion` now actually polls) keeps missing until
 *      the real version lands. A poll keyed on the untargeted read would
 *      return immediately on the stale version; this proves the targeted one
 *      does not.
 *   3. NEVER resolves within the budget — `--post` must still fail.
 *
 * No network: the fake `npm` is a local Node script prepended to `PATH`. Poll
 * budgets here are small (10s-order) real numbers so the suite stays fast —
 * `pollViewVersion`'s own unit tests (verify-published-group.test.ts) already
 * prove the DEFAULT ~5-minute budget's shape with an injected fake clock.
 */

const REAL_PATH = process.env.PATH;
const FAKE_NPM_MARKER = 'FAKE-NPM-9999.9999.9999';

function fakeNpmScript(): string {
  // FAKE_NPM_VIEW_STATE: path to a JSON counter file, keyed by the exact
  //   `npm view` target string ("<name>" or "<name>@<version>"), so the
  //   untargeted and targeted reads are tracked independently.
  // FAKE_NPM_LAG_ROUNDS: how many TARGETED (name@version) misses before a
  //   hit; 'never' = always misses. Untargeted reads are UNAFFECTED by this
  //   — they always report FAKE_NPM_STALE_VERSION (or FAKE_NPM_VERSION when
  //   that is unset), simulating the `latest` dist-tag staying put during lag.
  // FAKE_NPM_VERSION: the version a TARGETED read reports once it hits.
  // FAKE_NPM_STALE_VERSION: what an UNTARGETED read reports (defaults to
  //   FAKE_NPM_VERSION when unset — the "no real staleness" shape).
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);

if (argv[0] === '--version') {
  process.stdout.write('${FAKE_NPM_MARKER}\\n');
  process.exit(0);
}

if (argv[0] === 'view') {
  const target = argv[1]; // "<name>" or "<name>@<version>"
  const isTargeted = target.includes('@') && !target.startsWith('@') || (target.startsWith('@') && target.lastIndexOf('@') > 0);
  const statePath = process.env.FAKE_NPM_VIEW_STATE;
  const version = process.env.FAKE_NPM_VERSION ?? '0.0.0';
  const staleVersion = process.env.FAKE_NPM_STALE_VERSION ?? version;

  if (!isTargeted) {
    // The UNTARGETED read ("latest" dist-tag) always answers immediately —
    // the whole point of #1364 round 2 is that this is non-null throughout
    // the lag and must NOT be what the poll keys on.
    process.stdout.write(staleVersion + '\\n');
    process.exit(0);
  }

  const lagRounds = process.env.FAKE_NPM_LAG_ROUNDS ?? '0';
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

  // Round-3 review (macOS): a real npm on PATH can shadow the fake one under
  // some shells. Fail LOUDLY here, before any test's own assertions run,
  // rather than silently exercising a real registry call.
  const probe = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  const stdout = (probe.stdout ?? '').trim();
  if (stdout !== FAKE_NPM_MARKER) {
    throw new Error(
      `fake npm is NOT first on PATH — 'npm --version' returned ${JSON.stringify(stdout)} ` +
        `instead of ${JSON.stringify(FAKE_NPM_MARKER)} (stderr: ${probe.stderr ?? ''})`,
    );
  }

  stateDir = mkdtempSync(join(tmpdir(), 'knext-verify-fake-npm-state-'));
});

afterEach(() => {
  process.env.PATH = REAL_PATH;
  delete process.env.FAKE_NPM_VIEW_STATE;
  delete process.env.FAKE_NPM_LAG_ROUNDS;
  delete process.env.FAKE_NPM_VERSION;
  delete process.env.FAKE_NPM_STALE_VERSION;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe('npmViewVersion / npmResolvesAtVersion / npmProbe — real spawnSync against a fake npm', () => {
  it('npmViewVersion (untargeted) reads the exit code and stdout', () => {
    process.env.FAKE_NPM_VERSION = '0.4.3';
    expect(npmViewVersion('@getknext/core', 'http://127.0.0.1:1/')).toBe('0.4.3');
  });

  it('npmResolvesAtVersion (targeted) is TRUE only once the exact version resolves', () => {
    process.env.FAKE_NPM_VIEW_STATE = join(stateDir, 'view.json');
    process.env.FAKE_NPM_LAG_ROUNDS = '0';
    process.env.FAKE_NPM_VERSION = '0.4.3';
    expect(npmResolvesAtVersion('@getknext/core', '0.4.3', 'http://127.0.0.1:1/')).toBe(true);
  });

  it('npmResolvesAtVersion is FALSE (not throw) on a miss', () => {
    process.env.FAKE_NPM_VIEW_STATE = join(stateDir, 'view.json');
    process.env.FAKE_NPM_LAG_ROUNDS = 'never';
    expect(npmResolvesAtVersion('@getknext/core', '0.4.3', 'http://127.0.0.1:1/')).toBe(false);
  });

  it('npmProbe mirrors the same exit-code contract', () => {
    process.env.FAKE_NPM_VERSION = '9.9.9';
    expect(npmProbe('http://127.0.0.1:1/')).toBe(true);
  });
});

describe('pollViewVersion + npmResolvesAtVersion — end-to-end (#1364 findings 1 + round 2)', () => {
  it('registry read-after-write LAG then present: recovers within the poll budget', async () => {
    process.env.FAKE_NPM_VIEW_STATE = join(stateDir, 'view.json');
    process.env.FAKE_NPM_LAG_ROUNDS = '2'; // first 2 targeted reads miss
    process.env.FAKE_NPM_VERSION = '0.4.3';

    const hit = await pollViewVersion({
      name: '@getknext/core',
      resolvesAtTarget: (name) => npmResolvesAtVersion(name, '0.4.3', 'http://127.0.0.1:1/'),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      maxTotalMs: 2_000,
      backoffMs: () => 50, // real small delays — this test actually waits, briefly
    });
    expect(hit).toBe(true);
  });

  it('#1364 round 2 — THE REPLAYED BUG: the untargeted `latest` read stays non-null (stale) throughout the lag, but the poll does not return early on it', async () => {
    process.env.FAKE_NPM_VIEW_STATE = join(stateDir, 'view.json');
    process.env.FAKE_NPM_LAG_ROUNDS = '2'; // the TARGET version needs 2 misses before landing
    process.env.FAKE_NPM_VERSION = '0.4.3'; // what the target read reports once it hits
    process.env.FAKE_NPM_STALE_VERSION = '0.4.2'; // what `latest` reports throughout — the OLD version

    // Precondition, proven for real: the untargeted read is non-null (stale)
    // from round 0, exactly the read the OLD (round-1) implementation polled.
    expect(npmViewVersion('@getknext/core', 'http://127.0.0.1:1/')).toBe('0.4.2');

    let targetedCalls = 0;
    const hit = await pollViewVersion({
      name: '@getknext/core',
      resolvesAtTarget: (name) => {
        targetedCalls += 1;
        return npmResolvesAtVersion(name, '0.4.3', 'http://127.0.0.1:1/');
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      maxTotalMs: 2_000,
      backoffMs: () => 50,
    });
    expect(hit).toBe(true);
    expect(targetedCalls).toBeGreaterThan(1); // did NOT stop after round 0 on the stale-but-non-null untargeted read
    // The untargeted read is STILL stale even after the poll succeeded — proves
    // the poll's success came from the TARGETED check, not this one.
    expect(npmViewVersion('@getknext/core', 'http://127.0.0.1:1/')).toBe('0.4.2');
  });

  it('NEVER resolves within the budget: still fails — a real partial publish must not be certified coherent', async () => {
    process.env.FAKE_NPM_VIEW_STATE = join(stateDir, 'view.json');
    process.env.FAKE_NPM_LAG_ROUNDS = 'never'; // the target version never appears
    process.env.FAKE_NPM_VERSION = '0.4.3';
    process.env.FAKE_NPM_STALE_VERSION = '0.4.2'; // `latest` stays on the old version forever too

    const hit = await pollViewVersion({
      name: '@getknext/core',
      resolvesAtTarget: (name) => npmResolvesAtVersion(name, '0.4.3', 'http://127.0.0.1:1/'),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      maxTotalMs: 300,
      backoffMs: () => 50,
    });
    expect(hit).toBe(false);
  });
});
