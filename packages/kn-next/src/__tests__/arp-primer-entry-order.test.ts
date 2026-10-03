/**
 * #1760 / #1863 — ARP primer wiring, per entry.
 *
 * `node-server.ts` is the supervisor for BOTH disk-mode children (a Node or
 * Bun `server.js`, spawned via `childSpawnPlan`); it has no sibling
 * supervisor for the compiled standalone-on-Bun executable, which carries no
 * supervisor at all (see `Dockerfile.standalone.hbs`'s ENTRYPOINT comment).
 * Neither does the compiled vinext executable, nor the vinext×node entry
 * (`node .output/server/index.mjs`, no supervisor in front of it either). So
 * the fix lands in FOUR different places:
 *
 *   - `node-server.ts` requires `arp-primer.cjs` directly, as the supervisor's
 *     OWN first action — before metrics bind, before the child is spawned.
 *     That is earlier than any `--require` preload the spawned child could
 *     run itself, so the child-side preload list is untouched.
 *   - `standalone-compile.mjs` bakes `arp-primer.cjs` into the compiled
 *     entry's preload list, FIRST — before every other preload and before
 *     Next's own `server.js` body.
 *   - `vinext-compile.mjs` (#1863) injects `arp-primer.cjs` as the compiled
 *     vinext executable's FIRST import — before the Bun.serve keep-alive
 *     guard, the sidecar resolver and the cache-control normalization, and
 *     before the nitro entry's own body.
 *   - `knext-node-entry.mjs.hbs` (#1863) imports the primer as this
 *     scaffolded file's very first statement — before even nitro's own
 *     `#nitro/virtual/polyfills` import — because vinext×node has no compile
 *     step of knext's own to hook into (nitro/vite build the app's own
 *     `.output/server/index.mjs` directly).
 *
 * These are source-order guards (the same pattern as
 * `deferred-default-metrics.test.ts`'s `createAt`/`spawnAt`/`listenAt`
 * assertions): they prove the TEXT ORDER in the committed source, which is
 * what actually determines execution order for a static require/compile-time
 * array — not a runtime behavior a unit test could otherwise observe without
 * a real Knative pod.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const NODE_SERVER_SRC = resolve(__dirname, "..", "adapters", "node-server.ts");
const STANDALONE_COMPILE_SRC = resolve(
    __dirname,
    "..",
    "adapters",
    "standalone-compile.mjs",
);
const VINEXT_COMPILE_SRC = resolve(
    __dirname,
    "..",
    "adapters",
    "vinext-compile.mjs",
);
const NODE_ENTRY_TEMPLATE_SRC = resolve(
    __dirname,
    "..",
    "..",
    "templates",
    "app",
    "knext-node-entry.mjs.hbs",
);

describe("node-server.ts — arp-primer fires before metrics bind and before spawn", () => {
    const src = readFileSync(NODE_SERVER_SRC, "utf8");

    it("requires arp-primer.cjs somewhere in the module", () => {
        expect(src).toContain('"arp-primer.cjs"');
        expect(src).toContain("createRequire(import.meta.url)(arpPrimerPath)");
    });

    it("fires arp-primer BEFORE the metrics endpoint binds", () => {
        const primerAt = src.indexOf(
            'resolve(import.meta.dirname, "arp-primer.cjs")',
        );
        const metricsListenAt = src.indexOf(
            'metricsEndpoint.ensureListening("',
        );
        expect(primerAt).toBeGreaterThan(-1);
        expect(metricsListenAt).toBeGreaterThan(-1);
        expect(primerAt).toBeLessThan(metricsListenAt);
    });

    it("fires arp-primer BEFORE the child is spawned", () => {
        const primerAt = src.indexOf(
            'resolve(import.meta.dirname, "arp-primer.cjs")',
        );
        const spawnAt = src.indexOf("spawn(spawnPlan.command");
        expect(primerAt).toBeGreaterThan(-1);
        expect(spawnAt).toBeGreaterThan(-1);
        expect(primerAt).toBeLessThan(spawnAt);
    });

    it("fires arp-primer as close to process start as possible — before bootTrace's entry-eval mark line completes, i.e. immediately after it", () => {
        const entryEvalAt = src.indexOf('bootTrace.mark("entry-eval")');
        const primerAt = src.indexOf(
            'resolve(import.meta.dirname, "arp-primer.cjs")',
        );
        expect(entryEvalAt).toBeGreaterThan(-1);
        expect(primerAt).toBeGreaterThan(entryEvalAt);
        // Nothing heavy should sit between the two: no "createLogger(" call in
        // between (the logger must not be constructed before the primer fires).
        const between = src.slice(entryEvalAt, primerAt);
        expect(between).not.toContain("createLogger(");
    });

    it("the require is wrapped so a failure to load the module can never throw out of the entry", () => {
        const primerAt = src.indexOf(
            'resolve(import.meta.dirname, "arp-primer.cjs")',
        );
        const nearby = src.slice(primerAt, primerAt + 400);
        expect(nearby).toContain("try {");
        expect(nearby).toContain("catch");
    });
});

describe("standalone-compile.mjs — arp-primer is the FIRST baked-in preload", () => {
    const src = readFileSync(STANDALONE_COMPILE_SRC, "utf8");

    it("lists arp-primer.cjs in PRELOAD_NAMES", () => {
        expect(src).toContain('"arp-primer.cjs"');
    });

    it("arp-primer.cjs is the FIRST entry in PRELOAD_NAMES — before cache-control-normalize, bun-keepalive-guard and request-body-cap", () => {
        const match = src.match(/const PRELOAD_NAMES = \[([\s\S]*?)\];/);
        expect(match).not.toBeNull();
        const names = (match as RegExpMatchArray)[1]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => s.replace(/^"|"$/g, ""));
        expect(names[0]).toBe("arp-primer.cjs");
        expect(names).toContain("cache-control-normalize.cjs");
        expect(names).toContain("bun-keepalive-guard.cjs");
        expect(names).toContain("request-body-cap.cjs");
    });
});

describe("vinext-compile.mjs — arp-primer is resolved and injected FIRST into the compiled entry (#1863)", () => {
    const src = readFileSync(VINEXT_COMPILE_SRC, "utf8");

    it("resolves arp-primer.cjs beside the compile script", () => {
        expect(src).toContain('join(compileHere, "arp-primer.cjs")');
        expect(src).toContain("const ARP_PRIMER_FILE");
    });

    it("fails closed (process.exit(1)) when arp-primer.cjs is missing, like every other baked-in preload", () => {
        const at = src.indexOf("const ARP_PRIMER_FILE");
        expect(at).toBeGreaterThan(-1);
        const nearby = src.slice(at, at + 800);
        expect(nearby).toContain("if (!existsSync(ARP_PRIMER_FILE))");
        expect(nearby).toContain("process.exit(1)");
    });

    it("ARP_PRIMER_FILE is resolved BEFORE the Bun.serve keep-alive guard (GUARD_FILE)", () => {
        const arpAt = src.indexOf("const ARP_PRIMER_FILE");
        const guardAt = src.indexOf("const GUARD_FILE");
        expect(arpAt).toBeGreaterThan(-1);
        expect(guardAt).toBeGreaterThan(-1);
        expect(arpAt).toBeLessThan(guardAt);
    });

    it("the injected entry preamble puts ARP_PRIMER_FILE's import FIRST — before GUARD_FILE, SIDECAR_INSTALL_FILE and CACHE_CONTROL_FILE", () => {
        const block = src.match(/const src =\s*\n([\s\S]*?)wrapped\.contents;/);
        expect(block).not.toBeNull();
        const body = (block as RegExpMatchArray)[1];
        const arpAt = body.indexOf("ARP_PRIMER_FILE");
        const guardAt = body.indexOf("GUARD_FILE");
        const sidecarAt = body.indexOf("SIDECAR_INSTALL_FILE");
        const cacheAt = body.indexOf("CACHE_CONTROL_FILE");
        expect(arpAt).toBeGreaterThan(-1);
        expect(guardAt).toBeGreaterThan(-1);
        expect(sidecarAt).toBeGreaterThan(-1);
        expect(cacheAt).toBeGreaterThan(-1);
        expect(arpAt).toBeLessThan(guardAt);
        expect(arpAt).toBeLessThan(sidecarAt);
        expect(arpAt).toBeLessThan(cacheAt);
    });

    it("the injected preamble is unconditional — present for both disk and self-contained builds", () => {
        const block = src.match(/const src =\s*\n([\s\S]*?)wrapped\.contents;/);
        expect(block).not.toBeNull();
        const body = (block as RegExpMatchArray)[1];
        // Only the embedded-public import is gated on SELF_CONTAINED; the
        // ARP_PRIMER_FILE line itself must not be inside that conditional.
        const arpLine = body
            .split("\n")
            .find((line) => line.includes("ARP_PRIMER_FILE"));
        expect(arpLine).toBeDefined();
        expect(arpLine as string).not.toContain("SELF_CONTAINED");
    });
});

describe("knext-node-entry.mjs.hbs — arp-primer is the FIRST statement, before nitro's polyfills import (#1863)", () => {
    const src = readFileSync(NODE_ENTRY_TEMPLATE_SRC, "utf8");

    it("imports the primer via the public @getknext/core/internal/arp-primer subpath", () => {
        expect(src).toContain("import '@getknext/core/internal/arp-primer';");
    });

    it("the @getknext/core/internal/arp-primer subpath the entry imports is declared in package.json's exports map, pointing at the real arp-primer.cjs", () => {
        const pkgPath = resolve(__dirname, "..", "..", "package.json");
        // biome-ignore lint/suspicious/noExplicitAny: reading arbitrary package.json shape
        const pkg: any = JSON.parse(readFileSync(pkgPath, "utf8"));
        expect(pkg.exports["./internal/arp-primer"]).toBe(
            "./dist/adapters/arp-primer.cjs",
        );
    });

    it("the primer import is BEFORE nitro's '#nitro/virtual/polyfills' import", () => {
        const primerAt = src.indexOf(
            "import '@getknext/core/internal/arp-primer';",
        );
        const polyfillsAt = src.indexOf("import '#nitro/virtual/polyfills';");
        expect(primerAt).toBeGreaterThan(-1);
        expect(polyfillsAt).toBeGreaterThan(-1);
        expect(primerAt).toBeLessThan(polyfillsAt);
    });

    it("the primer import is the FIRST import statement in the file (nothing else precedes it)", () => {
        const primerAt = src.indexOf(
            "import '@getknext/core/internal/arp-primer';",
        );
        expect(primerAt).toBeGreaterThan(-1);
        const before = src.slice(0, primerAt);
        expect(before).not.toMatch(/^\s*import\s/m);
    });

    it("the template's marker was bumped and its header + startup log agree (regression-proofs the version-drift check)", () => {
        const headerMatch = src.match(/KNEXT_NODE_ENTRY_MARKER:\s*(\d+)/);
        const logMatch = src.match(/console\.log\('NODE_ENTRY_MARKER:(\d+)'\)/);
        expect(headerMatch).not.toBeNull();
        expect(logMatch).not.toBeNull();
        expect((headerMatch as RegExpMatchArray)[1]).toBe(
            (logMatch as RegExpMatchArray)[1],
        );
    });
});
