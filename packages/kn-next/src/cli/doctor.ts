#!/usr/bin/env node

/**
 * kn-next doctor — cluster-prereq preflight.
 *
 * Usage:
 *   kn-next doctor [--json]
 *
 * Runs the checks a fresh `kn-next deploy` depends on, each one field-learned
 * from a real outage:
 *   (a) NextApp CRD present + a served version
 *   (b) operator Deployment Ready in kn-next-operator-system
 *   (c) cert-manager webhook prereq (the operator bundle ships webhook certs)
 *   (d) config-network ingress-class vs the reconciler that actually serves it
 *       (#208)
 *   (e) operator-image anonymous pullability (#198)
 *   (e2) APP-image pullability vs the app SA's pull credentials (#952)
 *   (f) Knative Serving installed
 *   (g) the LOCAL kubectl is new enough (>= v1.25) for `--validate=strict`
 *
 * READ-ONLY by construction (ADR-0001): every kubectl call is a `get` or a
 * client-side `version`; the registry probe is an HTTP manifest HEAD.
 *
 * Exit-code contract:
 *   - 1 on hard FAILs (a cluster-state fact is wrong) AND on probe ERRORs
 *     (#230). WARN/SKIP never fail the preflight; a fully-unreachable cluster
 *     keeps the documented degrade path (gate WARNs, every check SKIPs, exit 0).
 *
 * DECOMPOSED (#1055): this file is now a thin orchestrator over the spine
 * modules in `./doctor/{types,kubectl,report,args}.ts` and the per-check
 * modules in `./doctor/checks/*`. The check SEQUENCE below is load-bearing —
 * it is the row order of the human table, pinned byte-identical by
 * `__tests__/doctor-golden.test.ts`. The public symbols this module has always
 * exported are re-exported here for back-compat (deploy.ts / status.ts / the
 * test suite import them from `./doctor`).
 */

import { writeSync } from "node:fs";
import { parseDoctorArgs } from "./doctor/args";
import { appImageCheck } from "./doctor/checks/app-image";
import { certManagerCheck } from "./doctor/checks/cert-manager";
import { clusterCheck } from "./doctor/checks/cluster";
import { crdCheck } from "./doctor/checks/crd";
import { crdSchemaCheck } from "./doctor/checks/crd-schema";
import { ingressCheck } from "./doctor/checks/ingress";
import { knativeCheck } from "./doctor/checks/knative";
import { kubectlValidationCheck } from "./doctor/checks/kubectl-validation";
import { metricsCheck } from "./doctor/checks/metrics";
import { networkPolicyCheck } from "./doctor/checks/network-policy";
import { operatorCheck } from "./doctor/checks/operator";
import { operatorImageCheck } from "./doctor/checks/operator-image";
import { storageModeCheck } from "./doctor/checks/storage-mode";
import { kubectlRunner, probeManifest } from "./doctor/kubectl";
import { formatDoctorTable } from "./doctor/report";
import type {
    CheckContext,
    CheckResult,
    DoctorDeps,
    DoctorReport,
} from "./doctor/types";

export { type DoctorArgs, parseDoctorArgs } from "./doctor/args";
export {
    classifyCNIEnforcement,
    classifyKubectlFailure,
    diagnoseNoCluster,
    infraFailure,
    inspectKubeconfig,
    kubectlRunner,
    parseImageRef,
    parseKubectlClientVersion,
    probeManifest,
    supportsStrictValidation,
} from "./doctor/kubectl";
export { formatDoctorTable } from "./doctor/report";
// ── Back-compat public surface ──────────────────────────────────────────────
// deploy.ts, status.ts and the test suite import these from `./doctor`.
export type {
    CheckResult,
    CheckStatus,
    CNIEnforcement,
    DaemonSetRef,
    DoctorDeps,
    DoctorReport,
    KubeconfigInspectFn,
    KubeconfigState,
    KubectlFailureClass,
    KubectlFn,
    KubectlResult,
    ManifestProbeFn,
    ProbeOutcome,
} from "./doctor/types";
export {
    KOURIER_INGRESS_CLASS,
    MIN_STRICT_VALIDATION_KUBECTL,
    PRIVATE_REGISTRY_DOCS_URL,
    QUEUE_PROXY_OWNED_PORTS,
    QUEUE_PROXY_USER_METRICS_PORT,
} from "./doctor/types";

/**
 * Run every preflight check. Pure orchestration over the injected deps: the
 * cluster gate decides `skipAll`, then each check module is called in the
 * documented sequence and its results concatenated in order.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
    const checks: CheckResult[] = [];

    const cluster = clusterCheck(deps);
    checks.push(...cluster.checks);

    const ctx: CheckContext = {
        deps,
        kubectl: deps.kubectl,
        skipAll: !cluster.reachable,
    };

    checks.push(...kubectlValidationCheck(ctx));
    checks.push(...(await storageModeCheck(ctx)));
    checks.push(...crdCheck(ctx));
    checks.push(...crdSchemaCheck(ctx));
    checks.push(...operatorCheck(ctx)); // sets ctx.operatorImage
    checks.push(...certManagerCheck(ctx));
    checks.push(...ingressCheck(ctx));
    checks.push(...(await operatorImageCheck(ctx))); // reads ctx.operatorImage
    checks.push(...(await appImageCheck(ctx)));
    checks.push(...knativeCheck(ctx));
    checks.push(...metricsCheck(ctx));
    checks.push(...networkPolicyCheck(ctx));

    // ERRORs exit nonzero like FAILs (#230): an errored probe means the
    // preflight could NOT verify the cluster — reporting green would be a lie.
    const exitCode = checks.some(
        (c) => c.status === "fail" || c.status === "error",
    )
        ? 1
        : 0;
    return { checks, exitCode };
}

const DOCTOR_HELP = `kn-next doctor — cluster-prereq preflight (read-only)

Checks: NextApp CRD, operator readiness, cert-manager webhook, Knative
ingress-class vs its reconciler (#208), operator-image pullability (#198),
app-image pullability vs the namespace's pull credentials (#952),
Knative Serving, CNI NetworkPolicy enforcement (whether the cluster can\nenforce the operator's default-on policy — on flannel it cannot), and the\nlocal kubectl's --validate=strict support. Exit 1 on
hard FAILs and on probe ERRORs (a check's kubectl
probe hit a network/TLS/credential/RBAC failure — the cluster state could not
be verified); WARN/SKIP never fail; a fully unreachable cluster SKIPs (exit 0).
A missing/empty kubeconfig, or a refused dial on a local-only apiserver
address, is reported plainly as "no cluster connected yet" (with the
getting-started guide), never as a network flake.

Options:
  --json      Emit the check results as JSON
  -h, --help  Show this help
`;

/**
 * Entry for `kn-next doctor`. Returns the process exit code.
 *
 * `deps` defaults to the production kubectl runner + registry probe; tests
 * inject fakes so the unit suite never shells out to a real kubectl or dials
 * a real registry (a real probe cost ~7s of connection timeouts under CI
 * load and flaked the 5s test budget).
 */
export async function doctorMain(
    argv: readonly string[],
    deps: DoctorDeps = { kubectl: kubectlRunner, probeImage: probeManifest },
): Promise<number> {
    // parseDoctorArgs first, so an unknown flag is rejected before anything
    // runs (byte-identical to the pre-decomposition monolith). Then the
    // -h/--help short-circuit prints DOCTOR_HELP and returns 0 WITHOUT touching
    // the cluster — the ADR-0046 cli-verb-dispatch contract requires this
    // module's own Main to parse its own argv for help (guarded by
    // cli-dispatch-contract.test.ts, which scans for the includes("--help")
    // idiom here).
    const args = parseDoctorArgs(argv);
    if (args.help || argv.includes("--help") || argv.includes("-h")) {
        writeSync(1, DOCTOR_HELP);
        return 0;
    }
    const report = await runDoctor(deps);
    if (args.json) {
        writeSync(1, `${JSON.stringify(report, null, 2)}\n`);
    } else {
        writeSync(1, formatDoctorTable(report.checks));
    }
    return report.exitCode;
}

// NO self-entry block here, DELIBERATELY — this module is reached ONLY via
// the kn-next bin's subcommand dispatch (see the hazard note atop deploy.ts's
// dispatcher: an isEntrypoint block in a bin-dispatched module re-arms the
// tsup-inlining hijack, #263).
