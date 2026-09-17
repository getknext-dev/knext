/**
 * (e2, #952) APP image pullability — the operator-image anonymous-manifest
 * probe, extended from the operator image to every NextApp's spec.image. A
 * fresh namespace's first deploy sits in ImagePullBackOff when the app image
 * lives on a private registry (OCIR/private GHCR/ECR — the NORMAL targets) and
 * nothing in the namespace carries a credential.
 *
 * The ONLY carrier that counts for a pass is the app ServiceAccount (<app>-sa):
 * pods resolve pull secrets from the SA at pod creation, and the operator
 * writes imagePullSecrets nowhere else on the revision template. A
 * dockerconfigjson Secret sitting UNATTACHED is dead weight — it gets its own
 * WARN, never a pass.
 *
 * Honest-status shape throughout: an unreachable registry, an exhausted probe
 * budget, or an unreadable SA degrades to "not verified", NEVER to a pass — and
 * attachment PRESENCE is all this read-only check can see; it never proves the
 * credential actually authorizes the pull.
 */

import { writeSync } from "node:fs";
import { classifyKubectlFailure, infraFailure, safeJson } from "../kubectl";
import { mk } from "../report";
import type { CheckContext, CheckResult, ProbeOutcome } from "../types";
import { PRIVATE_REGISTRY_DOCS_URL, SKIP_UNREACHABLE } from "../types";

export async function appImageCheck(ctx: CheckContext): Promise<CheckResult[]> {
    const deps = ctx.deps;
    if (ctx.skipAll) {
        return [
            mk("app-image", "App image pullable", "skip", SKIP_UNREACHABLE),
        ];
    }
    const apps = ctx.kubectl([
        "kubectl",
        "get",
        "nextapps",
        "--all-namespaces",
        "-o",
        "json",
    ]);
    const appsInfra = apps.ok ? undefined : infraFailure(apps);
    if (appsInfra) {
        return [
            mk(
                "app-image",
                "App image pullable",
                "error",
                `${appsInfra.detail} — NextApp image pullability could not be verified`,
                appsInfra.hint,
            ),
        ];
    }
    // A non-infra list failure (CRD not installed yet) means no NextApps exist
    // whose images could need pulling.
    const items = apps.ok
        ? (safeJson<{
              items?: {
                  metadata?: { name?: string; namespace?: string };
                  spec?: { image?: string };
              }[];
          }>(apps.stdout)?.items ?? [])
        : [];
    const targets = items.flatMap((i) => {
        const name = i.metadata?.name;
        const namespace = i.metadata?.namespace;
        const image = i.spec?.image;
        return name && namespace && image ? [{ name, namespace, image }] : [];
    });
    if (targets.length === 0) {
        return [
            mk(
                "app-image",
                "App image pullable",
                "skip",
                "no NextApps on this cluster — nothing to verify",
            ),
        ];
    }
    // Evidence buckets; the row's status is the WORST bucket hit
    // (warn > skip > pass) and the detail names every non-empty one, so a
    // mixed cluster never hides an app.
    const notFound: string[] = [];
    const noCreds: string[] = [];
    const unattached: string[] = [];
    const credsUnknown: string[] = [];
    const withCreds: string[] = [];
    const anonymous: string[] = [];
    const unreachable: string[] = [];
    const unprobed: string[] = [];
    // Bounded fan-out: unique images only (apps share images), a small
    // concurrent pool, and a TOTAL time budget — 20 dead registries must cost
    // seconds, not 20 × the per-fetch timeout. Images the budget cuts off are
    // "not verified", never guessed. (In-flight probes are not cancelled — each
    // is bounded internally — so the overrun past the deadline is at most one
    // probe's worth, not the whole queue's.)
    const budgetMs = deps.appImageProbeBudgetMs ?? 30_000;
    const deadline = Date.now() + budgetMs;
    const uniqueImages = [...new Set(targets.map((t) => t.image))];
    if (uniqueImages.length > 3) {
        writeSync(
            2,
            `doctor: probing ${uniqueImages.length} app images for anonymous pullability (bounded, <=${Math.round(budgetMs / 1000)}s total)\n`,
        );
    }
    const probeCache = new Map<string, ProbeOutcome | "budget-exhausted">();
    let nextImage = 0;
    const worker = async () => {
        while (nextImage < uniqueImages.length) {
            const image = uniqueImages[nextImage];
            nextImage += 1;
            if (image === undefined) break;
            if (Date.now() >= deadline) {
                probeCache.set(image, "budget-exhausted");
                continue;
            }
            probeCache.set(image, await deps.probeImage(image));
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(4, uniqueImages.length) }, worker),
    );
    // Namespace Secret listings answer for every app in the namespace, so
    // cache per namespace.
    const nsSecretCache = new Map<string, "has" | "none" | "unknown">();
    for (const t of targets) {
        const outcome = probeCache.get(t.image);
        const label = `${t.namespace}/${t.name} (${t.image})`;
        if (outcome === "budget-exhausted" || outcome === undefined) {
            unprobed.push(label);
            continue;
        }
        if (outcome === "ok") {
            anonymous.push(label);
            continue;
        }
        if (outcome === "not-found") {
            notFound.push(label);
            continue;
        }
        if (outcome === "unreachable") {
            unreachable.push(label);
            continue;
        }
        // auth-required: the ONLY carrier that counts for a pass is the app SA
        // — pods resolve pull secrets from it at pod creation, and the operator
        // writes imagePullSecrets nowhere else on the revision template.
        const sa = ctx.kubectl([
            "kubectl",
            "get",
            "serviceaccount",
            `${t.name}-sa`,
            "-n",
            t.namespace,
            "-o",
            "json",
        ]);
        let saState: "has" | "none" | "unknown";
        if (sa.ok) {
            const parsed = safeJson<{
                imagePullSecrets?: { name?: string }[];
            }>(sa.stdout);
            saState =
                (parsed?.imagePullSecrets?.length ?? 0) > 0 ? "has" : "none";
        } else {
            // A missing SA (operator not yet reconciled) carries no credential
            // — that is a fact, not an unknown.
            saState =
                classifyKubectlFailure(sa.stderr) === "not-found"
                    ? "none"
                    : "unknown";
        }
        // The namespace Secret listing is DIAGNOSTIC only — it tells "no
        // credential anywhere" apart from "created the Secret, skipped the
        // attach". It can never produce a pass, so it is fetched only when the
        // SA verifiably has nothing, and it is field-selector-narrowed: no
        // Secret payloads are materialized, and RBAC can grant the read
        // narrowly.
        let nsState: "has" | "none" | "unknown" | undefined;
        if (saState === "none") {
            nsState = nsSecretCache.get(t.namespace);
            if (nsState === undefined) {
                const secrets = ctx.kubectl([
                    "kubectl",
                    "get",
                    "secrets",
                    "-n",
                    t.namespace,
                    "--field-selector",
                    "type=kubernetes.io/dockerconfigjson",
                    "-o",
                    "name",
                ]);
                if (secrets.ok) {
                    nsState = secrets.stdout.trim() === "" ? "none" : "has";
                } else {
                    nsState =
                        classifyKubectlFailure(secrets.stderr) === "not-found"
                            ? "none"
                            : "unknown";
                }
                nsSecretCache.set(t.namespace, nsState);
            }
        }
        if (saState === "has") {
            withCreds.push(
                `${label}: imagePullSecrets on ServiceAccount ${t.name}-sa`,
            );
        } else if (nsState === "has") {
            unattached.push(label);
        } else if (saState === "none" && nsState === "none") {
            noCreds.push(label);
        } else {
            credsUnknown.push(label);
        }
    }
    const parts: string[] = [];
    if (notFound.length > 0) {
        // A 404 is AMBIGUOUS anonymously: some registries (Artifactory, Harbor)
        // answer 404 rather than 401 for private repositories, so "does not
        // exist" would false-red every such user. Warn with both readings.
        parts.push(
            `${notFound.join(", ")}: 404 anonymously — either the image does not exist on its registry (new nodes cannot pull it; pods go ImagePullBackOff) or the registry hides private repositories behind 404 rather than 401 (Artifactory and Harbor do) — verify the image ref, and attach a pull credential if the repository is private (#952)`,
        );
    }
    if (noCreds.length > 0) {
        parts.push(
            `${noCreds.join(", ")} is NOT anonymously pullable and NO pull credential is visible — the namespace has no kubernetes.io/dockerconfigjson Secret and the app ServiceAccount lists no imagePullSecrets, so pods will sit in ImagePullBackOff (the registry answers 401/403, e.g. "Anonymous users are only allowed read access") (#952)`,
        );
    }
    if (unattached.length > 0) {
        parts.push(
            `${unattached.join(", ")}: a kubernetes.io/dockerconfigjson Secret exists in the namespace but the app ServiceAccount lists no imagePullSecrets — pods resolve pull secrets from the ServiceAccount, NOT from the namespace, so the credential does nothing until attached; attach it, then redeploy (#952)`,
        );
    }
    if (credsUnknown.length > 0) {
        parts.push(
            `${credsUnknown.join(", ")} is NOT anonymously pullable and doctor could not verify pull credentials (reading the app ServiceAccount, or the namespace's Secrets, was denied or failed) — treat the image as unpullable until verified`,
        );
    }
    if (unreachable.length > 0) {
        parts.push(
            `${unreachable.join(", ")}: registry unreachable (offline?) — pullability not verified`,
        );
    }
    if (unprobed.length > 0) {
        parts.push(
            `${unprobed.join(", ")}: not probed (the app-image probe budget ran out) — pullability not verified`,
        );
    }
    if (withCreds.length > 0) {
        parts.push(
            `${withCreds.join("; ")} — not anonymously pullable, but a pull credential is attached to the app ServiceAccount (doctor verifies attachment, not that the credential actually authorizes the pull)`,
        );
    }
    if (anonymous.length > 0) {
        parts.push(`${anonymous.join(", ")} anonymously pullable`);
    }
    const hasWarn =
        notFound.length > 0 ||
        noCreds.length > 0 ||
        unattached.length > 0 ||
        credsUnknown.length > 0;
    const status = hasWarn
        ? "warn"
        : unreachable.length > 0 || unprobed.length > 0
          ? "skip"
          : "pass";
    const hint =
        noCreds.length > 0 || credsUnknown.length > 0
            ? `create the registry credential and attach it to the app ServiceAccount, then redeploy — pull secrets are resolved at pod creation, so patching the SA alone does not rescue a running revision: kubectl create secret docker-registry <name> -n <namespace> --docker-server=… --docker-username=… --docker-password=…; full walkthrough: ${PRIVATE_REGISTRY_DOCS_URL}`
            : unattached.length > 0
              ? `attach the existing Secret to the app ServiceAccount and redeploy — pull secrets are resolved at pod creation: kubectl patch serviceaccount <app>-sa -n <namespace> --patch '{"imagePullSecrets":[{"name":"<secret>"}]}' (the patch REPLACES the whole imagePullSecrets list — include every entry); full walkthrough: ${PRIVATE_REGISTRY_DOCS_URL}`
              : undefined;
    return [
        mk("app-image", "App image pullable", status, parts.join("; "), hint),
    ];
}
