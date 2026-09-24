import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceRoots } from '../scripts/lib/workspace-globs.mjs';

/**
 * PROCESS-LEVEL `--post` test (#1364 round 3): a fake `npm` on `PATH`, driving
 * `runPost()`'s own WIRING end-to-end — the exact gap the round-2 fix left
 * open. `verify-published-group-fake-npm.test.ts` proves `pollViewVersion` +
 * `npmResolvesAtVersion` are correct IN ISOLATION; it never calls `runPost()`
 * itself, so a regression at the WIRING SITE (`resolvesAtTarget: (n) =>
 * npmResolvesAtVersion(...)` — line ~450) that reverted to the pre-#1364
 * untargeted check (`npmViewVersion(n, registry) !== null`) would leave every
 * existing test green while `--post` silently certifies a stale publish.
 * Mutation-proven: reverting that one line to the untargeted form flips
 * "never resolves at target" from FAIL (exit 1, below) to a false PASS
 * (exit 0) — because the untargeted `latest` dist-tag read is non-null
 * (stale) from round zero, exactly reproducing the incident this file exists
 * to catch (run 36040935670, #1364 finding 1).
 *
 * `runPost()` is not exported (it is the CLI's own `--post` handler, reading
 * the REAL repo tree for its fixed group + target version) — spawned as a
 * real child process instead, `node scripts/verify-published-group.mjs
 * --post`, with `VERIFY_POST_POLL_MAX_MS` (a test-only override) keeping the
 * "never resolves" case fast instead of the real ~5-minute budget.
 *
 * macOS PATH-shadowing note (round-3 review): a real `npm` on `PATH` can
 * resolve ahead of the fake one under some shells/tool wrappers. Every test
 * here asserts the CHILD actually ran the fake — via `FAKE_NPM_MARKER` in its
 * own stdout — rather than merely asserting the exit code, so a shadowed real
 * npm making a live network call fails LOUDLY (wrong marker, likely a network
 * timeout too) instead of silently passing or failing for the wrong reason.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'verify-published-group.mjs');
const REAL_PATH = process.env.PATH ?? '';
const FAKE_NPM_MARKER = 'FAKE-NPM-9999.9999.9999';

function fakeNpmScript(): string {
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);

if (argv[0] === '--version') {
  process.stdout.write('${FAKE_NPM_MARKER}\\n');
  process.exit(0);
}

if (argv[0] === 'view') {
  const target = argv[1];
  const isTargeted = target.lastIndexOf('@') > 0;
  const statePath = process.env.FAKE_NPM_VIEW_STATE;
  const version = process.env.FAKE_NPM_VERSION ?? '0.0.0';
  const staleVersion = process.env.FAKE_NPM_STALE_VERSION ?? version;

  if (!isTargeted) {
    // The untargeted "latest" read — always non-null (stale), reproducing
    // the read-after-write lag shape the wiring must NOT trust.
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
  binDir = mkdtempSync(join(tmpdir(), 'knext-verify-post-e2e-bin-'));
  const npmPath = join(binDir, 'npm');
  writeFileSync(npmPath, fakeNpmScript());
  chmodSync(npmPath, 0o755);
  stateDir = mkdtempSync(join(tmpdir(), 'knext-verify-post-e2e-state-'));
});

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

/** Fake-first PATH: prepend, never append-only — robust against a real npm elsewhere on PATH. */
function fakeFirstPath(): string {
  return `${binDir}${process.platform === 'win32' ? ';' : ':'}${REAL_PATH}`;
}

/**
 * Loudly verifies the fake actually wins PATH resolution for THIS exact env
 * before trusting any test built on it — the round-3 review's macOS finding.
 */
function assertFakeNpmActive(env: NodeJS.ProcessEnv): void {
  const probe = spawnSync('npm', ['--version'], { env, encoding: 'utf8' });
  const stdout = (probe.stdout ?? '').trim();
  if (stdout !== FAKE_NPM_MARKER) {
    throw new Error(
      `fake npm is NOT first on PATH for this test env — 'npm --version' returned ` +
        `${JSON.stringify(stdout)} instead of ${JSON.stringify(FAKE_NPM_MARKER)} ` +
        `(stderr: ${probe.stderr ?? ''}). A real npm is shadowing the fake, which would ` +
        `otherwise make this test silently exercise a live network call.`,
    );
  }
}

/** The real fixed-group target version, read from this checked-out tree. */
function realTargetVersion(): string {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, '.changeset', 'config.json'), 'utf8')) as {
    fixed: string[][];
  };
  const [firstMember] = config.fixed[0] ?? [];
  if (!firstMember) throw new Error('no fixed group in .changeset/config.json');
  // Mirrors readWorkspace()'s own lookup (via the SAME shared helper the
  // production script uses, so this cannot drift from it): walk every
  // declared workspace root for the member's package.json.
  for (const root of workspaceRoots()) {
    const base = join(REPO_ROOT, root);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(base, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === firstMember && typeof pkg.version === 'string') return pkg.version;
    }
  }
  throw new Error(
    `could not find a package.json for ${firstMember} under ${workspaceRoots().join(', ')}`,
  );
}

describe('verify-published-group.mjs --post — process-level, real wiring (#1364 round 3)', () => {
  it('FAILS (exit 1) when the target version NEVER resolves via the targeted read — the exact incident regression', () => {
    const target = realTargetVersion();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: fakeFirstPath(),
      FAKE_NPM_VIEW_STATE: join(stateDir, 'view.json'),
      FAKE_NPM_LAG_ROUNDS: 'never', // the targeted (name@version) read NEVER succeeds
      FAKE_NPM_VERSION: target,
      FAKE_NPM_STALE_VERSION: '0.0.1', // the untargeted "latest" read stays non-null throughout
      VERIFY_POST_POLL_MAX_MS: '300', // keep this fast — no real 5-minute wait
      PUBLISH_PREFLIGHT_REGISTRY: 'http://127.0.0.1:1/',
    };
    assertFakeNpmActive(env);

    const run = spawnSync('node', [SCRIPT, '--post'], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      timeout: 10_000, // a genuinely hung child must not hang the test runner
    });

    // If line ~450's wiring were reverted to the untargeted
    // `npmViewVersion(n, registry) !== null` check, this would exit 0 —
    // the untargeted read is non-null (stale) from round zero. The CORRECT
    // wiring (targeted, version-scoped) must fail here.
    expect(run.status).toBe(1);
    expect(run.stdout + run.stderr).toContain('INCOHERENT');
  }, 15_000);

  it('SUCCEEDS (exit 0) once the target version genuinely resolves via the targeted read', () => {
    const target = realTargetVersion();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: fakeFirstPath(),
      FAKE_NPM_VIEW_STATE: join(stateDir, 'view.json'),
      FAKE_NPM_LAG_ROUNDS: '0', // the targeted read succeeds immediately
      FAKE_NPM_VERSION: target,
      VERIFY_POST_POLL_MAX_MS: '2000',
      PUBLISH_PREFLIGHT_REGISTRY: 'http://127.0.0.1:1/',
    };
    assertFakeNpmActive(env);

    const run = spawnSync('node', [SCRIPT, '--post'], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      timeout: 10_000, // a genuinely hung child must not hang the test runner
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('PASS (post)');

    // The targeted endpoint was actually used for every fixed-group member —
    // proves success came from the version-scoped read, not the untargeted
    // one (which this test never even configures a distinct value for).
    const state = JSON.parse(readFileSync(join(stateDir, 'view.json'), 'utf8')) as Record<
      string,
      number
    >;
    const config = JSON.parse(
      readFileSync(join(REPO_ROOT, '.changeset', 'config.json'), 'utf8'),
    ) as { fixed: string[][] };
    for (const member of config.fixed[0] ?? []) {
      expect(state[`${member}@${target}`]).toBeGreaterThanOrEqual(1);
    }
  }, 15_000);
});
