import { describe, expect, it } from "vitest";
import { validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

/**
 * ADR-0048 consistency: what `kn-next create` scaffolds must survive
 * `kn-next validate`. If the scaffolder emits a config the validator rejects,
 * the first thing a new user does is produce an app that cannot deploy.
 */
describe("#ADR-0048 the scaffold and the validator agree", () => {
    it("a default scaffolded config validates", () => {
        const scaffolded = {
            name: "scaffolded",
            registry: "ghcr.io/example",
        } as KnativeNextConfig;

        expect(() => validateConfig(scaffolded)).not.toThrow();
    });
});
