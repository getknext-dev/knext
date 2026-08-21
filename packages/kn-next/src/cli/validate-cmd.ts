/**
 * `kn-next validate` — check the config without touching a cluster
 * (UX ledger row 4, finding 4a; routed per the ADR-0046 dispatch contract).
 *
 * Runs config load + the schema checks (validate.ts, via loadConfig) + the
 * placeholder preflight (placeholder-preflight.ts), and nothing else — no
 * cluster tooling, no container tooling, no network; a scan test pins that
 * this module never imports an exec surface. Plain output on both streams,
 * exit 0/1.
 *
 * This is a separate module from validate.ts deliberately: validate.ts is the
 * load-time validation LIBRARY (shared.ts imports it, and it is re-exported as
 * the public `@getknext/core/validate` subpath), so the verb entry importing
 * loadConfig from shared.ts must live one file over or the two would form an
 * import cycle. Bin-dispatched only — NO self-entry block (#263; see the
 * hazard note atop deploy.ts's dispatcher).
 */

import { writeSync } from "node:fs";
import {
    assertNoPlaceholders,
    PlaceholderConfigError,
} from "./placeholder-preflight";
import { loadConfig, UsageError } from "./shared";
import { CONFIG_INVALID_CODE } from "./validate";

const VALIDATE_HELP = `kn-next validate — check kn-next.config.ts without deploying anything

Usage:
  kn-next validate

Loads the config from the current directory, runs every schema check, and
flags placeholder values (like "ghcr.io/<your-user>") that still need real
ones. Needs no cluster: it reads your config file and nothing else.

Exit code 0 means the config is ready for \`kn-next deploy\`.

Options:
  -h, --help            Show this help
`;

/** Injectable writers so tests can pin both streams; fd-backed by default. */
interface ValidateIO {
    out: (text: string) => void;
    err: (text: string) => void;
}

const FD_IO: ValidateIO = {
    out: (text) => writeSync(1, text),
    err: (text) => writeSync(2, text),
};

/**
 * argv entry for `kn-next validate` (dispatched by the bin; parses its OWN
 * argv per the ADR-0046 contract — flags first, so `validate --help` in an
 * empty directory is help, never a config error).
 */
export async function validateMain(
    argv: readonly string[],
    io: ValidateIO = FD_IO,
): Promise<number> {
    if (argv.includes("-h") || argv.includes("--help")) {
        io.out(VALIDATE_HELP);
        return 0;
    }
    for (const a of argv) {
        throw new UsageError(
            a.startsWith("-")
                ? `unknown flag "${a}" (see kn-next validate --help)`
                : `unexpected positional ${JSON.stringify(a)} — validate takes no arguments (see kn-next validate --help)`,
        );
    }

    let config: Awaited<ReturnType<typeof loadConfig>>;
    try {
        config = await loadConfig();
    } catch (err) {
        // A schema-invalid config is validate's VERDICT, not a crash: print
        // the validator's own plain message and exit 1. (Checked by `code`,
        // not instanceof — the tsup bundle can hold two copies of the class.)
        if (
            typeof err === "object" &&
            err !== null &&
            (err as { code?: unknown }).code === CONFIG_INVALID_CODE
        ) {
            io.err(`${String((err as Error).message)}\n`);
            return 1;
        }
        // Everything else — including the missing-config state — propagates:
        // the dispatcher already renders ConfigNotFound as guidance.
        throw err;
    }

    try {
        assertNoPlaceholders(config);
    } catch (err) {
        if (err instanceof PlaceholderConfigError) {
            io.err(err.message);
            return 1;
        }
        throw err;
    }

    io.out(
        `kn-next.config.ts is valid — "${config.name}" is ready for \`kn-next deploy\`.\n`,
    );
    return 0;
}
