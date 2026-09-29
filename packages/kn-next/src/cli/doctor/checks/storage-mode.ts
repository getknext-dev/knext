/**
 * (h) static-asset mode (ADR-0047) — LOCAL and read-only, so it runs even when
 * the cluster is unreachable. Both modes are healthy states, so both are
 * "pass": the value is that the mode is STATED where the user looks, never
 * inferred from what happens to be in the config.
 */

import { dirname } from "node:path";
import type { KnativeNextConfig } from "../../../config";
import { NO_STORAGE_DOCS_URL } from "../../../utils/asset-upload";
import { loadConfig } from "../../shared";
import {
    CONFIG_FILE,
    defaultResolveConfigFile,
    LEGACY_CONFIG_FILE,
} from "../config-file";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";

/**
 * Default loadAppConfig: the real cwd loader. ANY failure — no config in this
 * directory, a config that does not validate — yields undefined: doctor
 * diagnoses, it must never crash on the state it is diagnosing.
 */
async function loadAppConfigOrUndefined(): Promise<
    KnativeNextConfig | undefined
> {
    try {
        return await loadConfig();
    } catch {
        return undefined;
    }
}

export async function storageModeCheck(
    ctx: CheckContext,
): Promise<CheckResult[]> {
    const appConfig = await (
        ctx.deps.loadAppConfig ?? loadAppConfigOrUndefined
    )();
    if (!appConfig) {
        // #1559 round-2 review fix: `loadAppConfig` collapses "only the
        // pre-rename filename is here" into the same `undefined` as
        // "no app here at all" (that is its documented contract — doctor must
        // never crash on the state it is diagnosing). Ask the narrower,
        // read-only probe separately so THIS specific state gets ONE FAIL row
        // naming the rename, instead of being told "run doctor from the app
        // directory" when the app is right there under the old name.
        const resolution = (
            ctx.deps.resolveConfigFile ?? defaultResolveConfigFile
        )();
        if (resolution.kind === "legacy") {
            return [
                mk(
                    "storage-mode",
                    "Static asset mode",
                    "fail",
                    `found ${LEGACY_CONFIG_FILE} in ${dirname(resolution.legacyPath)}, but knext now reads ${CONFIG_FILE} — there is no dual-read`,
                    `rename it, then re-run doctor: mv ${LEGACY_CONFIG_FILE} ${CONFIG_FILE}`,
                ),
            ];
        }
        return [
            mk(
                "storage-mode",
                "Static asset mode",
                "skip",
                "no knext.config.ts in this directory — run doctor from the app directory to see how its static assets will be served",
            ),
        ];
    }
    if (appConfig.storage) {
        return [
            mk(
                "storage-mode",
                "Static asset mode",
                "pass",
                `object storage configured (${appConfig.storage.provider}: ${appConfig.storage.bucket}) — assets are offloaded to the bucket and retained across deploys`,
            ),
        ];
    }
    return [
        mk(
            "storage-mode",
            "Static asset mode",
            "pass",
            "no object storage configured — static assets are served from the image (no CDN offload, no cross-deploy asset retention)",
            `add a storage block when you need the offload path: ${NO_STORAGE_DOCS_URL}`,
        ),
    ];
}
