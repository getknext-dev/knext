#!/usr/bin/env node
/**
 * Mutation proof for in-process Rust's build and image integration (issue
 * #2345, ADR-0069 D14, D15, D17).
 *
 * Four guards, four specs, each run one file per process:
 *
 *   - `ffi-image-staging.test.ts` — the integrity-manifest call on the
 *     standalone compile, the conditional `COPY native` line and its nest rule
 *     (both halves: opted in AND the D17 zero-diff), the anchor-count check, and
 *     vinext's clean-up leaving native/ffi/ alone;
 *   - `ffi-preflight.test.ts` — the two refusals and the caller-order scan;
 *   - `ffi-preflight-callers.test.ts` — the refusals reached through
 *     `knext build --skip-next`, `knext deploy --skip-build`,
 *     `knext deploy --image` and `knext preview`, the vinext × bun "nothing
 *     staged" refusal on `build --skip-next` and `deploy --skip-build` (and
 *     its absence on `deploy --image`), and the spec's own dry-run guard;
 *   - `packages/ffi/src/__tests__/ffi-build.test.ts` — `knext ffi build`'s
 *     libc allowlist, staging scope, drift check and cargo flags.
 *
 * Each mutation puts back ONE defect and requires its spec to go red.
 * Removing the preflight from `deploy()` (P03) is EXECUTED against the callers
 * spec, not proved against a source scan.
 * Executing it is safe because every deploy() there passes `--dry-run` (a scan
 * in that spec enforces it), and deploy.ts skips the prune preflight, docker
 * build/push and the CR apply on a dry run — so with the refusal gone deploy()
 * reaches the (mocked) freshness check and the spec goes red there, with no
 * cluster or docker call. The dry-run guard's own mutations (G01, G02) add a
 * deploy() call or argv assignment that never executes; none removes
 * `--dry-run`, which would run the prune preflight's kubectl calls.
 *
 * Verdicts are by EXIT CODE only (the shared driver,
 * `scripts/lib/guard-prover.mjs`, never parses output), every anchor must occur
 * exactly once (preflight first), each baseline must be green, a canary must go
 * red before any green is trusted, and every restore is content-verified.
 *
 * Usage:  node scripts/mutation-prove-ffi-build.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE_SPEC = 'packages/kn-next/src/__tests__/ffi-image-staging.test.ts';
const PREFLIGHT_SPEC = 'packages/kn-next/src/__tests__/ffi-preflight.test.ts';
const CALLERS_SPEC = 'packages/kn-next/src/__tests__/ffi-preflight-callers.test.ts';
const BUILD_SPEC = 'packages/ffi/src/__tests__/ffi-build.test.ts';

const IMAGE = [
  {
    id: 'I01',
    subject: 'artifact',
    claim: 'the standalone compile no longer writes native/.integrity.json for an opted-in app',
    anchor: '            writeNativeIntegrityManifest(nativeDir, findLockfile(cwd));',
    replacement: '',
  },
  {
    id: 'I02',
    subject: 'image',
    claim: 'the nest rule for the native COPY is dropped (opted-in nested app keeps the flat path)',
    anchor: '        ? [...BASE_NEST_RULES, FFI_NEST_RULE]',
    replacement: '        ? [...BASE_NEST_RULES]',
  },
  {
    id: 'I03',
    subject: 'image',
    claim: 'the nest rule is added unconditionally (a non-ffi nested Dockerfile changes)',
    anchor: '        : BASE_NEST_RULES;',
    replacement: '        : [...BASE_NEST_RULES, FFI_NEST_RULE];',
  },
  {
    id: 'I04',
    subject: 'image',
    claim: 'the COPY native line is added unconditionally (D17 zero-diff broken)',
    anchor: '    if (ffi) dockerfileText = insertFfiNativeCopy(dockerfileText);',
    replacement: '    dockerfileText = insertFfiNativeCopy(dockerfileText);',
  },
  {
    id: 'I05',
    subject: 'image',
    claim: 'a duplicated anchor is accepted (only a missing one fails)',
    anchor: '    if (hits.length !== 1) {',
    replacement: '    if (hits.length === 0) {',
  },
  {
    id: 'I06',
    subject: 'vinext',
    claim: 'vinext clean-up counts native/ffi/ as foreign content (first opted-in build refused)',
    anchor: '    const entries = readdirSync(dest).filter((e) => !kept(e));',
    replacement: '    const entries = readdirSync(dest);',
  },
  {
    id: 'I07',
    subject: 'vinext',
    claim: 'vinext clean-up deletes native/ffi/ when the previous manifest lists ffi/**',
    anchor: '            !kept(seg) &&',
    replacement: '',
  },
  {
    id: 'I08',
    subject: 'artifact',
    claim: 'the standalone compile no longer refuses an opted-in app with nothing staged',
    anchor:
      '            assertFfiLibraryStaged(cwd, arch, FFI_STAGED_REMEDY.compile);\n            writeNativeIntegrityManifest',
    replacement: '            writeNativeIntegrityManifest',
  },
  {
    id: 'I09',
    subject: 'vinext',
    claim: 'vinext clean-up keeps native/ffi/ after the app opts out (stale library shipped)',
    anchor: '    clearStagedNative(dest, { keepFfi: ffiOptedIn(cwd) });',
    replacement: '    clearStagedNative(dest, { keepFfi: true });',
  },
  {
    id: 'I10',
    subject: 'vinext',
    claim: 'vinext clean-up clears native/ffi/ even while the app opts in',
    anchor: '    clearStagedNative(dest, { keepFfi: ffiOptedIn(cwd) });',
    replacement: '    clearStagedNative(dest, { keepFfi: false });',
  },
];

const PREFLIGHT = [
  {
    id: 'P01',
    subject: 'preflight',
    claim: 'the Node refusal is gone',
    anchor: '    if ((config.runtime ?? DEFAULT_RUNTIME_ID) === "node") {',
    replacement: '    if ((config.runtime ?? DEFAULT_RUNTIME_ID) === "node-never") {',
  },
  {
    id: 'P02',
    subject: 'preflight',
    claim: 'the self-contained refusal is gone',
    anchor: '    if (resolveSelfContained(config, opts.selfContained)) {',
    replacement: '    if (false && resolveSelfContained(config, opts.selfContained)) {',
  },
  // P03 (deploy() without the preflight) is EXECUTED against the callers spec;
  // see CALLERS below.
  {
    id: 'P04',
    subject: 'deploy',
    claim: 'deploy() no longer dispatches knext ffi build before the project build',
    anchor: '        await runFfiBuildStep(process.cwd(), DEPLOY_SHIP_ARCH);',
    replacement: '',
  },
  {
    id: 'P05',
    subject: 'preview',
    claim: 'preview no longer dispatches knext ffi build before the project build',
    anchor: '    await runFfiBuildStep(process.cwd(), DEPLOY_SHIP_ARCH);',
    replacement: '',
  },
];

const CALLERS = [
  {
    id: 'C01',
    subject: 'coreBuild',
    claim:
      'knext build no longer calls the preflight (--skip-next ships a node/self-contained ffi app)',
    anchor:
      '    assertFfiTargetSupported(config, process.cwd(), {\n        selfContained: options.selfContained,\n    });',
    replacement: '',
  },
  {
    id: 'C02',
    subject: 'preview',
    claim: 'runPreviewDeploy no longer calls the preflight',
    anchor: '    assertFfiTargetSupported(config, process.cwd());',
    replacement: '',
  },
  {
    id: 'P03',
    subject: 'deploy',
    claim:
      'deploy() no longer calls the preflight (executed: --skip-build --dry-run reaches the freshness check)',
    anchor: '    assertFfiTargetSupported(baseConfig, process.cwd());',
    replacement: '',
  },
  {
    id: 'C04',
    subject: 'artifact',
    claim: 'the vinext × bun compile no longer refuses an opted-in app with nothing staged',
    anchor:
      '        // build leaves nothing `deploy --skip-build` would accept.\n        assertFfiLibraryStaged(cwd, arch, FFI_STAGED_REMEDY.compile);',
    replacement: '        // build leaves nothing `deploy --skip-build` would accept.',
  },
  {
    id: 'C05',
    subject: 'deploy',
    claim: 'deploy --skip-build no longer refuses an opted-in app with nothing staged',
    anchor:
      '        if (!options.image) {\n            assertFfiLibraryStaged(\n                process.cwd(),\n                DEPLOY_SHIP_ARCH,\n                FFI_STAGED_REMEDY.skipBuild,\n            );\n',
    replacement: '        if (!options.image) {\n',
  },
  {
    id: 'C06',
    subject: 'deploy',
    claim: 'the --skip-build refusal tells the user to drop --skip-next (a flag deploy lacks)',
    anchor: '                FFI_STAGED_REMEDY.skipBuild,',
    replacement: '                FFI_STAGED_REMEDY.compile,',
  },
  {
    id: 'C07',
    subject: 'deploy',
    claim: 'deploy --image <pre-built ref> is refused over a local native/ffi/ it never uses',
    anchor: '        if (!options.image) {\n            assertFfiLibraryStaged(',
    replacement:
      '        if (options.image || !options.image) {\n            assertFfiLibraryStaged(',
  },
  {
    // Was "the staged-library check is back inside the freshness check, which
    // --image also reaches". Since #2355 --image no longer reaches the
    // freshness check at all (its only caller is the non---image leg, where
    // the staged check already ran), so that mutation became equivalent. The
    // regression worth killing now is the freshness check escaping the guard.
    id: 'C08',
    subject: 'deploy',
    claim:
      'the local exec freshness check runs under deploy --image again, refusing a pre-built image over a stale local leftover',
    anchor:
      '            );\n            assertCompiledArtifactFresh(config, process.cwd());\n        }\n',
    replacement:
      '            );\n        }\n        assertCompiledArtifactFresh(config, process.cwd());\n',
  },
  {
    id: 'G01',
    subject: 'callersSpec',
    claim: 'a second deploy() call site appears outside runDeploy (never executed)',
    anchor: '    return deploy();\n}',
    replacement:
      '    return deploy();\n}\n\nexport async function unguardedDeploy(): Promise<void> {\n    return deploy();\n}',
  },
  {
    id: 'G02',
    subject: 'callersSpec',
    claim: 'a second argv assignment without --dry-run appears (never executed)',
    anchor: 'const savedArgv = process.argv;',
    replacement:
      'const savedArgv = process.argv;\nif (savedArgv.length < 0) process.argv = ["node", "kn-next.js"];',
  },
];

const BUILD = [
  {
    id: 'B01',
    subject: 'elf',
    claim: 'glibc libc.so.6 is on the musl allowlist',
    anchor:
      "  return new Set(['libc.so', `libc.musl-${arch}.so.1`, `ld-musl-${arch}.so.1`, 'libgcc_s.so.1']);",
    replacement:
      "  return new Set(['libc.so', 'libc.so.6', `libc.musl-${arch}.so.1`, `ld-musl-${arch}.so.1`, 'libgcc_s.so.1']);",
  },
  {
    id: 'B02',
    subject: 'ffiBuild',
    claim: 'staging clears the whole native/ dir, not only native/ffi/',
    anchor:
      "    const ffiDir = join(native, 'ffi');\n    rmSync(ffiDir, { recursive: true, force: true });",
    replacement:
      "    const ffiDir = join(native, 'ffi');\n    rmSync(native, { recursive: true, force: true });",
  },
  {
    id: 'B03',
    subject: 'ffiBuild',
    claim: 'the drift check never fails',
    anchor: '      if (drift.length > 0) {',
    replacement: '      if (drift.length < 0) {',
  },
  {
    id: 'B04',
    subject: 'ffiBuild',
    claim: 'the cross-build links libc statically again (-crt-static not turned off)',
    anchor:
      "      RUSTFLAGS: [baseEnv.RUSTFLAGS, '-C target-feature=-crt-static'].filter(Boolean).join(' '),",
    replacement: '      RUSTFLAGS: baseEnv.RUSTFLAGS,',
  },
  {
    id: 'B05',
    subject: 'ffiBuild',
    claim: 'the cross-build is no longer --locked',
    anchor: "          '--release',\n          '--locked',",
    replacement: "          '--release',",
  },
];

// The subjects are inline literals, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const image = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: IMAGE_SPEC,
  subjects: {
    artifact: 'packages/kn-next/src/cli/build-artifact.ts',
    image: 'packages/kn-next/src/cli/runtime-image.ts',
    vinext: 'packages/kn-next/src/cli/vinext-build.ts',
  },
});
const preflight = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: PREFLIGHT_SPEC,
  subjects: {
    preflight: 'packages/kn-next/src/cli/ffi-preflight.ts',
    deploy: 'packages/kn-next/src/cli/deploy.ts',
    preview: 'packages/kn-next/src/cli/preview.ts',
  },
});
const callers = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: CALLERS_SPEC,
  subjects: {
    coreBuild: 'packages/kn-next/src/cli/build.ts',
    preview: 'packages/kn-next/src/cli/preview.ts',
    deploy: 'packages/kn-next/src/cli/deploy.ts',
    artifact: 'packages/kn-next/src/cli/build-artifact.ts',
    callersSpec: 'packages/kn-next/src/__tests__/ffi-preflight-callers.test.ts',
  },
});
const ffiBuild = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: BUILD_SPEC,
  subjects: { ffiBuild: 'packages/ffi/src/build.ts', elf: 'packages/ffi/src/elf.ts' },
});

console.log('=== mutation proof: in-process Rust build and image (#2345) ===');
image.preflight(IMAGE);
preflight.preflight(PREFLIGHT);
callers.preflight(CALLERS);
ffiBuild.preflight(BUILD);
declareMutations(IMAGE.length + PREFLIGHT.length + CALLERS.length + BUILD.length);

console.log(
  '\n=== image spec (Dockerfile line, nest rule, integrity manifest, vinext clean-up) ===',
);
image.baseline();
image.proveCanSeeRed({
  subject: 'image',
  anchor: '    if (ffi) dockerfileText = insertFfiNativeCopy(dockerfileText);',
  replacement: '    dockerfileText = `${dockerfileText}\\n# canary`;',
});
for (const m of IMAGE) {
  image.run({ ...m, expect: 'red' });
  recordMutation();
}
image.finish(IMAGE.length);

console.log('\n=== preflight spec (refusals and the caller-order scan) ===');
preflight.baseline();
preflight.proveCanSeeRed({
  subject: 'preflight',
  anchor: '    if (!ffiOptedIn(cwd)) return;\n    if ((config.runtime',
  replacement: '    return;\n    if ((config.runtime',
});
for (const m of PREFLIGHT) {
  preflight.run({ ...m, expect: 'red' });
  recordMutation();
}
preflight.finish(PREFLIGHT.length);

console.log(
  '\n=== callers spec (refusals through build --skip-next, deploy --skip-build --dry-run and preview) ===',
);
callers.baseline();
callers.proveCanSeeRed({
  subject: 'preview',
  anchor: '    assertFfiTargetSupported(config, process.cwd());',
  replacement: '    throw new Error("canary");',
});
for (const m of CALLERS) {
  callers.run({ ...m, expect: 'red' });
  recordMutation();
}
callers.finish(CALLERS.length);

console.log('\n=== knext ffi build spec (libc check, staging scope, drift, cargo flags) ===');
ffiBuild.baseline();
ffiBuild.proveCanSeeRed({
  subject: 'ffiBuild',
  anchor: "export const PROVENANCE_FILE = 'provenance.json';",
  replacement: "export const PROVENANCE_FILE = 'provenance.canary.json';",
});
for (const m of BUILD) {
  ffiBuild.run({ ...m, expect: 'red' });
  recordMutation();
}
ffiBuild.finish(BUILD.length);
