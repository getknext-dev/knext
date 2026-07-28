/**
 * preflight.ts — the prune preflight (#314, T6). Three tiers, ONE verdict.
 *
 * WHAT IT PROTECTS. The NextApp CRD is structural and carries no
 * `x-kubernetes-preserve-unknown-fields`, so a field a newer CLI emits and an
 * older CRD does not define is either REJECTED (strict validation) or PRUNED
 * (ignore). Pruned is the dangerous half: take `spec.database.roSecretRef` —
 * the operator then never injects `DATABASE_URL_RO`, `getDbRO()` falls back to
 * the writer pool, and staleness-tolerant reads run on the read-WRITE primary
 * credential. A least-privilege downgrade, reported as success.
 *
 * THE TIERS (docs/SPRINT_2.md decision D-3 — implement, do not redesign):
 *
 *   1. VERDICT — a server-side `--dry-run=server --validate=strict` apply of
 *      the exact CR, as the FIRST cluster-touching step. It requires
 *      `create`/`patch` on `nextapps` in the target namespace, which is
 *      PRECISELY what `deploy` already requires. No kubeconfig can deploy but
 *      not preflight, so hard failure costs nothing: it can only be denied
 *      where the deploy would also be denied. That is what dissolves the
 *      apparent RBAC contradiction — the safety verdict never needs to read
 *      the CRD.
 *   2. DIAGNOSIS (best-effort) — the aggregated OpenAPI v3 discovery document
 *      (`/openapi/v3/apis/<group>/<version>`), which needs NO cluster-scoped
 *      RBAC (`system:discovery` is bound to `system:authenticated`). If denied,
 *      degrade to parsing the apiserver's own `unknown field "…"` message,
 *      which already names the field.
 *   3. ENRICHMENT — `kubectl get crd`, when the caller happens to have
 *      cluster-scoped `get customresourcedefinitions`.
 *
 * **Failure of tiers 2–3 degrades the MESSAGE, never the VERDICT.**
 *
 * WHAT IT DOES NOT PROTECT (stated rather than implied): a CLI-side preflight
 * cannot help the GitOps path at all — Argo CD and Flux never invoke this CLI,
 * and neither asserts strict field validation. That residual is #314's, not
 * this function's.
 */

import {
    crdGetArgv,
    crdSchemaFromCrdObject,
    crdSchemaFromOpenApiV3Doc,
    flattenSchemaPaths,
    openApiV3Argv,
    parseUnknownFieldsFromError,
    unknownEmittedFields,
} from "./crd-schema";
import { EMITTED_CR_FIELD_PATHS } from "./emitted-fields.generated";

export interface KubectlResult {
    ok: boolean;
    stdout: string;
    stderr: string;
}

/** Injected kubectl boundary. MUST NOT throw — failures come back as ok:false. */
export type KubectlCapture = (argv: readonly string[]) => KubectlResult;

export type PreflightVerdict = "ok" | "skew" | "blocked";

export type PreflightReason =
    | "none"
    | "unknown-field"
    | "webhook-unavailable"
    | "client-too-old"
    | "apply-failed";

export type DiagnosisSource =
    | "openapi-v3"
    | "crd"
    | "apiserver-message"
    | "none";

export interface PreflightOutcome {
    verdict: PreflightVerdict;
    reason: PreflightReason;
    /** Fields the installed CRD does not know, named where possible. */
    unknownFields: string[];
    diagnosis: DiagnosisSource;
    /** Raw kubectl stderr from the dry-run apply (bounded by the caller's log). */
    stderr: string;
    /** How the schema read went — surfaced so a degraded message says so. */
    diagnosisDetail: string;
}

const STRICT_DECODING = /strict decoding error|unknown field "/;
const WEBHOOK_DOWN =
    /failed calling webhook|failed to call webhook|no endpoints available for service .*webhook/i;
const CLIENT_TOO_OLD =
    /invalid argument "strict" for "--validate"|flag needs an argument|unknown flag: --validate/i;

/** argv for tier 1. One `--validate` flag — pflag takes the LAST occurrence. */
export function dryRunApplyArgv(crPath: string, namespace: string): string[] {
    return [
        "kubectl",
        "apply",
        "--dry-run=server",
        "--validate=strict",
        "-f",
        crPath,
        "-n",
        namespace,
    ];
}

export interface KnownFieldsRead {
    known?: ReadonlySet<string>;
    source: DiagnosisSource;
    detail: string;
}

/**
 * Read the installed NextApp structural schema: OpenAPI v3 first (no
 * cluster-scoped RBAC), then the CRD. Returns `source: "none"` — never an empty
 * set — when both are denied: an empty known-set would report EVERY field as
 * missing, and a confident wrong answer is worse than an admitted unknown.
 */
export function readKnownCRDFields(kubectl: KubectlCapture): KnownFieldsRead {
    const notes: string[] = [];

    const openapi = kubectl(openApiV3Argv());
    if (openapi.ok) {
        let doc: unknown;
        try {
            doc = JSON.parse(openapi.stdout);
        } catch {
            doc = undefined;
        }
        const found = crdSchemaFromOpenApiV3Doc(doc);
        if (found) {
            return {
                known: flattenSchemaPaths(found.schema, {
                    resolveRef: found.resolveRef,
                }),
                source: "openapi-v3",
                detail: "read from the aggregated OpenAPI v3 discovery document",
            };
        }
        notes.push(
            "the OpenAPI v3 document carried no NextApp schema (is the CRD installed?)",
        );
    } else {
        notes.push(`OpenAPI v3 read failed: ${firstLine(openapi.stderr)}`);
    }

    const crd = kubectl(crdGetArgv());
    if (crd.ok) {
        let obj: unknown;
        try {
            obj = JSON.parse(crd.stdout);
        } catch {
            obj = undefined;
        }
        const schema = crdSchemaFromCrdObject(obj);
        if (schema) {
            return {
                known: flattenSchemaPaths(schema),
                source: "crd",
                detail: "read from the installed CustomResourceDefinition",
            };
        }
        notes.push("the CRD carried no v1alpha1 structural schema");
    } else {
        notes.push(`CRD read failed: ${firstLine(crd.stderr)}`);
    }

    return {
        source: "none",
        detail: `could not read the installed NextApp schema — ${notes.join("; ")}`,
    };
}

function firstLine(s: string): string {
    return (s.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 200);
}

/**
 * Run the preflight. NEVER throws: the caller decides what a non-`ok` verdict
 * costs (for `deploy` and `preview` it is a hard, pre-upload abort).
 */
export function preflightCRSchema(
    deps: { kubectl: KubectlCapture },
    args: { crPath: string; namespace: string },
): PreflightOutcome {
    const apply = deps.kubectl(dryRunApplyArgv(args.crPath, args.namespace));
    if (apply.ok) {
        return {
            verdict: "ok",
            reason: "none",
            unknownFields: [],
            diagnosis: "none",
            stderr: "",
            diagnosisDetail:
                "the apiserver accepted the CR under strict validation (server-side dry run) — no field was pruned",
        };
    }

    const stderr = apply.stderr || apply.stdout;

    if (CLIENT_TOO_OLD.test(stderr)) {
        return {
            verdict: "blocked",
            reason: "client-too-old",
            unknownFields: [],
            diagnosis: "none",
            stderr,
            diagnosisDetail:
                "the local kubectl rejected --validate=strict at flag parsing (before v1.25 --validate is a BOOLEAN)",
        };
    }

    if (WEBHOOK_DOWN.test(stderr)) {
        return {
            verdict: "blocked",
            reason: "webhook-unavailable",
            unknownFields: [],
            diagnosis: "none",
            stderr,
            diagnosisDetail:
                "the NextApp admission webhook could not be reached — this is NOT field skew",
        };
    }

    if (!STRICT_DECODING.test(stderr)) {
        return {
            verdict: "blocked",
            reason: "apply-failed",
            unknownFields: [],
            diagnosis: "none",
            stderr,
            diagnosisDetail:
                "the server-side dry run did not complete, so knext cannot say whether this CR would be stored intact",
        };
    }

    // Skew. The verdict is already decided; everything below only names fields.
    const read = readKnownCRDFields(deps.kubectl);
    if (read.known) {
        const missing = unknownEmittedFields(
            EMITTED_CR_FIELD_PATHS,
            read.known,
        );
        if (missing.length > 0) {
            return {
                verdict: "skew",
                reason: "unknown-field",
                unknownFields: missing,
                diagnosis: read.source,
                stderr,
                diagnosisDetail: read.detail,
            };
        }
    }

    // Last resort, and it needs no permission at all: the apiserver already put
    // the answer in the error it returned.
    const named = parseUnknownFieldsFromError(stderr);
    return {
        verdict: "skew",
        reason: "unknown-field",
        unknownFields: named,
        diagnosis: "apiserver-message",
        stderr,
        diagnosisDetail:
            read.source === "none"
                ? `${read.detail} — falling back to the apiserver's own rejection message`
                : "the installed schema defines every field this CLI emits, so the rejected field is named from the apiserver's message",
    };
}

/**
 * The image ref used for the PREFLIGHT CR only.
 *
 * The preflight runs BEFORE the build and push (that is the point — a skew
 * failure must not leave assets in the bucket), so the real content digest does
 * not exist yet. What the apiserver validates is the FIELD SET, not the value,
 * so a syntactically valid placeholder digest exercises exactly the same
 * structural schema — while still satisfying any digest-pinning admission rule
 * that a bare tag would trip. The applied CR always carries the real digest.
 */
export const PREFLIGHT_PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;

export function preflightImageRef(taggedRef: string): string {
    return taggedRef.includes("@sha256:")
        ? taggedRef
        : `${taggedRef}@${PREFLIGHT_PLACEHOLDER_DIGEST}`;
}

const UPGRADE_ORDER =
    "Upgrade order is load-bearing: upgrade the OPERATOR/CRD first, THEN the CLI (docs/RELEASING.md).";

/** Extra context only the caller can establish (e.g. a local kubectl probe). */
export interface PreflightFailureContext {
    /** Local kubectl version string when it predates `--validate=strict`. */
    oldClient?: string;
}

/** The user-facing failure text. Pure — no I/O, no cluster calls. */
export function formatPreflightFailure(
    outcome: PreflightOutcome,
    context: PreflightFailureContext = {},
): string {
    if (outcome.verdict === "ok") return "";

    if (outcome.reason === "unknown-field") {
        const fields = outcome.unknownFields.length
            ? outcome.unknownFields.map((f) => `  - ${f}`).join("\n")
            : "  (the apiserver did not name the field)";
        const roNote = outcome.unknownFields.some((f) =>
            f.includes("database.roSecretRef"),
        )
            ? "\nWhy this one matters: with `spec.database.roSecretRef` absent the operator never " +
              "injects DATABASE_URL_RO, so `getDbRO()` falls back to the writer pool and " +
              "staleness-tolerant reads would run on the read-write primary credential — a " +
              "least-privilege downgrade on a CR that would still report Ready=True."
            : "";
        return (
            "PREFLIGHT FAILED: the NextApp CRD installed on this cluster does not know " +
            "field(s) this CLI emits, so the CR would be rejected (or, under a client that does " +
            "not assert strict validation, SILENTLY PRUNED):\n" +
            `${fields}\n${roNote}\n` +
            `Diagnosis source: ${outcome.diagnosis} (${outcome.diagnosisDetail}).\n` +
            `${UPGRADE_ORDER}\n` +
            "Nothing was built, uploaded or applied — this ran before any side effect.\n" +
            "  kubectl get crd nextapps.apps.kn-next.dev -o jsonpath='{.spec.versions[*].name}'\n" +
            "  kn-next doctor"
        );
    }

    if (outcome.reason === "client-too-old") {
        const which = context.oldClient ? ` (${context.oldClient})` : "";
        return (
            `PREFLIGHT FAILED: your kubectl client${which} is older than v1.25, where ` +
            "`--validate` is a BOOLEAN flag — so `--validate=strict` is rejected at flag parsing " +
            "and the preflight never reached the cluster. This is deliberate (fail-closed): on " +
            "that client knext cannot guarantee an unknown CR field is rejected rather than " +
            "silently pruned.\n" +
            "Fix: upgrade kubectl to >= v1.25 (v1.24 is long EOL), then re-run.\n" +
            "  kubectl version --client"
        );
    }

    if (outcome.reason === "webhook-unavailable") {
        return (
            "PREFLIGHT FAILED: the NextApp admission webhook could not be reached, so the " +
            "apiserver could not evaluate this CR. This is an availability problem, NOT " +
            "CLI/operator field skew — do not upgrade anything on the strength of it.\n" +
            `kubectl said: ${firstLine(outcome.stderr)}\n` +
            "  kubectl -n kn-next-operator-system get deploy,pods\n" +
            "  kn-next doctor"
        );
    }

    return (
        "PREFLIGHT FAILED: the server-side dry-run apply of the NextApp CR did not complete, so " +
        "knext cannot say whether this cluster would store the CR intact. Nothing was built, " +
        "uploaded or applied.\n" +
        `kubectl said: ${firstLine(outcome.stderr)}\n` +
        "The preflight needs exactly what the deploy needs — `create`/`patch` on nextapps in the " +
        "target namespace — so a denial here is a denial of the deploy itself, surfaced before " +
        "any side effect rather than after.\n" +
        "  kn-next doctor"
    );
}

/**
 * Run the preflight and THROW on anything but `ok` — the form both `deploy` and
 * `preview` use, so the hard-failure semantics live in one place.
 *
 * Deliberately hard on `blocked` as well as `skew`: a preflight that could not
 * reach a verdict has not established that this CR would be stored intact, and
 * "warn and continue" is useless exactly when it matters (docs/SPRINT_1.md,
 * the "silently useless" list).
 */
export function assertCRSchemaCompatible(args: {
    crPath: string;
    namespace: string;
    kubectl: KubectlCapture;
    /** Optional enrichment: the local kubectl version, when it is too old. */
    oldClient?: string;
}): PreflightOutcome {
    const outcome = preflightCRSchema({ kubectl: args.kubectl }, args);
    if (outcome.verdict !== "ok") {
        throw new Error(
            formatPreflightFailure(outcome, { oldClient: args.oldClient }),
        );
    }
    return outcome;
}
