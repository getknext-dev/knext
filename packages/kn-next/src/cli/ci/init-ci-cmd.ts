#!/usr/bin/env node
/**
 * The `knext init-ci` verb entry (ADR-0049, #874).
 *
 * Separate from `init-ci.ts` for the same reason `validate-cmd.ts` is separate
 * from `validate.ts`: the generators are a library other things test and reuse,
 * and a verb entry that owns argument parsing, output and exit codes is not
 * something you want to import.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createLogger } from "../../utils/logger";
import { handleUsageError, UsageError } from "../shared";
import {
    initCi,
    nextSteps,
    RBAC_PATH,
    skippedFileMessage,
    WORKFLOW_PATH,
} from "./init-ci";
import { pushKubeconfigSecret } from "./push-kubeconfig-secret";

const log = createLogger({ module: "init-ci" });

const USAGE = `knext init-ci — set up push-to-deploy against YOUR cluster

  Writes two files and touches no cluster:

    ${WORKFLOW_PATH}   the deploy workflow
    ${RBAC_PATH}                 a ServiceAccount, Role and RoleBinding

  The Role grants permission to write ONE kind of object in ONE namespace.
  knext hosts nothing and never holds your credentials.

Options
  --namespace <name>      namespace to deploy into (required)
  --app-dir <path>        app directory, relative to the repo root (default: .)
  --force                 overwrite files that already exist
  --push-secret <path>    read a kubeconfig from <path> and push it as the
                           KNEXT_KUBECONFIG repo secret via \`gh secret set\`.
                           Refuses a kubeconfig that needs cloud-account
                           credentials (exec/auth-provider). The token is
                           never printed or logged — only piped to gh's stdin.
  --help                  show this
`;

export async function initCiMain(argv: string[]): Promise<number> {
    let values: {
        namespace?: string;
        "app-dir"?: string;
        force?: boolean;
        "push-secret"?: string;
        help?: boolean;
    };
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                namespace: { type: "string" },
                "app-dir": { type: "string", default: "." },
                force: { type: "boolean", default: false },
                "push-secret": { type: "string" },
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
        // nothing is how someone concludes the tool is broken (#1535).
        log.warn(skippedFileMessage(f));
    }

    process.stdout.write(`\n${nextSteps(values.namespace)}\n`);

    if (values["push-secret"]) {
        const path = values["push-secret"];
        let raw: string;
        try {
            raw = readFileSync(resolve(process.cwd(), path), "utf8");
        } catch (err) {
            // A file-not-found here is never logged with the path's contents
            // — only the path itself and the OS error, neither of which can
            // carry the kubeconfig's bytes.
            process.stderr.write(
                `\nerror: could not read ${path}: ` +
                    `${err instanceof Error ? err.message : String(err)}\n`,
            );
            return 1;
        }

        // The classifier + push both run on the RAW file content, never on
        // anything echoed back — pushKubeconfigSecret's own return value is
        // typed to carry no secret bytes either (GhRunResult has no
        // stdout/stderr field at all, by construction).
        const pushed = pushKubeconfigSecret(raw);
        if (!pushed.ok) {
            process.stderr.write(`\nerror: ${pushed.error}\n`);
            return 1;
        }
        log.info(
            `pushed ${path} as the KNEXT_KUBECONFIG secret via \`gh secret set\``,
        );
    }

    return 0;
}
