#!/usr/bin/env node
/**
 * The deploy's build id, and how it reaches the app's `next.config`.
 *
 * ADR-0011's lock-step needs `.next/BUILD_ID` == the deploy tag, so the
 * uploaded `_next/static/<id>/` prefix, the image tag, the CR `spec.buildId`
 * and the GC's protection key are one value. knext used to hand the tag to the
 * build as `NEXT_DEPLOYMENT_ID` and the templates read it back through
 * `generateBuildId`.
 *
 * That stopped working on Next >= 16.2.11. Next fills `config.deploymentId`
 * from `NEXT_DEPLOYMENT_ID` (`dist/server/config.js`, "only leverage
 * deploymentId"), and `getBuildId` (`dist/build/index.js`) then returns the
 * literal constant below and NEVER calls `generateBuildId` — Next's own skew
 * protection keys on the deployment id instead of the build id. So every
 * standalone deploy wrote the constant and the lock-step guard aborted it.
 *
 * The fix is to own the variable: knext exports `KNEXT_BUILD_ID`, which Next
 * never reads, and the standalone build sees NO `NEXT_DEPLOYMENT_ID` at all.
 * vinext is a different build (vite, not `next build`): it reads
 * `NEXT_DEPLOYMENT_ID` itself for `?dpl=` suffixing and has no constant-id
 * path, so the vinext leg keeps receiving it unchanged.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS_URL } from "./help";

/** The env var knext owns for the build id. Next never reads it. */
export const KNEXT_BUILD_ID_ENV = "KNEXT_BUILD_ID";

/** The env var Next reads as `deploymentId` (and vinext for `?dpl=`). */
export const NEXT_DEPLOYMENT_ID_ENV = "NEXT_DEPLOYMENT_ID";

/**
 * What Next >= 16.2.11 writes to `.next/BUILD_ID` whenever `deploymentId` is
 * set, ignoring `generateBuildId`. Seeing it means Next saw a deployment id.
 */
export const NEXT_CONSTANT_BUILD_ID = "build-TfctsWXpff2fKS";

/** The skew-protection docs page — where the fix is spelled out for users. */
export const SKEW_PROTECTION_DOCS_URL = `${DOCS_URL}/docs/skew-protection`;

/**
 * Export this deploy's build id into `env` before the project build runs.
 *
 * Always sets `KNEXT_BUILD_ID`. On the vinext leg also sets
 * `NEXT_DEPLOYMENT_ID` (vinext's `?dpl=` source). On every other leg REMOVES
 * any inherited `NEXT_DEPLOYMENT_ID` — a CI runner or shell that exports one
 * would otherwise put Next back on the constant-id path.
 *
 * @returns the `NEXT_DEPLOYMENT_ID` value that was removed from the
 *   environment (so the caller can say so), or `undefined` if none was.
 */
export function exportBuildIdEnv(
    env: Record<string, string | undefined>,
    buildId: string,
    builder: string,
): string | undefined {
    env[KNEXT_BUILD_ID_ENV] = buildId;
    if (builder === "vinext") {
        env[NEXT_DEPLOYMENT_ID_ENV] = buildId;
        return undefined;
    }
    const inherited = env[NEXT_DEPLOYMENT_ID_ENV];
    delete env[NEXT_DEPLOYMENT_ID_ENV];
    return inherited !== undefined && inherited !== buildId
        ? inherited
        : undefined;
}

const NEXT_CONFIG_NAMES = [
    "next.config.ts",
    "next.config.mts",
    "next.config.cts",
    "next.config.js",
    "next.config.mjs",
    "next.config.cjs",
];

/** The app's next.config source, comments stripped; `undefined` if none. */
function readNextConfigCode(cwd: string): string | undefined {
    for (const name of NEXT_CONFIG_NAMES) {
        let source: string;
        try {
            source = readFileSync(join(cwd, name), "utf-8");
        } catch {
            continue;
        }
        return source
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");
    }
    return undefined;
}

/**
 * The error for a standalone build whose `.next/BUILD_ID` is not the deploy
 * tag. When the cause is recognisably the old `NEXT_DEPLOYMENT_ID` wiring —
 * Next's constant id on disk, or a next.config that never reads
 * `KNEXT_BUILD_ID` — it leads with the one sentence that fixes it.
 */
export function buildIdMismatchError(
    builtId: string,
    buildId: string,
    cwd: string,
): Error {
    const detail = `.next/BUILD_ID "${builtId}" != deploy tag "${buildId}".`;
    const code = readNextConfigCode(cwd);
    const readsKnextBuildId = code?.includes(KNEXT_BUILD_ID_ENV) === true;
    if (builtId === NEXT_CONSTANT_BUILD_ID || !readsKnextBuildId) {
        return new Error(
            "Update generateBuildId in next.config to read KNEXT_BUILD_ID: " +
                "`generateBuildId: () => process.env.KNEXT_BUILD_ID || " +
                "process.env.NEXT_DEPLOYMENT_ID || null`, and set no " +
                "deploymentId or NEXT_DEPLOYMENT_ID for a standalone build " +
                `(see ${SKEW_PROTECTION_DOCS_URL}). ${detail}`,
        );
    }
    return new Error(
        `${detail} Skew-protection asset retention requires BUILD_ID == ` +
            `${KNEXT_BUILD_ID_ENV} (check next.config generateBuildId, ` +
            `${SKEW_PROTECTION_DOCS_URL}).`,
    );
}

/**
 * The standalone-leg lock-step guard: throw unless `<cwd>/.next/BUILD_ID` is
 * the deploy tag. Returns `"missing"` when the file does not exist (an app
 * shape knext does not control — the caller warns), `"ok"` on a match.
 */
export function checkStandaloneBuildId(
    cwd: string,
    buildId: string,
): "ok" | "missing" {
    let builtId: string;
    try {
        builtId = readFileSync(join(cwd, ".next", "BUILD_ID"), "utf-8").trim();
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return "missing";
        throw err;
    }
    if (builtId !== buildId) {
        throw buildIdMismatchError(builtId, buildId, cwd);
    }
    return "ok";
}
