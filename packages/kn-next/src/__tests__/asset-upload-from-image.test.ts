/**
 * asset-upload-from-image — #1447. `uploadAssetsFromImage` extracts `/app` from
 * the image, proves the assets cover the server's chunk references, and only
 * then uploads FROM THE EXTRACTED TREE. Only `../cli/exec` (docker) is mocked;
 * `docker cp` is simulated by materialising a fixture `/app` at the destination.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnativeNextConfig } from "../config";

// biome-ignore lint/suspicious/noExplicitAny: mock plumbing
type AnyFn = (...args: unknown[]) => any;
const state = {
    uploaded: ["vinext-AAA.js"],
    server: 'x="chunks/vinext-AAA.js"',
};
const runCapture = mock<AnyFn>(() => "cid123");
const runQuiet = mock<AnyFn>((argv: unknown) => {
    const a = argv as string[];
    if (a[1] !== "cp") return;
    const dest = a[3];
    for (const f of state.uploaded) {
        const p = join(dest, ".output/public/_next/static/chunks");
        mkdirSync(p, { recursive: true });
        writeFileSync(join(p, f), "//");
    }
    mkdirSync(join(dest, ".output/server"), { recursive: true });
    writeFileSync(join(dest, ".output/server/index.mjs"), state.server);
});
const runQuietAllowFail = mock<AnyFn>();
mock.module("../cli/exec", () => ({
    runCapture: (...a: unknown[]) => runCapture(...a),
    runQuiet: (...a: unknown[]) => runQuiet(...a),
    runQuietAllowFail: (...a: unknown[]) => runQuietAllowFail(...a),
    runInherit: mock(),
    isEntrypoint: () => false,
}));

const { uploadAssetsFromImage } = await import("../utils/asset-upload");
const config = { name: "a" } as unknown as KnativeNextConfig & {
    storage: never;
};

beforeEach(() => {
    state.uploaded = ["vinext-AAA.js"];
    state.server = 'x="chunks/vinext-AAA.js"';
    runCapture.mockClear();
    runQuietAllowFail.mockClear();
});

describe("uploadAssetsFromImage (#1447)", () => {
    it("uploads from the EXTRACTED image tree when the chunks match", async () => {
        const upload = mock<AnyFn>(async () => {});
        await uploadAssetsFromImage(config, "t1", "reg/app:t1", {
            upload: upload as never,
        });
        expect(upload).toHaveBeenCalledTimes(1);
        const opts = upload.mock.calls[0]?.[2] as { cwd: string };
        expect(opts.cwd).toContain("knext-image-assets-");
        expect(runQuietAllowFail).toHaveBeenCalled(); // container removed
    });

    it("extracts with `docker create --platform linux/amd64`", async () => {
        const upload = mock<AnyFn>(async () => {});
        await uploadAssetsFromImage(config, "t1", "reg/app:t1", {
            upload: upload as never,
        });
        expect(runCapture.mock.calls[0]?.[0]).toEqual([
            "docker",
            "create",
            "--platform",
            "linux/amd64",
            "reg/app:t1",
        ]);
    });

    it("REFUSES to upload when the image references a chunk its assets lack", async () => {
        state.server = 'x="chunks/vinext-BBB.js"';
        const upload = mock<AnyFn>(async () => {});
        await expect(
            uploadAssetsFromImage(config, "t1", "reg/app:t1", {
                upload: upload as never,
            }),
        ).rejects.toThrow(/vinext-BBB\.js/);
        expect(upload).not.toHaveBeenCalled();
    });

    it("verify:false (the --skip-image-lockstep-check opt-out) still uploads from the image but skips the cross-check", async () => {
        state.server = 'x="chunks/vinext-BBB.js"';
        const upload = mock<AnyFn>(async () => {});
        await uploadAssetsFromImage(config, "t1", "reg/app:t1", {
            verify: false,
            upload: upload as never,
        });
        expect(upload).toHaveBeenCalledTimes(1);
    });

    it("fails when the image cannot be extracted", async () => {
        runCapture.mockImplementationOnce(() => {
            throw new Error("docker create failed");
        });
        const upload = mock<AnyFn>(async () => {});
        await expect(
            uploadAssetsFromImage(config, "t1", "reg/app:t1", {
                upload: upload as never,
            }),
        ).rejects.toThrow(/could not extract/);
        expect(upload).not.toHaveBeenCalled();
    });
});
