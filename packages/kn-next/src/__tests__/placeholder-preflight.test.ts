/**
 * UX ledger row 4 (4b) — the fail-fast placeholder preflight.
 *
 * The scaffold ships `registry: "ghcr.io/<your-user>"` (and, when uncommented,
 * `bucket: "<your-assets-bucket>"`). Row 4 measured that those placeholders
 * flow SILENTLY into the build: the persona burns a full multi-minute
 * `next build` before failing at the image push — the most expensive possible
 * place to learn the config is unfinished.
 *
 * The scan is GENERIC over the config object (workflow rule: scan, don't
 * enumerate). An enumerated field list is how the second placeholder field gets
 * missed — the adversarial-dodge cases below exist to kill that mutation.
 */

import { describe, expect, it } from "vitest";
import {
    findPlaceholders,
    formatPlaceholderFindings,
    PlaceholderConfigError,
} from "../cli/placeholder-preflight";
import { handleUsageError, USAGE_ERROR_CODE } from "../cli/shared";
import type { KnativeNextConfig } from "../config";

const clean: KnativeNextConfig = {
    name: "my-app",
    registry: "ghcr.io/real-user",
    storage: {
        provider: "gcs",
        bucket: "real-assets",
        publicUrl: "https://storage.googleapis.com/real-assets",
    },
};

describe("findPlaceholders — generic scan over the config object", () => {
    it("finds the scaffold's live placeholder (registry)", () => {
        const findings = findPlaceholders({
            ...clean,
            registry: "ghcr.io/<your-user>",
        });
        expect(findings).toEqual([
            { path: "registry", value: "ghcr.io/<your-user>" },
        ]);
    });

    it("finds a placeholder in a nested field (storage.bucket)", () => {
        const findings = findPlaceholders({
            ...clean,
            storage: {
                provider: "gcs",
                bucket: "<your-assets-bucket>",
                publicUrl: "https://storage.googleapis.com/real-assets",
            },
        });
        expect(findings).toEqual([
            { path: "storage.bucket", value: "<your-assets-bucket>" },
        ]);
    });

    it("reports EVERY placeholder field, not just the first", () => {
        const findings = findPlaceholders({
            ...clean,
            registry: "ghcr.io/<your-user>",
            storage: {
                provider: "gcs",
                bucket: "<your-assets-bucket>",
                publicUrl:
                    "https://storage.googleapis.com/<your-assets-bucket>",
            },
        });
        expect(findings.map((f) => f.path)).toEqual([
            "registry",
            "storage.bucket",
            "storage.publicUrl",
        ]);
    });

    it("ABSENT storage is not a placeholder error (ADR-0047 valid mode)", () => {
        expect(
            findPlaceholders({ name: "my-app", registry: "ghcr.io/real" }),
        ).toEqual([]);
    });

    it("a fully-filled config has no findings", () => {
        expect(findPlaceholders(clean)).toEqual([]);
    });

    // ADVERSARIAL DODGE (of this suite's own design): an implementation that
    // enumerates known field names (registry, storage.*) passes every case
    // above. These two are unreachable by enumeration — a field name the
    // schema has never heard of, nested where no list would look, and an
    // array element. If the scan is generic, both fall out for free.
    it("dodge 1: a placeholder under an unknown, deeply-nested key is still found", () => {
        const cfg = {
            ...clean,
            shipping: { image: { pushTarget: "ghcr.io/<your-user>" } },
        } as unknown as KnativeNextConfig;
        expect(findPlaceholders(cfg)).toEqual([
            {
                path: "shipping.image.pushTarget",
                value: "ghcr.io/<your-user>",
            },
        ]);
    });

    it("dodge 2: a placeholder inside an array element is still found", () => {
        const cfg = {
            ...clean,
            domains: ["real.example.com", "<your-domain>"],
        } as unknown as KnativeNextConfig;
        expect(findPlaceholders(cfg)).toEqual([
            { path: "domains[1]", value: "<your-domain>" },
        ]);
    });

    it("env values are exempt — even a placeholder-shaped one never blocks", () => {
        const cfg = {
            ...clean,
            env: { API_URL: "https://api.example.com", API_KEY: "<set-me>" },
        };
        expect(findPlaceholders(cfg)).toEqual([]);
    });

    // Architect-gate carve-out (design-gate fix round): `env` is the config's
    // free-text Record<string,string> — arbitrary user data the scan cannot
    // classify. A schema-valid markup value must never make a deploy refusable
    // with no escape, and "the placeholder from the scaffold" would be
    // confidently wrong about the user's own data.
    it("dodge 3 (env carve-out): angle-bracket markup in env is NOT a finding", () => {
        const cfg = {
            ...clean,
            env: { ALLOWED_TAGS: "<b><i>", TEMPLATE: "Hello <name>!" },
        };
        expect(findPlaceholders(cfg)).toEqual([]);
    });

    it("the env carve-out is exactly the root `env` map, not every key named env", () => {
        // A nested unknown block named `env` is not the config contract's
        // free-text map — the generic walk still covers it (M2 stays meaningful).
        const cfg = {
            ...clean,
            shipping: { env: { target: "ghcr.io/<your-user>" } },
        } as unknown as KnativeNextConfig;
        expect(findPlaceholders(cfg)).toEqual([
            { path: "shipping.env.target", value: "ghcr.io/<your-user>" },
        ]);
    });

    it("non-string values are never findings", () => {
        const cfg = {
            ...clean,
            scaling: { minScale: 0, maxScale: 3 },
        };
        expect(findPlaceholders(cfg)).toEqual([]);
    });

    it("a lone `<` without a closing `>` is not a placeholder", () => {
        expect(findPlaceholders({ ...clean, name: "a<b" })).toEqual([]);
    });

    it("a circular config terminates instead of hanging", () => {
        const cfg = { ...clean } as Record<string, unknown>;
        cfg.self = cfg;
        expect(findPlaceholders(cfg as unknown as KnativeNextConfig)).toEqual(
            [],
        );
    });
});

describe("formatPlaceholderFindings — plain English, per field", () => {
    const text = formatPlaceholderFindings([
        { path: "registry", value: "ghcr.io/<your-user>" },
        { path: "storage.bucket", value: "<your-assets-bucket>" },
        { path: "shipping.image.pushTarget", value: "<mystery>" },
    ]);

    it("names each field and quotes its current value", () => {
        expect(text).toContain("registry");
        expect(text).toContain("ghcr.io/<your-user>");
        expect(text).toContain("storage.bucket");
        expect(text).toContain("<your-assets-bucket>");
        expect(text).toContain("shipping.image.pushTarget");
    });

    it("explains what the known fields are, in plain words", () => {
        // registry: the reader has never pushed an image.
        expect(text.toLowerCase()).toContain("image");
        expect(text.toLowerCase()).toContain("push");
        // bucket: the reader has never made a bucket — and omitting storage
        // is a real option post-ADR-0047, so the way out is stated.
        expect(text.toLowerCase()).toContain("static files");
        expect(text.toLowerCase()).toContain("storage");
    });

    it("an unknown field still gets a usable generic sentence", () => {
        expect(text.toLowerCase()).toContain("placeholder");
        expect(text.toLowerCase()).toContain("replace");
    });

    it("points at the docs and carries no stack frame", () => {
        expect(text).toContain("https://knext.dev");
        expect(text).not.toMatch(/\n\s+at\s/);
    });
});

describe("PlaceholderConfigError — the friendly write-and-exit path", () => {
    it("is a UsageError-family error, so every entry renders it as a message", () => {
        const err = new PlaceholderConfigError([
            { path: "registry", value: "ghcr.io/<your-user>" },
        ]);
        expect(err.code).toBe(USAGE_ERROR_CODE);
    });

    it("handleUsageError writes the per-field message and reports handled", () => {
        const err = new PlaceholderConfigError([
            { path: "registry", value: "ghcr.io/<your-user>" },
        ]);
        const chunks: string[] = [];
        expect(handleUsageError(err, (t) => chunks.push(t))).toBe(true);
        const out = chunks.join("");
        expect(out).toContain("registry");
        expect(out).toContain("ghcr.io/<your-user>");
        expect(out).not.toContain("FATAL");
        expect(out).not.toMatch(/\n\s+at\s/);
    });

    it("a non-placeholder error is NOT claimed by the handler (mutation half)", () => {
        const chunks: string[] = [];
        expect(handleUsageError(new Error("boom"), (t) => chunks.push(t))).toBe(
            false,
        );
        expect(chunks).toEqual([]);
    });
});
