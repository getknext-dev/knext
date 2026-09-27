/**
 * The standalone build-id lock-step on Next >= 16.2.11.
 *
 * Next fills `deploymentId` from `NEXT_DEPLOYMENT_ID`, and whenever
 * `deploymentId` is set `getBuildId` writes the constant
 * `build-TfctsWXpff2fKS` and never calls `generateBuildId`. knext used to
 * export `NEXT_DEPLOYMENT_ID` before `next build`, so every default-target
 * deploy failed its own `.next/BUILD_ID == tag` guard.
 *
 * The "fake next build" below reproduces exactly those two upstream rules
 * (next@16.3.5 `dist/server/config.js` "only leverage deploymentId" and
 * `dist/build/index.js` `getBuildId`), and runs the `generateBuildId` line
 * lifted VERBATIM from the shipped scaffold template — so a template that
 * stops reading `KNEXT_BUILD_ID` reds here, not only in the text scan.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildIdMismatchError,
    checkStandaloneBuildId,
    exportBuildIdEnv,
    KNEXT_BUILD_ID_ENV,
    NEXT_CONSTANT_BUILD_ID,
    NEXT_DEPLOYMENT_ID_ENV,
    SKEW_PROTECTION_DOCS_URL,
} from "../cli/build-id-env";

const TEMPLATE = join(
    import.meta.dir,
    "..",
    "..",
    "templates",
    "app",
    "next.config.ts.hbs",
);

/** The template's `generateBuildId: ...,` property, comments excluded. */
function templateGenerateBuildIdLine(): string {
    const line = readFileSync(TEMPLATE, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("generateBuildId:"));
    expect(line).toHaveLength(1);
    return (line[0] as string).replace(/,$/, "");
}

/**
 * A stand-in for `next build` that applies Next 16.3.5's build-id rules to
 * the app's `next.config.js` and writes `.next/BUILD_ID`.
 */
const FAKE_NEXT_BUILD = `
const fs = require("node:fs");
const path = require("node:path");
const config = require(path.join(process.cwd(), "next.config.js"));
// dist/server/config.js: "only leverage deploymentId"
if (process.env.NEXT_DEPLOYMENT_ID) config.deploymentId = process.env.NEXT_DEPLOYMENT_ID;
// dist/build/index.js getBuildId
let id;
if (config.deploymentId) id = "${NEXT_CONSTANT_BUILD_ID}";
else id = (config.generateBuildId && config.generateBuildId()) || "random-nanoid";
fs.mkdirSync(".next", { recursive: true });
fs.writeFileSync(path.join(".next", "BUILD_ID"), id);
`;

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-build-id-"));
    writeFileSync(join(dir, "fake-next-build.cjs"), FAKE_NEXT_BUILD);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeNextConfig(generateBuildIdLine: string): void {
    writeFileSync(
        join(dir, "next.config.js"),
        `module.exports = { output: "standalone", ${generateBuildIdLine} };\n`,
    );
}

function fakeNextBuild(env: NodeJS.ProcessEnv): void {
    execFileSync(process.execPath, [join(dir, "fake-next-build.cjs")], {
        cwd: dir,
        env,
    });
}

/** A clean env: no inherited NEXT_DEPLOYMENT_ID / KNEXT_BUILD_ID. */
function cleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env[NEXT_DEPLOYMENT_ID_ENV];
    delete env[KNEXT_BUILD_ID_ENV];
    return env;
}

describe("the standalone lock-step on Next >= 16.2.11 (constant BUILD_ID)", () => {
    it("REPRO: the old wiring (NEXT_DEPLOYMENT_ID exported) builds the constant and the guard fails with the one-sentence fix", () => {
        writeNextConfig(
            "generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID || null",
        );
        fakeNextBuild({ ...cleanEnv(), NEXT_DEPLOYMENT_ID: "tag-1" });

        expect(readFileSync(join(dir, ".next", "BUILD_ID"), "utf8")).toBe(
            NEXT_CONSTANT_BUILD_ID,
        );
        let message = "";
        try {
            checkStandaloneBuildId(dir, "tag-1");
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).toStartWith(
            "Update generateBuildId in next.config to read KNEXT_BUILD_ID",
        );
        expect(message).toContain(SKEW_PROTECTION_DOCS_URL);
        expect(message).toContain(NEXT_CONSTANT_BUILD_ID);
    });

    it("FIX: knext's env export + the shipped template → BUILD_ID == tag and the guard passes", () => {
        writeNextConfig(templateGenerateBuildIdLine());
        const env = cleanEnv();
        // A runner that exports NEXT_DEPLOYMENT_ID must not put Next back on
        // the constant-id path.
        env[NEXT_DEPLOYMENT_ID_ENV] = "inherited-from-ci";
        exportBuildIdEnv(env, "tag-2", "turbopack");
        fakeNextBuild(env);

        expect(readFileSync(join(dir, ".next", "BUILD_ID"), "utf8")).toBe(
            "tag-2",
        );
        expect(checkStandaloneBuildId(dir, "tag-2")).toBe("ok");
    });

    it("an app still on the old generateBuildId gets the actionable sentence even without the constant", () => {
        // knext no longer exports NEXT_DEPLOYMENT_ID, so the old config line
        // returns null and Next mints a random id.
        writeNextConfig(
            "generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID || null",
        );
        const env = cleanEnv();
        exportBuildIdEnv(env, "tag-3", "webpack");
        fakeNextBuild(env);

        expect(() => checkStandaloneBuildId(dir, "tag-3")).toThrow(
            /^Update generateBuildId in next\.config to read KNEXT_BUILD_ID/,
        );
    });

    it("a config that DOES read KNEXT_BUILD_ID but still mismatches gets the plain lock-step message", () => {
        writeNextConfig(
            "generateBuildId: () => process.env.KNEXT_BUILD_ID || null",
        );
        const err = buildIdMismatchError("other-id", "tag-4", dir);
        expect(err.message).toStartWith(
            '.next/BUILD_ID "other-id" != deploy tag "tag-4"',
        );
        expect(err.message).not.toContain("Update generateBuildId");
    });

    it("a missing .next/BUILD_ID reports 'missing' (the caller warns), never throws", () => {
        expect(checkStandaloneBuildId(dir, "tag-5")).toBe("missing");
    });
});

describe("exportBuildIdEnv", () => {
    it("standalone: sets KNEXT_BUILD_ID and REMOVES NEXT_DEPLOYMENT_ID, reporting what it removed", () => {
        const env: Record<string, string | undefined> = {
            NEXT_DEPLOYMENT_ID: "stale",
        };
        expect(exportBuildIdEnv(env, "t", "turbopack")).toBe("stale");
        expect(env).toEqual({ KNEXT_BUILD_ID: "t" });
    });

    it("standalone with nothing inherited reports nothing removed", () => {
        const env: Record<string, string | undefined> = {};
        expect(exportBuildIdEnv(env, "t", "webpack")).toBeUndefined();
        expect(env).toEqual({ KNEXT_BUILD_ID: "t" });
    });

    it("vinext: keeps exporting NEXT_DEPLOYMENT_ID (vinext's ?dpl= source) alongside KNEXT_BUILD_ID", () => {
        const env: Record<string, string | undefined> = {};
        expect(exportBuildIdEnv(env, "t", "vinext")).toBeUndefined();
        expect(env).toEqual({ KNEXT_BUILD_ID: "t", NEXT_DEPLOYMENT_ID: "t" });
    });
});
