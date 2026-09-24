#!/usr/bin/env node
/**
 * `knext` — the canonical bin entry (#1369, replacing `kn-next`).
 *
 * This file is deliberately a thin RUNTIME PROXY, not the dispatcher itself.
 * The real dispatch logic (verb routing, --help/--version, the deploy flow)
 * still lives in `deploy.ts`, built as tsup's ONLY entry pointing at that
 * source file — see the SELF-ENTRY HAZARD note atop `deploy.ts`'s
 * `isEntrypoint(import.meta.url)` block for why: a SECOND tsup entry built
 * from the same source shares a chunk with the first, and inside that shared
 * chunk `import.meta.url` is the CHUNK's own URL, not either bin's — so
 * `isEntrypoint` stops matching and the dispatcher silently never fires for
 * EITHER bin. Measured live in this round (a real `tsup` build), not a
 * theoretical concern.
 *
 * So instead of a second build of deploy.ts, this is a tiny, SEPARATE source
 * file: it points `process.argv[1]` at the real `dist/cli/kn-next.js`
 * sibling (so `isEntrypoint` inside it still matches THAT file's own URL),
 * sets an env marker so the deprecation notice knows this is the canonical
 * invocation, and imports it. Same process, same argv (verb/flags), same
 * exit code — `knext` and `kn-next` are behaviourally identical except for
 * the one-line stderr notice.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./exec";
import { KNEXT_CANONICAL_BIN_ENV } from "./shared";

if (isEntrypoint(import.meta.url)) {
    process.env[KNEXT_CANONICAL_BIN_ENV] = "1";
    // Computed, not a string literal: `dist/cli/kn-next.js` does not exist
    // relative to THIS source file (only its compiled sibling does), so a
    // literal `import("./kn-next.js")` would fail tsup's static resolution
    // at BUILD time. A runtime-computed specifier is left alone by esbuild
    // (there is nothing to statically resolve) and only ever evaluated when
    // this proxy actually runs, against the real dist layout.
    const knNextEntry = join(
        dirname(fileURLToPath(import.meta.url)),
        "kn-next.js",
    );
    process.argv[1] = knNextEntry;
    await import(knNextEntry);
}
