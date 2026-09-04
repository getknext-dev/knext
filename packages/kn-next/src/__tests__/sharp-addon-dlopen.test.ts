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
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
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
            // C2: the shim is the last gate before native-code privilege, so
            // the verification must be IN it and must run BEFORE the dlopen.
            expect(
                text,
                "shim must verify against the integrity manifest",
            ).toContain(".integrity.json");
            expect(text, "shim must hash with node:crypto").toContain(
                "createHash",
            );
            expect(
                text.indexOf("verifyAgainstManifest("),
                "the verification call must precede process.dlopen",
            ).toBeLessThan(text.indexOf("process.dlopen("));
            // The shim's source is injected as TEXT into sharp's module slot by
            // vinext-compile.mjs's onLoad, so a relative import would resolve
            // against `sharp/dist/`, not against this directory. It must stay a
            // single self-contained file over node builtins.
            const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
                (m) => m[1],
            );
            expect(
                imports.every((s) => s.startsWith("node:")),
                `shim must import only node builtins, saw: ${imports.join(", ")}`,
            ).toBe(true);
        });
    });
});

/**
 * The shim's fail-closed half, exercised on the REAL shim rather than a restated
 * copy: the module is imported in a subprocess with `process.dlopen` stubbed, so
 * everything up to and including the verification runs for real and only the
 * call into the OS loader is replaced.
 *
 * A restated copy is what the resolution tests above have to do (the shim's
 * `addonPath` is not exported), and it is the weaker option — worth paying a
 * subprocess to avoid it for the security-relevant branch.
 */
const SHIM = join(
    dirname(import.meta.dirname),
    "adapters",
    "sharp-addon-dlopen.mjs",
);

function stageVerifiable(): {
    dir: string;
    addon: string;
    manifest: string;
    lib: string;
} {
    const dir = mkdtempSync(join(tmpdir(), "knext-sharp-verify-"));
    const pkgLib = join(dir, "native", "sharp-linux-x64", "lib");
    mkdirSync(pkgLib, { recursive: true });
    const addon = join(pkgLib, "sharp-linux-x64.node");
    writeFileSync(addon, "ADDON BYTES");
    const vipsLib = join(dir, "native", "sharp-libvips-linux-x64", "lib");
    mkdirSync(vipsLib, { recursive: true });
    const lib = join(vipsLib, "libvips-cpp.so.42");
    writeFileSync(lib, "VIPS BYTES");

    const sha = (p: string) =>
        createHash("sha256").update(readFileSync(p)).digest("hex");
    const manifest = join(dir, "native", ".integrity.json");
    writeFileSync(
        manifest,
        JSON.stringify({
            version: 1,
            algorithm: "sha256",
            packages: {},
            files: {
                "sharp-linux-x64/lib/sharp-linux-x64.node": sha(addon),
                "sharp-libvips-linux-x64/lib/libvips-cpp.so.42": sha(lib),
            },
        }),
    );
    return { dir, addon, manifest, lib };
}

/** Import the real shim with `process.dlopen` stubbed. Returns the exit code. */
function loadShim(
    addon: string,
    dir: string,
): { status: number; stderr: string; stdout: string } {
    const harness = join(dir, "harness.mjs");
    writeFileSync(
        harness,
        `process.dlopen = (m) => { m.exports = { KNEXT_STUB: true }; };\n` +
            `const mod = await import(${JSON.stringify(`file://${SHIM}`)});\n` +
            `if (!mod.default?.KNEXT_STUB) { console.error('shim did not dlopen'); process.exit(3); }\n` +
            `console.log('DLOPENED');\n`,
    );
    const r = spawnSync(process.execPath, [harness], {
        encoding: "utf8",
        env: { ...process.env, KNEXT_SHARP_ADDON: addon },
    });
    return {
        status: r.status ?? -1,
        stderr: r.stderr ?? "",
        stdout: r.stdout ?? "",
    };
}

describe("sharp addon integrity verification", () => {
    it("loads when every listed payload matches the manifest", () => {
        const { dir, addon } = stageVerifiable();
        const r = loadShim(addon, dir);
        expect(r.stderr).not.toContain("refusing");
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("DLOPENED");
    });

    it("REFUSES a tampered addon, naming the file", () => {
        const { dir, addon } = stageVerifiable();
        // One byte. The whole point is that a `.node` is an opaque blob: an SBOM
        // that lists the package cannot tell this apart from the real thing.
        writeFileSync(addon, "aDDON BYTES");

        const r = loadShim(addon, dir);
        expect(r.status).not.toBe(0);
        expect(r.stdout).not.toContain("DLOPENED");
        expect(r.stderr).toContain("refusing to dlopen");
        expect(r.stderr).toContain("sharp-linux-x64/lib/sharp-linux-x64.node");
    });

    it("REFUSES a tampered libvips even though the addon itself is intact", () => {
        // The addon links libvips by relative rpath and the OS loader pulls it
        // in transitively — it never passes through this shim, so verifying only
        // the dlopened file would leave the larger payload unpinned.
        const { dir, addon, lib } = stageVerifiable();
        writeFileSync(lib, "vIPS BYTES");

        const r = loadShim(addon, dir);
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain(
            "sharp-libvips-linux-x64/lib/libvips-cpp.so.42",
        );
    });

    it("REFUSES an addon the manifest does not list", () => {
        // A native payload present in a tree that HAS a manifest, but absent
        // from it, is the injected-file case — it must not read as "nothing to
        // check".
        const { dir } = stageVerifiable();
        const rogue = join(
            dir,
            "native",
            "sharp-linux-x64",
            "lib",
            "evil.node",
        );
        writeFileSync(rogue, "EVIL");

        const r = loadShim(rogue, dir);
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain("does not list");
        expect(r.stderr).toContain("evil.node");
    });

    it("warns and loads when there is no manifest — never bricks an older image", () => {
        // Images built before this landed have no manifest. Failing closed on
        // absence would turn a security improvement into a fleet outage, so
        // absence is loud and permissive while a MISMATCH is fatal.
        const dir = mkdtempSync(join(tmpdir(), "knext-sharp-legacy-"));
        const lib = join(dir, "native", "sharp-linux-x64", "lib");
        mkdirSync(lib, { recursive: true });
        const addon = join(lib, "sharp-linux-x64.node");
        writeFileSync(addon, "ADDON BYTES");

        const r = loadShim(addon, dir);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("DLOPENED");
        expect(r.stderr).toContain("no native integrity manifest");
    });
});
