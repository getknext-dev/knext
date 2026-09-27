/**
 * #1460 — the self-contained sharp extractor and its lazy loader.
 *
 * `extractEmbeddedNative` unpacks the native tree a self-contained binary
 * embeds; inside the binary its `path`s are `$bunfs` paths, here they are real
 * files, which is the same `readFileSync` contract.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    extractEmbeddedNative,
    lazySharp,
} from "../adapters/sharp-native-extract.mjs";

const temps: string[] = [];
afterAll(() => {
    for (const d of temps) {
        try {
            chmodSync(d, 0o755);
        } catch {}
        rmSync(d, { recursive: true, force: true });
    }
});
function temp(prefix: string): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    temps.push(d);
    return d;
}

/** An embedded-tree stand-in: sources on disk, listed as `{ rel, path }`. */
function tree(files: Record<string, string>): { rel: string; path: string }[] {
    const src = temp("knext-1460-src-");
    return Object.entries(files).map(([rel, body]) => {
        const path = join(src, rel);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body);
        return { rel, path };
    });
}

const LAYOUT = {
    "sharp-linux-x64/lib/sharp-linux-x64.node": "ADDON",
    "sharp-libvips-linux-x64/lib/libvips-cpp.so.42": "LIBVIPS",
    ".integrity.json": '{"version":1}',
};

describe("extractEmbeddedNative", () => {
    it("unpacks every file with its relative layout, into a private directory", () => {
        const tmpRoot = temp("knext-1460-tmp-");
        const out = extractEmbeddedNative({ files: tree(LAYOUT), tmpRoot });
        expect(out.extracted).toBe(3);
        expect(out.reused).toBe(0);
        expect(dirname(out.root)).toBe(tmpRoot);
        for (const [rel, body] of Object.entries(LAYOUT)) {
            expect(readFileSync(join(out.root, rel), "utf8")).toBe(body);
        }
        expect(statSync(out.root).mode & 0o077).toBe(0);
    });

    it("the second call reuses the unpacked tree instead of rewriting it", () => {
        const tmpRoot = temp("knext-1460-tmp-");
        const files = tree(LAYOUT);
        const first = extractEmbeddedNative({ files, tmpRoot });
        const second = extractEmbeddedNative({ files, tmpRoot });
        expect(second.root).toBe(first.root);
        expect(second).toMatchObject({ extracted: 0, reused: 3 });
    });

    it("a tampered file is rewritten from the embedded bytes, never trusted", () => {
        const tmpRoot = temp("knext-1460-tmp-");
        const files = tree(LAYOUT);
        const { root } = extractEmbeddedNative({ files, tmpRoot });
        const lib = join(root, "sharp-libvips-linux-x64/lib/libvips-cpp.so.42");
        writeFileSync(lib, "LIBVIPZ"); // same length, different bytes
        const again = extractEmbeddedNative({ files, tmpRoot });
        expect(again).toMatchObject({ extracted: 1, reused: 2 });
        expect(readFileSync(lib, "utf8")).toBe("LIBVIPS");
    });

    it("a different embedded tree gets a different directory (content-addressed)", () => {
        const tmpRoot = temp("knext-1460-tmp-");
        const a = extractEmbeddedNative({ files: tree(LAYOUT), tmpRoot });
        const b = extractEmbeddedNative({
            files: tree({
                ...LAYOUT,
                ".integrity.json": '{"version":1,"x":1}',
            }),
            tmpRoot,
        });
        expect(b.root).not.toBe(a.root);
    });

    it("an unwritable temp root is a clear error naming the fix — thrown, not a hang", () => {
        const tmpRoot = temp("knext-1460-ro-");
        chmodSync(tmpRoot, 0o555);
        const started = performance.now();
        expect(() =>
            extractEmbeddedNative({ files: tree(LAYOUT), tmpRoot }),
        ).toThrow(
            /could not unpack sharp's native libraries[\s\S]*WRITABLE[\s\S]*emptyDir[\s\S]*underlying error: E(ACCES|ROFS|PERM)/,
        );
        expect(performance.now() - started).toBeLessThan(5_000);
        expect(readdirSync(tmpRoot)).toEqual([]);
    });

    it("refuses a pre-existing extraction directory other users can write", () => {
        const tmpRoot = temp("knext-1460-tmp-");
        const files = tree(LAYOUT);
        const { root } = extractEmbeddedNative({ files, tmpRoot });
        chmodSync(root, 0o777);
        expect(() => extractEmbeddedNative({ files, tmpRoot })).toThrow(
            /refusing to extract .* writable by other users/,
        );
    });

    it("refuses a relpath that escapes the root", () => {
        const tmpRoot = temp("knext-1460-tmp-");
        const [file] = tree({ "a.node": "A" });
        expect(() =>
            extractEmbeddedNative({
                files: [{ rel: "../escape.node", path: file.path }],
                tmpRoot,
            }),
        ).toThrow(/escapes the native root/);
        expect(existsSync(join(tmpRoot, "..", "escape.node"))).toBe(false);
    });

    it("an empty embedded tree is an error, not a silent no-op", () => {
        expect(() =>
            extractEmbeddedNative({
                files: [],
                tmpRoot: temp("knext-1460-tmp-"),
            }),
        ).toThrow(/embeds no native tree/);
    });
});

describe("lazySharp", () => {
    it("does not load at construction — only on first use", () => {
        let loads = 0;
        const real = Object.assign((n: number) => n * 2, { cache: "c" });
        const s = lazySharp(() => {
            loads++;
            return real;
        }) as unknown as typeof real;
        expect(loads).toBe(0);
        expect(s(21)).toBe(42);
        expect(s.cache).toBe("c");
        expect(s(1)).toBe(2);
        expect(loads).toBe(1);
    });

    it("a property read is a use (sharp's statics load it too)", () => {
        let loads = 0;
        const s = lazySharp(() => {
            loads++;
            return Object.assign(() => 0, { versions: { vips: "8" } });
        }) as unknown as { versions: { vips: string } };
        expect(s.versions.vips).toBe("8");
        expect(loads).toBe(1);
    });

    it("`new` reaches the real constructor", () => {
        class Real {
            v = 7;
        }
        const S = lazySharp(() => Real) as unknown as typeof Real;
        expect(new S().v).toBe(7);
        expect(new S()).toBeInstanceOf(Real);
    });

    it("a load failure is remembered: every later use rethrows the SAME cause", () => {
        let loads = 0;
        const s = lazySharp(() => {
            loads++;
            throw new Error(
                "knext: could not unpack sharp's native libraries to /x",
            );
        }) as unknown as () => void;
        expect(() => s()).toThrow(/could not unpack/);
        expect(() => s()).toThrow(/could not unpack/);
        expect(loads).toBe(1);
    });

    it("a load that yields a non-function is refused, not called", () => {
        const s = lazySharp(
            () => ({}) as unknown as () => void,
        ) as unknown as () => void;
        expect(() => s()).toThrow(/sharp loaded as object, not a function/);
    });
});
