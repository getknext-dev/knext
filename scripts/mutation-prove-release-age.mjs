#!/usr/bin/env node
/**
 * Mutation prover for the lockfile release-age gate.
 *
 * The guard is `tests/release-age-gate.test.ts` over `scripts/lib/release-age.mjs`
 * and `.github/workflows/release-age.yml`. Each row plants one regression and
 * requires the guard to go RED, by exit code:
 *
 *   A1  the boundary moves: an entry exactly as old as the quarantine fails.
 *   A2  the quarantine is not enforced (any age passes).
 *   A3  a registry failure is swallowed instead of failing the check (fail OPEN).
 *   A4  a lookup that returns a non-time is accepted.
 *   A5  first-party exclusions start to excuse an unresolved source.
 *   A6  an exception stops being scoped to its version.
 *   A7  the added-or-changed key forgets the lockfile.
 *   A8  an exception may outlive its 14-day cap.
 *   A9  exceptions accept a wildcard package.
 *   A10 the crates.io publish time is read from the wrong field.
 *   A11 Go module paths are not case-escaped for the proxy.
 *   A12 go.mod require blocks are ignored.
 *   A13 Cargo.lock path and git sources are treated as registry crates.
 *   A14 npm aliases are not resolved to the real package.
 *   A15 a freshness exception gets the long source-spec cap.
 *   U1-U4 a git/tarball source, a non-default registry, or an entry with no
 *       resolved URL is treated as a registry release (bun.lock, package-lock.json).
 *   U5  a Cargo alternate registry named like crates.io is accepted.
 *   U6-U8 go.mod replace handling: a local replace, a replaced-away require, the
 *       replacement module.
 *   U9-U10 an unresolved source passes / stops failing the check.
 *   U11 an exception may be dated in the future.
 *   U12 the OSV report stops listing what it did not cover.
 *   I1-I5 integrity: the entry key, bun.lock/package-lock.json reading, and the
 *       exception scope all forget the content hash (a tarball re-pinned to new
 *       bytes under the same URL passes).
 *   H1-H3 a hashless URL dependency is excusable by an exception / stops failing /
 *       is not classified as hashless.
 *   W1  the workflow gets a soft-fail flag.
 *   W2  the workflow's token gains a write scope.
 *   W3  the workflow stops fetching full history.
 *   W4  the pull_request trigger is removed.
 *   N1  negative control: the failure hint's wording changes.
 *   N2  negative control: the concurrency policy flips.
 *
 * Mutated JS is checked to still PARSE (the shared parse-validity hook) and mutated
 * YAML/JSON to still parse, so each red is a red for the reason its row claims.
 * Mid-line anchors embed the residue marker as a block comment, because the
 * harness's own line-comment marker would swallow the rest of the line.
 *
 *   node scripts/mutation-prove-release-age.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createGuardProver } from './lib/guard-prover.mjs';
import { MUTATION_MARKER } from './lib/mutation-harness.mjs';
import { jsStillParses } from './lib/parse-validity.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/release-age-gate.test.ts';
const M = MUTATION_MARKER;

const parsesYaml = (text) => {
  try {
    parse(text);
    return undefined;
  } catch (err) {
    return `not valid YAML: ${err.message}`;
  }
};

const MUTATIONS = [
  {
    id: 'A1',
    claim: 'an entry exactly as old as the quarantine fails',
    subject: 'lib',
    anchor: 'if (ageSeconds >= minSeconds) continue;',
    replacement: 'if (ageSeconds > minSeconds) continue;',
  },
  {
    id: 'A2',
    claim: 'the quarantine is not enforced',
    subject: 'lib',
    anchor: 'if (ageSeconds >= minSeconds) continue;',
    replacement: 'if (ageSeconds >= 0) continue;',
  },
  {
    id: 'A3',
    claim: 'a registry failure is swallowed (fail open)',
    subject: 'lib',
    anchor: 'errors.push({ ...e, error: err instanceof Error ? err.message : String(err) });',
    replacement: 'void err;',
  },
  {
    id: 'A4',
    claim: 'a lookup that returns a non-time is accepted',
    subject: 'lib',
    anchor: "if (!Number.isFinite(published)) throw new Error('lookup returned a non-time');",
    replacement: 'void 0;',
  },
  {
    id: 'A6',
    claim: 'an exception stops being scoped to its version',
    subject: 'lib',
    anchor: '        x.package === e.name &&\n        x.version === e.version &&',
    replacement: '        x.package === e.name &&',
  },
  {
    id: 'A7',
    claim: 'the added-or-changed key forgets the lockfile',
    subject: 'lib',
    anchor:
      "const keyOf = (e) => `${e.lockfile}|${e.ecosystem}|${e.name}|${e.version}|${e.integrity ?? ''}`;",
    replacement:
      "const keyOf = (e) => `${e.ecosystem}|${e.name}|${e.version}|${e.integrity ?? ''}`;",
  },
  {
    id: 'A9',
    claim: 'exceptions accept a wildcard package',
    subject: 'lib',
    anchor: ' || /[*?\\s]/.test(e.package)',
    replacement: ` /* ${M} */`,
  },
  {
    id: 'A10',
    claim: 'the crates.io publish time is read from the wrong field',
    subject: 'lib',
    anchor: 'json?.version?.created_at',
    replacement: `json?.version?.updated_at /* ${M} */`,
  },
  {
    id: 'A11',
    claim: 'Go module paths are not case-escaped for the proxy',
    subject: 'lib',
    anchor: 'const escaped = e.name.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);',
    replacement: 'const escaped = e.name;',
  },
  {
    id: 'A5',
    claim: 'first-party excludes start to excuse an UNRESOLVED source',
    subject: 'lib',
    anchor: 'if (e.unresolved) {\n      // No publish time exists',
    replacement: `if (e.unresolved && !excludes.includes(e.name) /* ${M} */) {\n      // No publish time exists`,
  },
  {
    id: 'A8',
    claim: 'an exception may outlive its cap',
    subject: 'lib',
    anchor: 'if (span > cap) {',
    replacement: `if (false /* ${M} */) {`,
  },
  {
    id: 'A12',
    claim: 'go.mod require/replace blocks are ignored',
    subject: 'lib',
    anchor: 'else handle(block, line, raw);',
    replacement: 'void 0;',
  },
  {
    id: 'A13',
    claim: 'a Cargo git or alternate-registry crate is silently dropped',
    subject: 'lib',
    anchor:
      "else out.push({ ecosystem: 'crates', name, version: source, unresolved: 'not crates.io' });",
    replacement: 'void 0;',
  },
  {
    id: 'A14',
    claim: 'npm aliases are not resolved to the real package',
    subject: 'lib',
    anchor: "if (spec.startsWith('npm:')) return npmFromId(spec.slice(4), registry);",
    replacement: `if (false /* ${M} */) return npmFromId(spec.slice(4), registry);`,
  },
  {
    id: 'A15',
    claim: 'a freshness exception gets the long source-spec cap',
    subject: 'lib',
    anchor:
      'const cap = SEMVERISH.test(e.version) ? MAX_EXCEPTION_DAYS : MAX_UNRESOLVED_EXCEPTION_DAYS;',
    replacement: 'const cap = MAX_UNRESOLVED_EXCEPTION_DAYS;',
  },
  {
    id: 'U1',
    claim: 'a bun.lock github:/tarball source is treated as a registry version',
    subject: 'lib',
    anchor: 'if (!SEMVERISH.test(spec)) {',
    replacement: `if (false /* ${M} */) {`,
  },
  {
    id: 'U2',
    claim: 'a bun.lock entry on a non-default registry is accepted',
    subject: 'lib',
    anchor: "if (typeof registry === 'string' && registry !== '') {",
    replacement: `if (false /* ${M} */) {`,
  },
  {
    id: 'U3',
    claim: 'a package-lock.json git or other-host source is treated as registry',
    subject: 'lib',
    anchor:
      "} else if (e.resolved.startsWith('https://registry.npmjs.org/') && SEMVERISH.test(version)) {",
    replacement: `} else if (e.resolved.startsWith('https://registry.npmjs.org/') || true /* ${M} */) {`,
  },
  {
    id: 'U4',
    claim: 'a package-lock.json entry with no resolved URL is accepted',
    subject: 'lib',
    anchor: "if (typeof e.resolved !== 'string') {",
    replacement: `if (false /* ${M} */) {`,
  },
  {
    id: 'U5',
    claim: 'a Cargo alternate registry with crates.io in its name is accepted',
    subject: 'lib',
    anchor: 'if (CRATES_IO_SOURCES.includes(source))',
    replacement: `if (source.includes('crates.io') /* ${M} */)`,
  },
  {
    id: 'U6',
    claim: 'a go.mod replace to a local directory is no longer skipped',
    subject: 'lib',
    anchor: 'if (isLocalPath(r.target)) continue;',
    replacement: `void 0; /* ${M} */`,
  },
  {
    id: 'U7',
    claim: 'a go.mod require that a replace swaps out is still age-checked',
    subject: 'lib',
    anchor: 'const out = requires.filter((e) => !replacedAway(e));',
    replacement: 'const out = [...requires];',
  },
  {
    id: 'U8',
    claim: 'a go.mod replacement is aged at the wrong module',
    subject: 'lib',
    anchor: 'name: r.target, version: r.targetVer',
    replacement: `name: r.old, version: r.targetVer /* ${M} */`,
  },
  {
    id: 'U9',
    claim: 'an unresolved source passes without an exception',
    subject: 'lib',
    anchor: '(isExcepted(e) ? excepted : unresolved).push(e);',
    replacement: 'excepted.push(e);',
  },
  {
    id: 'U10',
    claim: 'an unresolved source no longer fails the check',
    subject: 'lib',
    anchor: '  r.unresolved.length > 0 ||\n',
    replacement: `  false /* ${M} */ ||\n`,
  },
  {
    id: 'U11',
    claim: 'an exception may be dated in the future',
    subject: 'lib',
    anchor: 'if (e.added > today) throw',
    replacement: `if (false /* ${M} */) throw`,
  },
  {
    id: 'U12',
    claim: 'the OSV report stops listing what it did not cover',
    subject: 'lib',
    anchor: "if (bad.length === 0) return '';",
    replacement: `return ''; /* ${M} */`,
  },
  {
    id: 'I1',
    claim: 'the entry key forgets the integrity hash (a re-pinned tarball is not a change)',
    subject: 'lib',
    anchor:
      "const keyOf = (e) => `${e.lockfile}|${e.ecosystem}|${e.name}|${e.version}|${e.integrity ?? ''}`;",
    replacement: 'const keyOf = (e) => `${e.lockfile}|${e.ecosystem}|${e.name}|${e.version}`;',
  },
  {
    id: 'I2',
    claim: 'bun.lock integrity is no longer read for unresolved entries',
    subject: 'lib',
    anchor: '        e.integrity = integrity;',
    replacement: '        void integrity;',
  },
  {
    id: 'I3',
    claim: 'an exception stops being scoped to the integrity hash',
    subject: 'lib',
    anchor: '        x.version === e.version &&\n        x.integrity === e.integrity,',
    replacement: '        x.version === e.version,',
  },
  {
    id: 'I4',
    claim: 'package-lock.json integrity is dropped for unresolved entries',
    subject: 'lib',
    anchor: "unresolved: 'resolved outside registry.npmjs.org',\n        ...integrity,",
    replacement: "unresolved: 'resolved outside registry.npmjs.org',",
  },
  {
    id: 'I5',
    claim: 'a malformed exception integrity is accepted',
    subject: 'lib',
    anchor: 'if (e.integrity !== undefined && !/^[A-Za-z0-9+/=_.-]+$/.test(String(e.integrity))) {',
    replacement: `if (false /* ${M} */) {`,
  },
  {
    id: 'H1',
    claim: 'an exception can excuse a URL dependency that has no integrity hash',
    subject: 'lib',
    anchor: 'if (isHashlessUrlSource(e)) hashless.push(e);',
    replacement: `if (false /* ${M} */) hashless.push(e);`,
  },
  {
    id: 'H2',
    claim: 'a hashless URL dependency stops failing the check',
    subject: 'lib',
    anchor: '  (r.hashless?.length ?? 0) > 0;',
    replacement: `  false /* ${M} */;`,
  },
  {
    id: 'H3',
    claim: 'the hashless classifier treats a tarball with no hash as safe',
    subject: 'lib',
    anchor: '    Boolean(e.unresolved) &&',
    replacement: `    false /* ${M} */ &&`,
  },
  {
    id: 'H4',
    claim: 'any #fragment (branch, tag, range) pins a repo spec, not only a full commit sha',
    subject: 'lib',
    anchor: '|git\\+).*#(?:[0-9a-f]{40}|[0-9a-f]{64})$/;',
    replacement: `|git\\+).*#.+$/; /* ${M} */`,
  },
  {
    id: 'H5',
    claim: 'any non-empty integrity string counts as a hash (junk, whitespace)',
    subject: 'lib',
    anchor: "!SRI.test(e.integrity ?? '') &&",
    replacement: `!e.integrity /* ${M} */ &&`,
  },
  {
    id: 'H6',
    claim: 'bun.lock accepts a non-SRI trailing id as the hash of a tarball entry',
    subject: 'lib',
    anchor: 'if (integrity && (SRI.test(integrity) || REPO_SPEC.test(e.version))) {',
    replacement: `if (integrity /* ${M} */) {`,
  },
  {
    id: 'H7',
    claim: 'package-lock.json accepts a non-SRI integrity string as a hash',
    subject: 'lib',
    anchor: "typeof e.integrity === 'string' && SRI.test(e.integrity) ?",
    replacement: `typeof e.integrity === 'string' /* ${M} */ ?`,
  },
  {
    id: 'H8',
    claim: 'a codeload tarball at a full commit is wrongly refused as hashless',
    subject: 'lib',
    anchor: '    !COMMIT_TARBALL.test(e.version)',
    replacement: `    true /* ${M} */`,
  },
  {
    id: 'H9',
    claim: 'the commit-tarball exemption accepts any host, not only codeload.github.com',
    subject: 'lib',
    anchor: 'codeload\\.github\\.com',
    replacement: '[a-z.]+',
  },
  {
    id: 'H10',
    claim: 'the report calls every hashless entry a URL dependency again',
    subject: 'lib',
    anchor: 'unresolved dependenc${r.hashless.length',
    replacement: 'URL dependenc${r.hashless.length',
  },
  {
    id: 'W1',
    claim: 'the workflow gets a soft-fail flag',
    subject: 'wf',
    anchor: '      - name: Release-age gate\n        env:',
    replacement: '      - name: Release-age gate\n        continue-on-error: true\n        env:',
  },
  {
    id: 'W2',
    claim: "the workflow's token gains a write scope",
    subject: 'wf',
    anchor: 'permissions:\n  contents: read\n\nconcurrency:',
    replacement: 'permissions:\n  contents: read\n  pull-requests: write\n\nconcurrency:',
  },
  {
    id: 'W3',
    claim: 'the workflow stops fetching full history',
    subject: 'wf',
    anchor: '          fetch-depth: 0\n          persist-credentials: false',
    replacement: '          persist-credentials: false',
  },
  {
    id: 'W4',
    claim: 'the pull_request trigger is removed',
    subject: 'wf',
    anchor: '  pull_request:\n  push:',
    replacement: '  push:',
  },
  {
    id: 'N1',
    expect: 'green',
    claim: "the failure hint's wording changes",
    subject: 'lib',
    anchor: "'Wait, or record a short-lived entry in security/release-age-exceptions.json.',",
    replacement:
      "'Wait for it to age, or record a short-lived entry in security/release-age-exceptions.json.',",
  },
  {
    id: 'N2',
    expect: 'green',
    claim: "the workflow's concurrency policy flips",
    subject: 'wf',
    anchor: '  cancel-in-progress: true',
    replacement: '  cancel-in-progress: false',
  },
].map((m) => ({
  expect: 'red',
  validate: m.subject === 'lib' ? jsStillParses : parsesYaml,
  ...m,
}));

const CANARY = {
  subject: 'lib',
  anchor: 'export const MAX_EXCEPTION_DAYS = 14;',
  replacement: 'export const MAX_EXCEPTION_DAYS = 3650;',
};

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    lib: 'scripts/lib/release-age.mjs',
    wf: '.github/workflows/release-age.yml',
  },
});

console.log('=== mutation proof: lockfile release-age gate ===');
prover.preflight([...MUTATIONS, { id: 'canary', ...CANARY }]);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed(CANARY);
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);
