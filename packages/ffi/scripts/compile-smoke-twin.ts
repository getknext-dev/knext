// Compiles a HOST-arch twin of a standalone build for the compat-smoke run,
// with core's own compile step (`buildStandaloneExecutable`, the function
// `knext build` ships the linux-musl executable with). The shipped executable
// targets bun-linux-*-musl and cannot run on a glibc runner; this is the same
// answer `knext build`'s post-compile smoke gives (vinext-build.ts,
// `hostSmokeArch`). The shipped binary itself is exercised by the kind deploy.
//
//   bun compile-smoke-twin.ts <app-dir> <out-file>
//
// <app-dir> holds the `.next/standalone` tree to compile; pass a COPY of the
// build's tree, so the original (whose freshness stamp `knext deploy
// --skip-build` checks) is never touched.

import { buildStandaloneExecutable } from '../../kn-next/src/cli/standalone-exec-build';
import { hostSmokeArch } from '../../kn-next/src/cli/vinext-build';

const [cwd, outFile] = process.argv.slice(2);
if (!cwd || !outFile) {
  console.error('usage: compile-smoke-twin.ts <app-dir> <out-file>');
  process.exit(2);
}
const arch = hostSmokeArch();
const binary = buildStandaloneExecutable({ cwd, arch, outFile });
console.log(`compiled the ${arch} smoke twin: ${binary}`);
