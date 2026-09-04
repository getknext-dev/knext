#!/usr/bin/env bun
/**
 * Writes `<native>/.integrity.json` for a tree staged OUTSIDE `kn-next build`.
 *
 * `apps/file-manager/Dockerfile` stages `@img` itself (`cp -RL`) inside its
 * builder stage rather than calling `stageSharpNative`, because the compile
 * happens in the image. That path needs the same pinning as the CLI path, and
 * the only way to guarantee they cannot drift is for both to run the SAME code
 * — hence a thin wrapper over the CLI module rather than a shell reimplementation
 * of sha256-a-tree-and-parse-a-lockfile.
 *
 * Run under bun (the builder image already is bun), which imports the TS source
 * directly; the module itself is node-builtins-only.
 *
 * Usage: bun scripts/write-native-integrity.mjs <native-dir> <bun.lock>
 */

import { writeNativeIntegrityManifest } from '../packages/kn-next/src/cli/native-integrity.ts';

const [nativeDir, lockfile] = process.argv.slice(2);
if (!nativeDir || !lockfile) {
  console.error('usage: bun scripts/write-native-integrity.mjs <native-dir> <bun.lock>');
  process.exit(2);
}

try {
  writeNativeIntegrityManifest(nativeDir, lockfile);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
console.log(`wrote ${nativeDir}/.integrity.json`);
