/**
 * Argument parsing for `knext doctor`.
 */

import { UsageError } from "../shared";

export interface DoctorArgs {
    json: boolean;
    help: boolean;
    /**
     * Path from `--ci-kubeconfig <path>` (#1533) — a LOCAL file read, not a
     * cluster call. Undefined when the flag was not given, which is what
     * keeps every other invocation of `doctor` byte-identical to before
     * (`doctor-golden.test.ts` pins the row set).
     */
    ciKubeconfig?: string;
}

export function parseDoctorArgs(argv: readonly string[]): DoctorArgs {
    // Unknown flags fail loudly (a typo like `--jsno` must not silently run
    // the human-table mode a script then fails to parse).
    let json = false;
    let help = false;
    let ciKubeconfig: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--json") {
            json = true;
            continue;
        }
        if (a === "-h" || a === "--help") {
            help = true;
            continue;
        }
        if (a === "--ci-kubeconfig") {
            const value = argv[i + 1];
            if (value === undefined) {
                throw new UsageError(
                    "--ci-kubeconfig requires a file path (see knext doctor --help)",
                );
            }
            ciKubeconfig = value;
            i += 1; // consume the value too
            continue;
        }
        throw new UsageError(
            `unknown argument "${a}" (see knext doctor --help)`,
        );
    }
    return { json, help, ciKubeconfig };
}
