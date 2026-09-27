/**
 * #1506 — the build-progress log lines in `deploy()` used to be hardcoded to
 * the standalone (turbopack/webpack) shape regardless of `resolvedBuild`
 * (`config.build ?? DEFAULT_BUILDER_ID`). A vinext deploy — the docs app's
 * `build: 'vinext'` — logged "Running next build (output:standalone)..." and
 * "Next.js build complete — standalone output in .next/standalone/" even
 * though `npm run build` actually ran the app's own `vite build` script and
 * produced `.output/`. The DISPATCH (`runProjectBuild` → `npm run build`) was
 * always correct; only the operator-facing message lied about it, which is
 * exactly what made a working build look like a routing bug from the log
 * alone.
 *
 * Pinned here, hermetically (same seams as deploy-no-storage.test.ts):
 *   - `build: 'vinext'` logs a message naming "vinext build" and NEVER the
 *     standalone/next-build wording.
 *   - the default (no `build` key, i.e. turbopack) logs the ORIGINAL
 *     standalone wording unchanged — a regression pin so this fix cannot
 *     silently invert which target gets which message.
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
import { reconciledNextAppCapture } from "./helpers/reconciled-nextapp";

// biome-ignore lint/suspicious/noExplicitAny: mock return type must be `any` (bun:test typing gap)
type AnyFn = (...args: unknown[]) => any;

const runQuiet = mock<AnyFn>();
const runInherit = mock<AnyFn>();
const runCapture = mock<AnyFn>(() => "");
const { createRequire: __knextCreateRequire } = await import("node:module");
const __knextRealFs = __knextCreateRequire(import.meta.url)(
    "node:fs",
) as typeof import("node:fs");

mock.module("../cli/exec", () => ({
    runQuiet: (...a: unknown[]) => runQuiet(...a),
    runInherit: (...a: unknown[]) => runInherit(...a),
    runCapture: (...a: unknown[]) => runCapture(...a),
    runQuietAllowFail: mock(),
    isEntrypoint: () => false,
}));

const uploadAssets = mock<AnyFn>(async () => {});
const getAssetPrefix = mock<AnyFn>(() => "https://cdn.example.com/my-app");
const reclaimBuildPrefix = mock<AnyFn>();
const verifyVinextStaticPrefix = mock<AnyFn>(() => ({
    ok: false,
    reason: "no-static-root",
    siblings: [],
}));
const verifyBuiltImageLockstep = mock<AnyFn>(() => ({ ok: true }));
const __knextReal1 = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", async () => {
    const actual = __knextReal1;
    return {
        ...actual,
        uploadAssets: (...a: unknown[]) => uploadAssets(...a),
        getAssetPrefix: (...a: unknown[]) => getAssetPrefix(...a),
        reclaimBuildPrefix: (...a: unknown[]) => reclaimBuildPrefix(...a),
        verifyVinextStaticPrefix: (...a: unknown[]) =>
            verifyVinextStaticPrefix(...a),
        verifyBuiltImageLockstep: (...a: unknown[]) =>
            verifyBuiltImageLockstep(...a),
    };
});

const renderNextAppCR = mock<AnyFn>(() => "kind: NextApp\n");
const resolveDigest = mock<AnyFn>(async () => "reg/my-app@sha256:deadbeef");
const validateCRImageRef = mock<AnyFn>();
mock.module("../cli/cr-builder", () => ({
    renderNextAppCR: (...a: unknown[]) => renderNextAppCR(...a),
    resolveDigest: (...a: unknown[]) => resolveDigest(...a),
    validateCRImageRef: (...a: unknown[]) => validateCRImageRef(...a),
}));

mock.module("../cli/build-artifact", () => ({
    compileArtifactForDeploy: () => ({ compiled: false }),
    assertCompiledArtifactFresh: () => {},
}));

const runAssetGC = mock<AnyFn>(() => ({ pruned: true }));
mock.module("../cli/gc", () => ({
    runAssetGC: (...a: unknown[]) => runAssetGC(...a),
    gcMain: mock(),
}));

mock.module("../cli/schema/kubectl-capture", () => ({
    captureKubectl: () => reconciledNextAppCapture(),
}));

const logInfo = mock<AnyFn>();
mock.module("../utils/logger", () => ({
    createLogger: () => ({
        info: (...a: unknown[]) => logInfo(...a),
        warn: mock(),
        error: mock(),
        debug: mock(),
        fatal: mock(),
        trace: mock(),
    }),
}));

const vinextConfig: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
    build: "vinext",
};

const turbopackConfig: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
};

const loadConfig = mock<AnyFn>(async () => vinextConfig);
const __knextRealShared = { ...(await import("../cli/shared")) };
class MockUsageError extends Error {}
mock.module("../cli/shared", () => ({
    ...__knextRealShared,
    loadConfig: (...a: unknown[]) => loadConfig(...a),
    excerpt: (s: string) => s,
    UsageError: MockUsageError,
    handleUsageError: () => false,
    handleConfigNotFound: () => false,
}));

// Every app in this suite is treated as a readable ESM package (required for
// the vinext leg's ESM preflight); the deploy-tag read still needs a plain
// string.
const fsRead = (p: unknown): string =>
    String(p).endsWith("package.json") ? '{"type":"module"}' : "deploytag";
const readFileSyncMock = mock<(...a: unknown[]) => string>(fsRead);
const __knextReal2 = { ...(await import("node:fs")) };
mock.module("node:fs", async () => {
    const actual = __knextReal2;
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

async function importDeploy(): Promise<() => Promise<void>> {
    const mod = (await import("../cli/deploy")) as {
        deploy: () => Promise<void>;
    };
    return mod.deploy;
}

function setArgv(flags: string[]): void {
    process.argv = ["node", "/path/to/kn-next.js", ...flags];
}

function infoMessages(): string[] {
    return logInfo.mock.calls.map((call) =>
        call
            .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
            .join(" "),
    );
}

const savedArgv = process.argv;
const savedEnv = { ...process.env };

beforeEach(() => {
    jest.clearAllMocks();
    runCapture.mockReturnValue("");
    resolveDigest.mockResolvedValue("reg/my-app@sha256:deadbeef");
    renderNextAppCR.mockReturnValue("kind: NextApp\n");
    runAssetGC.mockReturnValue({ pruned: true });
    readFileSyncMock.mockImplementation(fsRead);
    verifyVinextStaticPrefix.mockReturnValue({
        ok: false,
        reason: "no-static-root",
        siblings: [],
    });
    verifyBuiltImageLockstep.mockReturnValue({ ok: true });
    delete process.env.ASSET_PREFIX;
});

afterEach(() => {
    process.argv = savedArgv;
    process.env = { ...savedEnv };
});

describe("#1506 deploy build-progress log matches the resolved build target", () => {
    it("build: 'vinext' logs vinext wording, never the standalone/next-build wording", async () => {
        loadConfig.mockResolvedValue(vinextConfig);
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();

        const messages = infoMessages();
        expect(messages.some((m) => /running vinext build/i.test(m))).toBe(
            true,
        );
        expect(messages.some((m) => /vinext build complete/i.test(m))).toBe(
            true,
        );
        expect(
            messages.some((m) => /next build \(output:standalone/i.test(m)),
        ).toBe(false);
        expect(
            messages.some((m) =>
                /standalone output in \.next\/standalone/i.test(m),
            ),
        ).toBe(false);

        // The dispatch itself is unaffected by this fix: `npm run build` is
        // still what actually runs (whatever the app's own script does).
        expect(
            runQuiet.mock.calls.some(
                (c) =>
                    JSON.stringify(c[0]) ===
                    JSON.stringify(["npm", "run", "build"]),
            ),
        ).toBe(true);
    });

    it("the default (turbopack) target keeps the original standalone wording — regression pin", async () => {
        loadConfig.mockResolvedValue(turbopackConfig);
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();

        const messages = infoMessages();
        expect(
            messages.some((m) => /next build \(output:standalone/i.test(m)),
        ).toBe(true);
        expect(
            messages.some((m) =>
                /standalone output in \.next\/standalone/i.test(m),
            ),
        ).toBe(true);
        expect(messages.some((m) => /vinext build/i.test(m))).toBe(false);
    });
});
