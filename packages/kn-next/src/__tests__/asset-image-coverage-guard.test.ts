/**
 * asset-image-coverage-guard — #1447. The uploaded asset set must cover every
 * client chunk the image's server output references. Real filesystem fixtures:
 * the guard's whole job is reading bytes, so nothing is mocked.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyAssetsCoverServerReferences } from "../utils/asset-upload";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function app(opts: {
    uploaded: string[];
    server?: { path: string; body: string | Buffer };
}): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-guard-"));
    dirs.push(dir);
    for (const f of opts.uploaded) {
        const p = join(dir, ".output/public/_next/static/chunks", f);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, "//");
    }
    if (opts.server) {
        const p = join(dir, opts.server.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, opts.server.body);
    }
    return dir;
}

const SERVER = ".output/server/_ssr/rsc.mjs";

describe("verifyAssetsCoverServerReferences (#1447)", () => {
    it("ok when every referenced chunk was uploaded", () => {
        const d = app({
            uploaded: ["vinext-AAA.js", "framework-BBB.js"],
            server: {
                path: SERVER,
                body: 'x="chunks/vinext-AAA.js";y="chunks/framework-BBB.js"',
            },
        });
        expect(verifyAssetsCoverServerReferences(d)).toEqual({
            ok: true,
            referenced: 2,
        });
    });

    it("FAILS on the reported shape: image references vinext-B, bucket holds vinext-A", () => {
        const d = app({
            uploaded: ["vinext-AAA.js", "framework-BBB.js"],
            server: {
                path: SERVER,
                body: 'x="chunks/vinext-CCC.js";y="chunks/framework-BBB.js"',
            },
        });
        expect(verifyAssetsCoverServerReferences(d)).toEqual({
            ok: false,
            reason: "chunk-missing",
            missing: ["vinext-CCC.js"],
        });
    });

    it("reads a compiled server binary in UTF-16LE (Bun's encoding for non-Latin-1 modules)", () => {
        const d = app({
            uploaded: ["vinext-AAA.js"],
            server: {
                path: "server",
                body: Buffer.concat([
                    Buffer.from([0, 1, 2]),
                    Buffer.from("chunks/vinext-ZZZ.js", "utf16le"),
                ]),
            },
        });
        expect(verifyAssetsCoverServerReferences(d)).toMatchObject({
            ok: false,
            reason: "chunk-missing",
            missing: ["vinext-ZZZ.js"],
        });
    });

    it("fails closed when there is no server artifact", () => {
        const d = app({ uploaded: ["vinext-AAA.js"] });
        expect(verifyAssetsCoverServerReferences(d)).toMatchObject({
            ok: false,
            reason: "server-artifact-missing",
        });
    });

    it("fails closed when the server references no chunk at all (cannot observe != pass)", () => {
        const d = app({
            uploaded: ["vinext-AAA.js"],
            server: { path: SERVER, body: "nothing to see" },
        });
        expect(verifyAssetsCoverServerReferences(d)).toMatchObject({
            ok: false,
            reason: "no-chunk-references",
        });
    });
});
