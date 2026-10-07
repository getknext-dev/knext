/**
 * (b2) operator VERSION and its pairing with this CLI (#1947).
 *
 * Reads the version the operator bundle stamped on the manager Deployment
 * (`app.kubernetes.io/version`, falling back to a semver image tag) and applies
 * the documented pairing rule (see `classifyOperatorCompat`). Everything here
 * is a WARN at worst — the schema preflight (`preflightCRSchema`) is the
 * authoritative "can this cluster store what the CLI emits" gate; this row
 * tells the user WHICH release to pin or move to.
 */

import {
    classifyOperatorCompat,
    type OperatorVersion,
    parseSemver,
    resolveOperatorVersion,
    shortDigest,
} from "../operator-version";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";
import { SKIP_UNREACHABLE, VERSIONING_DOCS_URL } from "../types";

const ID = "operator-version";
const TITLE = "Operator version";
const RELEASES_URL = "https://github.com/getknext-dev/knext/releases";

function pinHint(extra: string): string {
    return `${extra} Apply a specific release's digest-pinned bundle: \`kubectl apply --server-side -f ${RELEASES_URL}/download/operator-v<X.Y.Z>/install-v<X.Y.Z>.yaml\` (see ${VERSIONING_DOCS_URL}).`;
}

function describe(v: OperatorVersion): string {
    const digest = shortDigest(v.digest);
    const image = digest ? `image ${digest}` : "image digest not reported";
    switch (v.kind) {
        case "version": {
            const pre = v.parsed.prerelease ? " (pre-release)" : "";
            const src = v.source === "label" ? "from label" : "from image tag";
            return `v${v.version}${pre} (${src}), ${image}`;
        }
        case "unreleased":
            return `unreleased build (source or operator-edge), ${image}`;
        default:
            return `no release version reported, ${image}`;
    }
}

export function operatorVersionCheck(ctx: CheckContext): CheckResult[] {
    if (ctx.skipAll) {
        return [mk(ID, TITLE, "skip", SKIP_UNREACHABLE)];
    }
    if (!ctx.operatorManager) {
        return [
            mk(
                ID,
                TITLE,
                "skip",
                "no operator deployment resolved (operator check did not pass) — skipped",
            ),
        ];
    }
    const v = resolveOperatorVersion(ctx.operatorManager);
    const base = describe(v);

    if (v.kind === "unreleased") {
        return [
            mk(
                ID,
                TITLE,
                "warn",
                `${base}; not a pinned release, so it cannot be pinned or rolled back to`,
                pinHint("Install a released operator."),
            ),
        ];
    }
    if (v.kind === "unknown") {
        return [
            mk(
                ID,
                TITLE,
                "warn",
                `${base} (a bundle from before the operator version line); compatibility with this CLI cannot be checked`,
                pinHint(
                    "Move to a versioned operator (operator first, then CLI).",
                ),
            ),
        ];
    }

    const cli = ctx.deps.cliVersion
        ? parseSemver(ctx.deps.cliVersion)
        : undefined;
    if (!cli) {
        return [mk(ID, TITLE, "pass", base)];
    }
    switch (classifyOperatorCompat(v.parsed, cli)) {
        case "ok":
            return [
                mk(
                    ID,
                    TITLE,
                    "pass",
                    `${base}; compatible with CLI ${ctx.deps.cliVersion}`,
                ),
            ];
        case "operator-older":
            return [
                mk(
                    ID,
                    TITLE,
                    "warn",
                    `${base}; operator is older than this CLI (${ctx.deps.cliVersion}) — the CLI pairs with operator ${cli.major}.${cli.minor}.x or newer, so it may emit a field this operator's CRD does not know`,
                    pinHint(
                        `Upgrade the operator first, then the CLI: pick an operator release with MAJOR.MINOR >= ${cli.major}.${cli.minor}.`,
                    ),
                ),
            ];
        default:
            return [
                mk(
                    ID,
                    TITLE,
                    "warn",
                    `${base}; operator major ${v.parsed.major} differs from CLI major ${cli.major} (${ctx.deps.cliVersion}) — outside the supported pairing`,
                    pinHint(
                        `Use an operator release whose major is ${cli.major}, or the CLI release that matches this operator.`,
                    ),
                ),
            ];
    }
}
