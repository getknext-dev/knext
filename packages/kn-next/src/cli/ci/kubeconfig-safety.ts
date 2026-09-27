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
 * Structural, not textual: the YAML is PARSED (with and without merge-key
 * resolution) and every `users[]` entry is walked, at any depth, for the
 * cloud-auth keys — rather than grepping the raw text for `exec:`, so a
 * context or cluster NAME containing the substring "exec" never trips this.
 *
 * A refusal NEVER carries source text. A kubeconfig holds a credential, and a
 * YAML parser's error message quotes the line it failed on.
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

/**
 * The keys that make kubectl run a binary (or a cloud auth plugin) on the
 * runner. `authProvider` is client-go's Go field name; kubectl's decoder is
 * case-sensitive and ignores it today, but refusing it costs a scoped
 * credential nothing and does not bet on that decoder never changing.
 */
const CLOUD_AUTH_KEYS = new Set(["exec", "auth-provider", "authProvider"]);

/**
 * Two parse modes, both walked. `merge: true` resolves `<<` the way kubectl's
 * go-yaml does, so a merged-in `exec:` appears as a real key. `merge: false`
 * keeps `<<` as a literal key whose VALUE the depth walk below still descends
 * into — which is sufficient WHEN the `<<` sits under `users[i].user` or
 * deeper, because `doc.users` is unaffected by that merge and the walk still
 * reaches the merged-in value through the literal `<<` key.
 *
 * It is NOT sufficient for a ROOT-level merge (`<<: {users: [...]}` at the
 * top of the document, inline or via an alias): with `merge: false` that
 * leaves `doc['<<']` holding the whole map and `doc.users` itself undefined,
 * so `usersNeedCloudAuth` — which only reads `doc.users` — sees nothing.
 * `merge: true` is what makes `doc.users` exist at all in that case (review
 * of #1557, round 2, B2: measured against kubectl v1.33.3, which resolves
 * the root-level form and runs `exec`). So `merge: true` is REQUIRED, not
 * merely one of two equally-sufficient modes — do not "simplify" this to
 * `merge: false` alone.
 *
 * `logLevel: "error"` keeps parse WARNINGS (unresolved tags and the like)
 * off the console: a warning's message can quote source text, and this
 * source holds a credential. Errors still throw — and are never relayed.
 */
const PARSE_MODES = [
    { merge: true, logLevel: "error", prettyErrors: false },
    { merge: false, logLevel: "error", prettyErrors: false },
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The refusal for a file that does not parse. A FIXED sentence plus, at
 * most, the 1-based line NUMBER — never the parser's message, which quotes
 * the failing source line, and on a kubeconfig that line is often `token:`.
 */
function invalidYamlReason(err: unknown, source: string): string {
    // `YAMLError.pos` is a [start, end] character OFFSET pair; the line
    // number is derived from it here rather than read from anything that
    // carries text.
    const offset = (err as { pos?: readonly unknown[] })?.pos?.[0];
    const near =
        typeof offset === "number" &&
        Number.isInteger(offset) &&
        offset >= 0 &&
        offset <= source.length
            ? ` near line ${source.slice(0, offset).split("\n").length}`
            : "";
    return `could not parse this file as a kubeconfig (invalid YAML${near}). Its contents are not shown.`;
}

/**
 * True if `node` — or anything reachable from it, at any depth — carries a
 * cloud-auth key. Structural, over the RESOLVED object graph: aliases and
 * merged-in maps are real objects here. `seen` stops alias cycles.
 */
function reachesCloudAuthKey(node: unknown, seen: Set<object>): boolean {
    if (typeof node !== "object" || node === null) return false;
    if (seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) {
        return node.some((item) => reachesCloudAuthKey(item, seen));
    }
    if (node instanceof Map) {
        for (const [k, v] of node) {
            if (typeof k === "string" && CLOUD_AUTH_KEYS.has(k)) return true;
            if (reachesCloudAuthKey(k, seen) || reachesCloudAuthKey(v, seen)) {
                return true;
            }
        }
        return false;
    }
    for (const [k, v] of Object.entries(node)) {
        if (CLOUD_AUTH_KEYS.has(k)) return true;
        if (reachesCloudAuthKey(v, seen)) return true;
    }
    return false;
}

/** Does any `users[]` entry of one parsed document reach a cloud-auth key? */
function usersNeedCloudAuth(doc: unknown): boolean {
    if (!isRecord(doc)) return false;
    const users = doc.users;
    // Walk `users` whatever its shape (list, or a map kubectl would reject):
    // every entry, the whole entry, any depth.
    return reachesCloudAuthKey(users, new Set());
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
    for (const mode of PARSE_MODES) {
        let doc: unknown;
        try {
            doc = parseYaml(kubeconfigYaml, mode);
        } catch (err) {
            return {
                ok: false,
                reason: invalidYamlReason(err, kubeconfigYaml),
            };
        }
        // A non-mapping document (a bare scalar, null) carries no `users`,
        // so no dangerous key — not this function's job to say what it IS.
        if (usersNeedCloudAuth(doc)) {
            return { ok: false, reason: CLOUD_CREDENTIAL_REFUSAL };
        }
    }
    return { ok: true };
}
