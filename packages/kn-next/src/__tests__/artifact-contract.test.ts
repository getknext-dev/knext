/**
 * Track B1 — the build/runtime seam's contract test.
 *
 * The point of this file is that it is written against the INTERFACE, not
 * against the one builder that exists today. Every builder in `BUILDERS` and
 * every runtime in `RUNTIMES` is run through the same assertions, so adding
 * vinext (B3) inherits the whole suite by appearing in the registry — and fails
 * here if it does not satisfy the contract, rather than passing because nobody
 * wrote it a test.
 *
 * That is the difference between a contract and a table: a table has to be
 * remembered, a contract enumerates itself.
 */

import { describe, expect, it } from "bun:test";
import {
    type ArtifactShape,
    AVAILABLE_BUILDERS,
    BUILDERS,
    type BuilderAdapter,
    bunRuntime,
    explainIncompatibility,
    isCompatible,
    nodeRuntime,
    RUNTIMES,
    turbopackBuilder,
    vinextBuilder,
} from "../adapters/artifact-contract";

const ALL_SHAPES: readonly ArtifactShape[] = [
    "next-standalone",
    "nitro-output-bun",
];

describe("every builder satisfies the contract", () => {
    it.each(
        BUILDERS.map((b) => [b.id, b] as const),
    )("%s emits a well-formed artifact", (_id, builder: BuilderAdapter) => {
        const artifact = builder.describeArtifact("/app");

        // The shape it declares and the shape it emits must agree — a
        // builder whose `emits` lies would route artifacts to a runtime
        // that cannot execute them, and nothing downstream would notice.
        expect(artifact.shape).toBe(builder.emits);
        expect(ALL_SHAPES).toContain(artifact.shape);

        expect(artifact.root).toBe("/app");
        // Relative, so the descriptor survives the move from build host to
        // container — the prefix mismatch behind #857.
        expect(artifact.entry.startsWith("/")).toBe(false);
        expect(artifact.entry.length).toBeGreaterThan(0);
        expect(["spawn", "in-process"]).toContain(artifact.execution);
    });

    it.each(
        BUILDERS.map((b) => [b.id, b] as const),
    )("%s is pure — describing twice gives the same answer", (_id, builder: BuilderAdapter) => {
        expect(builder.describeArtifact("/app")).toEqual(
            builder.describeArtifact("/app"),
        );
    });

    it.each(
        BUILDERS.map((b) => [b.id, b] as const),
    )("%s honours the root it is given", (_id, builder: BuilderAdapter) => {
        expect(builder.describeArtifact("/srv/other").root).toBe("/srv/other");
    });

    it("at least one runtime can execute every builder's output", () => {
        // The contract's health property: a builder nothing can run is dead
        // weight, and would be a silent hole rather than a failure.
        for (const builder of BUILDERS) {
            const artifact = builder.describeArtifact("/app");
            const runners = RUNTIMES.filter((r) => isCompatible(r, artifact));
            expect(
                runners.length,
                `no runtime accepts '${artifact.shape}' from builder '${builder.id}'`,
            ).toBeGreaterThan(0);
        }
    });
});

describe("every runtime satisfies the contract", () => {
    it.each(
        RUNTIMES.map((r) => [r.id, r] as const),
    )("%s accepts only known shapes, without duplicates", (_id, runtime) => {
        for (const shape of runtime.accepts) {
            expect(ALL_SHAPES).toContain(shape);
        }
        expect(new Set(runtime.accepts).size).toBe(runtime.accepts.length);
    });
});

describe("isCompatible replaces the enumerated matrix", () => {
    const standalone = turbopackBuilder.describeArtifact("/app");

    it("accepts the shipped default: node + next-standalone", () => {
        expect(isCompatible(nodeRuntime, standalone)).toBe(true);
    });

    it("accepts bun + next-standalone, which is what `runtime: bun` means TODAY", () => {
        // Both halves. `config.ts` documents `runtime` as "Runtime to execute
        // the Next.js standalone server.js: 'bun' or 'node'", and `build.ts`
        // carries bytecode precompilation gated on it. ADR-0036 calls this
        // pairing "rejected" under a `bun ⇒ vinext` invariant that was never
        // implemented — no such CEL rule exists in the CRD. The contract
        // records the code, not the ADR.
        expect(isCompatible(bunRuntime, standalone)).toBe(true);
        expect(explainIncompatibility(bunRuntime, standalone)).toBeNull();
    });

    it("refuses, with a reason, a runtime that accepts nothing", () => {
        const inert = { id: "node" as const, accepts: [] as ArtifactShape[] };

        expect(isCompatible(inert, standalone)).toBe(false);
        const why = explainIncompatibility(inert, standalone);
        // Names the shape AND what the runtime can do, so the message is
        // actionable rather than just a refusal.
        expect(why).toContain("next-standalone");
        expect(why).toContain("accepts: nothing");
    });

    it("explainIncompatibility agrees with isCompatible in both directions", () => {
        // The two must never disagree: the operator's status condition and the
        // CLI validator are meant to call different ones and reach the same
        // verdict. Asserting only the refusing direction would let a
        // permanently-null explainer pass.
        for (const runtime of RUNTIMES) {
            for (const shape of ALL_SHAPES) {
                const artifact = {
                    shape,
                    root: "/app",
                    entry: "entry.js",
                    execution: "spawn" as const,
                };
                expect(explainIncompatibility(runtime, artifact) === null).toBe(
                    isCompatible(runtime, artifact),
                );
            }
        }
    });
});

describe("availability is separate from being described (B3)", () => {
    it("vinext is available; turbopack is described but RETIRED", () => {
        // Inverted by ADR-0048. Both halves still asserted: checking only that
        // turbopack is retired would pass on a contract where nothing is
        // available at all, which is the state that ships a broken product.
        expect(vinextBuilder.available).toBe(true);
        expect(turbopackBuilder.available).toBe(false);
    });

    it("AVAILABLE_BUILDERS is derived, not restated", () => {
        expect(AVAILABLE_BUILDERS.map((b) => b.id)).toEqual(
            BUILDERS.filter((b) => b.available).map((b) => b.id),
        );
        // And it is a strict subset today — if this ever equals BUILDERS, the
        // "known but unavailable" branch in the validator has become dead code
        // and its message can no longer be reached.
        expect(AVAILABLE_BUILDERS.length).toBeLessThan(BUILDERS.length);
    });

    it("an unavailable builder still describes a runnable-shaped artifact", () => {
        // The descriptor has to be correct BEFORE the toolchain is adopted —
        // that is what makes adding vinext an implementation step rather than a
        // redesign. A placeholder here would be discovered only at B3.
        const artifact = vinextBuilder.describeArtifact("/app");

        expect(artifact.shape).toBe("nitro-output-bun");
        expect(artifact.entry).toBe(".output/server/index.mjs");
        // In-process, not spawn: there is no child to supervise, so SIGTERM
        // draining is the entry's own job. That is a property of the SHAPE.
        expect(artifact.execution).toBe("in-process");
        expect(RUNTIMES.some((r) => isCompatible(r, artifact))).toBe(true);
    });

    it("ONLY bun accepts the bun-preset nitro shape — node cannot execute it", () => {
        // This test used to assert the opposite: "both runtimes accept the
        // nitro shape — ADR-0036's shared entry". A design gate ran the
        // artifact and refuted it:
        //
        //   $ node examples/bun-exec/.output/server/index.mjs
        //   exit 1 — ReferenceError: Bun is not defined
        //
        // `.output/nitro.json` carries `"preset": "bun"`, and the entry calls
        // `Bun.serve()` at module top level. The old assertion took ADR-0036's
        // prose ("vinext runs on either runtime") as fact and bound it to a
        // constant, so it could never have caught this — the test and the code
        // were wrong in the same direction.
        //
        // Both halves, deliberately: asserting only that bun accepts it would
        // stay green if node quietly started accepting it again.
        const artifact = vinextBuilder.describeArtifact("/app");

        expect(isCompatible(bunRuntime, artifact)).toBe(true);
        expect(
            isCompatible(nodeRuntime, artifact),
            "node must NOT accept a bun-preset nitro output — it crashes on boot",
        ).toBe(false);
    });
});

describe("the turbopack builder matches the shipped runtime half", () => {
    it("emits the entry node-server.ts defaults to", () => {
        // `node-server.ts:85` falls back to ".next/standalone/server.js" when
        // STANDALONE_SERVER_PATH is unset. If these drift, the contract would
        // describe an artifact the supervisor does not look for — the exact
        // class of defect #857 was.
        expect(turbopackBuilder.describeArtifact("/app").entry).toBe(
            ".next/standalone/server.js",
        );
    });

    it("spawns rather than running in-process", () => {
        // The standalone server owns its own listener, so it must be a child
        // process — that is what makes SIGTERM draining possible.
        expect(turbopackBuilder.describeArtifact("/app").execution).toBe(
            "spawn",
        );
    });
});
