/**
 * The opt-in patched Bun toolchain (`compile: { bun: 'knext-patched' }`).
 *
 * Supply-chain contract under test: the binary is fetched from a pinned
 * release asset, checked against a sha256 EMBEDDED in knext, and refused —
 * never run, never cached, never silently swapped for stock Bun — when that
 * check fails. The default (no `compile`, or `bun: 'stock'`) touches nothing:
 * no fetch, no cache, plain `bun` on PATH, exactly as before.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    parseIncludeJson,
    userIncludePart,
} from "../adapters/compile-embed.mjs";
import {
    type BunToolchainPins,
    ensurePatchedBun,
    PATCHED_BUN,
    PATCHED_BUN_SIGNER,
    patchedBunCacheDir,
    patchedBunPlatformKey,
    resolveCompileBun,
    validateCompileConfig,
} from "../cli/bun-toolchain";
import { UsageError } from "../cli/shared";
import { standaloneCompileArgv } from "../cli/standalone-exec-build";
import { compileArgv } from "../cli/vinext-build";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const GOOD = new TextEncoder().encode("#!/bin/sh\necho patched-bun\n");
const EVIL = new TextEncoder().encode("#!/bin/sh\necho something-else\n");

function pins(digest = sha(GOOD)): BunToolchainPins {
    return {
        tag: "bun-patched-test",
        bunVersion: "1.4.2",
        baseUrl: "https://example.invalid/releases/download/bun-patched-test",
        assets: {
            "linux-x64": { file: "bun-linux-x64", sha256: digest },
        },
    };
}

const LINUX_X64 = { platform: "linux", arch: "x64", libc: "gnu" } as const;

/** A fetch double that records calls and serves fixed bytes (or a status). */
function fakeFetch(body: Uint8Array | null, status = 200) {
    const calls: string[] = [];
    const fn = async (url: string) => {
        calls.push(url);
        return {
            ok: status >= 200 && status < 300,
            status,
            arrayBuffer: async () =>
                (body ?? new Uint8Array()).slice().buffer as ArrayBuffer,
        };
    };
    return { fn, calls };
}

const created: string[] = [];
const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "knext-bun-toolchain-"));
    created.push(d);
    return d;
};
afterAll(() => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
});

describe("default stays stock Bun", () => {
    it("no compile block → plain `bun`, no fetch", async () => {
        const f = fakeFetch(GOOD);
        const r = await resolveCompileBun({}, { fetch: f.fn, host: LINUX_X64 });
        expect(r).toEqual({ id: "stock", bin: "bun" });
        expect(f.calls).toEqual([]);
    });

    it("compile.bun: 'stock' → plain `bun`, no fetch", async () => {
        const f = fakeFetch(GOOD);
        const r = await resolveCompileBun(
            { compile: { bun: "stock" } },
            { fetch: f.fn, host: LINUX_X64 },
        );
        expect(r).toEqual({ id: "stock", bin: "bun" });
        expect(f.calls).toEqual([]);
    });
});

describe("platform support", () => {
    it.each([
        ["linux", "x64", "gnu", "linux-x64"],
        ["linux", "arm64", "gnu", "linux-arm64"],
        ["linux", "x64", "musl", undefined],
        ["darwin", "arm64", "gnu", undefined],
        ["win32", "x64", "gnu", undefined],
    ] as const)("%s/%s/%s → %s", (platform, arch, libc, want) => {
        expect(patchedBunPlatformKey({ platform, arch, libc })).toBe(want);
    });

    it("opt-in on an unsupported host fails with a clear message, no fetch", async () => {
        const f = fakeFetch(GOOD);
        const err = await ensurePatchedBun({
            fetch: f.fn,
            host: { platform: "darwin", arch: "arm64", libc: "gnu" },
            cacheDir: tmp(),
            pins: pins(),
        }).catch((e) => e);
        expect(err).toBeInstanceOf(UsageError);
        expect(String(err.message)).toContain("darwin-arm64");
        expect(String(err.message)).toContain("compile.bun");
        expect(f.calls).toEqual([]);
    });

    it("a supported key with no pinned asset is refused, not guessed", async () => {
        const f = fakeFetch(GOOD);
        const err = await ensurePatchedBun({
            fetch: f.fn,
            host: { platform: "linux", arch: "arm64", libc: "gnu" },
            cacheDir: tmp(),
            pins: pins(), // only linux-x64 pinned
        }).catch((e) => e);
        expect(err).toBeInstanceOf(UsageError);
        expect(f.calls).toEqual([]);
    });
});

describe("download + verify", () => {
    it("downloads the pinned asset, verifies it, caches it executable", async () => {
        const dir = tmp();
        const f = fakeFetch(GOOD);
        const p = await ensurePatchedBun({
            fetch: f.fn,
            host: LINUX_X64,
            cacheDir: dir,
            pins: pins(),
        });
        expect(f.calls).toEqual([
            "https://example.invalid/releases/download/bun-patched-test/bun-linux-x64",
        ]);
        expect(p.startsWith(dir)).toBe(true);
        expect(sha(readFileSync(p))).toBe(sha(GOOD));
        expect(statSync(p).mode & 0o111).not.toBe(0);
    });

    it("CHECKSUM MISMATCH fails closed: throws, caches nothing, no stock fallback", async () => {
        const dir = tmp();
        const f = fakeFetch(EVIL);
        const err = await ensurePatchedBun({
            fetch: f.fn,
            host: LINUX_X64,
            cacheDir: dir,
            pins: pins(),
        }).catch((e) => e);
        expect(err).toBeInstanceOf(UsageError);
        expect(String(err.message)).toContain("sha256 mismatch");
        expect(String(err.message)).toContain(sha(EVIL));
        // Nothing usable is left behind: no binary, no temp file.
        expect(readdirSync(dir).filter((n) => !n.startsWith("."))).toEqual([]);
        expect(readdirSync(dir)).toEqual([]);
    });

    it("checksum mismatch through resolveCompileBun never returns stock `bun`", async () => {
        const f = fakeFetch(EVIL);
        const err = await resolveCompileBun(
            { compile: { bun: "knext-patched" } },
            { fetch: f.fn, host: LINUX_X64, cacheDir: tmp(), pins: pins() },
        ).catch((e) => e);
        expect(err).toBeInstanceOf(UsageError);
    });

    it("a valid cached binary is reused without a fetch", async () => {
        const dir = tmp();
        await ensurePatchedBun({
            fetch: fakeFetch(GOOD).fn,
            host: LINUX_X64,
            cacheDir: dir,
            pins: pins(),
        });
        const f = fakeFetch(GOOD);
        const p = await ensurePatchedBun({
            fetch: f.fn,
            host: LINUX_X64,
            cacheDir: dir,
            pins: pins(),
        });
        expect(f.calls).toEqual([]);
        expect(sha(readFileSync(p))).toBe(sha(GOOD));
    });

    it("a tampered cached binary is NOT trusted: re-downloaded and re-verified", async () => {
        const dir = tmp();
        const p = await ensurePatchedBun({
            fetch: fakeFetch(GOOD).fn,
            host: LINUX_X64,
            cacheDir: dir,
            pins: pins(),
        });
        writeFileSync(p, EVIL);
        const f = fakeFetch(GOOD);
        const again = await ensurePatchedBun({
            fetch: f.fn,
            host: LINUX_X64,
            cacheDir: dir,
            pins: pins(),
        });
        expect(f.calls.length).toBe(1);
        expect(sha(readFileSync(again))).toBe(sha(GOOD));
    });

    it("a tampered cache AND a bad download fails closed and removes the tampered file", async () => {
        const dir = tmp();
        const p = await ensurePatchedBun({
            fetch: fakeFetch(GOOD).fn,
            host: LINUX_X64,
            cacheDir: dir,
            pins: pins(),
        });
        writeFileSync(p, EVIL);
        const err = await ensurePatchedBun({
            fetch: fakeFetch(EVIL).fn,
            host: LINUX_X64,
            cacheDir: dir,
            pins: pins(),
        }).catch((e) => e);
        expect(err).toBeInstanceOf(UsageError);
        expect(existsSync(p)).toBe(false);
    });

    it("an HTTP failure fails closed with the URL and status", async () => {
        const err = await ensurePatchedBun({
            fetch: fakeFetch(null, 404).fn,
            host: LINUX_X64,
            cacheDir: tmp(),
            pins: pins(),
        }).catch((e) => e);
        expect(err).toBeInstanceOf(UsageError);
        expect(String(err.message)).toContain("404");
        expect(String(err.message)).toContain("bun-linux-x64");
    });

    it("a network error fails closed", async () => {
        const err = await ensurePatchedBun({
            fetch: async () => {
                throw new Error("ECONNRESET");
            },
            host: LINUX_X64,
            cacheDir: tmp(),
            pins: pins(),
        }).catch((e) => e);
        expect(err).toBeInstanceOf(UsageError);
        expect(String(err.message)).toContain("ECONNRESET");
    });

    it("resolveCompileBun returns the verified path for the opt-in", async () => {
        const r = await resolveCompileBun(
            { compile: { bun: "knext-patched" } },
            {
                fetch: fakeFetch(GOOD).fn,
                host: LINUX_X64,
                cacheDir: tmp(),
                pins: pins(),
            },
        );
        expect(r.id).toBe("knext-patched");
        expect(sha(readFileSync(r.bin))).toBe(sha(GOOD));
    });
});

describe("cache dir", () => {
    it("KNEXT_CACHE_DIR wins, then XDG_CACHE_HOME, then ~/.cache; keyed by the release tag", () => {
        expect(
            patchedBunCacheDir({ KNEXT_CACHE_DIR: "/k" }, "/home/u", "t1"),
        ).toBe("/k/bun-patched/t1");
        expect(
            patchedBunCacheDir({ XDG_CACHE_HOME: "/x" }, "/home/u", "t1"),
        ).toBe("/x/knext/bun-patched/t1");
        expect(patchedBunCacheDir({}, "/home/u", "t1")).toBe(
            "/home/u/.cache/knext/bun-patched/t1",
        );
    });
});

describe("the embedded pins", () => {
    it("pin a 1.4.2-based release with a 64-hex sha256 per supported platform", () => {
        expect(PATCHED_BUN.bunVersion).toBe("1.4.2");
        expect(PATCHED_BUN.tag).toMatch(/^bun-patched-1\.4\.2-knext\.\d+$/);
        expect(PATCHED_BUN.baseUrl).toBe(
            `https://github.com/getknext-dev/knext/releases/download/${PATCHED_BUN.tag}`,
        );
        const keys = Object.keys(PATCHED_BUN.assets);
        expect(keys).toContain("linux-x64");
        for (const k of keys) {
            const a = PATCHED_BUN.assets[k];
            expect(a?.sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(a?.sha256).not.toMatch(/^0+$/);
            expect(a?.file).toBe(`bun-${k.replace("arm64", "aarch64")}`);
        }
    });
});

describe("lockstep with the release + docs", () => {
    const repo = join(import.meta.dir, "..", "..", "..", "..");

    it("deploy/bun-patched/RELEASE.sha256 pins exactly the assets knext embeds", () => {
        const lines = readFileSync(
            join(repo, "deploy/bun-patched/RELEASE.sha256"),
            "utf8",
        )
            .split("\n")
            .filter(Boolean);
        const fromFile = Object.fromEntries(
            lines.map((l) => {
                const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(l);
                if (!m) throw new Error(`bad RELEASE.sha256 line: ${l}`);
                return [m[2], m[1]];
            }),
        );
        const fromCode = Object.fromEntries(
            Object.values(PATCHED_BUN.assets).map((a) => [a.file, a.sha256]),
        );
        expect(fromFile).toEqual(fromCode);
    });

    it("the docs' cosign command names the signer identity for the pinned tag", () => {
        const docs = readFileSync(
            join(repo, "apps/docs/content/docs/build-pipeline.mdx"),
            "utf8",
        );
        expect(docs).toContain(PATCHED_BUN_SIGNER);
    });
});

describe("config validation", () => {
    it("accepts absent, stock, and knext-patched with include globs", () => {
        expect(validateCompileConfig({})).toEqual([]);
        expect(validateCompileConfig({ compile: { bun: "stock" } })).toEqual(
            [],
        );
        expect(
            validateCompileConfig({
                compile: { bun: "knext-patched", include: ["./plugins/**"] },
            }),
        ).toEqual([]);
    });

    it("rejects an unknown toolchain, a non-array include, and include without the patched toolchain", () => {
        expect(
            validateCompileConfig({ compile: { bun: "canary" } }).join("\n"),
        ).toContain("compile.bun");
        expect(
            validateCompileConfig({
                compile: { bun: "knext-patched", include: "./x" },
            }).join("\n"),
        ).toContain("compile.include");
        expect(
            validateCompileConfig({ compile: { include: ["./x"] } }).join("\n"),
        ).toContain("knext-patched");
        expect(
            validateCompileConfig({ compile: "knext-patched" }).join("\n"),
        ).toContain("compile");
    });
});

describe("compile-script include pass-through", () => {
    it("parseIncludeJson: absent → [], a glob list round-trips, junk throws", () => {
        expect(parseIncludeJson(undefined)).toEqual([]);
        expect(parseIncludeJson('["./plugins/**"]')).toEqual(["./plugins/**"]);
        for (const bad of ["not json", "[]", '"./x"', "[1]", '[""]', "{}"]) {
            expect(() => parseIncludeJson(bad)).toThrow();
        }
    });

    it("userIncludePart: none → undefined (compile unchanged); appends after an existing include", () => {
        expect(userIncludePart([])).toBeUndefined();
        expect(userIncludePart(["./a/**"])).toEqual({ include: ["./a/**"] });
        expect(userIncludePart(["./a/**"], ["./plan.js"])).toEqual({
            include: ["./plan.js", "./a/**"],
        });
    });
});

describe("compile argv", () => {
    it("default argv still starts with plain `bun` (unchanged)", () => {
        expect(compileArgv("linux-x64", "e.mjs", "out")[0]).toBe("bun");
    });

    it("runs the compile script with the resolved toolchain and passes include globs through", () => {
        const argv = compileArgv("linux-x64", "e.mjs", "out", {
            bin: "/cache/bun-linux-x64",
            include: ["./plugins/**", "./data/*.json"],
        });
        expect(argv[0]).toBe("/cache/bun-linux-x64");
        const i = argv.indexOf("--include-json");
        expect(i).toBeGreaterThan(0);
        expect(JSON.parse(argv[i + 1] ?? "null")).toEqual([
            "./plugins/**",
            "./data/*.json",
        ]);
    });

    it("the standalone compile argv takes the same toolchain (and is unchanged without one)", () => {
        const base = {
            arch: "linux-x64",
            server: "s.js",
            root: "r",
            outFile: "o",
            marker: "m",
        };
        const plain = standaloneCompileArgv(base);
        expect(plain[0]).toBe("bun");
        expect(plain).not.toContain("--include-json");
        const patched = standaloneCompileArgv({
            ...base,
            toolchain: { bin: "/cache/bun-linux-x64", include: ["./p/**"] },
        });
        expect(patched[0]).toBe("/cache/bun-linux-x64");
        expect(patched.slice(-2)).toEqual(["--include-json", '["./p/**"]']);
    });
});
