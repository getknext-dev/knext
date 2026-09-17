/**
 * (h) static-asset mode (ADR-0047) — LOCAL and read-only, so it runs even when
 * the cluster is unreachable. Both modes are healthy states, so both are
 * "pass": the value is that the mode is STATED where the user looks, never
 * inferred from what happens to be in the config.
 */

import type { KnativeNextConfig } from "../../../config";
import { NO_STORAGE_DOCS_URL } from "../../../utils/asset-upload";
import { loadConfig } from "../../shared";
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
        return [
            mk(
                "storage-mode",
                "Static asset mode",
                "skip",
                "no kn-next.config.ts in this directory — run doctor from the app directory to see how its static assets will be served",
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
