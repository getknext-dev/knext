/**
 * #1865 (review round 3) — `preview.ts`'s `runPreviewDeploy` applies the SAME
 * NextApp CR kind, through the SAME `kubectl apply` semantics, as
 * `deploy.ts` — but a preview reuses ONE CR name (`<app>-pr-<n>`) across
 * EVERY commit of the same PR. Without the shared guard wired in, a later
 * commit whose `knext.config.ts` no longer sets `networking.visibility:
 * "cluster-local"` would silently make a previously-private preview PUBLIC
 * on its next redeploy — the exact fail-open hazard `deploy.ts` already
 * closed, reopened on the other apply path.
 *
 * This suite exercises the REAL `assertVisibilityDowngradeIsExplicit`
 * (imported from `../cli/visibility-guard`) wired into the REAL
 * `runPreviewDeploy`, with ONLY `captureKubectl` mocked (the module-level
 * cluster-read boundary both the guard and `defaultPreflight` use) — not a
 * stand-in stub of the guard itself, which would stay green even if
 * `runPreviewDeploy` stopped calling it correctly.
 *
 * Previews have NO `--public` override. A currently-private preview goes
 * public only via a commit that sets `networking.visibility: "public"`
 * explicitly in `knext.config.ts`; an omitted block is refused.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test";
import type { KnativeNextConfig } from "../config";

// biome-ignore lint/suspicious/noExplicitAny: mock return type only
type AnyFn = (...args: unknown[]) => any;

// The real `captureKubectl` shells out to `kubectl` via `spawnSync` — mock it
// so both `defaultPreflight` (stubbed away per-test below) and the REAL
// `assertVisibilityDowngradeIsExplicit` run hermetically.
const captureKubectl = mock<AnyFn>();
mock.module("../cli/schema/kubectl-capture", () => ({
    captureKubectl: (...a: unknown[]) => captureKubectl(...a),
}));

// Imported DYNAMICALLY, after `mock.module` registers — a static import is
// hoisted before the mock, and both modules would bind the REAL
// `captureKubectl` (same hazard documented in preview-no-storage.test.ts /
// preview-default-seams.test.ts).
const { runPreviewDeploy } = await import("../cli/preview");
const { assertVisibilityDowngradeIsExplicit } = await import(
    "../cli/visibility-guard"
);

const baseConfig: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
    storage: {
        provider: "gcs",
        bucket: "b",
        publicUrl: "https://example.com",
    },
};

const privateConfig: KnativeNextConfig = {
    ...baseConfig,
    networking: { visibility: "cluster-local" },
};

const digestImage =
    "registry.example.com/my-app-pr-42:123@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1";

function okReconciled(): { ok: true; stdout: string; stderr: string } {
    return { ok: true, stdout: "{}", stderr: "" };
}

function notFound(): { ok: false; stdout: string; stderr: string } {
    return {
        ok: false,
        stdout: "",
        stderr: 'Error from server (NotFound): nextapps.apps.kn-next.dev "my-app-pr-42" not found',
    };
}

function liveIsPrivate(): { ok: true; stdout: string; stderr: string } {
    return {
        ok: true,
        stdout: JSON.stringify({
            spec: { networking: { visibility: "cluster-local" } },
        }),
        stderr: "",
    };
}

async function deployPreview(config: KnativeNextConfig) {
    const apply = mock((_argv: readonly string[]) => {});
    const capture = mock(
        (_argv: readonly string[]) =>
            "https://my-app-pr-42.previews.example.com",
    );
    const buildAndPush = mock(async (_name: string) => digestImage);
    await runPreviewDeploy(
        config,
        { prId: "42", branch: "feat/x", namespace: "previews" },
        {
            apply,
            capture,
            buildAndPush,
            preflight: () => {}, // #314's real cluster call — covered elsewhere
            visibilityGuard: assertVisibilityDowngradeIsExplicit,
        },
    );
    return { apply };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe("runPreviewDeploy visibility downgrade guard (#1865 round 3)", () => {
    it("a brand-new preview (live NextApp not found) deploys without the guard blocking it", async () => {
        captureKubectl.mockReturnValue(notFound());
        const { apply } = await deployPreview(baseConfig);
        expect(apply).toHaveBeenCalledTimes(1);
        expect(captureKubectl).toHaveBeenCalledTimes(1); // the guard's one read
    });

    it("a config that keeps networking.visibility: cluster-local never reads live state (short-circuits) and deploys", async () => {
        const { apply } = await deployPreview(privateConfig);
        expect(apply).toHaveBeenCalledTimes(1);
        expect(captureKubectl).not.toHaveBeenCalled();
    });

    it("a later redeploy whose config DROPPED networking.visibility, against a LIVE cluster-local preview, REFUSES", async () => {
        captureKubectl.mockReturnValue(liveIsPrivate());
        const apply = mock((_argv: readonly string[]) => {});
        const capture = mock((_argv: readonly string[]) => "");
        const buildAndPush = mock(async (_name: string) => digestImage);
        await expect(
            runPreviewDeploy(
                baseConfig, // no networking.visibility — the dropped commit
                { prId: "42", branch: "feat/x", namespace: "previews" },
                {
                    apply,
                    capture,
                    buildAndPush,
                    preflight: () => {},
                    visibilityGuard: assertVisibilityDowngradeIsExplicit,
                },
            ),
        ).rejects.toThrow(/knext\.config\.ts/);
        // The refusal happens BEFORE the real apply.
        expect(apply).not.toHaveBeenCalled();
    });

    it("the refusal message for a preview never tells the user to PASS --public (previews have no such flag)", async () => {
        captureKubectl.mockReturnValue(liveIsPrivate());
        // It legitimately SAYS "no --public override" (explaining the
        // absence) — what it must never do is instruct the user to pass one,
        // the deploy-specific remediation that does not apply here.
        await expect(deployPreview(baseConfig)).rejects.not.toThrow(
            /re-run with --public|pass --public/i,
        );
    });

    it("round trip, live PRIVATE: config says public is ALLOWED and applies", async () => {
        captureKubectl.mockReturnValue(liveIsPrivate());
        const { apply } = await deployPreview({
            ...baseConfig,
            networking: { visibility: "public" },
        });
        expect(apply).toHaveBeenCalledTimes(1);
    });

    it("round trip, live PRIVATE: config omits networking is REFUSED with an accurate message", async () => {
        captureKubectl.mockReturnValue(liveIsPrivate());
        const err = await deployPreview(baseConfig).then(
            () => null,
            (e: Error) => e,
        );
        expect(err).not.toBeNull();
        const msg = (err as Error).message;
        // names both working fixes: restore cluster-local, or write public explicitly
        expect(msg).toMatch(/cluster-local/);
        expect(msg).toMatch(/visibility: "public"/);
        // must not claim that removing/omitting the block makes it public
        expect(msg).not.toMatch(/also a config change, not a flag/);
    });

    it("round trip, live PRIVATE: config says cluster-local is unchanged (no live read, applies)", async () => {
        captureKubectl.mockReturnValue(liveIsPrivate());
        const { apply } = await deployPreview(privateConfig);
        expect(apply).toHaveBeenCalledTimes(1);
        expect(captureKubectl).not.toHaveBeenCalled();
    });

    it("the refusal message for a preview names knext.config.ts as the fix", async () => {
        captureKubectl.mockReturnValue(liveIsPrivate());
        await expect(deployPreview(baseConfig)).rejects.toThrow(
            /knext\.config\.ts/,
        );
    });

    it("a live-read failure for a reason OTHER than not-found FAILS CLOSED", async () => {
        captureKubectl.mockReturnValue({
            ok: false,
            stdout: "",
            stderr: "Error from server (Forbidden): nextapps.apps.kn-next.dev is forbidden",
        });
        const apply = mock((_argv: readonly string[]) => {});
        await expect(
            runPreviewDeploy(
                baseConfig,
                { prId: "42", branch: "feat/x", namespace: "previews" },
                {
                    apply,
                    capture: () => "",
                    buildAndPush: async () => digestImage,
                    preflight: () => {},
                    visibilityGuard: assertVisibilityDowngradeIsExplicit,
                },
            ),
        ).rejects.toThrow(/failing closed|Forbidden/i);
        expect(apply).not.toHaveBeenCalled();
    });

    // Not strictly needed given okReconciled() is unused elsewhere, but keeps
    // the helper from reading as dead code if a future case needs an
    // ok-but-irrelevant live response (e.g. a reconciled, PUBLIC live app).
    it("a live PUBLIC app (ok, no networking field) does not block a plain redeploy", async () => {
        captureKubectl.mockReturnValue(okReconciled());
        const { apply } = await deployPreview(baseConfig);
        expect(apply).toHaveBeenCalledTimes(1);
    });
});
