/**
 * standalone-image-contract — the runtime image declares how to start itself
 * (ADR-0055).
 *
 * ADR-0055 moves the standalone start command OUT of the operator and INTO the
 * image: the image owns its ENTRYPOINT (a supervisor entry that imports
 * `@getknext/core/internal/node-server`), and the operator selects image + env
 * and never a command. This spec pins the image-contract half — the template
 * `Dockerfile.standalone.hbs` + its supervisor shim — so a regression that
 * re-collides the shim with the real Next server, drops the non-root user, or
 * ships node/npm into the bun runtime layer reds `bun test`, not a cluster.
 *
 * WHY THIS PARSES STAGES RATHER THAN RENDERING MUSTACHES.
 *
 * The runtime axis (bun vs node) is selected by the Docker build `--target`, NOT
 * by a Handlebars mustache. It has to be: `packages/kn-next/src/cli/create.ts`'s
 * `renderScaffold` is a pure `{{var}}` substitutor that runs over EVERY `.hbs`
 * under `templates/app` and THROWS on any leftover `{{`, so a `{{ runtime }}`
 * mustache in this file would break `kn-next create`. Docker-native `--target`
 * selection keeps the two digest-pinned base images literal and auditable in the
 * file (reused verbatim from the repo's existing pins) and gives each runtime its
 * own correct ENTRYPOINT (`node file` is not `node run file`). The build wiring
 * that picks the target is a separate ADR-0055 increment.
 *
 * The C5 path algebra (ADR-0055 §Consequences) is the load-bearing part and is
 * mutation-proved: WORKDIR /app, the compat shim at /app/server.js, and the REAL
 * Next server at the non-colliding /app/.next/standalone/server.js. A
 * conventional Next image copies the standalone tree's own `server.js` to exactly
 * /app/server.js — a collision where the wrong one wins silently. That is the bug
 * C5 exists to catch.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// packages/kn-next/src/__tests__ -> package root (../..)
const PKG_ROOT = resolve(__dirname, "..", "..");
const TEMPLATE_DIR = join(PKG_ROOT, "templates", "app");
const DOCKERFILE = join(TEMPLATE_DIR, "Dockerfile.standalone.hbs");
const ENTRY = join(TEMPLATE_DIR, "knext-standalone-entry.mjs.hbs");

/** Read a file, join line-continuations, drop comment lines so prose can't trip a match. */
function readJoined(path: string): string {
    return readFileSync(path, "utf8")
        .replace(/\\\n/g, " ")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
}

/**
 * Split a Dockerfile into stages keyed by their `AS <name>` alias. Comments are
 * stripped first (a prose `# FROM ...` must not open a phantom stage).
 */
function stages(dockerfile: string): Map<string, string> {
    const code = dockerfile
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
    const out = new Map<string, string>();
    // Each chunk after a `FROM` line; capture the stage alias when present.
    const parts = code.split(/^FROM /m).slice(1);
    for (const part of parts) {
        const header = part.split("\n", 1)[0] ?? "";
        const asMatch = header.match(/\bAS\s+([A-Za-z0-9_-]+)/i);
        if (asMatch) out.set(asMatch[1], `FROM ${part}`);
    }
    return out;
}

const dockerfile = readJoined(DOCKERFILE);
const stageMap = stages(dockerfile);
const BUN_STAGE = "standalone-bun";
const NODE_STAGE = "standalone-node";

describe("Dockerfile.standalone.hbs — ADR-0055 image-owned start contract", () => {
    it("defines both runtime target stages", () => {
        expect([...stageMap.keys()]).toEqual(
            expect.arrayContaining([BUN_STAGE, NODE_STAGE]),
        );
    });

    it("pins BOTH base images by digest (bun via oven/bun, node via node:22), reusing the repo's pins", () => {
        // The exact digests already pinned elsewhere in the repo — reused, not invented.
        expect(dockerfile).toContain(
            "oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb",
        );
        expect(dockerfile).toContain(
            "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
        );
        // Every external FROM carries a digest — none floats by tag.
        for (const line of dockerfile.split("\n")) {
            const m = line.match(/^FROM\s+(\S+)/);
            if (!m) continue;
            const ref = m[1];
            if (!ref.includes("/") && !ref.includes(":")) continue; // stage alias (FROM base-x)
            if (ref.startsWith("base-") || ref.startsWith("$")) continue; // intra-file alias
            expect(ref, `floating base image: ${ref}`).toMatch(
                /@sha256:[0-9a-f]{64}/,
            );
        }
    });

    it("carries the durable whole-base upgrade before linking libs (matches Dockerfile.hbs rationale)", () => {
        expect(dockerfile).toMatch(/apk\s+upgrade\s+--no-cache/);
        // No pinned package versions — they go stale like the digest.
        expect(dockerfile).not.toMatch(/apk\s+(add|upgrade)[^\n]*=\d/);
    });

    describe.each([BUN_STAGE, NODE_STAGE])("%s runtime stage", (name) => {
        const body = () => stageMap.get(name) ?? "";

        it("WORKDIR is /app (the forced legacy server.js is RELATIVE — the shim breaks if WORKDIR moves)", () => {
            expect(body()).toMatch(/^WORKDIR\s+\/app\s*$/m);
        });

        it("runs non-root as 65532", () => {
            expect(body()).toMatch(/^USER\s+65532:65532\s*$/m);
        });

        it("EXPOSEs 3000", () => {
            expect(body()).toMatch(/^EXPOSE\s+3000\s*$/m);
        });

        it("sets NODE_ENV=production", () => {
            expect(body()).toMatch(/\bNODE_ENV\s*=\s*production\b/);
        });

        // ---- C5 path algebra (mutation-proved) ----

        it("C5: copies the supervisor shim to the ENTRYPOINT target /app/knext-entry.mjs", () => {
            expect(body()).toMatch(
                /^COPY\s+\S*knext-standalone-entry\.mjs\s+\/app\/knext-entry\.mjs\s*$/m,
            );
        });

        it("C5: ALSO copies the SAME shim to /app/server.js (the R3 compat shim the old operator command names)", () => {
            expect(body()).toMatch(
                /^COPY\s+\S*knext-standalone-entry\.mjs\s+\/app\/server\.js\s*$/m,
            );
        });

        it("C5: puts the REAL Next standalone tree under /app/.next/standalone, so its own server.js is /app/.next/standalone/server.js", () => {
            // The standalone TREE (not its nested .next/static) must land under
            // .next/standalone, which puts the real server at the non-colliding
            // STANDALONE_SERVER_PATH.
            expect(body()).toMatch(
                /^COPY\s+(?:--from=\S+\s+)?\.next\/standalone\s+(?:\/app\/|\.\/|)\.next\/standalone\/?\s*$/m,
            );
        });

        it("C5: NEVER copies the standalone tree onto /app root, where its server.js would collide with the shim (the silent-wrong-one-wins bug)", () => {
            for (const line of body().split("\n")) {
                const m = line.match(
                    /^COPY\s+(?:--from=\S+\s+)?(\.next\/standalone)\s+(\S+)\s*$/,
                );
                if (!m) continue;
                const dest = m[2];
                // A collision is copying the tree to the WORKDIR root.
                expect(
                    [".", "./", "/app", "/app/"].includes(dest),
                    `standalone tree copied to '${dest}' — its server.js collides with the /app/server.js shim`,
                ).toBe(false);
            }
        });

        it("C5: names the non-colliding STANDALONE_SERVER_PATH at /app/.next/standalone/server.js", () => {
            expect(body()).toMatch(
                /STANDALONE_SERVER_PATH=\/app\/\.next\/standalone\/server\.js/,
            );
        });

        it("copies @getknext/core's dist/adapters so the shim's internal import resolves", () => {
            expect(body()).toMatch(/@getknext\/core\/dist\/adapters/);
        });

        it("ENTRYPOINT points at the supervisor entry /app/knext-entry.mjs", () => {
            const m = body().match(/^ENTRYPOINT\s+(\[.*\])\s*$/m);
            expect(m, "no exec-form ENTRYPOINT").toBeTruthy();
            expect(m?.[1]).toContain("/app/knext-entry.mjs");
        });
    });

    it("the bun runtime layer carries NO node and NO npm (built-image Trivy reds on bundled-npm CVEs)", () => {
        const body = stageMap.get(BUN_STAGE) ?? "";
        // No package-manager install of a node/npm runtime into the bun image.
        expect(body).not.toMatch(/apk\s+add[^\n]*\b(nodejs|npm)\b/);
        expect(body).not.toMatch(/\bnpm\s+(install|i|ci)\b/);
        // And the bun stage's base is the bun image, not node.
        expect(body).toMatch(/^FROM\s+oven\/bun:/m);
    });

    it("the node runtime stage's ENTRYPOINT invokes node (not `node run`, which is not a file runner)", () => {
        const body = stageMap.get(NODE_STAGE) ?? "";
        const m = body.match(/^ENTRYPOINT\s+(\[.*\])\s*$/m);
        expect(m?.[1]).toMatch(/"node"\s*,\s*"\/app\/knext-entry\.mjs"/);
    });

    it("the bun runtime stage's ENTRYPOINT invokes `bun run` on the entry", () => {
        const body = stageMap.get(BUN_STAGE) ?? "";
        const m = body.match(/^ENTRYPOINT\s+(\[.*\])\s*$/m);
        expect(m?.[1]).toMatch(
            /"bun"\s*,\s*"run"\s*,\s*"\/app\/knext-entry\.mjs"/,
        );
    });
});

describe("knext-standalone-entry.mjs.hbs — the dependency-free supervisor shim", () => {
    const entry = readFileSync(ENTRY, "utf8");

    it("imports the runtime-agnostic supervisor via the @getknext/core internal subpath", () => {
        expect(entry).toMatch(
            /import\(\s*['"]@getknext\/core\/internal\/node-server['"]\s*\)/,
        );
    });

    it("is dependency-free — it imports nothing but the supervisor subpath", () => {
        // A shim copied to BOTH /app/knext-entry.mjs and /app/server.js must not
        // pull in a relative module that only exists at one of those paths.
        const imports = [...entry.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(
            (m) => m[1],
        );
        const dynamic = [
            ...entry.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g),
        ].map((m) => m[1]);
        for (const spec of [...imports, ...dynamic]) {
            expect(
                spec === "@getknext/core/internal/node-server",
                `unexpected import '${spec}' in the shim`,
            ).toBe(true);
        }
    });
});
