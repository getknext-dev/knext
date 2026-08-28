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

import { describe, expect, it } from "vitest";
import {
    resolveBuildArtifact,
    standaloneStepsApply,
} from "../cli/build-artifact";
import type { KnativeNextConfig } from "../config";

const cfg = (over: Partial<KnativeNextConfig> = {}): KnativeNextConfig =>
    ({ name: "app", registry: "r", ...over }) as KnativeNextConfig;

describe("#B3 resolveBuildArtifact", () => {
    it("defaults to VINEXT — ADR-0048 made it the only supported target", () => {
        // Absence used to mean turbopack. ADR-0048 retired that target, so the
        // default moved with it: an app that sets nothing gets the single
        // executable, which is the only artifact knext can now build and ship.
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

    it("still RESOLVES retired turbopack — describing is not offering", () => {
        // The descriptor has to survive its own retirement. Existing configs
        // and stored CRs carry the retired value, and the validator needs to
        // recognise it to emit a MIGRATION message rather than reporting an
        // unknown builder, which would read as a typo.
        const r = resolveBuildArtifact(cfg({ build: "turbopack" }), "/app");

        expect(r.builder.id).toBe("turbopack");
        expect(r.builder.available).toBe(false);
        expect(r.artifact.shape).toBe("next-standalone");
    });

    it("threads the root through rather than assuming cwd", () => {
        expect(resolveBuildArtifact(cfg(), "/srv/other").artifact.root).toBe(
            "/srv/other",
        );
    });

    it("throws for a builder the contract does not know", () => {
        // Reached only if validation is bypassed, but it must not silently
        // fall back to turbopack — that would build the wrong thing and say
        // nothing, which is the #857 failure shape.
        expect(() =>
            resolveBuildArtifact(
                cfg({ build: "webpack" as unknown as "vinext" }),
                "/app",
            ),
        ).toThrow(/webpack/);
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
});
