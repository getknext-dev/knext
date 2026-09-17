/**
 * (i) CNI NetworkPolicy enforcement (#744). The operator reconciles a
 * default-on NetworkPolicy for every app, but flannel — which OKE GA and
 * OrbStack both run — ships no NetworkPolicy controller, so there the policy is
 * written yet enforces nothing. Detection is read-only (DaemonSet signatures;
 * doctor never launches probe pods) and fails honest: "cannot determine" is a
 * distinct outcome from "enforced", never folded into it.
 */

import {
    classifyCNIEnforcement,
    classifyKubectlFailure,
    infraFailure,
    safeJson,
} from "../kubectl";
import { mk } from "../report";
import type { CheckContext, CheckResult, DaemonSetRef } from "../types";
import { SKIP_UNREACHABLE } from "../types";

export function networkPolicyCheck(ctx: CheckContext): CheckResult[] {
    if (ctx.skipAll) {
        return [
            mk("netpol", "NetworkPolicy enforcement", "skip", SKIP_UNREACHABLE),
        ];
    }
    const ds = ctx.kubectl([
        "kubectl",
        "get",
        "daemonsets",
        "--all-namespaces",
        "-o",
        "json",
    ]);
    const dsInfra = ds.ok ? undefined : infraFailure(ds);
    if (!ds.ok && classifyKubectlFailure(ds.stderr) === "forbidden") {
        // A denied read is "cannot determine", not an infra ERROR: the check is
        // diagnosis, and the honest fallback — treat as unenforced — holds with
        // or without the permission.
        return [
            mk(
                "netpol",
                "NetworkPolicy enforcement",
                "warn",
                "cannot determine whether the cluster's CNI enforces NetworkPolicy (listing DaemonSets was denied by RBAC) — treat the operator's NetworkPolicy as UNENFORCED until verified",
                "grant `list daemonsets` cluster-wide for this diagnosis, or verify your CNI's NetworkPolicy support manually",
            ),
        ];
    }
    if (dsInfra) {
        return [
            mk(
                "netpol",
                "NetworkPolicy enforcement",
                "error",
                dsInfra.detail,
                dsInfra.hint,
            ),
        ];
    }
    const items = ds.ok
        ? (safeJson<{
              items?: {
                  metadata?: { name?: string; namespace?: string };
                  status?: { numberReady?: number };
              }[];
          }>(ds.stdout)?.items ?? [])
        : [];
    // numberReady > 0, not "unavailable === 0": PARTIAL readiness (agent up on
    // 2 of 5 nodes) still counts as running. This verdict answers "is an
    // enforcing agent alive at all" — what separates a real control from an
    // inert one — and the PASS wording hedges the rest. Absent status is 0,
    // i.e. not running: never assume health.
    const refs: DaemonSetRef[] = items.map((i) => ({
        name: i.metadata?.name ?? "",
        namespace: i.metadata?.namespace ?? "",
        ready: (i.status?.numberReady ?? 0) > 0,
    }));
    const { verdict, evidence } = classifyCNIEnforcement(refs);
    if (verdict === "enforced") {
        return [
            mk(
                "netpol",
                "NetworkPolicy enforcement",
                "pass",
                `a NetworkPolicy-enforcing agent is running (${evidence}) — the operator's default-on NetworkPolicy objects should be enforced; per-CNI configuration can still exempt traffic, so verify directly if isolation is load-bearing`,
            ),
        ];
    }
    if (verdict === "likely-unenforced") {
        return [
            mk(
                "netpol",
                "NetworkPolicy enforcement",
                "warn",
                `flannel is the cluster CNI (${evidence}) and no NetworkPolicy controller was detected — the operator still writes its default-on NetworkPolicy, but it is declarative only: it enforces NOTHING on this cluster (OKE GA and OrbStack both run flannel), so treat network isolation as absent`,
                "install a policy-capable CNI (Calico or Cilium) to make the NetworkPolicy effective",
            ),
        ];
    }
    if (evidence) {
        // An enforcing agent is installed but has no running pod — the round-1
        // false green. Name it: "calico is installed" and "calico is working"
        // are very different incidents.
        return [
            mk(
                "netpol",
                "NetworkPolicy enforcement",
                "warn",
                `a NetworkPolicy-enforcing agent is installed but not running (${evidence}) — cannot determine enforcement; treat the operator's NetworkPolicy as UNENFORCED until the agent is healthy`,
                "check the agent's pods (kubectl get pods -A -o wide | grep -E 'calico|cilium|antrea|weave|kube-router') — a crashed CNI agent enforces nothing",
            ),
        ];
    }
    return [
        mk(
            "netpol",
            "NetworkPolicy enforcement",
            "warn",
            "cannot determine whether the cluster's CNI enforces NetworkPolicy (no known CNI DaemonSet signature found) — treat the operator's NetworkPolicy as UNENFORCED until verified",
            "verify your CNI's NetworkPolicy support manually; a policy written but not enforced provides no isolation",
        ),
    ];
}
