/**
 * The sharp addon shim: how the compiled binary finds its native module.
 *
 * ## Why the shim exists
 *
 * `/_next/image` served unoptimized originals on the single-executable image
 * (ADR-0048 Amendment 2). Every route that reaches sharp through module
 * RESOLUTION fails inside a `bun build --compile` binary — measured on bun
 * 1.4.0, and none of these is a misconfiguration:
 *
 *   - sharp's own `require('@img/sharp-<platform>/sharp.node')` throws
 *     `Could not load the "sharp" module`;
 *   - `--external sharp` resolves from `/$bunfs/root/`, which has no
 *     `node_modules` above it;
 *   - `--asset=` embeds the `.node` and it is STILL unusable — the OS cannot
 *     `dlopen` a path inside the binary's virtual filesystem;
 *   - `createRequire(cwd)('sharp')` fails even with sharp and every dependency
 *     top-level in a flat `node_modules` beside the executable, while the same
 *     call succeeds uncompiled.
 *
 * `process.dlopen` on an absolute real path works. The shim is that, and the
 * addon ships beside the binary.
 *
 * ## What this file guards
 *
 * The PATH RESOLUTION, which is the part with branches. The dlopen itself is
 * proven by the prod-image probe against a real container — an assertion here
 * that "sharp loads" would only re-test the platform's loader.
 *
 * Both discovery bugs found while building this are pinned below, because both
 * shipped once and neither is obvious from reading the happy path.
 */

import { describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The shim's resolution rule, restated so it can be exercised without dlopening
 * anything. Kept in step with the real one by the source assertions below —
 * a private copy that silently drifts is the failure this repo keeps hitting.
 */
function addonPath(
    env: Record<string, string | undefined>,
    execDir: string,
): string {
    const configured = env.KNEXT_SHARP_ADDON;
    if (configured && configured.trim() !== "") return configured;
    const flat = join(execDir, "sharp.node");
    if (existsSync(flat)) return flat;
    const nativeRoot = join(execDir, "native");
    const read = (d: string) => {
        try {
            return readdirSync(d);
        } catch {
            return [];
        }
    };
    for (const pkg of read(nativeRoot)) {
        if (!pkg.startsWith("sharp-") || pkg.startsWith("sharp-libvips-"))
            continue;
        const lib = join(nativeRoot, pkg, "lib");
        for (const file of read(lib)) {
            if (file.startsWith("sharp-") && file.endsWith(".node"))
                return join(lib, file);
        }
    }
    return flat;
}

function stage(): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-sharp-shim-"));
    const lib = join(dir, "native", "sharp-linux-musl-x64", "lib");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "sharp-linux-musl-x64-0.35.2.node"), "");
    // libvips ships alongside and ALSO matches `sharp-*` — the discovery must not
    // return its stub. A `find … -name '*.node' | head -1` did exactly that while
    // this was being built, and the binary then dlopened libvips' stub instead of
    // the addon.
    const vips = join(dir, "native", "sharp-libvips-linux-musl-x64", "lib");
    mkdirSync(vips, { recursive: true });
    writeFileSync(join(vips, "stub.node"), "");
    return dir;
}

describe("sharp addon path resolution", () => {
    it("an explicit KNEXT_SHARP_ADDON wins", () => {
        const dir = stage();
        expect(addonPath({ KNEXT_SHARP_ADDON: "/custom/x.node" }, dir)).toBe(
            "/custom/x.node",
        );
    });

    it('an EMPTY KNEXT_SHARP_ADDON falls back instead of dlopening ""', () => {
        // `??` accepts `""`. A staging step like `KNEXT_SHARP_ADDON=$(find … )` that
        // matches nothing sets exactly that, and the failure read
        // `could not dlopen the sharp addon at ` — a message with a hole in it.
        const dir = stage();
        const resolved = addonPath({ KNEXT_SHARP_ADDON: "" }, dir);
        expect(resolved).not.toBe("");
        expect(resolved.endsWith("sharp-linux-musl-x64-0.35.2.node")).toBe(
            true,
        );
    });

    it("discovers the addon inside the staged native tree", () => {
        const dir = stage();
        expect(addonPath({}, dir)).toBe(
            join(
                dir,
                "native",
                "sharp-linux-musl-x64",
                "lib",
                "sharp-linux-musl-x64-0.35.2.node",
            ),
        );
    });

    it("never returns the libvips stub, which also matches sharp-*", () => {
        const dir = stage();
        expect(addonPath({}, dir)).not.toContain("libvips");
        expect(addonPath({}, dir)).not.toContain("stub.node");
    });

    it("falls back to a flat sharp.node beside the executable", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-sharp-flat-"));
        writeFileSync(join(dir, "sharp.node"), "");
        expect(addonPath({}, dir)).toBe(join(dir, "sharp.node"));
    });

    it("the shipped shim implements the rule this file restates", () => {
        // The guard would otherwise pass while the shim disagreed with it.
        const shim = Bun.file(
            join(
                dirname(import.meta.dirname),
                "adapters",
                "sharp-addon-dlopen.mjs",
            ),
        );
        const src = shim.text();
        return src.then((text) => {
            expect(
                text,
                "shim must use process.dlopen, not a require",
            ).toContain("process.dlopen");
            expect(text, "shim must reject an empty env var").toMatch(
                /trim\(\)\s*!==\s*['"]{2}/,
            );
            expect(
                text,
                "shim must skip the libvips package during discovery",
            ).toContain("sharp-libvips-");
            // Quote-agnostic: a formatter flipping ' to " must not turn this
            // guard red, and must not silently turn it green either.
            expect(
                text,
                "shim must search a native/ tree beside the executable",
            ).toMatch(/join\(beside,\s*['"]native['"]\)/);
        });
    });
});
