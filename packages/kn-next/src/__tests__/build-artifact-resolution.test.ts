/**
 * Track B3 — `kn-next build` resolves its expected artifact from the contract.
 *
 * Before this, `build.ts` hardcoded `.next/standalone` everywhere: the log
 * lines, the bun-exports heal, the bytecode pass, and the "is output:'standalone'
 * set?" warning. That is correct for turbopack and actively misleading for any
 * other builder — a vinext build would emit a warning naming a Next.js config
 * option that has nothing to do with why its output is elsewhere.
 *
 * The fix is not "add a vinext branch". It is to ask the contract where the
 * artifact should be, so that adding a builder does not mean auditing every
 * hardcoded path in the build command.
 */

import { describe, expect, it } from "bun:test";
import {
    resolveBuildArtifact,
    standaloneStepsApply,
} from "../cli/build-artifact";
import type { KnativeNextConfig } from "../config";

const cfg = (over: Partial<KnativeNextConfig> = {}): KnativeNextConfig =>
    ({ name: "app", registry: "r", ...over }) as KnativeNextConfig;

describe("#B3 resolveBuildArtifact", () => {
    it("defaults to VINEXT — still the default builder (#1167 keeps the flip gated)", () => {
        // Absence used to mean turbopack; ADR-0048 moved the default to vinext.
        // #1167 (ADR-0054) makes turbopack SELECTABLE again but leaves vinext
        // the default until the bun-standalone axis is credentialed — so an app
        // that sets nothing still gets the single executable.
        const r = resolveBuildArtifact(cfg(), "/app");

        expect(r.builder.id).toBe("vinext");
        expect(r.artifact.entry).toBe(".output/server/index.mjs");
        expect(r.artifact.shape).toBe("nitro-output-bun");
    });

    it("resolves an explicit vinext identically to the default", () => {
        expect(resolveBuildArtifact(cfg({ build: "vinext" }), "/app")).toEqual(
            resolveBuildArtifact(cfg(), "/app"),
        );
    });

    it("RESOLVES turbopack to the standalone shape — selectable again (#1167)", () => {
        // ADR-0054 item 6 re-opened turbopack. It resolves to the
        // `next-standalone` shape and is now an AVAILABLE builder.
        const r = resolveBuildArtifact(cfg({ build: "turbopack" }), "/app");

        expect(r.builder.id).toBe("turbopack");
        expect(r.builder.available).toBe(true);
        expect(r.artifact.shape).toBe("next-standalone");
    });

    it("RESOLVES vinext + runtime node to the node-preset shape (#1260)", () => {
        // The runtime is threaded into the contract: `kn-next build` must not
        // look for (and compile) a bun-preset artifact for a node app.
        const r = resolveBuildArtifact(
            cfg({ build: "vinext", runtime: "node" }),
            "/app",
        );
        expect(r.builder.id).toBe("vinext");
        expect(r.artifact.shape).toBe("nitro-output-node");
        expect(r.artifact.entry).toBe(".output/server/index.mjs");
        // Both halves: bun keeps the compiled shape.
        expect(
            resolveBuildArtifact(
                cfg({ build: "vinext", runtime: "bun" }),
                "/app",
            ).artifact.shape,
        ).toBe("nitro-output-bun");
        expect(
            standaloneStepsApply(r.artifact),
            "the node-preset nitro output has no .next/standalone tree",
        ).toBe(false);
    });

    it("threads the root through rather than assuming cwd", () => {
        expect(resolveBuildArtifact(cfg(), "/srv/other").artifact.root).toBe(
            "/srv/other",
        );
    });

    it("RESOLVES webpack to the standalone shape — same as turbopack (#1219)", () => {
        // webpack (`next build --webpack`) emits the identical
        // `.next/standalone` shape as turbopack.
        const r = resolveBuildArtifact(cfg({ build: "webpack" }), "/app");

        expect(r.builder.id).toBe("webpack");
        expect(r.builder.available).toBe(true);
        expect(r.artifact.shape).toBe("next-standalone");
        expect(r.artifact.entry).toBe(".next/standalone/server.js");
    });

    it("throws for a builder the contract does not know", () => {
        // Reached only if validation is bypassed, but it must not silently
        // fall back to turbopack — that would build the wrong thing and say
        // nothing, which is the #857 failure shape. `webpack` is now KNOWN
        // (#1219), so `rollup` stands in for "unrecognised" instead.
        expect(() =>
            resolveBuildArtifact(
                cfg({ build: "rollup" as unknown as "vinext" }),
                "/app",
            ),
        ).toThrow(/rollup/);
    });
});

describe("#B3 standaloneStepsApply", () => {
    // Both halves. The bun-exports heal and the bytecode pass operate on a
    // `.next/standalone` tree; running them for another shape is meaningless,
    // and WARNING about a missing standalone dir for a vinext build points the
    // user at a Next.js option that is not their problem.
    it("is true for the standalone shape (the retired turbopack path)", () => {
        expect(
            standaloneStepsApply(
                resolveBuildArtifact(cfg({ build: "turbopack" }), "/app")
                    .artifact,
            ),
        ).toBe(true);
    });

    it("is false for the nitro shape — which is now the DEFAULT", () => {
        expect(
            standaloneStepsApply(resolveBuildArtifact(cfg(), "/app").artifact),
        ).toBe(false);
    });

    it("is true for webpack too — same shape as turbopack (#1219)", () => {
        expect(
            standaloneStepsApply(
                resolveBuildArtifact(cfg({ build: "webpack" }), "/app")
                    .artifact,
            ),
        ).toBe(true);
    });
});
