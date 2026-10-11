/**
 * The doctor vinext-patches hint suggests `KNEXT_VINEXT_PATCHES=strict` as a
 * way to make `knext build` fail on drift. When strict is already active that
 * suggestion is noise, so the hint must leave it out; by default it stays.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { vinextPatchesCheck } from "../cli/doctor/checks/vinext-patches";
import type { CheckContext, DoctorDeps } from "../cli/doctor/types";
import {
    loadVinextPatchManifest,
    VINEXT_PATCHES_ENV,
} from "../cli/vinext-patches";

const manifest = loadVinextPatchManifest();

const ctxFor = (installed: string): CheckContext => {
    const deps: DoctorDeps = {
        kubectl: () => ({ ok: false, stdout: "", stderr: "no stub" }),
        probeImage: async () => "ok",
        readInstalledVinext: () => installed,
    };
    return {
        deps,
        kubectl: deps.kubectl,
        skipAll: true,
        verbose: false,
    };
};

const savedEnv = process.env[VINEXT_PATCHES_ENV];
afterEach(() => {
    if (savedEnv === undefined) delete process.env[VINEXT_PATCHES_ENV];
    else process.env[VINEXT_PATCHES_ENV] = savedEnv;
});

describe("doctor vinext-patches hint under KNEXT_VINEXT_PATCHES", () => {
    it("does not suggest setting strict when strict is already active", () => {
        process.env[VINEXT_PATCHES_ENV] = "strict";
        const [row] = vinextPatchesCheck(ctxFor("1.0.1"));
        expect(row?.status).toBe("fail");
        expect(row?.hint).toContain(`vinext@${manifest.vinext}`);
        expect(row?.hint).not.toContain(`${VINEXT_PATCHES_ENV}=strict`);
    });

    it("drops the strict suggestion on the cannot-compare warning too, when strict is active", () => {
        process.env[VINEXT_PATCHES_ENV] = " Strict ";
        const [row] = vinextPatchesCheck(ctxFor("workspace:*"));
        expect(row?.status).toBe("warn");
        expect(row?.hint).not.toMatch(/=strict/i);
    });

    it("still suggests strict when it is not set", () => {
        delete process.env[VINEXT_PATCHES_ENV];
        const [row] = vinextPatchesCheck(ctxFor("1.0.1"));
        expect(row?.hint).toContain(`${VINEXT_PATCHES_ENV}=strict`);
    });
});
