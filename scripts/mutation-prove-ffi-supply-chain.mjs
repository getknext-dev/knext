#!/usr/bin/env node
/**
 * Mutation proof for the in-process Rust supply-chain gates (issue #2347,
 * ADR-0069 D16): the build-tool pins, zig's verified download, the git-source
 * rule, `cargo deny check` with the dated advisory allowlist, cargo-auditable's
 * embedded crate list, and the CycloneDX SBOM.
 *
 * Two specs, each run one file per process:
 *
 *   - `packages/ffi/src/__tests__/supply-chain.test.ts` — the gates unit by
 *     unit (pin table, one wrong-version test per tool, zig — re-extracted
 *     from the verified archive into a private directory on every build, never
 *     run from the cache, safe under concurrent builds, time-limited — allowlist,
 *     cargo-deny JSON replayed from the real tool, the .dep-v0 reader, SBOM);
 *   - `packages/ffi/src/__tests__/ffi-build.test.ts` — the same gates reached
 *     through `knext ffi build`: the advisory fixture fails the build, a dated
 *     entry passes, an expired one fails; a foreign git source is refused;
 *     the library must carry audit data; the SBOM is staged and hashed.
 *
 * Each mutation disables ONE gate (or one tool's pin) and requires its spec to
 * go red. Verdicts are by EXIT CODE only (the shared driver,
 * `scripts/lib/guard-prover.mjs`, never parses output), every anchor must occur
 * exactly once (preflight first), each baseline must be green, a canary must go
 * red before any green is trusted, and every restore is content-verified.
 *
 * Usage:  node scripts/mutation-prove-ffi-supply-chain.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_SPEC = 'packages/ffi/src/__tests__/supply-chain.test.ts';
const BUILD_SPEC = 'packages/ffi/src/__tests__/ffi-build.test.ts';

// The wrong-version refusal for the cargo tools, exactly once in supply-chain.ts.
const TOOL_REFUSAL =
  '    if (got !== pin.version) {\n      throw new FfiUsageError(\n        `${pin.crate} ${got} is installed';
const toolSkips = (crate) =>
  TOOL_REFUSAL.replace(
    'if (got !== pin.version)',
    `if (got !== pin.version && pin.crate !== '${crate}')`,
  );

const UNIT = [
  // One per tool: that tool's wrong version is accepted, every other still refused.
  ...['cargo-zigbuild', 'cargo-deny', 'cargo-auditable', 'cargo-cyclonedx'].map((crate, i) => ({
    id: `T0${i + 1}`,
    subject: 'supply',
    claim: `a wrong ${crate} version is accepted`,
    anchor: TOOL_REFUSAL,
    replacement: toolSkips(crate),
  })),
  {
    id: 'T05',
    subject: 'supply',
    claim: 'cargo-auditable is version-probed like the others (it has no version flag)',
    anchor:
      "  if (tool === 'auditable') return installedVersion(bin, CARGO_TOOL_PINS.auditable.crate);\n",
    replacement: '',
  },
  {
    id: 'T06',
    subject: 'supply',
    claim: 'the pin table drifts from its test (a silent bump)',
    anchor: "    crate: 'cargo-deny',\n    version: '0.20.2',",
    replacement: "    crate: 'cargo-deny',\n    version: '0.20.3',",
  },
  {
    id: 'Z01',
    subject: 'supply',
    claim: 'a zig on PATH at another version is accepted',
    anchor:
      "    if (got !== pin.version) {\n      throw new FfiUsageError(\n        `zig ${got ?? '(version unreadable)'} is on PATH",
    replacement:
      "    if (false) {\n      throw new FfiUsageError(\n        `zig ${got ?? '(version unreadable)'} is on PATH",
  },
  {
    id: 'Z02',
    subject: 'supply',
    claim: 'a downloaded zig archive whose sha256 differs from the pin is accepted',
    anchor: '  if (got !== asset.sha256) {',
    replacement: '  if (false) {',
  },
  {
    id: 'Z03',
    subject: 'supply',
    claim: 'a cached zig archive is trusted without re-hashing',
    anchor: '  if (bytes === undefined || sha256Hex(bytes) !== asset.sha256) {',
    replacement: '  if (bytes === undefined) {',
  },
  {
    id: 'Z04',
    subject: 'supply',
    claim: 'a downloaded zig reporting another version is accepted',
    anchor: '  if (got !== pin.version) {\n    rmSync(scratch, { recursive: true, force: true });',
    replacement: '  if (false) {\n    rmSync(scratch, { recursive: true, force: true });',
  },
  {
    id: 'Z05',
    subject: 'supply',
    claim: 'cargo-zigbuild is not told which zig to use (it would prefer python3 -m ziglang)',
    anchor:
      "  return { CARGO_ZIGBUILD_ZIG_COMMAND: zig.bin, CARGO_ZIGBUILD_ZIG_COMMAND_ARGS: '' };",
    replacement: '  return {};',
  },
  {
    id: 'Z06',
    subject: 'supply',
    claim:
      'a zig already extracted into the cache is run without re-extracting the verified archive',
    anchor:
      '  const bin = extractZig(run, cwd, bytes, asset.file, stem, pin.version, deps.tmpRoot);',
    replacement:
      '  const bin = existsSync(join(dir, stem, "zig")) ? join(dir, stem, "zig") : extractZig(run, cwd, bytes, asset.file, stem, pin.version, deps.tmpRoot);',
  },
  {
    id: 'Z07',
    subject: 'supply',
    claim: 'tar reads an archive copy outside the private directory',
    anchor: '    const copy = join(scratch, file);',
    replacement: '    const copy = join(dirname(scratch), `${file}.${basename(scratch)}`);',
  },
  {
    id: 'Z08',
    subject: 'supply',
    claim: "a build's private zig directory is never removed",
    anchor: '  if (zig.scratch !== null) rmSync(zig.scratch, { recursive: true, force: true });',
    replacement: '  void zig;',
  },
  {
    id: 'Z09',
    subject: 'supply',
    claim: 'the zig cache directories are created with the default (world-readable) mode',
    anchor: '    mkdirSync(dir, { recursive: true, mode: 0o700 });',
    replacement: '    mkdirSync(dir, { recursive: true });',
  },
  {
    id: 'Z10',
    subject: 'supply',
    claim: 'a failed extract leaves its directory behind',
    anchor:
      '    rmSync(scratch, { recursive: true, force: true });\n    if (err instanceof FfiUsageError) throw err;',
    replacement: '    if (err instanceof FfiUsageError) throw err;',
  },
  {
    id: 'Z11',
    subject: 'supply',
    claim: 'concurrent builds extract into one shared zig directory',
    anchor: "    scratch = mkdtempSync(join(tmpRoot, 'knext-zig-'));",
    replacement:
      "    scratch = join(tmpRoot, 'knext-zig-shared');\n    mkdirSync(scratch, { recursive: true });",
  },
  {
    id: 'Z12',
    subject: 'supply',
    claim: 'a cache that cannot be written fails with a raw fs error, not a usage error',
    anchor: '  } catch (err) {\n    throw new FfiUsageError(\n      `could not cache zig',
    replacement:
      '  } catch (err) {\n    throw err;\n    throw new FfiUsageError(\n      `could not cache zig',
  },
  {
    id: 'Z13',
    subject: 'supply',
    claim: 'the zig download timeout only signals abort, so a fetch that ignores it hangs',
    anchor: '      controller.abort();\n      reject(',
    replacement: '      controller.abort();\n      void (',
  },
  {
    id: 'G01',
    subject: 'supply',
    claim: 'a git source other than getknext-dev/knext is accepted',
    anchor: '    if (!allowed.has(repo)) refused.add(repo);',
    replacement: '    void repo;',
  },
  {
    id: 'A01',
    subject: 'supply',
    claim: 'an expired allowlist entry still covers its advisory',
    anchor: '    } else if (entry.expires !== undefined && entry.expires < today) {',
    replacement: '    } else if (false) {',
  },
  {
    id: 'A02',
    subject: 'supply',
    claim: 'an advisory deny.toml ignores (a note) escapes the dated allowlist',
    anchor: "    if (f.advisory && typeof f.advisory.id === 'string') {",
    replacement:
      "    if (f.advisory && typeof f.advisory.id === 'string' && severity === 'error') {",
  },
  {
    id: 'A03',
    subject: 'supply',
    claim: 'the bans/licenses/sources check result is ignored',
    anchor: '  if (notStarted(policyRun) || policyRun.status !== 0) {',
    replacement: '  if (false) {',
  },
  {
    id: 'A04',
    subject: 'supply',
    claim: 'an advisories run that fails without a diagnostic passes (fail open)',
    anchor: '  if (adv.status !== 0 && !sawError) {',
    replacement: '  if (false) {',
  },
  {
    id: 'A05',
    subject: 'supply',
    claim: 'a non-advisory error (yanked crate) is dropped',
    anchor: "    } else if (severity === 'error') {",
    replacement: '    } else if (false) {',
  },
  {
    id: 'A06',
    subject: 'supply',
    claim: 'an allowlist entry without an added date is accepted',
    anchor: '    if (!isIsoDate(e.added)) {',
    replacement: '    if (false) {',
  },
  {
    id: 'A07',
    subject: 'supply',
    claim: 'an allowlist entry without a justification is accepted',
    anchor: "    if (typeof e.justification !== 'string' || e.justification.trim() === '') {",
    replacement: '    if (false) {',
  },
  {
    id: 'U01',
    subject: 'supply',
    claim: 'audit data rooted at another crate is accepted',
    anchor:
      '  if (crateName !== null && !packages.some((p) => p.root === true && p.name === crateName)) {',
    replacement: '  if (false) {',
  },
  {
    id: 'S01',
    subject: 'supply',
    claim: 'a non-CycloneDX document is accepted as the SBOM',
    anchor: "  if (bom.bomFormat !== 'CycloneDX') throw bad('bomFormat is not \"CycloneDX\"');",
    replacement: '',
  },
  {
    id: 'S02',
    subject: 'supply',
    claim: 'an SBOM generated for another target is accepted',
    anchor: '  if (target !== undefined && target.value !== triple) {',
    replacement: '  if (false) {',
  },
];

const BUILD = [
  {
    id: 'B01',
    subject: 'supply',
    claim: 'cargo deny check never runs (the advisory fixture builds)',
    anchor: '    accepted = runCargoDeny({',
    replacement: '    accepted = [];\n    void ({',
  },
  {
    id: 'B02',
    subject: 'supply',
    claim: 'an expired allowlist entry still covers its advisory, through knext ffi build',
    anchor: '    } else if (entry.expires !== undefined && entry.expires < today) {',
    replacement: '    } else if (false) {',
  },
  {
    id: 'B03',
    subject: 'supply',
    claim: 'the git-source rule never runs',
    anchor: '  assertGitSources(opts.cargoLock, `${crateLabel}/Cargo.lock`);',
    replacement: '',
  },
  {
    id: 'B04',
    subject: 'supply',
    claim: 'the pinned cargo tools are never checked',
    anchor: '  const versions = checkCargoTools(run, crateDir, env);',
    replacement:
      "  const versions: Record<string, string> = { 'cargo-zigbuild': '0.23.4', 'cargo-deny': '0.20.2', 'cargo-auditable': '0.7.7', 'cargo-cyclonedx': '0.5.9' };",
  },
  {
    id: 'B05',
    subject: 'supply',
    claim: 'the build no longer runs through cargo auditable',
    anchor: "    cargoPrefix: ['auditable', 'zigbuild'],",
    replacement: "    cargoPrefix: ['zigbuild'],",
  },
  {
    id: 'B06',
    subject: 'build',
    claim: 'the built library is not checked for cargo-auditable data',
    anchor: '      supply.verifyLibrary(bytes, `${fileName} (${triple})`);\n',
    replacement: '',
  },
  {
    id: 'B07',
    subject: 'build',
    claim: 'the SBOM is not staged',
    anchor: '      writeFileSync(join(dir, SBOM_FILE), b.sbom);\n',
    replacement: '',
  },
  {
    id: 'B08',
    subject: 'build',
    claim: 'the verified zig is not handed to the cross-build',
    anchor: '      ...supply.env,\n',
    replacement: '',
  },
  {
    id: 'B09',
    subject: 'build',
    claim: 'provenance.json no longer records the tool versions and accepted advisories',
    anchor: '        ...supply.provenance,\n',
    replacement: '',
  },
  {
    id: 'B11',
    subject: 'build',
    claim: 'knext ffi build never releases its private zig',
    anchor: '    supply?.dispose();\n',
    replacement: '',
  },
  {
    id: 'B12',
    subject: 'supply',
    claim: 'a cargo deny failure after zig was extracted leaks the private zig',
    anchor: '    releaseZig(zig);\n    throw err;',
    replacement: '    throw err;',
  },
  {
    id: 'B10',
    subject: 'supply',
    claim: 'a failed cargo cyclonedx run is ignored',
    anchor: '    if (notStarted(r) || r.status !== 0 || !existsSync(out)) {',
    replacement: '    if (false) {',
  },
];

// The subjects are inline literals, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const unit = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: UNIT_SPEC,
  subjects: { supply: 'packages/ffi/src/supply-chain.ts' },
});
const build = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: BUILD_SPEC,
  subjects: {
    supply: 'packages/ffi/src/supply-chain.ts',
    build: 'packages/ffi/src/build.ts',
  },
});

console.log('=== mutation proof: in-process Rust supply chain (#2347) ===');
unit.preflight(UNIT);
build.preflight(BUILD);
declareMutations(UNIT.length + BUILD.length);

console.log('\n=== supply-chain spec (pins, zig, git sources, advisories, audit data, SBOM) ===');
unit.baseline();
unit.proveCanSeeRed({
  subject: 'supply',
  anchor: "export const SBOM_FILE = 'sbom.cdx.json';",
  replacement: "export const SBOM_FILE = 'sbom.canary.json';\nthrow new Error('canary');",
});
for (const m of UNIT) {
  unit.run({ ...m, expect: 'red' });
  recordMutation();
}
unit.finish(UNIT.length);

console.log('\n=== knext ffi build spec (the gates reached through the build) ===');
build.baseline();
build.proveCanSeeRed({
  subject: 'build',
  anchor: "export const PROVENANCE_FILE = 'provenance.json';",
  replacement: "export const PROVENANCE_FILE = 'provenance.canary.json';",
});
for (const m of BUILD) {
  build.run({ ...m, expect: 'red' });
  recordMutation();
}
build.finish(BUILD.length);
