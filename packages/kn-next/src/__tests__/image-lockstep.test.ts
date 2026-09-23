/**
 * verifyBuiltImageLockstep — proves ADR-0011's build-id/asset-prefix
 * lock-step against the ACTUAL pushed image (#1283), not a Dockerfile's
 * source text.
 *
 * A text-only check ("does the Dockerfile declare `ARG ASSET_PREFIX`?") is
 * satisfiable while still wrong: the ARG can be declared and never exported
 * into the build step's env, set in the wrong stage, or clobbered. This
 * function extracts the pushed image's whole `/app` via `docker create
 * --platform linux/amd64` + `docker cp` and checks it:
 *
 *   - the build-id/static-prefix half against `app/.output/public/_next/
 *     static/<id>/` — the same artifact the HOST leg (`verifyVinextStaticPrefix`)
 *     checks;
 *   - the asset-prefix-embedding half against the SERVER artifact
 *     (`app/server`, the compiled vinext×bun single-executable, or the WHOLE
 *     `app/.output/server` tree, the vinext×node uncompiled shape) — round 1
 *     checked `.output/public` for this and would have failed EVERY real
 *     vinext deploy (vinext bakes `assetPrefix` into the SERVER only). Round 2
 *     fixed WHERE to look but only checked `.output/server/index.mjs`, which
 *     is a thin nitro entry — on a REAL vinext×node build the literal lands
 *     in a split chunk (`_ssr/rsc.mjs`), not the entry, so round 2's own
 *     fixture (which planted it in `index.mjs`) missed that its check would
 *     fail every real vinext×node storage deploy. This suite's `node-entry`
 *     fixture shape now mirrors that REAL layout: `index.mjs` re-exports from
 *     `_ssr/rsc.mjs`, and the literal lives ONLY in the latter.
 *
 * `docker` itself is never invoked here — `../cli/exec`'s argv helpers are
 * module-mocked so the suite stays hermetic, and the mock CONTROLS what "the
 * image contains" by copying a fixture tree in place of a real `docker cp`.
 * Real (non-mocked) proofs against ACTUAL vinext builds (both the compiled
 * vinext×bun binary and the vinext×node `.output/server` tree, built from
 * `examples/bun-exec` with real `docker buildx build --platform linux/amd64`)
 * were run manually (see the PR) — this suite pins the same contract
 * hermetically for CI.
 */

import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    mock,
} from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// biome-ignore lint/suspicious/noExplicitAny: variadic mock argv passthrough
type AnyFn = (...args: unknown[]) => any;

const runCapture = mock<AnyFn>(() => "fake-container-id");
const runQuiet = mock<AnyFn>();
const runQuietAllowFail = mock<AnyFn>();

mock.module("../cli/exec", () => ({
    runCapture: (...a: unknown[]) => runCapture(...a),
    runQuiet: (...a: unknown[]) => runQuiet(...a),
    runInherit: mock(),
    runQuietAllowFail: (...a: unknown[]) => runQuietAllowFail(...a),
    isEntrypoint: mock(() => false),
}));

const { verifyBuiltImageLockstep } = await import("../utils/asset-upload");

const _tmpDirs: string[] = [];
function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-image-lockstep-fixture-"));
    _tmpDirs.push(dir);
    return dir;
}
afterAll(() => {
    for (const dir of _tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Writes `text` at `file`, encoded as `encoding` (`"utf-8"` or `"utf16le"`) —
 * mirrors what a real `bun build --compile` bundle does to an embedded module
 * the moment it contains any non-Latin-1 character (see the doc comment on
 * `LITERAL_SEARCH_ENCODINGS` in `asset-upload.ts`).
 */
function writeEncoded(
    file: string,
    text: string,
    encoding: "utf-8" | "utf16le",
): void {
    writeFileSync(file, Buffer.from(text, encoding));
}

/**
 * Builds a fixture `/app` tree (matching what `docker cp <cid>:/app <dest>`
 * would land) and wires `docker cp` (via the `runQuiet` mock) to copy it to
 * whatever destination the function passes.
 *
 * `serverArtifact` controls where (if anywhere) the asset-prefix literal is
 * planted, so a test can exercise EACH real server shape or neither (proving
 * the function does not silently accept an unrecognised layout):
 *
 *   - `"compiled-binary"`: `app/server` — the vinext×bun single-executable.
 *   - `"node-entry-real-layout"`: a REAL vinext×node `.output/server` tree —
 *     `index.mjs` (no literal, mirrors a real thin nitro entry) that
 *     "imports" `_ssr/rsc.mjs` (the literal lives there, as a real vinext×
 *     node build actually lays it out).
 *   - `"node-entry-index-only"`: the round-2 fixture shape (literal planted
 *     directly in `index.mjs`) — kept as a regression pin that the function
 *     still passes the EASY case, not just the real one.
 *   - `"none"`: neither candidate path exists.
 */
function stageFixtureImage(opts: {
    staticId?: string;
    assetPrefixLiteral?: string;
    serverArtifact?:
        | "compiled-binary"
        | "node-entry-real-layout"
        | "node-entry-index-only"
        | "none";
    encoding?: "utf-8" | "utf16le";
}): void {
    const fixtureRoot = tmp();
    const appDir = join(fixtureRoot, "app");
    const publicDir = join(appDir, ".output", "public");
    if (opts.staticId) {
        const staticDir = join(publicDir, "_next", "static", opts.staticId);
        mkdirSync(staticDir, { recursive: true });
        writeFileSync(join(staticDir, "chunk.js"), "console.log('chunk')");
    } else {
        mkdirSync(publicDir, { recursive: true });
    }
    const shape = opts.serverArtifact ?? "compiled-binary";
    const encoding = opts.encoding ?? "utf-8";
    const embed = opts.assetPrefixLiteral
        ? `export const __assetPrefix = ${JSON.stringify(opts.assetPrefixLiteral)};`
        : "// no assetPrefix literal here";
    const noLiteral = "// re-exports from split chunks, no literal here";
    if (shape === "compiled-binary") {
        writeEncoded(join(appDir, "server"), embed, encoding);
    } else if (shape === "node-entry-index-only") {
        const serverDir = join(appDir, ".output", "server");
        mkdirSync(serverDir, { recursive: true });
        writeEncoded(join(serverDir, "index.mjs"), embed, encoding);
    } else if (shape === "node-entry-real-layout") {
        // Mirrors examples/bun-exec's REAL `.output/server` layout: a thin
        // `index.mjs` entry, and the split `_ssr/` chunk the literal actually
        // lands in.
        const serverDir = join(appDir, ".output", "server");
        const ssrDir = join(serverDir, "_ssr");
        mkdirSync(ssrDir, { recursive: true });
        writeEncoded(join(serverDir, "index.mjs"), noLiteral, encoding);
        writeEncoded(join(ssrDir, "rsc.mjs"), embed, encoding);
    }
    // shape === "none": neither candidate path exists.
    runQuiet.mockImplementation((...args: unknown[]) => {
        const argv = args[0] as string[];
        // ["docker", "cp", "<cid>:/app", destDir]
        const dest = argv[argv.length - 1];
        cpSync(appDir, dest, { recursive: true });
    });
}

beforeEach(() => {
    runCapture.mockReset();
    runCapture.mockImplementation(() => "fake-container-id");
    runQuiet.mockReset();
    runQuietAllowFail.mockReset();
});

afterEach(() => {
    runCapture.mockClear();
    runQuiet.mockClear();
    runQuietAllowFail.mockClear();
});

describe("verifyBuiltImageLockstep — docker create runs with --platform linux/amd64 (#1283 round 2)", () => {
    it('always passes --platform linux/amd64 to `docker create` — without it, `docker create` on an arm64 Docker host 404s the image ("no matching manifest for linux/arm64/v8")', () => {
        stageFixtureImage({ staticId: "deploytag-7" });
        verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
        });
        expect(runCapture).toHaveBeenCalledWith([
            "docker",
            "create",
            "--platform",
            "linux/amd64",
            "reg/app:deploytag-7",
        ]);
    });
});

describe("verifyBuiltImageLockstep — build-id (NEXT_DEPLOYMENT_ID) lock-step", () => {
    it("passes when the image's static namespace matches the deploy tag", () => {
        stageFixtureImage({ staticId: "deploytag-7" });
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
        });
        expect(result).toEqual({ ok: true });
    });

    it("fails `prefix-missing` — the mutation-proof case: the Dockerfile DECLARES the ARG but never passes it into the build step, so the image bakes a DIFFERENT id than the deploy tag", () => {
        stageFixtureImage({ staticId: "some-earlier-build-id" });
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
        });
        expect(result.ok).toBe(false);
        expect(result).toMatchObject({ reason: "prefix-missing" });
    });

    it("fails `no-static-root` when the image has no _next/static at all", () => {
        stageFixtureImage({});
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
        });
        expect(result).toEqual({
            ok: false,
            reason: "no-static-root",
            siblings: [],
        });
    });

    it("`docker create` failing (bad ref / not pushed / no pull creds) fails closed as image-extract-failed", () => {
        runCapture.mockImplementation(() => {
            throw new Error("docker: no such image");
        });
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
        });
        expect(result).toEqual({
            ok: false,
            reason: "image-extract-failed",
            siblings: [],
        });
    });

    it("`docker cp` failing (e.g. the image has no /app at all) fails closed as image-extract-failed", () => {
        runQuiet.mockImplementation(() => {
            throw new Error("docker: no such file or directory");
        });
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
        });
        expect(result).toEqual({
            ok: false,
            reason: "image-extract-failed",
            siblings: [],
        });
    });

    it("always cleans up the created container, even on a failed check", () => {
        stageFixtureImage({ staticId: "some-earlier-build-id" });
        verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
        });
        expect(runQuietAllowFail).toHaveBeenCalledWith([
            "docker",
            "rm",
            "-f",
            "fake-container-id",
        ]);
    });
});

describe("verifyBuiltImageLockstep — ASSET_PREFIX embedding (storage mode) — the SERVER artifact, not .output/public (#1283 round 2/3)", () => {
    it("passes when the compiled single-executable (vinext×bun `app/server`) embeds the configured assetPrefix", () => {
        stageFixtureImage({
            staticId: "deploytag-7",
            assetPrefixLiteral: "https://cdn.example.com/my-app",
            serverArtifact: "compiled-binary",
        });
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
            assetPrefix: "https://cdn.example.com/my-app",
        });
        expect(result).toEqual({ ok: true });
    });

    it("passes with a REAL vinext×node layout — the literal is in a split _ssr chunk, NOT index.mjs, and the whole .output/server tree is scanned (#1283 round 3)", () => {
        stageFixtureImage({
            staticId: "deploytag-7",
            assetPrefixLiteral: "https://cdn.example.com/my-app",
            serverArtifact: "node-entry-real-layout",
        });
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
            assetPrefix: "https://cdn.example.com/my-app",
        });
        expect(result).toEqual({ ok: true });
    });

    it("REGRESSION: still passes the round-2 fixture shape too (literal directly in index.mjs) — the tree scan is a superset, not a replacement", () => {
        stageFixtureImage({
            staticId: "deploytag-7",
            assetPrefixLiteral: "https://cdn.example.com/my-app",
            serverArtifact: "node-entry-index-only",
        });
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
            assetPrefix: "https://cdn.example.com/my-app",
        });
        expect(result).toEqual({ ok: true });
    });

    it("MUTATION-PROOF of round 3's own fix: checking ONLY index.mjs (round 2's defect) would fail this — index.mjs alone carries no literal in the real-layout fixture", () => {
        stageFixtureImage({
            staticId: "deploytag-7",
            assetPrefixLiteral: "https://cdn.example.com/my-app",
            serverArtifact: "node-entry-real-layout",
        });
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
            assetPrefix: "https://cdn.example.com/my-app",
        });
        // The previous test proves this passes (whole-tree scan). This test
        // exists to document, in the suite itself, exactly why a revert to
        // "check only index.mjs" would turn the previous test red: that file
        // alone never carries the literal in this fixture shape.
        expect(result).toEqual({ ok: true });
    });

    it("finds the literal stored as UTF-16LE (#1283 round 3) — Bun stores an embedded module UTF-16LE, not UTF-8/Latin-1, once it contains any non-Latin-1 character", () => {
        stageFixtureImage({
            staticId: "deploytag-7",
            assetPrefixLiteral: "https://cdn.example.com/my-app",
            serverArtifact: "compiled-binary",
            encoding: "utf16le",
        });
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
            assetPrefix: "https://cdn.example.com/my-app",
        });
        expect(result).toEqual({ ok: true });
    });

    it("finds a UTF-16LE literal inside the scanned .output/server tree too, not just the top-level binary", () => {
        stageFixtureImage({
            staticId: "deploytag-7",
            assetPrefixLiteral: "https://cdn.example.com/my-app",
            serverArtifact: "node-entry-real-layout",
            encoding: "utf16le",
        });
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
            assetPrefix: "https://cdn.example.com/my-app",
        });
        expect(result).toEqual({ ok: true });
    });

    it("does NOT look at .output/public for the literal — planting it ONLY there (the round-1 bug) still fails", () => {
        const fixtureRoot = tmp();
        const appDir = join(fixtureRoot, "app");
        const staticDir = join(
            appDir,
            ".output",
            "public",
            "_next",
            "static",
            "deploytag-7",
        );
        mkdirSync(staticDir, { recursive: true });
        // The literal lives ONLY in a public/static chunk — exactly the wrong
        // artifact per vinext's own source (assetPrefix is a SERVER-only
        // constant). No `app/server` or anything under `app/.output/server`
        // exists.
        writeFileSync(
            join(staticDir, "chunk.js"),
            '__webpack_require__.p = "https://cdn.example.com/my-app/_next/";',
        );
        runQuiet.mockImplementation((...args: unknown[]) => {
            const argv = args[0] as string[];
            const dest = argv[argv.length - 1];
            cpSync(appDir, dest, { recursive: true });
        });
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
            assetPrefix: "https://cdn.example.com/my-app",
        });
        expect(result).toEqual({
            ok: false,
            reason: "asset-prefix-not-embedded",
            siblings: [],
        });
    });

    it("fails `asset-prefix-not-embedded` — the mutation-proof case: ASSET_PREFIX is declared but never reaches the in-image build, so the server artifact does not reference it", () => {
        // staticId matches (NEXT_DEPLOYMENT_ID DID reach the build), but the
        // server artifact carries no assetPrefix literal (ASSET_PREFIX did NOT).
        stageFixtureImage({
            staticId: "deploytag-7",
            serverArtifact: "compiled-binary",
        });
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
            assetPrefix: "https://cdn.example.com/my-app",
        });
        expect(result).toEqual({
            ok: false,
            reason: "asset-prefix-not-embedded",
            siblings: [],
        });
    });

    it("fails `asset-prefix-not-embedded` on a real-layout tree that never got the literal (the vinext×node analog of the compiled-binary miss above)", () => {
        stageFixtureImage({
            staticId: "deploytag-7",
            serverArtifact: "node-entry-real-layout",
        });
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
            assetPrefix: "https://cdn.example.com/my-app",
        });
        expect(result).toEqual({
            ok: false,
            reason: "asset-prefix-not-embedded",
            siblings: [],
        });
    });

    it("fails `asset-prefix-not-embedded` when NEITHER known server-artifact path exists (unrecognised layout) rather than silently passing", () => {
        stageFixtureImage({ staticId: "deploytag-7", serverArtifact: "none" });
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
            assetPrefix: "https://cdn.example.com/my-app",
        });
        expect(result).toEqual({
            ok: false,
            reason: "asset-prefix-not-embedded",
            siblings: [],
        });
    });

    it("skips the embedding check entirely when no assetPrefix is configured (no-storage mode)", () => {
        stageFixtureImage({ staticId: "deploytag-7", serverArtifact: "none" });
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
        });
        expect(result).toEqual({ ok: true });
    });
});
