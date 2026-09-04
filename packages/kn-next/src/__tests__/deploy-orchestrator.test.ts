/**
 * v5-P4 — deploy() orchestrator branch/safety tests.
 *
 * `deploy()` in cli/deploy.ts is the CLUSTER-MUTATING path (it ends in a
 * `kubectl apply -f` of the NextApp CR). CLAUDE.md §9 flags core build/deploy
 * paths as thin on coverage; this suite pins the orchestrator's failure and
 * skip branches HERMETICALLY — no live cluster, no docker, no next build —
 * by module-mocking the side-effecting seams:
 *
 *   - ./exec          → runQuiet / runInherit / runCapture (build, apply, gets)
 *   - ../utils/asset-upload → uploadAssets / getAssetPrefix
 *   - ./cr-builder    → renderNextAppCR / resolveDigest / validateCRImageRef
 *   - ./gc            → runAssetGC (best-effort post-deploy GC)
 *   - ./shared        → loadConfig
 *   - node:fs         → readFileSync (the .next/BUILD_ID skew guard reads this)
 *
 * We assert OBSERVABLE behavior and CALL ORDER, not internal call shapes.
 *
 * Invariants pinned:
 *  1. Happy path ORDER: next build → upload assets → kubectl apply, in that
 *     sequence.
 *  2. Skew guard (ADR-0011 / #93): a `.next/BUILD_ID` that != the deploy tag
 *     THROWS and aborts BEFORE the mutating apply; a MISSING BUILD_ID (ENOENT)
 *     WARNS and PROCEEDS to apply.
 *  3. --dry-run: the mutating `kubectl apply` is NEVER reached (load-bearing
 *     safety invariant — dry-run must not mutate the cluster).
 *  4. --skip-build / --skip-upload: those steps are observably skipped.
 */

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    mock,
} from "bun:test";
import type { KnativeNextConfig } from "../config";

// ---------------------------------------------------------------------------
// Module mocks for every side-effecting seam. deploy.ts imports these by name;
// vi.mock replaces them BEFORE deploy.ts is (dynamically) imported per test.
// ---------------------------------------------------------------------------

// Every spy is typed with an explicit variadic signature so the thin factory
// wrappers below can spread `...a` into them without a tuple-type TS error.
// bun types `mockResolvedValue`/`mockReturnValue` off the declared return
// type. A mock returning `unknown` is not Promise-shaped, so every
// `mockResolvedValue` call is rejected. Arguments stay `unknown[]` — that is
// where the strictness that matters lives.
// biome-ignore lint/suspicious/noExplicitAny: the return must be `any`; see above
type AnyFn = (...args: unknown[]) => any;

const runQuiet = mock<AnyFn>();
const runInherit = mock<AnyFn>();
const runCapture = mock<AnyFn>(() => "");
const isEntrypoint = mock<AnyFn>(() => false); // never fire the CLI self-entry block under vitest

// `createRequire` and the REAL `node:fs` are resolved OUT HERE, not inside the
// `mock.module("node:fs", …)` factory below.
//
// An `await import(...)` inside a mock factory deadlocks under bun: the mock is
// already registered when the factory runs, so the import re-enters module
// resolution and waits on itself. The file does not fail — it HANGS with no
// output, which the runner can only report as a timeout naming no test.
const { createRequire: __knextCreateRequire } = await import("node:module");
const __knextRealFs = __knextCreateRequire(import.meta.url)(
    "node:fs",
) as typeof import("node:fs");

mock.module("../cli/exec", () => ({
    runQuiet: (...a: unknown[]) => runQuiet(...a),
    runInherit: (...a: unknown[]) => runInherit(...a),
    runCapture: (...a: unknown[]) => runCapture(...a),
    runQuietAllowFail: mock(),
    isEntrypoint: (...a: unknown[]) => isEntrypoint(...a),
}));

const uploadAssets = mock<AnyFn>(async () => {});
const getAssetPrefix = mock<AnyFn>(() => "https://cdn.example.com/_next");
// v6-P2: the scoped, single-prefix orphan-reclaim seam. deploy() calls this on
// the confirmed upload-ok-then-push-failed leg to reclaim EXACTLY this run's
// `<app>/_next/static/<BUILD_ID>/` prefix (NOT runAssetGC / pruneOldBuilds).
const reclaimBuildPrefix = mock<AnyFn>();
// T2a: the vinext leg of the lock-step guard asks whether the prefix this
// deploy claims to have built EXISTS, through THIS seam (the same one the #892
// marker write asks). Stubbed so the branches are drivable without a real
// `.output` tree.
const verifyVinextStaticPrefix = mock<AnyFn>(() => ({ ok: true }));

const __knextReal1 = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", () => ({
    // keep the REAL hasStorage/notice exports (ADR-0047) — stub only the seams
    ...__knextReal1,
    uploadAssets: (...a: unknown[]) => uploadAssets(...a),
    getAssetPrefix: (...a: unknown[]) => getAssetPrefix(...a),
    reclaimBuildPrefix: (...a: unknown[]) => reclaimBuildPrefix(...a),
    verifyVinextStaticPrefix: (...a: unknown[]) =>
        verifyVinextStaticPrefix(...a),
}));

const renderNextAppCR = mock<AnyFn>(() => "kind: NextApp\n");
const resolveDigest = mock<AnyFn>(
    async () => "registry.example.com/my-app@sha256:deadbeef",
);
const validateCRImageRef = mock<AnyFn>();

mock.module("../cli/cr-builder", () => ({
    renderNextAppCR: (...a: unknown[]) => renderNextAppCR(...a),
    resolveDigest: (...a: unknown[]) => resolveDigest(...a),
    validateCRImageRef: (...a: unknown[]) => validateCRImageRef(...a),
}));

const runAssetGC = mock<AnyFn>(() => ({ pruned: true }));

// #314: deploy runs a server-side dry-run prune preflight BEFORE any side
// effect. Stub its kubectl boundary so this suite stays hermetic; the preflight
// itself is covered by cr-prune-preflight.test.ts + deploy-preflight-ordering.test.ts.
mock.module("../cli/schema/kubectl-capture", () => ({
    captureKubectl: () => ({ ok: true, stdout: "", stderr: "" }),
}));

// T2d: the override warning is only observable through the logger, and pino
// writes through sonic-boom on a raw fd — patching `process.stderr.write`
// captures nothing (measured). Same module mock `deploy-no-storage` uses.
const logWarn = mock<AnyFn>();
mock.module("../utils/logger", () => ({
    createLogger: () => ({
        info: mock(),
        warn: (...a: unknown[]) => logWarn(...a),
        error: mock(),
        debug: mock(),
        fatal: mock(),
        trace: mock(),
    }),
}));

mock.module("../cli/gc", () => ({
    runAssetGC: (...a: unknown[]) => runAssetGC(...a),
    gcMain: mock(),
}));

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

const loadConfig = mock<AnyFn>(async () => baseConfig);
// The REAL module is spread first, then overridden.
//
// bun replaces a mocked module WHOLESALE — there is no partial/automock — so a
// factory listing only what the test drives drops every other export, and the
// importer dies with `Export named 'handleUsageError' not found in module`.
// That error names the consumer, not this factory, which is what made it slow
// to place. Spreading keeps the file honest as `../cli/shared` grows.
const __knextRealShared = { ...(await import("../cli/shared")) };

mock.module("../cli/shared", () => ({
    ...__knextRealShared,
    loadConfig: (...a: unknown[]) => loadConfig(...a),
    excerpt: (s: string) => s,
    // placeholder-preflight.ts (imported by deploy.ts) extends UsageError at
    // module-eval time, so the mock must define it (same as deploy-no-storage).
    UsageError: class MockUsageError extends Error {},
}));

// node:fs is mocked so the skew guard's readFileSync(.next/BUILD_ID) is
// controllable. writeFileSync/mkdirSync are stubbed so a real apply-branch run
// doesn't touch disk. readFileSync default: return the deploy tag (match).
// deploy.ts uses NAMED imports (`import { readFileSync, writeSync }`), so the
// named overrides below are what it actually binds to. We ALSO expose a matching
// `default` (spread of the real default + the same overrides) so the mock stays
// correct if deploy.ts ever switches to a default `import fs from "node:fs"` —
// belt-and-suspenders, no behavior change to the current named-import path.
const readFileSyncMock = mock<(...a: unknown[]) => string>(() => "");
const __knextReal2 = { ...(await import("node:fs")) };
mock.module("node:fs", async () => {
    const actual = __knextReal2;
    // #644: deploy now infers the docker build context from the real
    // filesystem (the lockfile walk in tracing-root.ts). Spreading
    // `importOriginal()` does NOT carry node-builtin named exports under
    // vitest, so every fs function the code touches must be listed here —
    // `existsSync` is passed through to the REAL one rather than stubbed, so
    // the walk still answers about the actual tree.
    const realFs = __knextRealFs;
    const overrides = {
        existsSync: realFs.existsSync,
        readFileSync: (...a: unknown[]) => readFileSyncMock(...(a as [string])),
        writeFileSync: mock(),
        mkdirSync: mock(),
        writeSync: mock(),
    };
    return {
        ...actual,
        ...overrides,
        default: { ...(actual as { default?: object }).default, ...overrides },
    };
});

// ---------------------------------------------------------------------------
// A tiny ordered call log so we can assert the happy-path SEQUENCE across the
// different seams (build vs upload vs apply).
// ---------------------------------------------------------------------------
let order: string[];

function argvOf(call: unknown[]): string[] {
    return (call[0] as string[]) ?? [];
}

/**
 * Import a FRESH copy of deploy.ts (resetModules first) so the top-level
 * isEntrypoint guard re-evaluates against our mock and module state is clean.
 * Returns the module's exported deploy().
 */
async function importDeploy(): Promise<() => Promise<void>> {
    const mod = (await import("../cli/deploy")) as {
        deploy: () => Promise<void>;
    };
    return mod.deploy;
}

/** Set process.argv to a `kn-next deploy` invocation with the given flags. */
function setArgv(flags: string[]): void {
    process.argv = ["node", "/path/to/kn-next.js", ...flags];
}

const savedArgv = process.argv;
const savedEnv = { ...process.env };

beforeEach(() => {
    // No `resetModules()`: everything this file varies goes through the mocks
    // cleared on the next line and the fixtures set below. bun has no registry
    // reset, and the deploy path holds no module state of its own — it reads
    // config and calls injected collaborators.
    jest.clearAllMocks();
    order = [];

    // Default seam behaviors + order tagging.
    runQuiet.mockImplementation((...a: unknown[]) => {
        // `npm run build`
        const argv = a[0] as string[];
        if (argv?.includes("build")) order.push("build");
    });
    runInherit.mockImplementation((...a: unknown[]) => {
        const argv = a[0] as string[];
        if (argv?.[0] === "kubectl" && argv?.[1] === "apply")
            order.push("apply");
        if (argv?.[0] === "docker") order.push("docker");
    });
    runCapture.mockReturnValue("");
    uploadAssets.mockImplementation(async () => {
        order.push("upload");
    });
    resolveDigest.mockResolvedValue(
        "registry.example.com/my-app@sha256:deadbeef",
    );
    renderNextAppCR.mockReturnValue("kind: NextApp\n");
    runAssetGC.mockReturnValue({ pruned: true });
    loadConfig.mockResolvedValue(baseConfig);
    // Skew guard reads .next/BUILD_ID — default: match the tag we pass.
    readFileSyncMock.mockReturnValue("deploytag");
    // ...and on the vinext leg, the built prefix — default: it is there.
    verifyVinextStaticPrefix.mockReturnValue({ ok: true });
});

afterEach(() => {
    process.argv = savedArgv;
    process.env = { ...savedEnv };
});

describe("deploy() happy-path ordering", () => {
    it("runs next build → upload assets → kubectl apply IN THAT ORDER", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();

        await deploy();

        // The mutating apply must have happened.
        expect(
            runInherit.mock.calls.some(
                (c) => argvOf(c)[0] === "kubectl" && argvOf(c)[1] === "apply",
            ),
        ).toBe(true);

        // ORDER: build before upload, upload before apply.
        const iBuild = order.indexOf("build");
        const iUpload = order.indexOf("upload");
        const iApply = order.indexOf("apply");
        expect(iBuild).toBeGreaterThanOrEqual(0);
        expect(iUpload).toBeGreaterThanOrEqual(0);
        expect(iApply).toBeGreaterThanOrEqual(0);
        expect(iBuild).toBeLessThan(iUpload);
        expect(iUpload).toBeLessThan(iApply);
    });

    it("digest-pins the CR image ref (validateCRImageRef called) before apply", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();
        expect(resolveDigest).toHaveBeenCalledTimes(1);
        expect(validateCRImageRef).toHaveBeenCalledTimes(1);
    });
});

/** Did the mutating `kubectl apply` run? */
function applied(): boolean {
    return runInherit.mock.calls.some(
        (c) => argvOf(c)[0] === "kubectl" && argvOf(c)[1] === "apply",
    );
}

/** The standalone (turbopack) leg — `.next/BUILD_ID` is the built id there. */
const standaloneConfig = { ...baseConfig, build: "turbopack" as const };

describe("deploy() skew guard — standalone leg (ADR-0011 / #93)", () => {
    beforeEach(() => loadConfig.mockResolvedValue(standaloneConfig));

    it("THROWS and aborts BEFORE apply when .next/BUILD_ID != deploy tag", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        // BUILD_ID on disk is a different (random) id → mismatch.
        readFileSyncMock.mockReturnValue("some-random-nanoid");

        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow(/BUILD_ID/);
        expect(applied()).toBe(false);
    });

    it("WARNS and PROCEEDS to apply when .next/BUILD_ID is MISSING (ENOENT)", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        // Simulate a missing file: readFileSync throws ENOENT.
        readFileSyncMock.mockImplementation(() => {
            const err = new Error(
                "ENOENT: no such file",
            ) as NodeJS.ErrnoException;
            err.code = "ENOENT";
            throw err;
        });

        const deploy = await importDeploy();

        // ENOENT is swallowed (warn) — deploy continues to the apply.
        await expect(deploy()).resolves.toBeUndefined();
        expect(applied()).toBe(true);
    });
});

/**
 * T2a — the vinext leg of the SAME guarantee. vinext writes no
 * `.next/BUILD_ID`, so the pre-T2a guard hit ENOENT and warn-skipped on EVERY
 * vinext deploy: a control reporting success while inert, in the exact place
 * ADR-0011's guarantee lives. The built id here is the static prefix, and the
 * check FAILS LOUDLY in every branch — including the one that used to skip.
 */
describe("deploy() skew guard — vinext leg (T2a)", () => {
    // baseConfig sets no `build`, which resolves to vinext (ADR-0048), and it
    // HAS a storage block — so the guard's subject exists.

    it("PROCEEDS to apply when the built prefix IS the deploy tag", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        verifyVinextStaticPrefix.mockReturnValue({ ok: true });

        const deploy = await importDeploy();
        await expect(deploy()).resolves.toBeUndefined();
        expect(applied()).toBe(true);
        // It asks about the DEPLOY TAG, not "which directory looks like a
        // build" — a discovery rule breaks on any next/font app, whose
        // `_vinext_fonts/` sits right beside the build prefix.
        expect(verifyVinextStaticPrefix).toHaveBeenCalledWith(
            expect.any(String),
            "deploytag",
        );
    });

    it("THROWS and aborts BEFORE apply when the tag's prefix is absent", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        // The pre-T2a symptom: vinext minted a UUID because the app's Next
        // config sets no generateBuildId, so nothing was built under the tag.
        verifyVinextStaticPrefix.mockReturnValue({
            ok: false,
            reason: "prefix-missing",
            siblings: ["1bf62579-a57c-4fec-b3a0-c6ce1c59ff1b", "chunks"],
        });

        const deploy = await importDeploy();
        // The error names BOTH the tag it wanted and what it found — "not
        // found" alone is not a diagnosis.
        await expect(deploy()).rejects.toThrow(
            /1bf62579-a57c-4fec-b3a0-c6ce1c59ff1b/,
        );
        expect(applied()).toBe(false);
        expect(uploadAssets).not.toHaveBeenCalled();
    });

    it("THROWS (never skips) when _next/static is missing entirely", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        verifyVinextStaticPrefix.mockReturnValue({
            ok: false,
            reason: "no-static-root",
            siblings: [],
        });

        const deploy = await importDeploy();
        await expect(deploy()).rejects.toThrow(/no-static-root/);
        expect(applied()).toBe(false);
    });

    it("--skip-build STILL checks, and reports it as a fixable mistake", async () => {
        // The case that silently orphans assets — the build is not re-run, so
        // nothing else can notice the artifact belongs to another deploy. It is
        // a UsageError because there is a one-word fix (drop the flag), and a
        // FATAL stack dump would bury that.
        setArgv(["deploy", "--tag", "deploytag", "--skip-build"]);
        verifyVinextStaticPrefix.mockReturnValue({
            ok: false,
            reason: "prefix-missing",
            siblings: ["older-tag"],
        });

        const { UsageError } = await import("../cli/shared");
        const deploy = await importDeploy();
        await expect(deploy()).rejects.toBeInstanceOf(UsageError);
        await expect(deploy()).rejects.toThrow(/--skip-build/);
        expect(applied()).toBe(false);
        // ...and nothing was uploaded under the wrong prefix.
        expect(uploadAssets).not.toHaveBeenCalled();
    });

    /**
     * Review round 2: the guard protects the correspondence between the
     * uploaded PREFIX and the key the GC resolves from a revision label. Where
     * nothing uploads there is no correspondence to break, and aborting over
     * the name of a directory inside the image is a hard failure protecting
     * nothing. Both of these deploys are legitimate and must complete.
     */
    describe("is scoped to deploys that actually upload", () => {
        it("--skip-upload: the guard is not consulted, and the deploy applies", async () => {
            setArgv(["deploy", "--tag", "deploytag", "--skip-upload"]);
            // Even with the artifact in the WORST state the guard knows about.
            verifyVinextStaticPrefix.mockReturnValue({
                ok: false,
                reason: "no-static-root",
                siblings: [],
            });

            const deploy = await importDeploy();
            await expect(deploy()).resolves.toBeUndefined();
            expect(applied()).toBe(true);
            expect(verifyVinextStaticPrefix).not.toHaveBeenCalled();
        });

        it("no-storage mode (ADR-0047): the guard is not consulted", async () => {
            // The real hasStorage is kept in this suite's module mock, so this
            // exercises the actual predicate rather than a stub of it.
            const { storage: _dropped, ...noStorage } = baseConfig;
            loadConfig.mockResolvedValue(noStorage);
            setArgv(["deploy", "--tag", "deploytag"]);
            verifyVinextStaticPrefix.mockReturnValue({
                ok: false,
                reason: "no-static-root",
                siblings: [],
            });

            const deploy = await importDeploy();
            await expect(deploy()).resolves.toBeUndefined();
            expect(applied()).toBe(true);
            expect(verifyVinextStaticPrefix).not.toHaveBeenCalled();
        });
    });
});

/**
 * T2d — the precedence decision has to be OBSERVABLE, or it is a comment.
 * knext's build id overrides a colliding `env.NEXT_DEPLOYMENT_ID` in the user's
 * config, and the user has to be told, because they wrote it expecting it to
 * take effect.
 */
describe("deploy() warns when config.env.NEXT_DEPLOYMENT_ID is overridden (T2d)", () => {
    /**
     * Every `log.warn` deploy() emitted for one run, flattened to text.
     *
     * Through the logger MODULE mock (the pattern `deploy-no-storage` uses):
     * pino writes through sonic-boom on a raw fd, so monkey-patching
     * `process.stderr.write` captures nothing — measured, it returned "".
     */
    async function warningsFrom(config: KnativeNextConfig): Promise<string> {
        loadConfig.mockResolvedValue(config);
        logWarn.mockClear();
        const deploy = await importDeploy();
        await deploy();
        return logWarn.mock.calls
            .map((call) => call.map((a) => JSON.stringify(a)).join(" "))
            .join("\n");
    }

    it("names the ignored value AND the id that won", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const output = await warningsFrom({
            ...baseConfig,
            env: { NEXT_DEPLOYMENT_ID: "user-typed-this" },
        });

        expect(output).toContain("user-typed-this");
        expect(output).toContain("deploytag");
        // Non-vacuity: it is the OVERRIDE being reported, not just any log line
        // that happens to mention the tag.
        expect(output).toMatch(/NEXT_DEPLOYMENT_ID/);
        expect(output.toLowerCase()).toContain("ignoring");
    });

    it("says NOTHING when the user set no colliding value", async () => {
        // The other half: a warning that fires on every deploy is noise, and
        // noise is how the real one gets scrolled past.
        setArgv(["deploy", "--tag", "deploytag"]);
        const output = await warningsFrom({
            ...baseConfig,
            env: { FEATURE_FLAG_BETA: "on" },
        });
        expect(output.toLowerCase()).not.toContain(
            "ignoring env.next_deployment_id",
        );
    });

    it("says nothing when the user's value AGREES with the deploy tag", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const output = await warningsFrom({
            ...baseConfig,
            env: { NEXT_DEPLOYMENT_ID: "deploytag" },
        });
        expect(output.toLowerCase()).not.toContain(
            "ignoring env.next_deployment_id",
        );
    });
});

describe("deploy() --dry-run safety (no cluster mutation)", () => {
    it("NEVER reaches the mutating kubectl apply in --dry-run", async () => {
        setArgv(["deploy", "--dry-run", "--tag", "deploytag"]);
        const deploy = await importDeploy();

        await deploy();

        // The load-bearing invariant: no kubectl apply in dry-run.
        const applied = runInherit.mock.calls.some(
            (c) => argvOf(c)[0] === "kubectl" && argvOf(c)[1] === "apply",
        );
        expect(applied).toBe(false);
    });

    it("--dry-run also skips upload + docker push (no side effects)", async () => {
        setArgv(["deploy", "--dry-run", "--tag", "deploytag"]);
        const deploy = await importDeploy();

        await deploy();

        expect(uploadAssets).not.toHaveBeenCalled();
        // No docker build/push either.
        expect(
            runInherit.mock.calls.some((c) => argvOf(c)[0] === "docker"),
        ).toBe(false);
    });
});

describe("deploy() skip flags", () => {
    it("--skip-build does NOT run next build (and never reads BUILD_ID)", async () => {
        setArgv(["deploy", "--skip-build", "--tag", "deploytag"]);
        const deploy = await importDeploy();

        await deploy();

        // No `npm run build`.
        expect(
            runQuiet.mock.calls.some((c) => argvOf(c).includes("build")),
        ).toBe(false);
        // Skew guard is inside the build branch → BUILD_ID never read.
        expect(readFileSyncMock).not.toHaveBeenCalled();
    });

    it("--skip-upload does NOT upload assets, but still applies the CR", async () => {
        setArgv(["deploy", "--skip-upload", "--tag", "deploytag"]);
        const deploy = await importDeploy();

        await deploy();

        expect(uploadAssets).not.toHaveBeenCalled();
        const applied = runInherit.mock.calls.some(
            (c) => argvOf(c)[0] === "kubectl" && argvOf(c)[1] === "apply",
        );
        expect(applied).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// v6-P2 — partial-failure atomicity + orphan-prefix reclaim (ADR-0011).
//
// deploy() runs uploadAssets(config) and the docker build/push CONCURRENTLY
// under one Promise.all. If the push REJECTS after the upload already resolved,
// `kubectl apply` is (correctly) never reached — but the just-uploaded
// `<app>/_next/static/<BUILD_ID>/` prefix is orphaned (post-apply runAssetGC
// never runs). The fix reclaims ONLY this run's own unique BUILD_ID prefix via
// a scoped single-prefix reclaim (reclaimBuildPrefix), then RETHROWS the
// original push error — never masking it, never reaching apply, and never
// invoking the full-remote-set classifiers runAssetGC / pruneOldBuilds (which
// enumerate ALL builds and could reap a concurrently-deploying build's
// not-yet-live assets — an ADR-0011 over-keep-never-over-delete violation).
// ---------------------------------------------------------------------------
describe("deploy() partial-failure atomicity + orphan reclaim (v6-P2, ADR-0011)", () => {
    /** Make the docker build/push reject; keep upload resolving (order-tagged). */
    function makePushFail(message = "docker push failed"): Error {
        const pushErr = new Error(message);
        runInherit.mockImplementation((...a: unknown[]) => {
            const argv = a[0] as string[];
            if (argv?.[0] === "docker") {
                order.push("docker");
                throw pushErr;
            }
            if (argv?.[0] === "kubectl" && argv?.[1] === "apply")
                order.push("apply");
        });
        return pushErr;
    }

    it("upload-ok + push-FAIL: never reaches kubectl apply and fails LOUDLY", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const pushErr = makePushFail();
        const deploy = await importDeploy();

        // The original push error must propagate (loud, non-zero) — not masked.
        await expect(deploy()).rejects.toBe(pushErr);

        // The mutating apply must NEVER have run.
        const applied = runInherit.mock.calls.some(
            (c) => argvOf(c)[0] === "kubectl" && argvOf(c)[1] === "apply",
        );
        expect(applied).toBe(false);
    });

    it("upload-ok + push-FAIL: reclaims EXACTLY this run's BUILD_ID prefix (scoped, single-prefix)", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        makePushFail();
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow();

        // Reclaim invoked once, for THIS run's BUILD_ID (== the deploy tag).
        expect(reclaimBuildPrefix).toHaveBeenCalledTimes(1);
        const [cfg, buildId] = reclaimBuildPrefix.mock.calls[0] as [
            KnativeNextConfig,
            string,
        ];
        expect(buildId).toBe("deploytag");
        expect(cfg?.name).toBe("my-app");
    });

    it("upload-ok + push-FAIL: does NOT call runAssetGC / pruneOldBuilds (no full-remote-set classifier)", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        makePushFail();
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow();

        // The full-remote-set classifier (runAssetGC → pruneOldBuilds) must NOT
        // run on the failure path — it enumerates ALL builds and could reap a
        // concurrent deploy's not-yet-live prefix (ADR-0011 over-delete hazard).
        expect(runAssetGC).not.toHaveBeenCalled();
    });

    it("upload-ok + push-FAIL: reclaim cleanup NEVER masks the original push error", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const pushErr = makePushFail("original push boom");
        // Even if the best-effort reclaim itself throws, the ORIGINAL error wins.
        reclaimBuildPrefix.mockImplementation(() => {
            throw new Error("cleanup blew up — must be swallowed");
        });
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toBe(pushErr);
    });

    it("SYMMETRIC leg — upload-FAIL + push-ok: no apply, fails LOUDLY (registry-orphan reclaim OUT OF SCOPE)", async () => {
        // The other Promise.all branch: assets REJECT while the push succeeds.
        // That leaks an image TAG in the registry — a SEPARATE authority
        // (registry GC), explicitly OUT OF SCOPE here. We only assert this leg
        // ALSO never reaches apply and fails loudly (and does not reclaim an
        // asset prefix — nothing was uploaded).
        setArgv(["deploy", "--tag", "deploytag"]);
        const uploadErr = new Error("asset upload failed");
        uploadAssets.mockImplementation(async () => {
            order.push("upload");
            throw uploadErr;
        });
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow();

        const applied = runInherit.mock.calls.some(
            (c) => argvOf(c)[0] === "kubectl" && argvOf(c)[1] === "apply",
        );
        expect(applied).toBe(false);
        expect(reclaimBuildPrefix).not.toHaveBeenCalled();
    });

    it("happy path unchanged: a successful push does NOT invoke reclaimBuildPrefix", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();

        await deploy();

        expect(reclaimBuildPrefix).not.toHaveBeenCalled();
    });
});
