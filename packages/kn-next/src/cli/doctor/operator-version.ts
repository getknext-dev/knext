/**
 * Pure helpers for the operator-version doctor row (#1947): reading the
 * installed operator's version back out of its manager Deployment, and the
 * CLI <-> operator pairing rule.
 *
 * No I/O here (the check module owns that), so the rule is unit-testable and
 * the doctor golden snapshots never depend on the machine's package version.
 */

import type { DeploymentJson } from "./types";

export const VERSION_LABEL = "app.kubernetes.io/version";

/**
 * The committed sentinel a source / `operator-edge` build carries in
 * `config/manager/manager.yaml`. Only an `operator-vX.Y.Z` tag publish
 * replaces it, so it must never be mistaken for (or parsed as) a version.
 */
export const UNRELEASED_SENTINEL = "unreleased";

export interface Semver {
    major: number;
    minor: number;
    patch: number;
    prerelease: string | undefined;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** `1.2.3`, `v1.2.3`, `v1.2.3-rc.1` -> parts; anything else -> undefined. */
export function parseSemver(raw: string): Semver | undefined {
    const m = SEMVER_RE.exec(raw.trim());
    if (!m) {
        return undefined;
    }
    return {
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3]),
        prerelease: m[4],
    };
}

export type OperatorVersion =
    | {
          kind: "version";
          version: string;
          parsed: Semver;
          source: "label" | "image-tag";
          digest: string | undefined;
      }
    | { kind: "unreleased"; digest: string | undefined }
    | { kind: "unknown"; digest: string | undefined };

/** `…@sha256:<64 hex>` -> `sha256:<64 hex>`. */
function digestOf(image: string | undefined): string | undefined {
    return /@(sha256:[0-9a-f]{64})$/.exec(image ?? "")?.[1];
}

/** The tag of `host[:port]/repo[:tag][@digest]`, if any. */
function tagOf(image: string | undefined): string | undefined {
    if (!image) {
        return undefined;
    }
    const noDigest = image.split("@")[0] ?? "";
    const last = noDigest.slice(noDigest.lastIndexOf("/") + 1);
    const colon = last.indexOf(":");
    return colon === -1 ? undefined : last.slice(colon + 1);
}

/**
 * The installed operator's version: the Deployment's (or its pod template's)
 * `app.kubernetes.io/version` label first — what the release workflow stamps —
 * then a semver image tag (covers a hand-built `make deploy IMG=…:vX.Y.Z`).
 * A digest-only ref with no label is `unknown` (a pre-version-line bundle).
 */
export function resolveOperatorVersion(dep: DeploymentJson): OperatorVersion {
    const image = dep.spec?.template?.spec?.containers?.[0]?.image;
    const digest = digestOf(image);
    const label =
        dep.metadata?.labels?.[VERSION_LABEL] ??
        dep.spec?.template?.metadata?.labels?.[VERSION_LABEL];

    if (label === UNRELEASED_SENTINEL) {
        return { kind: "unreleased", digest };
    }
    if (label) {
        const parsed = parseSemver(label);
        if (parsed) {
            return {
                kind: "version",
                version: label.replace(/^v/, ""),
                parsed,
                source: "label",
                digest,
            };
        }
    }
    const tag = tagOf(image);
    const fromTag = tag ? parseSemver(tag) : undefined;
    if (tag && fromTag) {
        return {
            kind: "version",
            version: tag.replace(/^v/, ""),
            parsed: fromTag,
            source: "image-tag",
            digest,
        };
    }
    return { kind: "unknown", digest };
}

export type OperatorCompat = "ok" | "operator-older" | "major-mismatch";

/**
 * The pairing rule (COMPATIBILITY.md): operator MAJOR.MINOR tracks the npm
 * package set's MAJOR.MINOR; patch is independent.
 *
 *   - different MAJOR              -> "major-mismatch"
 *   - operator MINOR < CLI MINOR   -> "operator-older"  (upgrade the operator
 *                                     FIRST — a CLI ahead of its CRD may emit a
 *                                     field the CRD does not know)
 *   - otherwise                    -> "ok" (an older CLI against a newer
 *                                     operator is always valid)
 *
 * Prerelease suffixes are ignored on both sides: `1.3.0-rc.7` pairs as `1.3`.
 */
export function classifyOperatorCompat(
    operator: Semver,
    cli: Semver,
): OperatorCompat {
    if (operator.major !== cli.major) {
        return "major-mismatch";
    }
    if (operator.minor < cli.minor) {
        return "operator-older";
    }
    return "ok";
}

/** `sha256:` + first 12 hex + an ellipsis — enough to eyeball, never a full dump. */
export function shortDigest(digest: string | undefined): string | undefined {
    return digest ? `${digest.slice(0, 19)}…` : undefined;
}
