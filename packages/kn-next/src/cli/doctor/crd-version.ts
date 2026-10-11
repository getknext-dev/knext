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

export type CrdPairing =
    | { kind: "paired"; emitted: string; served: string[] }
    | { kind: "not-served"; emitted: string; served: string[] };

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
        return { kind: "not-served", emitted: emittedApiVersion, served };
    }
    return served.includes(emitted)
        ? { kind: "paired", emitted, served }
        : { kind: "not-served", emitted, served };
}
