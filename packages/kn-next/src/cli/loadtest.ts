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

async function main() {
    const { values } = parseArgs({
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
        log.error("--url <ksvc URL> is required (the Knative service URL)");
        process.exit(1);
    }

    const type = values.type as string as LoadTestType;
    if (!VALID_TYPES.includes(type)) {
        log.error(`--type must be one of ${VALID_TYPES.join(", ")}`);
        process.exit(1);
    }

    const config = await loadConfig();
    await runLoadTest(
        config.name,
        targetUrl,
        type,
        values.namespace as string,
        config.observability?.enabled ?? false,
    );
}

// Run only when invoked directly (Node ESM entrypoint check).
if (
    import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith("loadtest.js")
) {
    main().catch((e: unknown) => {
        log.error(
            { err: e instanceof Error ? e.message : String(e) },
            "Failed to start load test",
        );
        process.exit(1);
    });
}
