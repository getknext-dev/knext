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

import { DOCS_URL } from "../../help";
import {
    partitionMissingFields,
    unknownEmittedFields,
} from "../../schema/crd-schema";
import { EMITTED_CR_FIELD_PATHS } from "../../schema/emitted-fields.generated";
import { readKnownCRDFields } from "../../schema/preflight";
import { actionableDetail } from "../error-format";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";
import { SKIP_UNREACHABLE } from "../types";

/**
 * #1535 round 2 (N3): the previous hint cited `docs/RELEASING.md`, a repo
 * path — meaningless to a `kn-next doctor` user who does not have this repo
 * checked out. Point at the actual docs page that explains the ordering.
 */
const UPGRADE_ORDER_URL = `${DOCS_URL}/docs/upgrading`;

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
    const { required, conditional } = partitionMissingFields(missing);
    if (required.length === 0) {
        // Only conditionally-emitted fields are missing: `knext deploy` still
        // applies unless the feature is in play (then its preflight refuses,
        // naming the field), so this is a heads-up, not a failure.
        const lines = conditional
            .map(
                (c) =>
                    `${c.path} — ${c.feature}; upgrade the operator to use it`,
            )
            .join("; ");
        return [
            mk(
                "crd-schema",
                "NextApp CRD schema coverage",
                "warn",
                actionableDetail(
                    `the installed CRD predates ${conditional.length} optional field(s): ${lines}`,
                    `deploys that do not use these features are unaffected. Source: ${read.detail}`,
                    ctx.verbose ?? false,
                ),
                `upgrade the operator/CRD FIRST, then the CLI, to use these features — see ${UPGRADE_ORDER_URL}`,
            ),
        ];
    }
    // #1535: the ONE actionable sentence. No literal "operator vX / CLI vY" —
    // the operator is versioned by image digest, not semver (`:latest` is
    // rejected cluster-wide), so no reliable operator version number exists to
    // report; naming the field COUNT + the fix + the required order is what
    // this CLI can say truthfully. The full field list + diagnosis source
    // moves behind --verbose rather than disappearing.
    return [
        mk(
            "crd-schema",
            "NextApp CRD schema coverage",
            "fail",
            actionableDetail(
                `operator behind CLI: the installed CRD is missing ${missing.length} field(s) this CLI emits — they would be dropped. Upgrade the operator first (operator, then CLI).`,
                `does not define: ${missing.join(", ")} — a deploy setting one of them is rejected (or, without strict validation, SILENTLY PRUNED). Source: ${read.detail}`,
                ctx.verbose ?? false,
            ),
            `upgrade the operator/CRD FIRST, then the CLI — see ${UPGRADE_ORDER_URL}`,
        ),
    ];
}
