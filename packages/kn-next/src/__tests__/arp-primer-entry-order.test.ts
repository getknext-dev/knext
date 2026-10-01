/**
 * #1760 — ARP primer wiring, per entry.
 *
 * `node-server.ts` is the supervisor for BOTH disk-mode children (a Node or
 * Bun `server.js`, spawned via `childSpawnPlan`); it has no sibling
 * supervisor for the compiled standalone-on-Bun executable, which carries no
 * supervisor at all (see `Dockerfile.standalone.hbs`'s ENTRYPOINT comment).
 * So the fix lands in two different places:
 *
 *   - `node-server.ts` requires `arp-primer.cjs` directly, as the supervisor's
 *     OWN first action — before metrics bind, before the child is spawned.
 *     That is earlier than any `--require` preload the spawned child could
 *     run itself, so the child-side preload list is untouched.
 *   - `standalone-compile.mjs` bakes `arp-primer.cjs` into the compiled
 *     entry's preload list, FIRST — before every other preload and before
 *     Next's own `server.js` body.
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
