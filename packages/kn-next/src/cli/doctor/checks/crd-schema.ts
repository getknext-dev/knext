/**
 * (a2) NextApp CRD SCHEMA COVERAGE (#314, T6) — the question the CRD-existence
 * check cannot answer. "The CRD exists and serves v1alpha1" is green on exactly
 * the cluster this exists for: one whose CRD is installed, served, and OLDER
 * than this CLI. What matters is whether the installed schema defines every
 * field this CLI can emit — and the emitted set is DERIVED BY SCANNING
 * cr-builder.ts (schema/emitted-fields.generated.ts), not enumerated.
 *
 * This is DIAGNOSIS. The verdict lives in `knext deploy`'s server-side
 * dry-run apply, which needs no read at all — so when both schema reads are
 * denied, doctor SKIPS (visibly) rather than failing.
 *
 * REUSE (ADR-0001 / #1055): every CRD-schema symbol comes from `cli/schema/`;
 * this module declares none of its own.
 */

import { unknownEmittedFields } from "../../schema/crd-schema";
import { EMITTED_CR_FIELD_PATHS } from "../../schema/emitted-fields.generated";
import { readKnownCRDFields } from "../../schema/preflight";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";
import { SKIP_UNREACHABLE } from "../types";

export function crdSchemaCheck(ctx: CheckContext): CheckResult[] {
    if (ctx.skipAll) {
        return [
            mk(
                "crd-schema",
                "NextApp CRD schema coverage",
                "skip",
                SKIP_UNREACHABLE,
            ),
        ];
    }
    const read = readKnownCRDFields(ctx.kubectl);
    if (!read.known) {
        return [
            mk(
                "crd-schema",
                "NextApp CRD schema coverage",
                "skip",
                `${read.detail} — diagnosis only; \`knext deploy\` still verifies this cluster with a server-side dry-run apply, which needs no extra permission`,
                "optional: grant `get customresourcedefinitions` (or access to /openapi/v3) for a named-field diagnosis here",
            ),
        ];
    }
    const missing = unknownEmittedFields(EMITTED_CR_FIELD_PATHS, read.known);
    if (missing.length === 0) {
        return [
            mk(
                "crd-schema",
                "NextApp CRD schema coverage",
                "pass",
                `all ${EMITTED_CR_FIELD_PATHS.length} field(s) this CLI emits are defined by the installed CRD (${read.detail})`,
            ),
        ];
    }
    return [
        mk(
            "crd-schema",
            "NextApp CRD schema coverage",
            "fail",
            `the installed NextApp CRD does not define ${missing.length} field(s) this CLI emits: ${missing.join(", ")} — a deploy setting one of them is rejected (or, without strict validation, SILENTLY PRUNED). Source: ${read.detail}`,
            "upgrade the operator/CRD FIRST, then the CLI (docs/RELEASING.md)",
        ),
    ];
}
