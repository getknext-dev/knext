/**
 * `experimental.turbopackModuleFragments` on the Bun runtime -- LOCAL and
 * read-only. Same condition `build` refuses (`../../turbopack-fragments-guard`);
 * no row unless it applies, so every other app's row set is unchanged.
 * Retire together with the guard (a Bun release containing the parser fix).
 */

import {
    DEFAULT_BUILDER_ID,
    DEFAULT_RUNTIME_ID,
} from "../../../adapters/artifact-contract";
import type { KnativeNextConfig } from "../../../config";
import { loadConfig } from "../../shared";
import {
    enablesTurbopackModuleFragments,
    readNextConfigStrict,
    TURBOPACK_FRAGMENTS_BUN_DETAIL,
    TURBOPACK_FRAGMENTS_BUN_HINT,
} from "../../turbopack-fragments-guard";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";

const ID = "turbopack-fragments-bun";
const TITLE = "turbopackModuleFragments on Bun";

/** Real cwd loader; any failure -> undefined (doctor never crashes on what it diagnoses). */
async function defaultLoadAppConfig(): Promise<KnativeNextConfig | undefined> {
    try {
        return await loadConfig();
    } catch {
        return undefined;
    }
}

export async function turbopackFragmentsCheck(
    ctx: CheckContext,
): Promise<CheckResult[]> {
    let config: KnativeNextConfig | undefined;
    try {
        config = await (ctx.deps.loadAppConfig ?? defaultLoadAppConfig)();
    } catch {
        config = undefined;
    }
    if (!config) return [];
    if ((config.runtime ?? DEFAULT_RUNTIME_ID) !== "bun") return [];
    if ((config.build ?? DEFAULT_BUILDER_ID) !== "turbopack") return [];
    let text: string | undefined;
    try {
        text = (ctx.deps.readNextConfigFile ?? readNextConfigStrict)();
    } catch {
        return [
            mk(
                ID,
                TITLE,
                "warn",
                "could not read next.config to check experimental.turbopackModuleFragments, which Bun cannot run",
                "fix the file's permissions; `knext build` refuses until it can be read",
            ),
        ];
    }
    if (text === undefined || !enablesTurbopackModuleFragments(text)) return [];
    return [
        mk(
            ID,
            TITLE,
            "fail",
            TURBOPACK_FRAGMENTS_BUN_DETAIL,
            TURBOPACK_FRAGMENTS_BUN_HINT,
        ),
    ];
}
