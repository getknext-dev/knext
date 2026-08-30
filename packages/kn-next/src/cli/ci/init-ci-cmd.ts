#!/usr/bin/env node
/**
 * The `kn-next init-ci` verb entry (ADR-0049, #874).
 *
 * Separate from `init-ci.ts` for the same reason `validate-cmd.ts` is separate
 * from `validate.ts`: the generators are a library other things test and reuse,
 * and a verb entry that owns argument parsing, output and exit codes is not
 * something you want to import.
 */
import { parseArgs } from "node:util";
import { createLogger } from "../../utils/logger";
import { handleUsageError, UsageError } from "../shared";
import { initCi, nextSteps, RBAC_PATH, WORKFLOW_PATH } from "./init-ci";

const log = createLogger({ module: "init-ci" });

const USAGE = `kn-next init-ci — set up push-to-deploy against YOUR cluster

  Writes two files and touches no cluster:

    ${WORKFLOW_PATH}   the deploy workflow
    ${RBAC_PATH}                 a ServiceAccount, Role and RoleBinding

  The Role grants permission to write ONE kind of object in ONE namespace.
  knext hosts nothing and never holds your credentials.

Options
  --namespace <name>   namespace to deploy into (required)
  --app-dir <path>     app directory, relative to the repo root (default: .)
  --force              overwrite files that already exist
  --help               show this
`;

export async function initCiMain(argv: string[]): Promise<number> {
    let values: {
        namespace?: string;
        "app-dir"?: string;
        force?: boolean;
        help?: boolean;
    };
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                namespace: { type: "string" },
                "app-dir": { type: "string", default: "." },
                force: { type: "boolean", default: false },
                help: { type: "boolean", short: "h", default: false },
            },
            allowPositionals: false,
        }));
    } catch (err) {
        handleUsageError(
            new UsageError(err instanceof Error ? err.message : String(err)),
        );
        process.stderr.write(USAGE);
        return 1;
    }

    if (values.help) {
        process.stdout.write(USAGE);
        return 0;
    }

    if (!values.namespace) {
        handleUsageError(
            new UsageError(
                "--namespace is required: it is what bounds the credential's " +
                    "blast radius, so there is no safe default.",
            ),
        );
        process.stderr.write(USAGE);
        return 1;
    }

    const result = initCi(process.cwd(), {
        namespace: values.namespace,
        appDir: values["app-dir"] ?? ".",
        force: values.force,
    });

    for (const f of result.written) log.info(`wrote ${f}`);
    for (const f of result.skipped) {
        // Not an error, and not silent either: a generator that quietly did
        // nothing is how someone concludes the tool is broken.
        log.warn(`${f} already exists — left alone (use --force to overwrite)`);
    }

    process.stdout.write(`\n${nextSteps(values.namespace)}\n`);
    return 0;
}
