#!/usr/bin/env bun
/**
 * Run the pinned, checksum-verified buf (src/buf.ts) with this script's
 * arguments, in the current directory. CI uses it for `buf lint` and
 * `buf breaking` so the binary it runs is the one the lockfile and the sha256
 * pin agree on — never one from PATH or a network install.
 *
 *   bun scripts/verified-buf.ts lint
 *   bun scripts/verified-buf.ts breaking --against '../../.git#ref=<sha>,subdir=packages/grpc'
 */

import { runBuf } from '../src/buf';

const r = runBuf(process.argv.slice(2), { cwd: process.cwd() });
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exit(r.status ?? 1);
