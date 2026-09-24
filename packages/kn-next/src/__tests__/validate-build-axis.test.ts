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
 * `docker run` on a cluster instead of at `knext validate` on a laptop. The
 * repo has been bitten by exactly that ordering before (#857: `next build`
 * exited 0 the whole way while emitting a server nothing could find).
 */

import { describe, expect, it } from "bun:test";
import { type ArtifactShape, BUILDERS } from "../adapters/artifact-contract";
import {
    checkPairing,
    type PairingContract,
    validateConfig,
} from "../cli/validate";
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

    it("ACCEPTS an explicit turbopack — #1167 re-opened the standalone target", () => {
        // ADR-0054 item 6 reverses ADR-0048's retirement: `next build` ->
        // `.next/standalone` is selectable again (the verified 778/0 axis).
        expect(() => validateConfig(cfg({ build: "turbopack" }))).not.toThrow();
    });

    it("ACCEPTS vinext — it stays a supported target alongside turbopack", () => {
        expect(() => validateConfig(cfg({ build: "vinext" }))).not.toThrow();
    });

    it("ACCEPTS webpack — next build --webpack -> .next/standalone (#1219)", () => {
        // webpack emits the same next-standalone shape as turbopack, so it is
        // selectable the same way — no new toolchain, no new pairing rules.
        expect(() => validateConfig(cfg({ build: "webpack" }))).not.toThrow();
    });

    it("rejects an unknown builder, listing what is supported", () => {
        expect(() =>
            validateConfig(cfg({ build: "rollup" as unknown as "turbopack" })),
        ).toThrow(/rollup.*not supported/i);
    });

    describe("independence from `runtime`", () => {
        // The whole point of the separation: neither axis constrains the other.
        // ADR-0036 asserted a `bun ⇒ vinext` invariant enforced by CEL on the
        // CRD; no such rule was ever implemented, and `runtime: bun` means
        // "run the Next standalone server under bun" in the shipped code.
        it("accepts runtime=bun with the default (vinext) build", () => {
            expect(() => validateConfig(cfg({ runtime: "bun" }))).not.toThrow();
        });

        it("ACCEPTS runtime=node with the default build — vinext × node is a supported cell (#1260)", () => {
            // It used to be rejected, and correctly: the only vinext artifact
            // was a bun-preset nitro output, which exits 1 under node. #1260
            // added the node-preset shape (`nitro-output-node`), so vinext on
            // node now describes an artifact node can run.
            expect(() =>
                validateConfig(cfg({ runtime: "node" })),
            ).not.toThrow();
        });

        it.each([
            "node",
            "bun",
        ] as const)("ACCEPTS runtime=%s with the (now selectable) turbopack build", (runtime) => {
            // #1167: turbopack emits `next-standalone`, which BOTH runtimes
            // accept — so both pairings validate, unlike vinext+node. Asserting
            // both halves so a regression on either is caught.
            expect(() =>
                validateConfig(cfg({ runtime, build: "turbopack" })),
            ).not.toThrow();
        });

        it.each([
            "node",
            "bun",
        ] as const)("ACCEPTS runtime=%s with the webpack build (#1219) — same shape as turbopack", (runtime) => {
            expect(() =>
                validateConfig(cfg({ runtime, build: "webpack" })),
            ).not.toThrow();
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

        it("accepts vinext+bun AND vinext+node — each runtime gets the preset it can run (#1260)", () => {
            expect(() =>
                validateConfig(cfg({ runtime: "bun", build: "vinext" })),
            ).not.toThrow();
            expect(() =>
                validateConfig(cfg({ runtime: "node", build: "vinext" })),
            ).not.toThrow();
        });
    });
});

/**
 * The pairing check (NEW-1 from the round-2 design gate).
 *
 * `checkPairing` is tested DIRECTLY as well as through `validateConfig`.
 *
 * #1260 changed what a real config can reach. `build: 'vinext'` +
 * `runtime: 'node'` used to be the one expressible, incompatible pairing: the
 * only vinext artifact was a bun-preset nitro output, which crashes under node.
 * vinext now describes a node-preset shape for node, so EVERY runtime × builder
 * cell (#1218) is compatible — and no shipped config can reach a refusal any
 * more.
 *
 * That is the state that once let deleting the call break nothing (see the
 * next block's history). So the contract is now INJECTABLE: these tests hand
 * `checkPairing` / `validateConfig` a registry whose node runtime accepts
 * nothing, and assert the refusal on OUTPUT. The shipped registry's own
 * refusal — node × the bun-preset shape — is pinned in artifact-contract.test.ts.
 */
const NODE_ACCEPTS_NOTHING: PairingContract = {
    builders: BUILDERS,
    runtimes: [
        { id: "node", accepts: [] as ArtifactShape[] },
        { id: "bun", accepts: ["next-standalone", "nitro-output-bun"] },
    ],
};

describe("#B2 checkPairing — the contract's production caller", () => {
    it("passes every pairing a shipped config can express (#1218 full matrix)", () => {
        expect(checkPairing(undefined, undefined)).toBeNull();
        for (const build of ["turbopack", "webpack", "vinext"]) {
            for (const runtime of ["node", "bun"]) {
                expect(checkPairing(build, runtime)).toBeNull();
            }
        }
    });

    it("REFUSES a pairing the contract says cannot run, naming the shape", () => {
        // vinext × node under a registry whose node accepts nothing: the
        // check must consult the runtime it was given, with the runtime's own
        // shape — `nitro-output-node`, not the bun one.
        const why = checkPairing("vinext", "node", NODE_ACCEPTS_NOTHING);
        expect(why).not.toBeNull();
        expect(why).toContain("nitro-output-node");
        expect(why).toContain("accepts: nothing");
    });

    it("still allows the runtime the injected contract does accept — both halves", () => {
        expect(checkPairing("vinext", "bun", NODE_ACCEPTS_NOTHING)).toBeNull();
    });

    it("stays silent for an unknown id — that error belongs to the enum check", () => {
        // Two errors for one mistake is worse than one. The builder/runtime
        // enum branches above already report it. `webpack` is now a KNOWN
        // builder (#1219), so it can no longer stand in for "unrecognised" —
        // `rollup` is genuinely unknown instead.
        expect(checkPairing("rollup", "node")).toBeNull();
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
 * behaviour. Since #1260 no shipped config is incompatible, so these assert on
 * OUTPUT through an injected contract. Dropping the reporting, deleting the
 * call, or not threading the contract through all fail here.
 */
describe("#B2 validateConfig enforces the pairing, observably", () => {
    it("REJECTS a pairing the (injected) contract cannot execute", () => {
        expect(() =>
            validateConfig(
                cfg({ build: "vinext", runtime: "node" }),
                NODE_ACCEPTS_NOTHING,
            ),
        ).toThrow(/nitro-output-node/);
    });

    it("accepts vinext+node under the SHIPPED contract while refusing it under the injected one — both halves", () => {
        expect(() =>
            validateConfig(cfg({ build: "vinext", runtime: "node" })),
        ).not.toThrow();

        let pairing = "";
        try {
            validateConfig(
                cfg({ build: "turbopack", runtime: "node" }),
                NODE_ACCEPTS_NOTHING,
            );
        } catch (e) {
            pairing = (e as Error).message;
        }
        expect(pairing).toMatch(/next-standalone/);
    });

    it("reports NOTHING for vinext + bun — the supported combination", () => {
        // If the checks ever rejected the one thing that is supposed to work,
        // this catches it before a user does.
        expect(() =>
            validateConfig(cfg({ build: "vinext", runtime: "bun" })),
        ).not.toThrow();
    });

    it("stays silent for the default vinext config (bare and explicit)", () => {
        // Absence of `build` means vinext, so both spellings of it must pass —
        // if the default and the explicit value ever diverged, one of these
        // would catch it. (turbopack is now ALSO shippable, #1167; this test
        // pins the default path specifically.)
        expect(() => validateConfig(cfg({ runtime: "bun" }))).not.toThrow();
        expect(() =>
            validateConfig(cfg({ runtime: "bun", build: "vinext" })),
        ).not.toThrow();
    });
});
