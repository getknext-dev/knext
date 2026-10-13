#!/usr/bin/env bun
/**
 * Run one of the package's verbs straight from source, exactly as
 * `knext <verb>` does once core has dispatched it. CI runs
 * `knext generate --check` over the fixture zone through this, which needs no
 * build and does not depend on the in-repo core version satisfying the
 * package's peer range (core's dispatch is tested on its own).
 *
 *   bun ../../scripts/knext-grpc.ts generate --check
 */

import { run } from '../src/cli';

process.exit(await run(process.argv[2] ?? '', process.argv.slice(3)));
