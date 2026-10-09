/**
 * The artifact contract's `entry` for a standalone build, flat and nested.
 *
 * `entry` is the one place the contract names where the server lives, and the
 * standalone builders used to hard-code `.next/standalone/server.js`. A
 * deliberate monorepo root nests it under the app's path, so the descriptor
 * takes the layout as an input instead of every consumer re-deriving the path.
 */

import { describe, expect, it } from "bun:test";
import {
    turbopackBuilder,
    vinextBuilder,
    webpackBuilder,
} from "../adapters/artifact-contract";

describe("describeArtifact entry for the standalone builders", () => {
    for (const builder of [turbopackBuilder, webpackBuilder]) {
        it(`${builder.id}: no layout -> the flat entry, exactly as before`, () => {
            expect(builder.describeArtifact("/app").entry).toBe(
                ".next/standalone/server.js",
            );
            expect(
                builder.describeArtifact("/app", "bun", { appRel: "" }).entry,
            ).toBe(".next/standalone/server.js");
        });

        it(`${builder.id}: a nested layout puts the app's path under .next/standalone`, () => {
            const artifact = builder.describeArtifact("/repo/apps/web", "bun", {
                appRel: "apps/web",
            });
            expect(artifact.entry).toBe(".next/standalone/apps/web/server.js");
            expect(artifact.root).toBe("/repo/apps/web");
            expect(artifact.shape).toBe("next-standalone");
            expect(artifact.execution).toBe("spawn");
        });
    }

    it("vinext has no standalone tree and ignores the layout", () => {
        expect(
            vinextBuilder.describeArtifact("/app", "bun", {
                appRel: "apps/web",
            }).entry,
        ).toBe(vinextBuilder.describeArtifact("/app", "bun").entry);
    });
});
