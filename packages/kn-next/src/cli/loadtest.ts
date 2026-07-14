#!/usr/bin/env node
/**
 * kn-next loadtest — generate + apply a k6 load-test Job against a Knative ksvc
 * (#30, salvaged from PR #10 and retargeted from the old vinext admin app to the
 * Knative serving URL).
 *
 * This is a MANUAL/NIGHTLY operability tool, NOT a PR gate. See the runbook:
 *   apps/file-manager/docs/loadtest-runbook.md
 *
 * Usage:
 *   kn-next loadtest --url https://app.example.com --type scale-to-zero [--namespace default]
 *
 * ADR-0001 note: this does NOT mutate cluster app state — it applies an ephemeral
 * k6 Job (ttlSecondsAfterFinished cleans it up). It does not touch the NextApp CR.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
    generateLoadTestManifests,
    type LoadTestType,
} from "../generators/loadtest-job";
import { createLogger } from "../utils/logger";
import { isEntrypoint } from "./exec";
import { loadConfig } from "./shared";

const log = createLogger({ module: "loadtest" });

const VALID_TYPES: LoadTestType[] = ["smoke", "load", "spike", "scale-to-zero"];

export async function runLoadTest(
    appName: string,
    targetUrl: string,
    type: LoadTestType,
    namespace = "default",
    observabilityEnabled = false,
): Promise<string> {
    const outputDir = join(process.cwd(), ".kn-next", "loadtest", appName);
    if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
    }

    // Pipe k6 metrics to the in-cluster Prometheus only when observability is on.
    const prometheusUrl = observabilityEnabled
        ? `http://prometheus-operated.${namespace}.svc.cluster.local:9090`
        : undefined;

    const manifests = generateLoadTestManifests(
        appName,
        namespace,
        targetUrl,
        type,
        prometheusUrl,
    );
    const manifestPath = join(outputDir, `job-${type}-${Date.now()}.yaml`);
    writeFileSync(manifestPath, manifests.join("\n---\n"));
    log.info({ manifestPath }, "Generated load-test manifest");

    // Apply via kubectl using execFile (ARGV array — no shell, no injection).
    log.info({ appName, type, namespace }, "Applying k6 load-test Job");
    execFileSync("kubectl", ["apply", "-f", manifestPath], {
        stdio: "inherit",
    });
    log.info(
        {
            tail: `kubectl logs -n ${namespace} -l app=k6-loadtest,target=${appName} -f`,
        },
        "Load-test Job started",
    );
    return manifestPath;
}

/** Injectable side-effects so the CLI wrapper is unit-testable + hermetic. */
export interface LoadTestCliDeps {
    /**
     * STDERR sink. Every early-exit error path MUST write a short hint here
     * BEFORE returning a non-zero code — a silent exit reads as false success.
     * Defaults to fd 2 (`process.stderr.write`), NOT pino (which writes fd 1).
     */
    stderr?: (line: string) => void;
}

/**
 * Parse argv and run the load test, returning the process exit code.
 *
 * Contract (v3-P6a): on every error/empty path this prints a one-line hint to
 * STDERR and returns a NON-ZERO code — it must never silently `exit(0)`.
 *
 * @param argv - args after the `loadtest` subcommand word
 * @param deps - injectable stderr sink (defaults to process.stderr)
 * @returns process exit code (0 success, 1 on any handled error)
 */
export async function runLoadTestCli(
    argv: readonly string[],
    deps: LoadTestCliDeps = {},
): Promise<number> {
    const emit = deps.stderr ?? ((line: string) => process.stderr.write(line));
    const hint = (msg: string) => emit(`${msg}\n`);

    const { values } = parseArgs({
        args: [...argv],
        options: {
            url: { type: "string", short: "u" },
            type: { type: "string", short: "t", default: "smoke" },
            namespace: { type: "string", short: "n", default: "default" },
        },
        strict: false,
        allowPositionals: true,
    });

    const targetUrl = values.url as string | undefined;
    if (!targetUrl) {
        hint("--url <ksvc URL> is required (the Knative service URL)");
        return 1;
    }

    const type = values.type as string as LoadTestType;
    if (!VALID_TYPES.includes(type)) {
        hint(`--type must be one of ${VALID_TYPES.join(", ")}`);
        return 1;
    }

    try {
        const config = await loadConfig();
        await runLoadTest(
            config.name,
            targetUrl,
            type,
            values.namespace as string,
            config.observability?.enabled ?? false,
        );
    } catch (e: unknown) {
        // Never bubble out as a silent exit — always leave a stderr breadcrumb.
        hint(
            `failed to start load test: ${e instanceof Error ? e.message : String(e)}`,
        );
        return 1;
    }
    return 0;
}

// Run only when invoked directly. Uses the SHARED isEntrypoint guard (./exec)
// — the same symlink-correct check every other CLI entrypoint uses — instead
// of a hand-rolled import.meta.url / basename comparison (see #263 / exec.ts).
if (isEntrypoint(import.meta.url)) {
    runLoadTestCli(process.argv.slice(2))
        .then((code) => process.exit(code))
        .catch((err) => {
            // Last-resort guard: an unexpected throw (e.g. from argv parsing,
            // outside runLoadTestCli's own try/catch) must never exit silently.
            process.stderr.write(
                `load test failed unexpectedly: ${err instanceof Error ? err.message : String(err)}\n`,
            );
            process.exit(1);
        });
}
