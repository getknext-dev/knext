/**
 * The `Bun.serve` keep-alive guard — the vinext-lane sibling of the node #188
 * guard, on the transport the node one structurally cannot reach.
 *
 * Root cause (`.claude/vinext-nitro-reset-rootcause.md`): the vinext runtime
 * serves via nitro's bun preset → srvx/bun → `Bun.serve`, and Bun resets a
 * REUSED keep-alive socket on an immediate back-to-back request — `socket hang
 * up`, no HTTP response, clean log, ~1 ms. It is MEASURED still-present at Bun
 * 1.4.2 on linux-x64, so — unlike the node guard, which self-disables at ≥1.4.0
 * — this guard carries NO version ceiling and is always on under Bun.
 *
 * The bug is linux-x64-timing-specific and does not reproduce on darwin, so the
 * behavioural proof here is the mechanism (every served response carries
 * `Connection: close`), not the reset itself; the reset recovery is proved by
 * the compat lane re-run.
 *
 * Two wirings ship the guard, and each is guarded here (mutation-proved):
 *   1. the COMPILED single executable — vinext-compile.mjs injects an `import`
 *      of the guard as the entry's FIRST statement (a `bun --preload` cannot
 *      reach a compiled binary);
 *   2. the UNCOMPILED diagnostic boot — e2e-deploy-vinext.sh `bun --preload`s it.
 */

// Neutralise the module-load side effect BEFORE importing: under `bun test`
// `globalThis.Bun.serve` is the REAL function, and importing the guard would
// patch it process-wide. `=0` makes the load-time install a no-op; the tests
// below exercise install() against a FAKE Bun object with the guard enabled.
process.env.KNEXT_BUN_KEEPALIVE_GUARD = "0";

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    install,
    shouldInstall,
    stampConnectionClose,
    wrapFetch,
    wrapServeOptions,
} from "../adapters/bun-serve-keepalive-guard.mjs";

const ADAPTERS = resolve(import.meta.dirname, "../adapters");
const GUARD_SRC = resolve(ADAPTERS, "bun-serve-keepalive-guard.mjs");
const COMPILE_SRC = resolve(ADAPTERS, "vinext-compile.mjs");
const LANE = resolve(
    import.meta.dirname,
    "../../../../scripts/e2e-deploy-vinext.sh",
);

/** A minimal fake `globalThis.Bun` with a recording `serve`. */
function fakeBun(): {
    serve: (opts: unknown) => { opts: unknown };
    served: unknown[];
} {
    const served: unknown[] = [];
    return {
        served,
        serve(opts: unknown) {
            served.push(opts);
            return { opts };
        },
    };
}

describe("shouldInstall — Bun-only, NO version ceiling, one kill switch", () => {
    it("never installs off Bun (no Bun object, or no serve function)", () => {
        expect(shouldInstall({}, undefined)).toBe(false);
        expect(shouldInstall({}, {})).toBe(false);
        expect(shouldInstall({}, { serve: "not-a-function" as unknown })).toBe(
            false,
        );
    });

    it("installs under Bun regardless of version — the Bun.serve path has no known fix", () => {
        // The whole point of NOT copying the node guard's ceiling: measured broken
        // at 1.4.2, ceiling unknown. Bun-ness is decided by the serve function's
        // presence, not a version string, so there is no version to gate on.
        expect(shouldInstall({}, { serve: () => {} })).toBe(true);
    });

    it("honors the kill switch KNEXT_BUN_KEEPALIVE_GUARD=0 even under Bun", () => {
        expect(
            shouldInstall(
                { KNEXT_BUN_KEEPALIVE_GUARD: "0" },
                { serve: () => {} },
            ),
        ).toBe(false);
    });

    it('stays ON for any non-"0" value — "1" and unknown values do not disable it', () => {
        expect(
            shouldInstall(
                { KNEXT_BUN_KEEPALIVE_GUARD: "1" },
                { serve: () => {} },
            ),
        ).toBe(true);
        expect(
            shouldInstall(
                { KNEXT_BUN_KEEPALIVE_GUARD: "yes" },
                { serve: () => {} },
            ),
        ).toBe(true);
    });
});

describe("stampConnectionClose — best-effort, never throws", () => {
    it("sets Connection: close on a real Response", () => {
        const res = new Response("ok");
        expect(res.headers.get("connection")).toBeNull();
        stampConnectionClose(res);
        expect(res.headers.get("connection")).toBe("close");
    });

    it("returns the same object it was given (composes in a return position)", () => {
        const res = new Response("ok");
        expect(stampConnectionClose(res)).toBe(res);
    });

    it("is inert and silent on non-responses", () => {
        expect(() => stampConnectionClose(undefined)).not.toThrow();
        expect(() => stampConnectionClose(null)).not.toThrow();
        expect(() => stampConnectionClose(42)).not.toThrow();
        expect(stampConnectionClose("x")).toBe("x");
    });
});

describe("wrapFetch — stamps sync AND async returns, preserves call shape", () => {
    it("stamps a synchronously returned Response", () => {
        const wrapped = wrapFetch(() => new Response("sync"));
        const res = wrapped(new Request("http://x/"));
        expect((res as Response).headers.get("connection")).toBe("close");
    });

    it("stamps an asynchronously returned Response", async () => {
        const wrapped = wrapFetch(async () => new Response("async"));
        const res = await wrapped(new Request("http://x/"));
        expect((res as Response).headers.get("connection")).toBe("close");
    });

    it("passes every argument through unchanged", () => {
        const seen: unknown[] = [];
        const wrapped = wrapFetch((...args: unknown[]) => {
            seen.push(...args);
            return new Response("ok");
        });
        const req = new Request("http://x/");
        const server = { id: 1 };
        wrapped(req, server);
        expect(seen).toEqual([req, server]);
    });
});

describe("wrapServeOptions — clones, wraps fetch, never mutates the original", () => {
    it("wraps the fetch handler so its responses are stamped", () => {
        const original = { port: 3000, fetch: () => new Response("ok") };
        const wrapped = wrapServeOptions(original) as {
            fetch: (r: Request) => Response;
        };
        const res = wrapped.fetch(new Request("http://x/"));
        expect(res.headers.get("connection")).toBe("close");
    });

    it("does not mutate the original options object", () => {
        const originalFetch = () => new Response("ok");
        const original = { fetch: originalFetch };
        wrapServeOptions(original);
        expect(original.fetch).toBe(originalFetch);
    });

    it("leaves options WITHOUT a fetch function untouched (not the srvx shape)", () => {
        const routesOnly = { routes: {} };
        expect(wrapServeOptions(routesOnly)).toBe(routesOnly);
        expect(wrapServeOptions(undefined)).toBeUndefined();
    });
});

describe("install — patches Bun.serve end-to-end, idempotent, gated", () => {
    it("makes every response served through Bun.serve carry Connection: close", () => {
        const bun = fakeBun();
        // Mutation anchor: BEFORE install, the served response has no Connection.
        const preOpts = { fetch: () => new Response("ok") } as {
            fetch: (r: Request) => Response;
        };
        expect(
            preOpts.fetch(new Request("http://x/")).headers.get("connection"),
        ).toBeNull();

        expect(install(bun, {})).toBe(true);

        // AFTER install, the fetch Bun actually receives stamps the header.
        bun.serve({ fetch: () => new Response("ok") });
        const passed = bun.served[0] as { fetch: (r: Request) => Response };
        expect(
            passed.fetch(new Request("http://x/")).headers.get("connection"),
        ).toBe("close");
    });

    it("is a no-op when the kill switch is set (proves the gate is wired to install)", () => {
        const bun = fakeBun();
        const beforeServe = bun.serve;
        expect(install(bun, { KNEXT_BUN_KEEPALIVE_GUARD: "0" })).toBe(false);
        // serve was never replaced, so a served response is NOT stamped.
        expect(bun.serve).toBe(beforeServe);
        bun.serve({ fetch: () => new Response("ok") });
        const passed = bun.served[0] as { fetch: (r: Request) => Response };
        expect(
            passed.fetch(new Request("http://x/")).headers.get("connection"),
        ).toBeNull();
    });

    it("is idempotent — a second install does not double-wrap", () => {
        const bun = fakeBun();
        install(bun, {});
        const afterFirst = bun.serve;
        install(bun, {});
        expect(bun.serve).toBe(afterFirst);
    });

    it("never installs off Bun", () => {
        // An object with no serve function is "not Bun" — install must decline.
        const notBun = {} as { serve?: (o: unknown) => unknown };
        expect(install(notBun, {})).toBe(false);
    });
});

describe("wiring 1/2 — the COMPILED binary bakes the guard in (vinext-compile.mjs)", () => {
    const src = () => readFileSync(COMPILE_SRC, "utf8");

    it("resolves the guard beside vinext-compile, fail-closed if absent", () => {
        const s = src();
        // Both shipped (.js) and source (.mjs) names, so the resolution works from
        // dist AND from the source tree.
        expect(s).toContain("bun-serve-keepalive-guard.js");
        expect(s).toContain("bun-serve-keepalive-guard.mjs");
        // Fail-closed: a missing guard must abort the compile, not ship a binary
        // that reintroduces the reset cluster.
        expect(s).toMatch(/if\s*\(!GUARD_FILE\)/);
        expect(s).toContain("process.exit(1)");
    });

    it("injects the guard as (one of) the entry's FIRST import(s) (mutation anchor)", () => {
        // The exact injection statement inside the preamble array. Removing it —
        // the mutation — deletes this substring and reds the test. The preamble
        // (guard + otel shim, #1309) PREPENDS to the entry source (`${raw}` after
        // it), so the guard evaluates before srvx/bun calls Bun.serve.
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the LITERAL source substring being asserted, not a template
        const injection = "`import ${JSON.stringify(GUARD_FILE)};`";
        expect(src()).toContain(injection);
        // And the preamble as a whole still prepends to raw, in order.
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the LITERAL source substring being asserted, not a template
        expect(src()).toContain("const src = `${preamble}\\n${raw}`;");
    });

    it("the guard-resolution block actually points at THIS guard file", () => {
        // Recover and run the source's own resolution block (no duplication, so
        // drift cannot pass silently), with a stubbed __dirname = the real adapters
        // dir, and assert it lands on the guard that exists.
        const block = src().match(
            /const compileHere =[\s\S]*?\.find\(\(c\) => existsSync\(c\)\);/,
        );
        expect(
            block,
            "the GUARD_FILE resolution block moved — re-anchor",
        ).not.toBeNull();
        const resolved = new Function(
            "existsSync",
            "dirname",
            "join",
            "fileURLToPath",
            "import_meta_url",
            `${(block as RegExpMatchArray)[0].replace(
                "dirname(fileURLToPath(import.meta.url))",
                "dirname(fileURLToPath(import_meta_url))",
            )}\nreturn GUARD_FILE;`,
        )(
            (p: string) => p.endsWith("bun-serve-keepalive-guard.mjs"), // only the source name exists here
            (p: string) => p.split("/").slice(0, -1).join("/"),
            (...parts: string[]) => parts.join("/"),
            (u: string) => u.replace("file://", ""),
            `file://${COMPILE_SRC}`,
        );
        expect(String(resolved)).toContain("bun-serve-keepalive-guard.mjs");
        expect(String(resolved).startsWith(ADAPTERS)).toBe(true);
    });
});

describe("wiring 2/2 — the UNCOMPILED boot --preloads the guard (e2e-deploy-vinext.sh)", () => {
    const executable = () =>
        readFileSync(LANE, "utf8")
            .split("\n")
            .filter((line) => !line.trim().startsWith("#"))
            .join("\n");

    it("resolves the shipped guard from the installed @getknext/core, fail-closed", () => {
        const e = executable();
        expect(e).toMatch(
            /GUARD_PRELOAD=.*@getknext\/core\/dist\/adapters\/bun-serve-keepalive-guard\.js/,
        );
        // Fail-closed: a missing guard aborts the boot rather than serving without it.
        expect(e).toMatch(/if \[ ! -f "\$\{GUARD_PRELOAD\}" \]/);
    });

    it("the uncompiled boot passes --preload <guard> BEFORE the nitro entry (mutation anchor)", () => {
        // The exact boot form for KNEXT_COMPILE=0. Dropping the --preload — the
        // mutation — leaves `exec bun "${NITRO_ENTRY}"` and reds this.
        const e = executable();
        expect(e).toMatch(
            /exec bun --preload "\$\{GUARD_PRELOAD\}" "\$\{NITRO_ENTRY\}"/,
        );
    });

    it("the mutation is caught: a boot line without --preload fails the anchor", () => {
        // Prove the assertion above is not vacuous — the un-guarded boot form (what
        // the script said before this change) does NOT match the anchor.
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell fragment (the pre-change boot form), not a JS template
        const mutated = 'exec bun "${NITRO_ENTRY}"';
        expect(
            /exec bun --preload "\$\{GUARD_PRELOAD\}" "\$\{NITRO_ENTRY\}"/.test(
                mutated,
            ),
        ).toBe(false);
    });

    it("the guard source is Bun-only and dependency-free (no imports)", () => {
        // A dependency would break both the --preload and the bundle injection.
        const s = readFileSync(GUARD_SRC, "utf8");
        expect(s).not.toMatch(/^\s*import\s/m);
        expect(s).not.toMatch(/\brequire\s*\(/);
    });
});
