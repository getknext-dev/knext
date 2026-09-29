/**
 * Legacy config-file detection (#1559 round-2 review fix).
 *
 * `loadConfig()` (`../shared.ts`) already knows the difference between "no
 * config here at all" and "only the pre-rename filename is here" -- it
 * throws a distinct `LegacyConfigFileError` for the latter, and every OTHER
 * CLI verb (build/deploy/...) routes its catch through
 * `handleConfigNotFound` to print the one-line rename block
 * (`formatLegacyConfigFile`). `knext doctor`'s checks never did: both
 * `storage-mode.ts` and `node-entry-staleness.ts` call `loadConfig()`
 * through a `try { } catch { return undefined; }` wrapper (their
 * `DoctorDeps.loadAppConfig` contract is "ANY failure -> undefined", on
 * purpose -- doctor diagnoses, it must never crash on the state it is
 * diagnosing), which collapsed the legacy-file case into the exact same
 * "nothing to see here" as a directory with no app at all. The result: a
 * directory holding ONLY the pre-rename file got told "no knext.config.ts in
 * this directory -- run doctor from the app directory", which is wrong --
 * the app IS there, just under the old name.
 *
 * `resolveConfigFile` is a SEPARATE, narrower probe -- a plain `existsSync`
 * check, not a config load -- so a check can ask "is this specifically the
 * legacy-rename case?" without touching its existing `loadAppConfig`/
 * `undefined` contract at all. Shared between `storage-mode.ts` (which owns
 * the one FAIL row) and `node-entry-staleness.ts` (which uses it only to
 * stop mislabeling the same state as "no config found").
 *
 * Reuses `CONFIG_FILE`/`LEGACY_CONFIG_FILE` from `../shared.ts` rather than
 * redeclaring the filenames here -- `../shared.ts` is the ONE file the
 * #1559 scan guard (`scripts/check-config-filename-mentions.mjs`) allows to
 * carry the pre-rename literal, so every OTHER surface (this one included)
 * must get it by reference, never by retyping it.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_FILE, LEGACY_CONFIG_FILE } from "../shared";
import type { ConfigFileResolution } from "./types";

export { CONFIG_FILE, LEGACY_CONFIG_FILE };

/**
 * Real default: does the CURRENT directory hold ONLY the pre-rename
 * filename (no {@link CONFIG_FILE} alongside it)? Read-only and never
 * imports/validates either file, so it stays correct even when the config
 * itself fails to load for an unrelated reason.
 */
export function defaultResolveConfigFile(): ConfigFileResolution {
    const cwd = process.cwd();
    if (existsSync(resolve(cwd, CONFIG_FILE))) {
        return { kind: "other" };
    }
    const legacyPath = resolve(cwd, LEGACY_CONFIG_FILE);
    if (existsSync(legacyPath)) {
        return { kind: "legacy", legacyPath };
    }
    return { kind: "other" };
}
