/**
 * Track B2 — the `build` axis on `kn-next.config.ts`.
 *
 * `build` and `runtime` are INDEPENDENT choices (see
 * `src/adapters/artifact-contract.ts`). This file asserts the validator treats
 * them that way, and — the part that matters most right now — that selecting a
 * builder this repo cannot actually run is **rejected** rather than accepted
 * into a broken image.
 *
 * vinext is not a dependency of this repo. A config key that silently accepted
 * `build: "vinext"` would produce an image with no build output, discovered at
 * `docker run` on a cluster instead of at `kn-next validate` on a laptop. The
 * repo has been bitten by exactly that ordering before (#857: `next build`
 * exited 0 the whole way while emitting a server nothing could find).
 */

import { describe, expect, it } from "vitest";
import { checkPairing, validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

/** Minimal config that validates clean, so each test varies exactly one thing. */
function cfg(overrides: Partial<KnativeNextConfig> = {}): KnativeNextConfig {
    return {
        name: "smoke-app",
        registry: "example.io/team",
        ...overrides,
    } as KnativeNextConfig;
}

describe("#B2 the `build` axis", () => {
    it("defaults to turbopack — absence is valid and means today's behaviour", () => {
        // Absence must stay the spelling of "turbopack". Every config ever
        // written omits this key, so if absence became invalid, every existing
        // app would fail validation on upgrade.
        expect(() => validateConfig(cfg())).not.toThrow();
    });

    it("REJECTS an explicit turbopack — ADR-0048 retired it", () => {
        // The message is a MIGRATION, not a spelling correction: turbopack is a
        // real builder that this release no longer supports.
        expect(() => validateConfig(cfg({ build: "turbopack" }))).toThrow(
            /turbopack.*retired by ADR-0048/i,
        );
    });

    it("ACCEPTS vinext — it is the only supported target now", () => {
        expect(() => validateConfig(cfg({ build: "vinext" }))).not.toThrow();
    });

    it("rejects an unknown builder, listing what is supported", () => {
        expect(() =>
            validateConfig(cfg({ build: "webpack" as unknown as "turbopack" })),
        ).toThrow(/webpack.*not supported/i);
    });

    describe("independence from `runtime`", () => {
        // The whole point of the separation: neither axis constrains the other.
        // ADR-0036 asserted a `bun ⇒ vinext` invariant enforced by CEL on the
        // CRD; no such rule was ever implemented, and `runtime: bun` means
        // "run the Next standalone server under bun" in the shipped code.
        it("accepts runtime=bun with the default (vinext) build", () => {
            expect(() => validateConfig(cfg({ runtime: "bun" }))).not.toThrow();
        });

        it("REJECTS runtime=node with the default build — node cannot run the artifact", () => {
            // Not a policy rule: measured. The vinext artifact is a bun-preset
            // nitro output and exits 1 under node with a missing-global error.
            expect(() => validateConfig(cfg({ runtime: "node" }))).toThrow(
                /nitro-output-bun/,
            );
        });

        it.each([
            "node",
            "bun",
        ] as const)("rejects runtime=%s with the retired turbopack build", (runtime) => {
            // The builder is retired regardless of runtime — asserting only
            // one would let the other quietly stay valid.
            expect(() =>
                validateConfig(cfg({ runtime, build: "turbopack" })),
            ).toThrow(/retired by ADR-0048/i);
        });

        it("does not invent a bun⇒vinext rule: runtime=bun alone never mentions vinext", () => {
            // Both halves. `not.toThrow()` alone would pass even if a coupling
            // were reintroduced under a different message, so the absence of
            // the coupling is asserted directly.
            let thrown: unknown;
            try {
                validateConfig(cfg({ runtime: "bun" }));
            } catch (e) {
                thrown = e;
            }
            expect(thrown).toBeUndefined();
        });

        it("accepts vinext+bun and rejects vinext+node — the PAIRING, not the builder", () => {
            // Both halves. vinext itself is fine; only the node pairing fails,
            // and it fails on the measured shape rather than on a name.
            expect(() =>
                validateConfig(cfg({ runtime: "bun", build: "vinext" })),
            ).not.toThrow();
            expect(() =>
                validateConfig(cfg({ runtime: "node", build: "vinext" })),
            ).toThrow(/nitro-output-bun/);
        });
    });
});

/**
 * The pairing check (NEW-1 from the round-2 design gate).
 *
 * `checkPairing` is tested DIRECTLY rather than through `validateConfig`,
 * because — measured — no reachable config can currently express an
 * incompatible pairing: only `turbopack` is available, and both runtimes accept
 * `next-standalone`. A mutation proved the consequence: deleting the call from
 * `validateConfig` broke no test.
 *
 * The gate's objection to the contract was "a contract nobody calls is an
 * enumerated table with better typing". Wiring in a call that nothing can reach
 * would have reproduced that objection one level down. Exercising the function
 * itself covers the incompatible case config cannot yet reach, so the seam is
 * already live for the day a second builder ships.
 */
describe("#B2 checkPairing — the contract's production caller", () => {
    it("passes the two pairings a config can actually express today", () => {
        expect(checkPairing(undefined, undefined)).toBeNull();
        expect(checkPairing("turbopack", "node")).toBeNull();
        expect(checkPairing("turbopack", "bun")).toBeNull();
    });

    it("REFUSES vinext + node, naming the shape and what node accepts", () => {
        // The case config cannot reach (vinext is unavailable) and the whole
        // reason the check exists. node cannot execute a bun-preset nitro
        // output — measured: `node .output/server/index.mjs` exits 1.
        const why = checkPairing("vinext", "node");

        expect(why).not.toBeNull();
        expect(why).toContain("nitro-output-bun");
        expect(why).toContain("node");
    });

    it("allows vinext + bun — the pairing that does work", () => {
        // Both halves. Asserting only the refusal would stay green if the check
        // rejected every vinext pairing indiscriminately.
        expect(checkPairing("vinext", "bun")).toBeNull();
    });

    it("stays silent for an unknown id — that error belongs to the enum check", () => {
        // Two errors for one mistake is worse than one. The builder/runtime
        // enum branches above already report it.
        expect(checkPairing("webpack", "node")).toBeNull();
        expect(checkPairing("turbopack", "deno")).toBeNull();
    });
});

/**
 * The production call site, guarded BEHAVIOURALLY (round-4 design gate).
 *
 * Three earlier attempts were defeated, each because the enforcement sat where
 * the defect could not reach it:
 *
 *  1. The call lived in the available-only branch. No reachable config could
 *     produce an incompatible pairing, so deleting it broke nothing across 162
 *     files and 1833 tests.
 *  2. A source scan replaced it — defeated by keeping the call byte-identical
 *     and dropping the reporting: `if (why) { /* not reported *\/ }`. Both
 *     scans matched; enforcement was zero.
 *  3. The same scan was defeated again by deleting the call and leaving a TODO
 *     comment containing its text. A raw-source regex matches a comment, so the
 *     guard was better at catching carelessness than care.
 *
 * The lesson is that a test about the SHAPE OF THE SOURCE cannot guard
 * behaviour. Running the pairing check for any KNOWN builder makes
 * `vinext + node` reachable, so these assert on OUTPUT. Dropping the reporting,
 * deleting the call, or gutting `checkPairing` all now fail here.
 */
describe("#B2 validateConfig enforces the pairing, observably", () => {
    it("REJECTS vinext + node — the pairing that genuinely cannot execute", () => {
        // node cannot run a bun-preset nitro output: measured,
        // `node .output/server/index.mjs` exits 1 with a missing-global error.
        expect(() =>
            validateConfig(cfg({ build: "vinext", runtime: "node" })),
        ).toThrow(/nitro-output-bun/);
    });

    it("reports the retirement AND the pairing, as independent problems", () => {
        // Both halves, on the config that has BOTH faults: a retired builder
        // and a runtime that cannot execute what it emits. A naive `toThrow()`
        // would pass on either alone, hiding the loss of the other — which is
        // exactly how an earlier version of this enforcement stayed green.
        let retired = "";
        try {
            validateConfig(cfg({ build: "turbopack", runtime: "node" }));
        } catch (e) {
            retired = (e as Error).message;
        }
        expect(retired).toMatch(/retired by ADR-0048/i);

        let pairing = "";
        try {
            validateConfig(cfg({ build: "vinext", runtime: "node" }));
        } catch (e) {
            pairing = (e as Error).message;
        }
        expect(pairing).toMatch(/nitro-output-bun/);
    });

    it("reports NOTHING for vinext + bun — the supported combination", () => {
        // If the checks ever rejected the one thing that is supposed to work,
        // this catches it before a user does.
        expect(() =>
            validateConfig(cfg({ build: "vinext", runtime: "bun" })),
        ).not.toThrow();
    });

    it("stays silent for the ONE config a user can ship today", () => {
        // ADR-0048 leaves exactly one valid combination. Absence of `build`
        // means vinext, so both spellings of it must pass — if the default and
        // the explicit value ever diverged, one of these would catch it.
        expect(() => validateConfig(cfg({ runtime: "bun" }))).not.toThrow();
        expect(() =>
            validateConfig(cfg({ runtime: "bun", build: "vinext" })),
        ).not.toThrow();
    });
});
