/**
 * Issue #1234 (coverage batch B3): two real, previously-untested seams in
 * `cli/preview.ts`, found by measuring ACTUAL uncovered executable lines
 * (not bun's lcov, which per #1248 also emits `DA` records for comments,
 * blank lines and lone braces) rather than trusting a raw uncovered-line
 * count:
 *
 *   1. `defaultPreflight` — the module-internal `PreviewPreflight` used when
 *      a caller does not inject `deps.preflight` (every OTHER preview test
 *      injects a no-op preflight, so this real wiring — server-side dry-run
 *      via `captureKubectl` — was never exercised).
 *   2. `extractTag`'s fallback branch — when the built image ref carries no
 *      `:tag` segment (digest-only), `runPreviewDeploy` falls back to
 *      `${Date.now()}` for `spec.buildId` rather than the parsed tag.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { KnativeNextConfig } from "../config";

// biome-ignore lint/suspicious/noExplicitAny: mock return type only
type AnyFn = (...args: unknown[]) => any;

// The real `captureKubectl` shells out to `kubectl` via `spawnSync` — mock it
// so `defaultPreflight`'s server-side dry-run runs hermetically.
const captureKubectl = mock<AnyFn>(() => ({
    ok: true,
    stdout: "",
    stderr: "",
}));
mock.module("../cli/schema/kubectl-capture", () => ({
    captureKubectl: (...a: unknown[]) => captureKubectl(...a),
}));

// Imported DYNAMICALLY, after `mock.module` registers — a static import is
// hoisted before the mock, and `../cli/preview` would bind the REAL
// `captureKubectl` (same hazard documented in preview-no-storage.test.ts).
const { runPreviewDeploy } = await import("../cli/preview");

const baseConfig: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
    storage: {
        provider: "gcs",
        bucket: "b",
        publicUrl: "https://example.com",
    },
};

const digestImage =
    "registry.example.com/my-app-pr-42:123@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1";

beforeEach(() => {
    jest.clearAllMocks();
    captureKubectl.mockImplementation(() => ({
        ok: true,
        stdout: "",
        stderr: "",
    }));
});

describe("runPreviewDeploy — default preflight (deps.preflight NOT injected, #1234)", () => {
    it("runs the real server-side dry-run preflight (captureKubectl) and proceeds on an ok verdict", async () => {
        const apply = mock((_argv: readonly string[]) => {});
        const capture = mock(
            (_argv: readonly string[]) =>
                "https://my-app-pr-42.previews.example.com",
        );
        const buildAndPush = mock(async (_name: string) => digestImage);

        const url = await runPreviewDeploy(
            baseConfig,
            { prId: "42", branch: "feat/x", namespace: "previews" },
            // preflight intentionally OMITTED — exercises defaultPreflight.
            { apply, capture, buildAndPush },
        );

        expect(url).toBe("https://my-app-pr-42.previews.example.com");
        expect(captureKubectl).toHaveBeenCalledTimes(1);
        const argv = captureKubectl.mock.calls[0]?.[0] as string[];
        expect(argv).toContain("--dry-run=server");
        expect(argv).toContain("--validate=strict");
        expect(argv.join(" ")).toContain("nextapp-preview-preflight-cr.yaml");
        expect(argv).toContain("previews");
        // Real preflight ran BEFORE build/apply, and succeeded, so both ran.
        expect(buildAndPush).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledTimes(1);
    });

    it("binds the target kube context into the dry-run preflight argv (#978) — a regression here would silently dry-run against the AMBIENT cluster", async () => {
        const apply = mock((_argv: readonly string[]) => {});
        const capture = mock(
            (_argv: readonly string[]) =>
                "https://my-app-pr-42.previews.example.com",
        );
        const buildAndPush = mock(async (_name: string) => digestImage);

        await runPreviewDeploy(
            baseConfig,
            {
                prId: "42",
                branch: "feat/x",
                namespace: "previews",
                context: "staging-cluster",
            },
            // preflight intentionally OMITTED — exercises defaultPreflight's
            // OWN withKubeContext wiring, not a caller-supplied stub's.
            { apply, capture, buildAndPush },
        );

        expect(captureKubectl).toHaveBeenCalledTimes(1);
        const argv = captureKubectl.mock.calls[0]?.[0] as string[];
        expect(argv).toContain("--context");
        expect(argv[argv.indexOf("--context") + 1]).toBe("staging-cluster");
    });

    it("NEGATIVE: throws before build/apply when the real preflight reports an incompatible CRD", async () => {
        captureKubectl.mockImplementation(() => ({
            ok: false,
            stdout: "",
            stderr: 'error: strict decoding error: unknown field "spec.bogus"',
        }));
        const apply = mock((_argv: readonly string[]) => {});
        const capture = mock((_argv: readonly string[]) => "https://x");
        const buildAndPush = mock(async (_name: string) => digestImage);

        await expect(
            runPreviewDeploy(
                baseConfig,
                { prId: "42", branch: "feat/x", namespace: "previews" },
                { apply, capture, buildAndPush },
            ),
        ).rejects.toThrow();

        // The whole point of preflighting BEFORE build/push (#314 T6): a bad
        // CRD costs nothing but the round-trip.
        expect(buildAndPush).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
    });
});

describe("runPreviewDeploy — buildId falls back to a timestamp when the image ref carries no tag (#1234)", () => {
    it("renders spec.buildId as a plain numeric timestamp, not the (absent) tag", async () => {
        // Digest-only ref: no ":tag" between the repo path and "@sha256:", so
        // `extractTag` returns undefined and the caller falls back to
        // `${Date.now()}`.
        const digestOnlyRef = `registry.example.com/my-app-pr-42@sha256:${"a".repeat(64)}`;
        const apply = mock((_argv: readonly string[]) => {});
        const capture = mock((_argv: readonly string[]) => "https://x");
        const buildAndPush = mock(async (_name: string) => digestOnlyRef);

        const before = Date.now();
        await runPreviewDeploy(
            baseConfig,
            { prId: "42", branch: "feat/x", namespace: "previews" },
            { apply, capture, buildAndPush, preflight: () => {} },
        );
        const after = Date.now();

        const crPath = join(
            process.cwd(),
            ".output",
            "nextapp-preview-cr.yaml",
        );
        const cr = YAML.parse(readFileSync(crPath, "utf-8")) as {
            spec: { buildId?: string };
        };
        expect(cr.spec.buildId).toBeDefined();
        // All-digit and inside the [before, after] window this test ran in —
        // could only be the `Date.now()` fallback, never a parsed tag string.
        expect(cr.spec.buildId).toMatch(/^\d+$/);
        const asNumber = Number(cr.spec.buildId);
        expect(asNumber).toBeGreaterThanOrEqual(before);
        expect(asNumber).toBeLessThanOrEqual(after);
    });

    it("regression pin: a tagged ref still uses the parsed tag as buildId, not a timestamp", async () => {
        const apply = mock((_argv: readonly string[]) => {});
        const capture = mock((_argv: readonly string[]) => "https://x");
        const buildAndPush = mock(async (_name: string) => digestImage);

        await runPreviewDeploy(
            baseConfig,
            { prId: "42", branch: "feat/x", namespace: "previews" },
            { apply, capture, buildAndPush, preflight: () => {} },
        );

        const crPath = join(
            process.cwd(),
            ".output",
            "nextapp-preview-cr.yaml",
        );
        const cr = YAML.parse(readFileSync(crPath, "utf-8")) as {
            spec: { buildId?: string };
        };
        // `digestImage` carries tag "123" between the repo path and "@sha256:".
        expect(cr.spec.buildId).toBe("123");
    });
});
