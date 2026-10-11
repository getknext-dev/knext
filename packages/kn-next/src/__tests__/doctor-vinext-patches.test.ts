/**
 * `knext doctor` -- vinext version drift.
 *
 * knext's bundled vinext fixes are validated against exactly one vinext
 * version. With any other version installed the build skips every fix, and
 * until now nothing in doctor said so. The row is local (no cluster call),
 * silent for an app without vinext, and graded by what the user is missing:
 * an OLDER vinext certainly lacks the fixes (FAIL, with a hint), a NEWER one
 * may already carry them upstream (WARN).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type KubectlFn, type ProbeOutcome, runDoctor } from "../cli/doctor";
import { vinextPatchesCheck } from "../cli/doctor/checks/vinext-patches";
import type { CheckContext, DoctorDeps } from "../cli/doctor/types";
import {
    loadVinextPatchManifest,
    readInstalledVinextVersion,
    VINEXT_PATCHES_ENV,
} from "../cli/vinext-patches";

const manifest = loadVinextPatchManifest();

const noKubectl: KubectlFn = () => ({
    ok: false,
    stdout: "",
    stderr: "no stub",
});
const okProbe = async (): Promise<ProbeOutcome> => "ok";

const ctxFor = (installed: string | undefined): CheckContext => {
    const deps: DoctorDeps = {
        kubectl: noKubectl,
        probeImage: okProbe,
        readInstalledVinext: () => installed,
    };
    return { deps, kubectl: noKubectl, skipAll: true, verbose: false };
};

const savedEnv = process.env[VINEXT_PATCHES_ENV];
afterEach(() => {
    if (savedEnv === undefined) delete process.env[VINEXT_PATCHES_ENV];
    else process.env[VINEXT_PATCHES_ENV] = savedEnv;
});

describe("doctor vinext-patches row", () => {
    it("FAILs with a repair hint for an older vinext (1.0.1): the known fixes are missing", () => {
        delete process.env[VINEXT_PATCHES_ENV];
        const [row, ...rest] = vinextPatchesCheck(ctxFor("1.0.1"));
        expect(rest).toEqual([]);
        expect(row?.id).toBe("vinext-patches");
        expect(row?.status).toBe("fail");
        expect(row?.detail).toContain("1.0.1");
        expect(row?.detail).toContain(manifest.vinext);
        expect(row?.detail).toContain(String(manifest.patches.length));
        expect(row?.hint).toContain(`vinext@${manifest.vinext}`);
    });

    it("WARNs for a newer vinext: its release may already carry the fixes", () => {
        delete process.env[VINEXT_PATCHES_ENV];
        const [row] = vinextPatchesCheck(ctxFor("99.0.0"));
        expect(row?.status).toBe("warn");
        expect(row?.detail).toContain("99.0.0");
        expect(row?.hint).toBeTruthy();
    });

    it("treats a prerelease of the validated version as older than it", () => {
        delete process.env[VINEXT_PATCHES_ENV];
        const [row] = vinextPatchesCheck(ctxFor(`${manifest.vinext}-beta.1`));
        expect(row?.status).toBe("fail");
    });

    it("PASSes when the installed vinext is the validated version", () => {
        delete process.env[VINEXT_PATCHES_ENV];
        const [row] = vinextPatchesCheck(ctxFor(manifest.vinext));
        expect(row?.status).toBe("pass");
    });

    it("WARNs, rather than guessing, when the installed version is not a version number", () => {
        delete process.env[VINEXT_PATCHES_ENV];
        const [row] = vinextPatchesCheck(ctxFor("workspace:*"));
        expect(row?.status).toBe("warn");
    });

    it("is silent (no row) for an app without vinext", () => {
        delete process.env[VINEXT_PATCHES_ENV];
        expect(vinextPatchesCheck(ctxFor(undefined))).toEqual([]);
    });

    it("SKIPs, naming the switch, when the user turned the bundled fixes off", () => {
        process.env[VINEXT_PATCHES_ENV] = "0";
        const [row] = vinextPatchesCheck(ctxFor("1.0.1"));
        expect(row?.status).toBe("skip");
        expect(row?.detail).toContain(VINEXT_PATCHES_ENV);
    });

    it("still reports drift under KNEXT_VINEXT_PATCHES=strict", () => {
        process.env[VINEXT_PATCHES_ENV] = "strict";
        const [row] = vinextPatchesCheck(ctxFor("1.0.1"));
        expect(row?.status).toBe("fail");
    });

    it("runs even when the cluster is unreachable (it is a local check)", async () => {
        delete process.env[VINEXT_PATCHES_ENV];
        const report = await runDoctor({
            kubectl: noKubectl,
            probeImage: okProbe,
            readInstalledVinext: () => "1.0.1",
        });
        const row = report.checks.find((c) => c.id === "vinext-patches");
        expect(row?.status).toBe("fail");
        expect(report.exitCode).toBe(1);
    });

    it("adds no row to a report for an app without vinext", async () => {
        const report = await runDoctor({
            kubectl: noKubectl,
            probeImage: okProbe,
            readInstalledVinext: () => undefined,
        });
        expect(report.checks.some((c) => c.id === "vinext-patches")).toBe(
            false,
        );
    });
});

describe("readInstalledVinextVersion", () => {
    const roots: string[] = [];
    afterEach(() => {
        for (const r of roots.splice(0)) {
            rmSync(r, { recursive: true, force: true });
        }
    });

    it("reads the version of the vinext installed for the app (a 1.0.1 fixture)", () => {
        const app = mkdtempSync(join(tmpdir(), "knext-doctor-vp-"));
        roots.push(app);
        const dir = join(app, "node_modules", "vinext");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({ name: "vinext", version: "1.0.1" }),
        );
        expect(readInstalledVinextVersion(app)).toBe("1.0.1");
    });

    it("is undefined without vinext, and for an unreadable package.json", () => {
        const app = mkdtempSync(join(tmpdir(), "knext-doctor-vp-"));
        roots.push(app);
        expect(readInstalledVinextVersion(app)).toBeUndefined();
        const dir = join(app, "node_modules", "vinext");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), "{not json");
        expect(readInstalledVinextVersion(app)).toBeUndefined();
    });
});
