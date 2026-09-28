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
    type CiProvider,
    initCi,
    nextSteps,
    RBAC_PATH,
    skippedFileMessage,
    WORKFLOW_PATH,
} from "./init-ci";
import { GITLAB_CI_PATH } from "./init-ci-gitlab";
import { pushKubeconfigSecret } from "./push-kubeconfig-secret";
import { pushKubeconfigSecretGitlab } from "./push-kubeconfig-secret-gitlab";

const PROVIDERS: readonly CiProvider[] = ["github", "gitlab"];

function isCiProvider(value: string): value is CiProvider {
    return (PROVIDERS as readonly string[]).includes(value);
}

const log = createLogger({ module: "init-ci" });

const USAGE = `knext init-ci — set up push-to-deploy against YOUR cluster

  Writes two files and touches no cluster:

    ${WORKFLOW_PATH}   the deploy workflow (--provider github, the default)
    ${GITLAB_CI_PATH}                  the deploy pipeline (--provider gitlab)
    ${RBAC_PATH}                 a ServiceAccount, Role and RoleBinding

  The Role grants permission to write ONE kind of object in ONE namespace.
  knext hosts nothing and never holds your credentials.

Options
  --namespace <name>      namespace to deploy into (required)
  --provider <name>       github (default) or gitlab
  --app-dir <path>        app directory, relative to the repo root (default: .)
  --force                 overwrite files that already exist
  --push-secret <path>    read a kubeconfig from <path> and push it as the
                           KNEXT_KUBECONFIG secret/CI-CD variable — via
                           \`gh secret set\` (github) or \`glab variable set\`
                           (gitlab). Refuses a kubeconfig that needs
                           cloud-account credentials (exec/auth-provider). The
                           token is never printed or logged — only piped to
                           the provider CLI's stdin.
  --help                  show this
`;

export async function initCiMain(argv: string[]): Promise<number> {
    let values: {
        namespace?: string;
        provider?: string;
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
                provider: { type: "string", default: "github" },
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

    const providerInput = values.provider ?? "github";
    if (!isCiProvider(providerInput)) {
        handleUsageError(
            new UsageError(
                `--provider must be one of ${PROVIDERS.join(", ")} (got ${JSON.stringify(providerInput)})`,
            ),
        );
        process.stderr.write(USAGE);
        return 1;
    }
    const provider = providerInput;

    const result = initCi(process.cwd(), {
        namespace: values.namespace,
        appDir: values["app-dir"] ?? ".",
        force: values.force,
        provider,
    });

    for (const f of result.written) log.info(`wrote ${f}`);
    for (const f of result.skipped) {
        // Not an error, and not silent either: a generator that quietly did
        // nothing is how someone concludes the tool is broken (#1535).
        log.warn(skippedFileMessage(f));
    }

    process.stdout.write(`\n${nextSteps(values.namespace, provider)}\n`);

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
        // anything echoed back — the return value of both pushers is typed
        // to carry no secret bytes either (no stdout/stderr field at all, by
        // construction).
        if (provider === "gitlab") {
            const pushed = pushKubeconfigSecretGitlab(raw);
            if (!pushed.ok) {
                process.stderr.write(`\nerror: ${pushed.error}\n`);
                return 1;
            }
            if (pushed.manualSteps) {
                process.stdout.write(`\n${pushed.manualSteps}\n`);
            } else {
                log.info(
                    `pushed ${path} as the KNEXT_KUBECONFIG CI/CD variable via \`glab variable set\``,
                );
            }
        } else {
            const pushed = pushKubeconfigSecret(raw);
            if (!pushed.ok) {
                process.stderr.write(`\nerror: ${pushed.error}\n`);
                return 1;
            }
            log.info(
                `pushed ${path} as the KNEXT_KUBECONFIG secret via \`gh secret set\``,
            );
        }
    }

    return 0;
}
