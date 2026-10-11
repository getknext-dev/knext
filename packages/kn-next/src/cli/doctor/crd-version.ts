/**
 * Pure helpers for the CRD-version pairing the NextApp CRD doctor row applies.
 *
 * The CLI and the operator pair by CRD API version: the `apiVersion` the CLI
 * emits (`NEXTAPP_API_VERSION`, cr-builder.ts) must be a version the installed
 * NextApp CRD serves. The package major is irrelevant -- the operator keeps its
 * own major line when `@getknext/core` goes to 2.0.
 *
 * No I/O here (the check module owns that), so the rule is unit-testable.
 */

export interface CrdVersionEntry {
    name?: string;
    served?: boolean;
}

export interface CrdDocument {
    spec?: { versions?: CrdVersionEntry[] };
}

/**
 * The names of the versions the CRD serves, in document order, or `undefined`
 * when the document has no versions list at all (unreadable -- callers fail
 * closed rather than treating it as "serves nothing").
 */
export function servedCrdVersions(
    crd: CrdDocument | undefined,
): string[] | undefined {
    const versions = crd?.spec?.versions;
    if (!Array.isArray(versions)) {
        return undefined;
    }
    return versions
        .filter((v) => v.served === true && typeof v.name === "string")
        .map((v) => v.name as string);
}

/**
 * Which side is behind when the CRD does not serve the emitted version:
 *   - "crd-older": every served version ranks below the emitted one, so the
 *     operator/CRD is behind (upgrade the operator first);
 *   - "crd-newer": every served version ranks above it, so the CLI is behind
 *     (upgrade the CLI to match the operator);
 *   - "unknown": served versions on both sides, or a name that is not a
 *     Kubernetes version -- no direction can be claimed, so say both.
 */
export type CrdDirection = "crd-older" | "crd-newer" | "unknown";

export type CrdPairing =
    | { kind: "paired"; emitted: string; served: string[] }
    | {
          kind: "not-served";
          emitted: string;
          served: string[];
          direction: CrdDirection;
      };

interface KubeVersion {
    /** 2 = GA (`v1`), 1 = beta, 0 = alpha: a GA version outranks every beta. */
    stability: number;
    major: number;
    minor: number;
}

const KUBE_VERSION_RE = /^v(\d+)(?:(alpha|beta)(\d+))?$/;

function parseKubeVersion(name: string): KubeVersion | undefined {
    const m = KUBE_VERSION_RE.exec(name);
    if (!m) {
        return undefined;
    }
    const stability = m[2] === undefined ? 2 : m[2] === "beta" ? 1 : 0;
    return {
        stability,
        major: Number(m[1]),
        minor: m[3] === undefined ? 0 : Number(m[3]),
    };
}

/**
 * Kubernetes API version priority: stability first (GA outranks every beta,
 * beta outranks every alpha), then the major number, then the alpha/beta
 * number -- so `v1alpha1` < `v1alpha2` < `v1beta1` < `v2beta1` < `v1` < `v2`.
 * Positive when `a` outranks `b`; `undefined` when either is not a Kubernetes
 * version name, i.e. the two are incomparable.
 */
export function compareKubeVersions(a: string, b: string): number | undefined {
    const va = parseKubeVersion(a);
    const vb = parseKubeVersion(b);
    if (!va || !vb) {
        return undefined;
    }
    return (
        va.stability - vb.stability ||
        va.major - vb.major ||
        va.minor - vb.minor
    );
}

function directionOf(emitted: string, served: string[]): CrdDirection {
    let newer = 0;
    let older = 0;
    for (const s of served) {
        const cmp = compareKubeVersions(s, emitted);
        if (cmp === undefined) {
            return "unknown";
        }
        if (cmp > 0) {
            newer++;
        } else if (cmp < 0) {
            older++;
        }
    }
    if (newer > 0 && older === 0) {
        return "crd-newer";
    }
    if (older > 0 && newer === 0) {
        return "crd-older";
    }
    return "unknown";
}

/**
 * Does the CRD serve the version the CLI emits? `emittedApiVersion` is the full
 * `group/version` string; anything else never pairs rather than guessing a
 * version.
 */
export function classifyCrdPairing(
    emittedApiVersion: string,
    served: string[],
): CrdPairing {
    const slash = emittedApiVersion.indexOf("/");
    const emitted = emittedApiVersion.slice(slash + 1);
    if (slash <= 0 || emitted.length === 0) {
        // Not a `<group>/<version>`: nothing can be shown to be served, so this
        // never pairs (fail closed) -- and never throws.
        return {
            kind: "not-served",
            emitted: emittedApiVersion,
            served,
            direction: "unknown",
        };
    }
    return served.includes(emitted)
        ? { kind: "paired", emitted, served }
        : {
              kind: "not-served",
              emitted,
              served,
              direction: directionOf(emitted, served),
          };
}
