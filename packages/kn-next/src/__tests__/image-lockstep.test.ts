/**
 * verifyBuiltImageLockstep — proves ADR-0011's build-id/asset-prefix
 * lock-step against the ACTUAL pushed image (#1283), not a Dockerfile's
 * source text.
 *
 * A text-only check ("does the Dockerfile declare `ARG ASSET_PREFIX`?") is
 * satisfiable while still wrong: the ARG can be declared and never exported
 * into the build step's env, set in the wrong stage, or clobbered. This
 * function extracts the pushed image's own `/app/.output/public` via
 * `docker create` + `docker cp` and checks it the same way the HOST leg
 * (`verifyVinextStaticPrefix`) checks `.output`. `docker` itself is never
 * invoked here — `../cli/exec`'s argv helpers are module-mocked so the suite
 * stays hermetic, and the mock CONTROLS what "the image contains" by copying
 * a fixture tree in place of a real `docker cp`.
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

/** Builds a fixture `.output/public` tree and wires `docker cp` (via the
 * `runQuiet` mock) to copy it to whatever destination the function passes. */
function stageFixtureImage(opts: {
    staticId?: string;
    assetPrefixLiteral?: string;
}): void {
    const fixtureRoot = tmp();
    const publicDir = join(fixtureRoot, "public");
    if (opts.staticId) {
        const staticDir = join(publicDir, "_next", "static", opts.staticId);
        mkdirSync(staticDir, { recursive: true });
        writeFileSync(
            join(staticDir, "chunk.js"),
            opts.assetPrefixLiteral
                ? `__webpack_require__.p = ${JSON.stringify(
                      `${opts.assetPrefixLiteral}/_next/`,
                  )};`
                : "console.log('chunk')",
        );
    } else {
        // no static root at all
        mkdirSync(publicDir, { recursive: true });
    }
    runQuiet.mockImplementation((...args: unknown[]) => {
        const argv = args[0] as string[];
        // ["docker", "cp", "<cid>:/app/.output/public", destDir]
        const dest = argv[argv.length - 1];
        cpSync(publicDir, dest, { recursive: true });
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

    it("`docker cp` failing (e.g. the app-dockerfile recipe uses a non-standard path) fails closed as image-extract-failed", () => {
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

describe("verifyBuiltImageLockstep — ASSET_PREFIX embedding (storage mode)", () => {
    it("passes when a built file literally embeds the configured assetPrefix", () => {
        stageFixtureImage({
            staticId: "deploytag-7",
            assetPrefixLiteral: "https://cdn.example.com/my-app",
        });
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
            assetPrefix: "https://cdn.example.com/my-app",
        });
        expect(result).toEqual({ ok: true });
    });

    it("fails `asset-prefix-not-embedded` — the mutation-proof case: ASSET_PREFIX is declared but never reaches the in-image build, so nothing in the output references it", () => {
        // staticId matches (NEXT_DEPLOYMENT_ID DID reach the build), but no
        // file embeds the configured bucket URL (ASSET_PREFIX did NOT).
        stageFixtureImage({ staticId: "deploytag-7" });
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
        stageFixtureImage({ staticId: "deploytag-7" });
        const result = verifyBuiltImageLockstep({
            taggedRef: "reg/app:deploytag-7",
            expectedId: "deploytag-7",
        });
        expect(result).toEqual({ ok: true });
    });
});
