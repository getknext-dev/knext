#!/usr/bin/env node
/**
 * #950 — resolve the scaffold's @getknext/* pins against the LIVE registry,
 * and run the quickstart as a stranger. The run-time "value" half of the
 * scaffold-pin guard; the PR-time "form" half is
 * `packages/kn-next/src/__tests__/scaffold-version-pins.test.ts` (pins derive
 * from the CLI's own version, no hardcoded literal, changesets `fixed` group
 * intact). Same division of labour as the action-pin and anonymous-install
 * checks: form at PR time, value at run time — because the answer lives on
 * registry.npmjs.org and legitimately changes at every publish, so baking it
 * into a committed assertion would rot.
 *
 * WHY NIGHTLY (+ release trigger), NOT A PR GATE. The workspace version is
 * routinely AHEAD of the registry between a changesets version bump and its
 * publish; a PR gate on registry state would go red on every such window for
 * reasons the PR did not cause, and a flaky gate trains people to bypass it.
 * A red HERE means exactly one thing: publishing is due (or broke — #853's
 * dead token produced precisely this state, S3-V Finding A-1).
 *
 * Two phases, both always run so a failure is attributable at a glance:
 *
 *   1. TEMPLATE PINS vs REGISTRY: substitute the CLI's own version into the
 *      scaffold template the way `create` does, then ask the registry whether
 *      each resulting `@getknext/*` range resolves. Red on notarget: the
 *      templates at HEAD reference versions no consumer can install.
 *   2. STRANGER QUICKSTART: in a clean temp dir, scaffold with the LATEST
 *      PUBLISHED CLI (`npm exec @getknext/core@latest`) and run the exact
 *      command its output tells a new user to run: `npm install`. This is the
 *      front door as a stranger meets it TODAY.
 *
 *   3. STRANGER PATH UNDER A PARENT LOCKFILE: the whole documented walk, not
 *      just the install — `npm init` + `npm i @getknext/core` in a parent dir
 *      (which leaves a `package-lock.json` there, exactly as the getting-started
 *      page has a reader do), `knext create my-app`, `npm install`,
 *      `knext build`, `knext deploy --dry-run`. The parent lockfile is the
 *      point: Next.js infers the workspace root from it, and a scaffold that
 *      does not pin its own root builds into `.next/standalone/<app>/` and
 *      fails its first build. Phases 1-2 stop before the build, so they stayed
 *      green through exactly that front-door failure.
 *      Which package this walks is `KNEXT_STRANGER_SPECS` (space-separated npm
 *      specs; default the `next` dist-tag, the line under development — the
 *      `latest` tag lags it). Setting it to local tarballs is how the step is
 *      mutation-proved: tarballs of the OLD template must turn it red.
 *
 * AN UNREACHABLE REGISTRY IS A FAILURE, NEVER A PASS — the ruling this repo
 * already made for `scripts/verify-action-pins.mjs`. Failures branch on EXIT
 * CODES, never on output text (a grep through ANSI once certified 14
 * decorative mutations green).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const fail = (phase, message) => {
  failures.push(`[${phase}] ${message}`);
  console.error(`FAIL [${phase}] ${message}`);
};

// ── Phase 1: the template's pins, rendered exactly as `create` renders them ──

function templatePins() {
  const version = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages/kn-next/package.json'), 'utf8'),
  ).version;
  const raw = readFileSync(
    join(REPO_ROOT, 'packages/kn-next/templates/app/package.json.hbs'),
    'utf8',
  ).replace(/\{\{\s*version\s*\}\}/g, version);
  const pkg = JSON.parse(raw);
  const pins = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([name]) =>
    name.startsWith('@getknext/'),
  );
  if (pins.length === 0) {
    // A template with no @getknext pins would make this whole check vacuous
    // green — that is a failure of the check's premise, not a pass.
    fail(
      'template-pins',
      'no @getknext/* deps found in package.json.hbs — the check has no subject',
    );
  }
  return pins;
}

console.log('── phase 1: HEAD template pins vs the registry ──');
for (const [name, range] of templatePins()) {
  // On npm >= 11 (measured, npm 11.6.2), a range that matches NOTHING exits 1
  // with an E404 error object on STDOUT (under `--json`) and prose on stderr —
  // notarget goes through the non-zero branch below. The exit-0-empty branch
  // after it is DEAD DEFENSE for that npm: kept because older npm treated an
  // empty result set as success, and a checker must never pass on silence.
  const r = spawnSync('npm', ['view', `${name}@${range}`, 'version', '--json'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (r.status !== 0) {
    // The REASON can land on either stream: with `--json`, npm >= 11 writes
    // the E404 error OBJECT to STDOUT and the prose to stderr. Capped PER
    // STREAM with stdout first — the stderr prose alone (441 chars measured)
    // would blow a shared cap and push the machine-readable reason out of the
    // message entirely.
    const slice = (s) => (s || '').trim().slice(0, 200);
    const reason = [slice(r.stdout), slice(r.stderr)].filter(Boolean).join(' | ');
    fail('template-pins', `npm view ${name}@${range} exited ${r.status}: ${reason}`);
  } else if ((r.stdout || '').trim() === '') {
    fail(
      'template-pins',
      `${name}@${range} matches NO published version (notarget) — publish is due`,
    );
  } else {
    console.log(`ok   ${name}@${range} resolves`);
  }
}

// ── Phase 2: the stranger quickstart, verbatim ───────────────────────────────

console.log('── phase 2: latest PUBLISHED CLI → create → npm install ──');
const work = mkdtempSync(join(tmpdir(), 'knext-stranger-'));
try {
  const appDir = join(work, 'app');
  // `npm exec` fetches the published package and runs its `kn-next` bin — the
  // documented `npx` path with the version made explicit.
  const create = spawnSync(
    'npm',
    [
      'exec',
      '--yes',
      '--package=@getknext/core@latest',
      '--',
      'kn-next',
      'create',
      appDir,
      '--name',
      'knext-stranger',
    ],
    { cwd: work, encoding: 'utf8', timeout: 300_000 },
  );
  process.stdout.write(create.stdout || '');
  process.stderr.write(create.stderr || '');
  if (create.status !== 0) {
    fail('stranger-quickstart', `kn-next create (published CLI) exited ${create.status}`);
  } else {
    const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: appDir,
      encoding: 'utf8',
      timeout: 600_000,
    });
    if (install.status !== 0) {
      fail(
        'stranger-quickstart',
        `npm install of the scaffolded app exited ${install.status}: ${(install.stderr || '').trim().slice(0, 500)}`,
      );
    } else {
      console.log('ok   scaffolded app npm-installs against the public registry');
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

// ── Phase 3: the whole stranger path, from a parent that has a lockfile ─────

console.log('── phase 3: npm i -> create -> build -> deploy --dry-run (parent lockfile) ──');
const strangerSpecs = (process.env.KNEXT_STRANGER_SPECS || '@getknext/core@next')
  .split(/\s+/)
  .filter(Boolean);
const work3 = mkdtempSync(join(tmpdir(), 'knext-stranger-path-'));
try {
  /** Run one step; record a failure (by exit code) and report whether to go on. */
  const step = (label, cmd, args, cwd, timeout) => {
    console.log(`$ ${cmd} ${args.join(' ')}   (in ${cwd})`);
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    if (r.status !== 0) {
      const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-12).join('\n');
      fail('stranger-path', `${label} exited ${r.status}: ${tail.slice(0, 1200)}`);
      return false;
    }
    return true;
  };
  const appDir = join(work3, 'my-app');
  const bin = join(work3, 'node_modules', '.bin', 'knext');
  // The CLI runs from node_modules/.bin, never a bare `npx knext`: that name on
  // the public registry is someone else's package.
  const ok =
    step('npm init', 'npm', ['init', '-y'], work3, 120_000) &&
    step(
      'npm i @getknext/core',
      'npm',
      ['i', '--no-audit', '--no-fund', ...strangerSpecs],
      work3,
      600_000,
    ) &&
    step('knext create', bin, ['create', 'my-app', '--runtime', 'node', '--yes'], work3, 300_000) &&
    step('npm install (app)', 'npm', ['install', '--no-audit', '--no-fund'], appDir, 600_000);
  if (ok) {
    // A stranger replaces the registry placeholder before anything else works.
    const cfgPath = join(appDir, 'knext.config.ts');
    const cfg = readFileSync(cfgPath, 'utf8');
    if (!cfg.includes('ghcr.io/<your-user>')) {
      fail(
        'stranger-path',
        'knext.config.ts no longer carries the registry placeholder this step replaces',
      );
    } else {
      writeFileSync(cfgPath, cfg.replace('ghcr.io/<your-user>', 'ghcr.io/knext-stranger'));
      if (
        step('knext build', bin, ['build'], appDir, 900_000) &&
        step('knext deploy --dry-run', bin, ['deploy', '--dry-run'], appDir, 900_000)
      ) {
        console.log('ok   npm i -> create -> build -> deploy --dry-run under a parent lockfile');
      }
    }
  }
} finally {
  rmSync(work3, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('\nscaffold-install: all checks passed');
