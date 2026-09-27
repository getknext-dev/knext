/**
 * The exec-plugin / cloud-credential kubeconfig refusal (#1533, ADR-0061).
 *
 * ADR-0061 is explicit: knext holds no cloud-account credentials, ever. A
 * kubeconfig whose `users[].user` carries an `exec:` or `auth-provider:`
 * entry authenticates by running a binary ON THE RUNNER — the cloud's own CLI
 * (`aws eks get-token`, `gke-gcloud-auth-plugin`, `oci ce cluster
 * generate-token`, `kubelogin`, …) with that cloud account's credentials in
 * scope. That is exactly the shape ADR-0061's tripwires forbid knext from
 * touching, and it is also just the wrong credential for CI: the
 * `knext-deployer` ServiceAccount token `kn-next init-ci` generates needs
 * nothing but the apiserver and a bearer token, on every cloud.
 *
 * This module is the ONE place that classifies a kubeconfig's shape, reused
 * by three call sites (#1533's scope): `init-ci --push-secret`, the
 * `kn-next-action` credential preflight, and `doctor --ci-kubeconfig`. A
 * refusal is a fact about the kubeconfig, not a fact about which of the three
 * happened to read it first — so there is one classifier and one sentence,
 * not three hand-maintained copies that can drift the way `credential-scope.ts`
 * already had to solve for the Role definition.
 *
 * Structural, not textual: the YAML is PARSED and `users[].user` is inspected
 * for the two keys, rather than grepping the raw text for `exec:` — a context
 * or cluster NAME containing the substring "exec" must never trip this.
 */
import { parse as parseYaml } from "yaml";

/**
 * The exact sentence #1533 specifies, verbatim, at all three call sites.
 * Exported so nothing downstream can quote a slightly-different paraphrase.
 */
export const CLOUD_CREDENTIAL_REFUSAL =
    "This kubeconfig needs cloud-account credentials on the runner. Use the knext-deployer ServiceAccount token.";

export interface KubeconfigSafetyVerdict {
    /** True when the kubeconfig carries no exec/auth-provider user entry. */
    ok: boolean;
    /** Set iff `ok` is false — either the refusal sentence or a parse error. */
    reason?: string;
}

interface ParsedKubeUser {
    name?: unknown;
    user?: Record<string, unknown> | null;
}

interface ParsedKubeconfig {
    users?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Classify a kubeconfig's authentication shape.
 *
 * Fails CLOSED on a kubeconfig this cannot even parse: an unreadable
 * kubeconfig is not evidence of safety, so refusing is the only honest
 * answer — matching the fail-closed discipline `credential-scope.ts` and
 * `preflight.mjs` already apply to "the review could not be performed".
 *
 * Checked ANYWHERE in `users[]`, not just the current context's user: a
 * kubeconfig with several contexts could otherwise pass by having the
 * refused user entry sit unreferenced by whichever context happens to be
 * "current" today and switched to tomorrow.
 */
export function classifyKubeconfigSafety(
    kubeconfigYaml: string,
): KubeconfigSafetyVerdict {
    let doc: ParsedKubeconfig;
    try {
        doc = (parseYaml(kubeconfigYaml) ?? {}) as ParsedKubeconfig;
    } catch (err) {
        return {
            ok: false,
            reason: `could not parse this as a kubeconfig (invalid YAML): ${
                err instanceof Error ? err.message : String(err)
            }`,
        };
    }

    if (!isRecord(doc) && doc !== null) {
        // parseYaml on non-mapping input (e.g. a bare scalar) — not a
        // kubeconfig at all, but not this function's job to say what it IS;
        // only whether the two dangerous keys are present, and they are not.
        return { ok: true };
    }

    const users = Array.isArray(doc.users) ? (doc.users as unknown[]) : [];
    for (const entry of users) {
        if (!isRecord(entry)) continue;
        const user = (entry as ParsedKubeUser).user;
        if (!isRecord(user)) continue;
        if ("exec" in user || "auth-provider" in user) {
            return { ok: false, reason: CLOUD_CREDENTIAL_REFUSAL };
        }
    }

    return { ok: true };
}
