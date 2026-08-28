/**
 * Track B3 — bind the artifact contract to the REAL built artifacts.
 *
 * The contract declares where each builder's output lands. A declaration that
 * nothing checks against reality is exactly the defect class #869 is about:
 * ADR-0036 and ADR-0042 confidently describe a CRD field, a CEL rule and a
 * config axis that do not exist, and nothing noticed because no test compared
 * the prose to the tree.
 *
 * So this file does the comparison. It is deliberately NOT a unit test of the
 * descriptor — `artifact-contract.test.ts` covers the interface. This one
 * asserts the descriptor agrees with:
 *
 *   - the path the shipped node supervisor actually looks for
 *     (`node-server.ts`'s STANDALONE_SERVER_PATH default), and
 *   - the path the vinext sample actually emits (`examples/bun-exec`).
 *
 * Both halves matter. A descriptor right about turbopack and wrong about vinext
 * would route a real build to a path nothing produces, and the first person to
 * find out would be whoever ran `docker run` on a cluster — the #857 ordering.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { turbopackBuilder, vinextBuilder } from "../adapters/artifact-contract";

const REPO_ROOT = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../..",
);
const SAMPLE = join(REPO_ROOT, "examples/bun-exec");

describe("#B3 the contract agrees with the shipped supervisor", () => {
    it("turbopack's declared entry is the one node-server.ts defaults to", () => {
        const supervisor = readFileSync(
            join(REPO_ROOT, "packages/kn-next/src/adapters/node-server.ts"),
            "utf8",
        );
        const declared = turbopackBuilder.describeArtifact("/app").entry;

        // Scanned out of the source rather than restated here, so the assertion
        // cannot pass by both copies being wrong in the same way.
        expect(
            supervisor.includes(`"${declared}"`),
            `node-server.ts does not mention '${declared}' — the contract and the supervisor have drifted`,
        ).toBe(true);
    });
});

describe("#B3 the contract agrees with the vinext sample", () => {
    // vinext IS adopted — `examples/bun-exec` depends on it (1.0.0-beta.4) and
    // builds through nitro. It is not a dependency of the CORE packages, which
    // is why the builder is marked unavailable; the sample drives its own
    // `build.sh`. Those are different claims and the contract keeps them apart.
    it("the sample really does depend on vinext", () => {
        const pkg = JSON.parse(
            readFileSync(join(SAMPLE, "package.json"), "utf8"),
        ) as { dependencies?: Record<string, string> };

        expect(pkg.dependencies?.vinext).toBeDefined();
    });

    it("vinext's declared entry is what the sample's build recipe names", () => {
        const recipe = readFileSync(join(SAMPLE, "build.sh"), "utf8");
        const declared = vinextBuilder.describeArtifact("/app").entry;

        expect(
            recipe.includes(declared),
            `build.sh does not mention '${declared}'`,
        ).toBe(true);
    });

    it.skipIf(!existsSync(join(SAMPLE, ".output")))(
        "vinext's declared entry EXISTS in the sample's built output",
        () => {
            // The strongest form: not "the recipe says so" but "the file is
            // there". Skipped when the sample has not been built, because a
            // clean checkout has no `.output` — but it must never be asserted
            // vacuously, so the existence of `.output` is the skip condition
            // rather than the existence of the entry itself.
            const declared = vinextBuilder.describeArtifact("/app").entry;

            expect(
                existsSync(join(SAMPLE, declared)),
                `the sample has a .output/ but not '${declared}' — the contract points at a path this builder does not emit`,
            ).toBe(true);
        },
    );

    it("the sample's entry is a nitro server entry, matching the in-process claim", () => {
        // `execution: "in-process"` is a claim about HOW the shape runs. The
        // sample's bespoke entry is the evidence: it wraps nitro's real request
        // pipeline rather than spawning a child, which is why SIGTERM draining
        // has to be the entry's own job.
        const entry = readFileSync(join(SAMPLE, "knext-bun-entry.mjs"), "utf8");

        expect(vinextBuilder.describeArtifact("/app").execution).toBe(
            "in-process",
        );
        expect(entry).toMatch(/nitro/i);
    });
});

describe("#B3 availability is an honest claim about the CORE cli", () => {
    it("vinext is available: BOTH the build path and the image now exist", () => {
        // An earlier version of this test asserted `build.ts` contains no
        // "vinext". That tripwire fired the moment `build.ts` became
        // shape-aware — and it was the WRONG proxy. `kn-next build` can now
        // resolve, verify and post-process a nitro artifact perfectly well; the
        // thing that still cannot work is the image.
        //
        // The scaffolded Dockerfile COPYs `.next/standalone` and WORKDIRs into
        // the standalone prefix, so a vinext deploy would produce an image
        // whose entry does not exist. Availability is an end-to-end claim —
        // build AND image AND runtime entry — so the guard is anchored on the
        // narrowest thing still missing rather than on a path literal that
        // happens to mention the word.
        const dockerfile = readFileSync(
            join(
                REPO_ROOT,
                "packages/kn-next/templates/app/Dockerfile.vinext.hbs",
            ),
            "utf8",
        );

        // Availability is an end-to-end claim, so both halves are checked:
        // the CLI can PRODUCE the artifact, and a template can SHIP it.
        // Neither alone would justify the flag.
        expect(vinextBuilder.available).toBe(true);
        expect(
            dockerfile.includes(".output/public"),
            "the vinext Dockerfile template must ship the nitro public assets",
        ).toBe(true);
        expect(
            dockerfile.includes("/app/server"),
            "the vinext Dockerfile template must run the compiled binary, not a server.js",
        ).toBe(true);
    });

    it("`kn-next build` IS shape-aware, even though vinext is not yet available", () => {
        // The two are independent, and conflating them is what the previous
        // version of the test above got wrong. Build-side support landing does
        // not make the builder available; image-side support is the remaining
        // gate.
        const build = readFileSync(
            join(REPO_ROOT, "packages/kn-next/src/cli/build.ts"),
            "utf8",
        );

        expect(build).toMatch(/resolveBuildArtifact/);
        expect(build).toMatch(/standaloneStepsApply/);
    });

    it("the CLI really can drive a vinext build — the reason the flag flipped", () => {
        // The flag is only honest if something produces the artifact. This is
        // that something: vite build -> nitro bun preset -> bun --compile.
        const vinextBuild = readFileSync(
            join(REPO_ROOT, "packages/kn-next/src/cli/vinext-build.ts"),
            "utf8",
        );

        expect(turbopackBuilder.available).toBe(false);
        expect(vinextBuild).toMatch(/--compile/);
        expect(vinextBuild).toMatch(/--bytecode/);
        expect(vinextBuild).toMatch(/vite/);
    });
});
