#!/usr/bin/env node
/**
 * The `knext ci-preflight` verb entry (#1534). Not typically run by hand —
 * it is what a generated CI pipeline with no composite-action equivalent
 * (`init-ci --provider gitlab`'s `.gitlab-ci.yml`) invokes to run the same
 * hazard preflight `kn-next-action` runs before any cluster-mutating call.
 *
 * Separate from `ci-preflight.ts` for the same reason `init-ci-cmd.ts` is
 * separate from `init-ci.ts`: the orchestration is a library other things
 * could import and test directly, and a verb entry that owns argument
 * parsing, output and exit codes is not something you want to import.
 */
import { parseArgs } from "node:util";
import { handleUsageError, UsageError } from "../shared";
import { runCiPreflight } from "./ci-preflight";

const USAGE = `knext ci-preflight — the credential preflight generated CI
pipelines run before any cluster-mutating call (the same check
kn-next-action runs). Not usually run by hand.

Options
  --namespace <name>     namespace the credential is scoped to (required)
  --kubeconfig <path>    kubeconfig file to check (default: $KUBECONFIG)
  --help                 show this
`;

export async function ciPreflightMain(argv: string[]): Promise<number> {
    let values: { namespace?: string; kubeconfig?: string; help?: boolean };
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                namespace: { type: "string" },
                kubeconfig: { type: "string" },
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
                "--namespace is required (see knext ci-preflight --help)",
            ),
        );
        process.stderr.write(USAGE);
        return 1;
    }

    const kubeconfigPath = values.kubeconfig ?? process.env.KUBECONFIG;
    if (!kubeconfigPath) {
        process.stderr.write(
            "error: no kubeconfig configured (--kubeconfig or $KUBECONFIG). Refusing.\n",
        );
        return 1;
    }

    const result = runCiPreflight({
        namespace: values.namespace,
        kubeconfigPath,
    });
    for (const line of result.lines) {
        (result.ok ? process.stdout : process.stderr).write(`${line}\n`);
    }
    return result.ok ? 0 : 1;
}
