/**
 * Mutation prover for the install-smoke alias-coverage guards.
 * Each mutation is applied ALONE and graded on the runner's EXIT CODE — never on grepped
 * output — then restored byte-identically with a clean-tree assertion on both sides.
 *
 * Two expectations, because a guard that reds on EVERYTHING is as useless as one that
 * never reds: `expect: 'red'` mutations remove the behaviour under test and must kill the
 * gate; `expect: 'green'` mutations are LEGITIMATE changes the guard must tolerate, and
 * they fail the prover if the gate reds on them.
 *
 * Run only against a COMMITTED tree — restores are `git checkout -- .`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const WT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = join(WT, 'scripts', 'install-smoke.mjs');
const CHANGESET = join(WT, '.changeset', 'config.json');
const ALIAS_DIR = join(WT, 'packages', 'kn-next-alias');
const ALIAS_PKG = join(ALIAS_DIR, 'package.json');
const ALIAS_BIN = join(ALIAS_DIR, 'bin', 'kn-next.js');
const SHAPE_SPEC = 'tests/install-smoke-coverage-derivation.test.ts';
const NEWPUB_DIR = join(WT, 'packages', 'newpub');
const LIB_PKG = join(WT, 'packages', 'lib', 'package.json');
const LOCKSTEP_SPEC = 'tests/publish-preflight.test.ts';
// #927 round 2: the spec that OWNS the scaffolded `start` script (`:305`).
// install-smoke asserts nothing about it — the gate runs `npm run build`, never
// `npm start` — so M15 had no observer and SURVIVED once the run was honest.
// It was reported KILLED in round 1; that was a spurious red, and finding it
// took re-running the fleet rather than trusting the previous log.
const SCAFFOLD_SPEC = 'packages/kn-next/src/__tests__/create-scaffold.test.ts';
const TEMPLATE_DIR = join(WT, 'packages', 'kn-next', 'templates', 'app');
// `NEXT_CONFIG_TPL` and `ADAPTER_SRC` were dropped with the rewrite of M10
// (#912): the vinext template deliberately carries no `output` key and the
// adapter hooks are a mechanism vinext never calls, so neither file holds a
// subject this prover can mutate any more.
// #1342/ADR-0058: the vinext-shaped `start` script moved from `package.json.hbs`
// (now the DEFAULT/standalone target's content, `node .next/standalone/server.js`)
// to `package.json.vinext.hbs` (the `--builder vinext` content override) — install-
// smoke.mjs's vinext-target block still observes exactly this file (it now passes
// `--builder vinext` to `kn-next create`).
const APP_PKG_TPL = join(TEMPLATE_DIR, 'package.json.vinext.hbs');
const DOCKERFILE_TPL = join(TEMPLATE_DIR, 'Dockerfile.hbs');
const STASH = join(tmpdir(), 'knext-alias-shim-stash.js');
/**
 * The paths this prover touches. The clean assertion is scoped to them, not
 * repo-wide: a repo-wide check aborts on any unrelated untracked file (a review
 * note, a stray build artifact), which fails closed but leaves the prover
 * unrunnable in a working checkout and reds the nightly lane for a non-finding.
 * Scoping keeps residue INSIDE the mutated paths caught, which is the residue
 * that could actually grade a later mutation against a dirty tree.
 */
const MUTATED_PATHS = [
  'scripts/install-smoke.mjs',
  '.changeset/config.json',
  'packages/kn-next-alias',
  'packages/newpub',
  'packages/lib/package.json',
  'packages/kn-next/templates/app',
  'packages/kn-next/src/adapters/next-adapter.ts',
];

const git = (...a) => execFileSync('git', a, { cwd: WT, encoding: 'utf8' });

function clean(when) {
  const st = git('status', '--porcelain', '--', ...MUTATED_PATHS).trim();
  if (st !== '') {
    console.error(`ABORT: tree not clean ${when}:\n${st}`);
    process.exit(1);
  }
}

/** Exactly-once anchored substitution. A miss ABORTS — a silent no-op would grade green. */
function mutate(file, anchor, replacement, checkOnly = false) {
  const s = readFileSync(file, 'utf8');
  const n = s.split(anchor).length - 1;
  if (n !== 1) {
    console.error(`ABORT: anchor occurs ${n}x in ${file} (expected 1)`);
    process.exit(1);
  }
  if (checkOnly) return;
  writeFileSync(file, s.replace(anchor, replacement));
}

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    guard: 'derived coverage — a PUBLISHABLE package this gate does not pack',
    apply: (checkOnly) => mutate(SMOKE, '    [aliasTarball, aliasPkgDir],\n', '', checkOnly),
    restore: () => git('checkout', '--', '.'),
  },
  {
    id: 'M2',
    expect: 'red',
    graded: 'lockstep',
    guard:
      'the lockstep group loses a member — graded by the spec that OWNS that invariant, ' +
      'because this gate deliberately no longer reads `fixed`',
    // Round 2 of this prover caught its own obsolescence: while coverage derived from
    // `fixed`, this mutation reddened the gate. Now that coverage derives from the
    // PUBLISHABLE set (review finding B1), mutating `fixed` correctly cannot affect the
    // gate — it exited 0. That is the fix working, not a hole, but dropping a member
    // from `fixed` still ships a broken set, so the mutation moves to the guard that
    // owns it rather than being deleted.
    apply: (checkOnly) => mutate(CHANGESET, ', "kn-next"]]', ']]', checkOnly),
    restore: () => git('checkout', '--', '.'),
  },
  {
    id: 'M8',
    expect: 'red',
    guard: 'the OTHER direction — a package this gate packs that no longer publishes',
    // M1 proves a publishable package left unpacked fails. This proves the converse,
    // which nothing else covered once M2 stopped applying: mark a packed package
    // private and it leaves the publishable set while still being packed.
    apply: (checkOnly) =>
      mutate(
        LIB_PKG,
        '"name": "@getknext/lib",',
        '"name": "@getknext/lib",\n  "private": true,',
        checkOnly,
      ),
    restore: () => git('checkout', '--', '.'),
  },
  {
    id: 'M3',
    expect: 'red',
    guard: 'the alias declares a bin the tarball does not ship (pnpm pack exits 0 on this)',
    apply: () => renameSync(ALIAS_BIN, STASH),
    restore: () => {
      if (existsSync(STASH)) renameSync(STASH, ALIAS_BIN);
      git('checkout', '--', '.');
    },
  },
  {
    id: 'M4',
    expect: 'red',
    guard: 'the shim is shipped but does not forward to the real CLI',
    apply: () => writeFileSync(ALIAS_BIN, '#!/usr/bin/env node\nprocess.exit(3);\n'),
    restore: () => git('checkout', '--', '.'),
  },
  {
    id: 'M5',
    expect: 'green',
    guard: 'FALSE-POSITIVE CHECK — renaming the shim AND its `bin` mapping together is legitimate',
    apply: () => {
      const pkg = JSON.parse(readFileSync(ALIAS_PKG, 'utf8'));
      pkg.bin = { 'kn-next': 'bin/cli.js' };
      writeFileSync(ALIAS_PKG, `${JSON.stringify(pkg, null, 2)}\n`);
      renameSync(ALIAS_BIN, join(ALIAS_DIR, 'bin', 'cli.js'));
    },
    restore: () => {
      const moved = join(ALIAS_DIR, 'bin', 'cli.js');
      if (existsSync(moved)) rmSync(moved);
      git('checkout', '--', '.');
    },
  },
  {
    id: 'M6',
    expect: 'red',
    graded: 'shape',
    guard: 'the derivation replaced by a hardcoded list that names every package publishable TODAY',
    apply: (checkOnly) =>
      mutate(
        SMOKE,
        '  const publishable = publishablePackages(\n' +
          '    readWorkspaceManifests(repoRoot),\n' +
          '    Array.isArray(changesetConfig.ignore) ? changesetConfig.ignore : [],\n' +
          '  ).map((p) => p.name);',
        "  const publishable = ['@getknext/core', '@getknext/lib', '@getknext/db', 'kn-next'];",
        checkOnly,
      ),
    restore: () => git('checkout', '--', '.'),
  },
  {
    id: 'M9',
    expect: 'red',
    graded: 'shape',
    guard: "step 5's exports/bin completeness reverted to a hardcoded package list",
    // Round 2 of review found this uncovered by all eight declared mutations, and its
    // own mutation survived both graders. Graded by the shape spec because the gate
    // cannot see it: the derived and hardcoded forms check the same set TODAY.
    apply: (checkOnly) =>
      mutate(
        SMOKE,
        '  const entries = packed.map((p) => ({',
        '  const entries = [corePkgDir, libPkgDir, dbPkgDir].map((p) => ({',
        checkOnly,
      ),
    restore: () => git('checkout', '--', '.'),
  },
  {
    id: 'M10',
    expect: 'red',
    guard:
      'the image ships no static assets — a SILENT break, the build exits 0, the container ' +
      'boots, and every /_next/* request 404s',
    // REWRITTEN for the vinext shape (#912). It used to remove BOTH copies of
    // `output: "standalone"` — the template's and `next-adapter.ts`'s — because the
    // guarantee was held in two places and removing one was defense-in-depth working
    // rather than a hole. ADR-0048 removed the shape entirely: `next.config.ts.hbs`
    // deliberately has no `output` key (its absence is itself guard-tested) and the
    // adapter hooks are a webpack/turbopack mechanism vinext never calls, so BOTH
    // anchors were dead and this prover aborted here on every run since.
    //
    // The CLAIM survives unchanged — "the container has nothing to serve, and nothing
    // says so" — and `install-smoke.mjs` still asserts it, just against `.output/public`
    // instead of a standalone tree. So the mutation moves to the live subject rather
    // than being deleted.
    apply: (checkOnly) =>
      mutate(DOCKERFILE_TPL, 'COPY .output/public /app/.output/public\n', '', checkOnly),
    restore: () => git('checkout', '--', '.'),
  },
  {
    id: 'M11',
    expect: 'red',
    guard: 'the scaffolded app cannot install — a dependency the template names does not exist',
    apply: (checkOnly) =>
      mutate(APP_PKG_TPL, '"next": "16.3.3"', '"next": "0.0.0-does-not-exist"', checkOnly),
    restore: () => git('checkout', '--', '.'),
  },
  {
    id: 'M12',
    expect: 'red',
    guard:
      'the generated Dockerfile references a build tree this builder does not produce — the ' +
      'pre-vinext leftover the smoke exists to refuse',
    // REWRITTEN for the vinext shape (#912). It used to blank
    // `WORKDIR /repo/{{ standalonePrefix }}`, which ADR-0048 deleted along with the
    // whole standalone tree; the runtime image WORKDIRs at `/app` now.
    //
    // The surviving requirement is the one `install-smoke.mjs` still checks in both
    // directions: the Dockerfile must ship what the build emits AND must not reference
    // what it does not. Only the first half had a mutation; this covers the second,
    // which is the half that catches a template carrying dead COPYs beside live ones.
    apply: (checkOnly) =>
      mutate(
        DOCKERFILE_TPL,
        'COPY ${BINARY} /app/server\n',
        'COPY ${BINARY} /app/server\nCOPY .next/standalone /app/legacy\n',
        checkOnly,
      ),
    restore: () => git('checkout', '--', '.'),
  },
  // ── M13 RETIRED (#931) ────────────────────────────────────────────────────
  //
  // It mutated the trailing slash off `create.ts`'s `standalonePrefix` and was
  // graded by `build-context-root.test.ts` after #927 measured that no gate
  // could observe it (zero template consumers). #931 removed the surface itself
  // — the computation, the `standalonePrefixFor` export, and the specs that
  // asserted the value — so there is no subject left to mutate. Retired rather
  // than repointed, per the convention M16–M22 established below: inventing a
  // replacement to keep the count up would be the decoration this prover is
  // supposed to detect.
  {
    id: 'M14',
    expect: 'red',
    guard: 'the template stops declaring @getknext/core, which its own generated files import',
    // Review's RM3: this PASSED before, because the gate force-added every packed package
    // into `dependencies` and so put back exactly what the mutation removed — the gate was
    // testing a manifest it had rewritten rather than the one `create` emitted.
    apply: (checkOnly) =>
      mutate(APP_PKG_TPL, '    "@getknext/core": "^{{ version }}",\n', '', checkOnly),
    restore: () => git('checkout', '--', '.'),
  },
  // ── M16–M22 RETIRED (#912), with the reason each one is gone ──────────────
  //
  // All seven anchored on `{{ standalonePrefix }}` text inside the templates, and
  // graded against ~90 lines in `install-smoke.mjs` that derived a prefix from a
  // `WORKDIR /repo/...` line and checked four consumers of it. ADR-0048 deleted
  // both ends: no template consumes the prefix (measured — zero occurrences under
  // `packages/kn-next/templates` and `turbo/generators/templates`), and the smoke's
  // prefix block is gone, replaced by assertions against the REAL build output.
  //
  // These are retired rather than repointed because there is no vinext-era subject
  // to repoint them AT — the failure mode each described (assets landing a level
  // above where the server looks, a `--chown` flag disarming the reader, an indented
  // COPY evading both counters) was a property of parsing a prefix that no longer
  // exists. Inventing a replacement to keep the count up would be the decoration
  // this prover is supposed to detect.
  //
  //   M16 static COPY destination loses the prefix          -> no prefix exists; the
  //                                                            destination is a literal
  //                                                            `/app/.output/public`,
  //                                                            covered by M10.
  //   M17 public COPY destination loses the prefix          -> same, same.
  //   M18 static COPY lands at the image root               -> the `./` exception it
  //                                                            defeated was deleted with
  //                                                            the prefix rules.
  //   M19 a --chown flag disarms the COPY reader            -> nothing reads COPY flags
  //                                                            now; the smoke asserts
  //                                                            presence/absence of paths.
  //   M20 an indented COPY evades both counters             -> as M19; there are no
  //                                                            counters left to disagree.
  //   M21 destination carries the prefix, wrong place       -> no prefix.
  //   M22 the standalone COPY gains a prefixed destination  -> there is no standalone
  //                                                            COPY; M12 now covers the
  //                                                            inverse (a standalone
  //                                                            reference reappearing).
  //
  // WHAT THIS LOSES, STATED. Coverage of the scaffolded `start` script (old M15) and
  // of the Dockerfile's binary COPY destination. M15 is REPLACED below rather than
  // retired, because its subject survived the migration in a new spelling. The binary
  // COPY destination is now covered too: install-smoke reads the `COPY ${BINARY} <dest>`
  // destination and the exec-form CMD/ENTRYPOINT target from the generated Dockerfile
  // and requires them to be one path, and M23 below retargets the COPY to red it —
  // closing #930, the gap this block used to only name.
  {
    id: 'M15',
    expect: 'red',
    graded: 'scaffold',
    guard:
      "the template's `start` script points at a path this build does not emit — review " +
      'measured the pre-vinext form of this surviving the ENTIRE repo, because nothing ' +
      "anywhere asserted the scaffolded app's start script",
    // REPOINTED, not retired (#912): the old anchor was
    // `node .next/standalone/{{ standalonePrefix }}server.js`. The script still exists
    // and still names the server entry; under vinext it is `bun .output/server/index.mjs`,
    // which is the exact path `install-smoke.mjs` asserts the build produces.
    apply: (checkOnly) =>
      mutate(
        APP_PKG_TPL,
        '"start": "bun .output/server/index.mjs"',
        '"start": "bun .output/server.mjs"',
        checkOnly,
      ),
    restore: () => git('checkout', '--', '.'),
  },
  {
    id: 'M23',
    expect: 'red',
    guard:
      'the binary COPY destination no longer matches the image CMD — the #857 shape on the ' +
      'one Dockerfile path the smoke did not observe: `docker run` execs a path no COPY produced',
    // The COPY destination and the CMD target are `/app/server` in the template and must
    // stay equal. Retargeting only the COPY leaves the CMD pointing at nothing; before
    // #930 install-smoke never read the COPY destination, so this survived. It anchors the
    // same line M12 does, but the two are applied one at a time, so each is exactly-once.
    apply: (checkOnly) =>
      mutate(
        DOCKERFILE_TPL,
        'COPY ${BINARY} /app/server\n',
        'COPY ${BINARY} /app/elsewhere\n',
        checkOnly,
      ),
    restore: () => git('checkout', '--', '.'),
  },
  {
    id: 'M7',
    expect: 'red',
    graded: 'shape',
    guard:
      'a NEW publishable package that nobody adds to the gate (the review finding, reproduced)',
    apply: () => {
      mkdirSync(NEWPUB_DIR, { recursive: true });
      writeFileSync(
        join(NEWPUB_DIR, 'package.json'),
        `${JSON.stringify({ name: '@getknext/newpub', version: '0.3.1', main: 'index.js' }, null, 2)}\n`,
      );
      writeFileSync(join(NEWPUB_DIR, 'index.js'), 'module.exports = {};\n');
    },
    restore: () => {
      if (existsSync(NEWPUB_DIR)) rmSync(NEWPUB_DIR, { recursive: true, force: true });
      git('checkout', '--', '.');
    },
  },
];

const runSmoke = () =>
  spawnSync('node', ['scripts/install-smoke.mjs'], {
    cwd: WT,
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
  }).status;

/**
 * The PR-time half. The gate proves coverage is correct TODAY; it cannot catch a
 * derivation swapped for a hardcoded list that happens to name every package
 * publishable today and silently misses the next one. `SHAPE_SPEC` asserts the
 * derivation still exists, so mutations of that shape are graded here.
 */
const runSpec = (spec) => {
  // #902: per-spec dispatch — some specs here are bun:test, which vitest collects nothing from.
  const runner = resolveSpecRunner(WT, spec);
  return spawnSync(runner.command, [...runner.args, ...runner.runArgs(spec)], {
    cwd: WT,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  }).status;
};

// Preflight every anchored mutation BEFORE the first expensive run. An anchor
// invalidated by an unrelated edit used to surface as an abort seven mutations and
// twenty-five minutes in — which is how it surfaced on this very branch, when a
// hardening of `changesetConfig.ignore` moved the text M6 anchors on. It is still an
// ABORT and never a skip: a mutation whose anchor no longer matches proves nothing,
// and a prover that quietly carried on would report a clean sweep it did not run.
console.log('=== preflight: every anchored mutation must still match its subject ===');
const anchoredCount = MUTATIONS.filter((m) => m.apply.length > 0).length;
for (const m of MUTATIONS) {
  if (m.apply.length > 0) m.apply(true);
}
console.log(`preflight ok: ${anchoredCount} anchored mutation(s) still match`);

declareMutations(MUTATIONS.length);

clean('before the negative control');
console.log('=== negative control: unmutated tree must EXIT 0 (both graders) ===');
const ncShape = runSpec(SHAPE_SPEC);
console.log(`NC(shape) exit=${ncShape}`);
if (ncShape !== 0) {
  console.error(
    'ABORT: the shape spec is red before any mutation — M6/M7 would grade meaningless.',
  );
  process.exit(1);
}
const ncLock = runSpec(LOCKSTEP_SPEC);
console.log(`NC(lockstep) exit=${ncLock}`);
if (ncLock !== 0) {
  console.error(
    'ABORT: the lockstep spec is red before any mutation — M2 would grade meaningless.',
  );
  process.exit(1);
}
const ncScaffold = runSpec(SCAFFOLD_SPEC);
console.log(`NC(scaffold) exit=${ncScaffold}`);
if (ncScaffold !== 0) {
  console.error(
    'ABORT: the scaffold spec is red before any mutation — M15 would grade meaningless.',
  );
  process.exit(1);
}
const nc = runSmoke();
console.log(`NC exit=${nc}`);
if (nc !== 0) {
  console.error('ABORT: the harness cannot see green — every mutation below would be meaningless.');
  process.exit(1);
}

const results = [];
for (const m of MUTATIONS) {
  clean(`before ${m.id}`);
  m.apply();
  if (git('status', '--porcelain', '--', ...MUTATED_PATHS).trim() === '') {
    console.error(`ABORT: ${m.id} changed nothing — it would grade for free.`);
    process.exit(1);
  }
  const status =
    m.graded === 'shape'
      ? runSpec(SHAPE_SPEC)
      : m.graded === 'scaffold'
        ? runSpec(SCAFFOLD_SPEC)
        : m.graded === 'lockstep'
          ? runSpec(LOCKSTEP_SPEC)
          : runSmoke();
  recordMutation();
  m.restore();
  clean(`after ${m.id}`);
  const ok = m.expect === 'red' ? status !== 0 : status === 0;
  results.push({ ...m, status, ok });
  const verdict = ok ? (m.expect === 'red' ? 'KILLED' : 'TOLERATED') : '*** FAILED ***';
  console.log(
    `${m.id} expect=${m.expect} graded=${m.graded ?? 'gate'} exit=${status} ${verdict} — ${m.guard}`,
  );
}

const bad = results.filter((r) => !r.ok);
console.log(
  `\ndeclared=${MUTATIONS.length} run=${results.length} passed=${results.length - bad.length}`,
);
if (results.length !== MUTATIONS.length) {
  console.error('ABORT: a partial run is a FAILURE, not a pass.');
  process.exit(1);
}
if (bad.length > 0) {
  console.error(`FAILED: ${bad.map((b) => `${b.id}(expected ${b.expect})`).join(', ')}`);
  process.exit(1);
}
console.log('every declared mutation graded as expected; tree restored byte-identically');
