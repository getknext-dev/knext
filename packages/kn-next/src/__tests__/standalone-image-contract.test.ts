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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// packages/kn-next/src/__tests__ -> package root (../..)
const PKG_ROOT = resolve(__dirname, "..", "..");
// NOT templates/app — see the relocation note in Dockerfile.standalone.hbs's
// own header: this template lives outside the tree `kn-next create` walks
// with no allowlist, so it is not (yet) emitted into a scaffolded app (#1155
// Blocker 2 — templates/app/ had no allowlist, so every `.hbs` under it was
// shipped into every new app, including this not-yet-buildable recipe).
const TEMPLATE_DIR = join(PKG_ROOT, "templates", "runtime-standalone");
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
                // The SOURCE is normalized (trailing slash stripped) before
                // matching: `COPY .next/standalone/ /app` is the same
                // collision as `COPY .next/standalone /app`, and a regex that
                // only matched the no-slash form let a trailing-slash variant
                // through uninspected.
                const m = line.match(
                    /^COPY\s+(?:--from=\S+\s+)?(\.next\/standalone)\/?\s+(\S+)\s*$/,
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

/**
 * The runtime closure the ENTRYPOINT actually needs — walked from the BUILT
 * `dist/`, not asserted by string-matching Dockerfile prose. The assertion
 * this replaces — `expect(body()).toMatch(/@getknext\/core\/dist\/adapters/)`
 * — matched a substring the Dockerfile happened to contain; it did not
 * establish that anything actually resolves. tsup's ESM chunk-splitting puts
 * code the entry STATICALLY imports (the shared logger chunk) at `dist/`
 * ROOT, outside `dist/adapters`, so the COPY that assertion pinned was
 * provably insufficient — the image crash-looped with `ERR_MODULE_NOT_FOUND`
 * at boot.
 *
 * `dist/` must exist: CI builds @getknext/core before running this suite
 * (ci.yml's `lint-and-test` job runs `bun run --filter @getknext/core build`
 * before the test step) — the same precondition `cli-node-runtime.test.ts`
 * already depends on.
 */
describe("@getknext/core's runtime closure actually resolves under what the Dockerfile COPYs", () => {
    const DIST_ROOT = join(PKG_ROOT, "dist");
    const ENTRY_REL = "adapters/node-server.js";

    function readDistFile(rel: string): string {
        const full = join(DIST_ROOT, rel);
        if (!existsSync(full)) {
            throw new Error(
                `${full} missing — run 'bun run build' in packages/kn-next ` +
                    "before this suite (CI builds @getknext/core before " +
                    "test; see ci.yml's lint-and-test job).",
            );
        }
        return readFileSync(full, "utf8");
    }

    /** Join + normalize a relative specifier against a dist-relative dir, POSIX-style. */
    function joinRel(dir: string, spec: string): string {
        const parts = (dir === "." ? [] : dir.split("/")).concat(
            spec.split("/"),
        );
        const out: string[] = [];
        for (const part of parts) {
            if (part === "." || part === "") continue;
            if (part === "..") out.pop();
            else out.push(part);
        }
        return out.join("/");
    }

    /**
     * Walk every STATIC `import ... from "./x"` / `export ... from "./x"`
     * specifier, recursively, from `entryRel`. Bare (non-relative, non-`node:`)
     * specifiers are collected but not followed — they resolve via
     * node_modules, not the dist tree, and are checked separately below.
     */
    function staticClosure(entryRel: string): {
        relativeFiles: Set<string>;
        bareSpecifiers: Set<string>;
    } {
        const relativeFiles = new Set<string>();
        const bareSpecifiers = new Set<string>();
        const seen = new Set<string>();
        const queue = [entryRel];
        while (queue.length > 0) {
            const rel = queue.pop();
            if (rel === undefined || seen.has(rel)) continue;
            seen.add(rel);
            const text = readDistFile(rel);
            const dir = dirname(rel).replace(/\\/g, "/");
            for (const m of text.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
                const spec = m[1];
                if (spec.startsWith(".")) {
                    let next = joinRel(dir === "." ? "" : dir, spec);
                    if (!next.endsWith(".js")) next += ".js";
                    relativeFiles.add(next);
                    if (!seen.has(next)) queue.push(next);
                } else if (!spec.startsWith("node:")) {
                    bareSpecifiers.add(spec);
                }
            }
        }
        return { relativeFiles, bareSpecifiers };
    }

    const closure = staticClosure(ENTRY_REL);

    it("sanity: the walker actually walks (an empty closure would make every assertion below vacuous)", () => {
        expect(closure.relativeFiles.size).toBeGreaterThan(0);
    });

    it("the closure includes a relative chunk OUTSIDE dist/adapters — exactly what a dist/adapters-only COPY misses", () => {
        const outside = [...closure.relativeFiles].filter(
            (rel) => !rel.startsWith("adapters/"),
        );
        expect(
            outside.length,
            `closure: ${[...closure.relativeFiles].join(", ")}`,
        ).toBeGreaterThan(0);
    });

    describe.each([
        BUN_STAGE,
        NODE_STAGE,
    ])("%s: copies the WHOLE @getknext/core package (covers every dist/** chunk, not just dist/adapters)", (name) => {
        const body = () => stageMap.get(name) ?? "";

        it("COPYs node_modules/@getknext/core whole — an ancestor of every dist/ path, including the ones outside dist/adapters", () => {
            expect(body()).toMatch(
                /^COPY\s+node_modules\/@getknext\/core\s+\/app\/node_modules\/@getknext\/core\s*$/m,
            );
        });
    });

    describe.each([
        BUN_STAGE,
        NODE_STAGE,
    ])("%s: pino, prom-client and @opentelemetry/api — the load-bearing lazy/dynamic deps — resolve", (name) => {
        const body = () => stageMap.get(name) ?? "";

        it("pino is required somewhere in the closure (the exact crash this blocker fixes: the first log call requires it eagerly)", () => {
            const graphText = [ENTRY_REL, ...closure.relativeFiles]
                .map(readDistFile)
                .join("\n");
            expect(graphText).toMatch(/\(\s*["']pino["']\s*\)/);
        });

        it("the entry dynamically imports prom-client, and @getknext/core's own metrics module (reached the same way) imports @opentelemetry/api", () => {
            const entryText = readDistFile(ENTRY_REL);
            expect(entryText).toMatch(/import\(\s*["']prom-client["']\s*\)/);
            // metrics.js is reached only via a dynamic import() from the
            // entry (the :9464 endpoint is deferred off the cold-start
            // path per #441), so it is not in the STATIC closure above —
            // but once reached, its own top-level imports are
            // unconditional and must resolve too.
            const metrics = readDistFile("adapters/metrics.js");
            expect(metrics).toMatch(/from\s+["']@opentelemetry\/api["']/);
            expect(metrics).toMatch(/from\s+["']prom-client["']/);
        });

        it("a dedicated deps stage installs pino, prom-client and @opentelemetry/api, and this stage COPYs its resolved node_modules", () => {
            const depsStage = stageMap.get("standalone-deps") ?? "";
            expect(
                depsStage,
                "no `standalone-deps` stage — pino/prom-client/@opentelemetry/api have no resolved source",
            ).not.toBe("");
            expect(depsStage).toMatch(/npm\s+install[^\n]*\bpino@/);
            expect(depsStage).toMatch(/npm\s+install[^\n]*\bprom-client@/);
            expect(depsStage).toMatch(
                /npm\s+install[^\n]*@opentelemetry\/api@/,
            );
            expect(body()).toMatch(
                /^COPY\s+--from=standalone-deps\s+\/deps\/node_modules\s+\/app\/node_modules\s*$/m,
            );
        });
    });

    it("@getknext/lib/clients is a DOCUMENTED, deferred gap, not silently missing — both call sites fail open per their own source", () => {
        // The one dependency this template intentionally leaves unresolved
        // (see the deps-stage comment in Dockerfile.standalone.hbs for why:
        // @cerbos/grpc + minio + pg is real, disproportionate scope for a
        // template-only increment). Ties the deferral to the SOURCE behaviour
        // it relies on, not just Dockerfile prose — if either call site ever
        // stops failing open, this canary should be revisited.
        const dbDrainSrc = readFileSync(
            join(PKG_ROOT, "src", "adapters", "db-drain.ts"),
            "utf8",
        );
        expect(dbDrainSrc).toMatch(/draining must not throw/i);
        const imageCacheSyncSrc = readFileSync(
            join(PKG_ROOT, "src", "adapters", "image-cache-sync.ts"),
            "utf8",
        );
        expect(imageCacheSyncSrc).toMatch(/STORAGE_BUCKET/);
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
