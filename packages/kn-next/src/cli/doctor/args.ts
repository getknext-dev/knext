/**
 * Argument parsing for `knext doctor`.
 */

import { UsageError } from "../shared";

export interface DoctorArgs {
    json: boolean;
    help: boolean;
}

export function parseDoctorArgs(argv: readonly string[]): DoctorArgs {
    // Unknown flags fail loudly (a typo like `--jsno` must not silently run
    // the human-table mode a script then fails to parse).
    for (const a of argv) {
        if (a !== "--json" && a !== "-h" && a !== "--help") {
            throw new UsageError(
                `unknown argument "${a}" (see knext doctor --help)`,
            );
        }
    }
    return {
        json: argv.includes("--json"),
        help: argv.includes("-h") || argv.includes("--help"),
    };
}
