/**
 * crd-api-version — the CRD version the CLI emits is the one ADR-0017 declares.
 *
 * Sprint-1 T8 / sprint-2 S4. ADR-0017 (amended) states that the NextApp CRD is
 * versioned SEPARATELY from the `@getknext/*` npm packages, and names the single
 * API version the CLI may emit. Without this spec the ADR is prose: `cr-builder.ts`
 * hardcodes `apps.kn-next.dev/v1alpha1` with nothing tying it to the decision, so
 * the two can drift silently in either direction.
 *
 * The declared version is read FROM the ADR (a single machine-readable anchor),
 * never re-typed here — a test that hardcodes the same string twice proves only
 * that the test agrees with itself.
 *
 * The CLI side is found by SCANNING `src/cli/**`, not by enumerating call sites:
 * a second CR-emitting site with a different version must fail, and an enumerated
 * list is exactly how the first such site would be missed (cf. `preview.ts`).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { buildNextAppCRObject, renderNextAppCR } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

// repo root: packages/kn-next/src/__tests__ -> up 4
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const ADR_PATH = join(
    REPO_ROOT,
    "docs",
    "adr",
    "0017-crd-stays-v1alpha1-conversion-webhook-deferred.md",
);
const CLI_DIR = resolve(__dirname, "..", "cli");
const PUBLIC_API_PATH = join(REPO_ROOT, "docs", "PUBLIC_API.md");

/** The one machine-readable declaration in ADR-0017. */
const ANCHOR = /<!--\s*CRD_API_VERSION:\s*(\S+)\s*-->/g;

/**
 * Any `apps.kn-next.dev/<version>` literal — version-shaped group segments only,
 * so unrelated `apps.kn-next.dev/build-id` / `/external-cleanup` annotation keys
 * are not swept up.
 */
const API_VERSION_LITERAL = /apps\.kn-next\.dev\/v\d+(?:alpha|beta)?\d*/g;

/**
 * Read the declared version out of the ADR, asserting the anchor occurs EXACTLY
 * once. Two anchors (or none) means the declaration is ambiguous, and an
 * ambiguous declaration must fail loudly rather than pick a winner.
 */
function declaredApiVersion(): string {
    const adr = readFileSync(ADR_PATH, "utf8");
    const matches = [...adr.matchAll(ANCHOR)];
    expect(
        matches.length,
        `ADR-0017 must carry exactly ONE <!-- CRD_API_VERSION: … --> anchor; found ${matches.length}`,
    ).toBe(1);
    return matches[0][1];
}

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...walk(full));
        } else if (full.endsWith(".ts")) {
            out.push(full);
        }
    }
    return out;
}

const baseConfig: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
    storage: {
        provider: "gcs",
        bucket: "my-bucket",
        publicUrl: "https://storage.googleapis.com/my-bucket",
    },
    cache: {
        provider: "redis",
        url: "redis://redis:6379",
        keyPrefix: "my-app",
    },
    scaling: { minScale: 0, maxScale: 5 },
};

const IMAGE = "registry.example.com/my-app:v1@sha256:abc123";

describe("CRD apiVersion is the one ADR-0017 declares", () => {
    it("ADR-0017 declares exactly one CRD API version, in group/version form", () => {
        const declared = declaredApiVersion();
        expect(declared).toMatch(
            /^apps\.kn-next\.dev\/v\d+(?:alpha|beta)?\d*$/,
        );
    });

    it("buildNextAppCRObject emits the ADR-declared apiVersion", () => {
        const cr = buildNextAppCRObject(baseConfig, IMAGE, "default");
        expect(cr.apiVersion).toBe(declaredApiVersion());
    });

    it("renderNextAppCR emits the ADR-declared apiVersion", () => {
        const parsed = YAML.parse(
            renderNextAppCR(baseConfig, IMAGE, "default"),
        ) as Record<string, unknown>;
        expect(parsed.apiVersion).toBe(declaredApiVersion());
    });

    it("no file under src/cli/ names a CRD API version other than the declared one", () => {
        const declared = declaredApiVersion();
        const offenders: string[] = [];
        for (const file of walk(CLI_DIR)) {
            const text = readFileSync(file, "utf8");
            for (const [literal] of text.matchAll(API_VERSION_LITERAL)) {
                if (literal !== declared) {
                    offenders.push(
                        `${file.slice(REPO_ROOT.length + 1)}: ${literal}`,
                    );
                }
            }
        }
        expect(
            offenders,
            "every CRD apiVersion the CLI names must equal the ADR-0017-declared one",
        ).toEqual([]);
    });

    /**
     * The link is asserted by its PATH, deliberately — not by the string
     * "ADR-0017". `PUBLIC_API.md` is a user-facing document and
     * `public-api-surface.test.ts` (PK5) forbids `/ADR-\d{4}/`, `/\bPK\d\b/` and
     * `/#\d{2,}/` inside it. Asserting the jargon here would put the two guards in
     * direct conflict and make one of them the thing someone edits to get green.
     * The path satisfies both: it resolves for a reader and names no internal id.
     */
    it("PUBLIC_API.md links the CRD versioning policy, by path not by jargon", () => {
        const publicApi = readFileSync(PUBLIC_API_PATH, "utf8");
        expect(publicApi).toMatch(
            /0017-crd-stays-v1alpha1-conversion-webhook-deferred\.md/,
        );
    });
});
