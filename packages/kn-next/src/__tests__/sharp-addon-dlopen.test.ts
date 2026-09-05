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

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

/** Every temp dir the #949 tests create, drained after the run (D9, #880). */
const tempDirs: string[] = [];
afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

/**
 * The shim's resolution rule, restated so it can be exercised without dlopening
 * anything. Kept in step with the real one by the source assertions below —
 * a private copy that silently drifts is the failure this repo keeps hitting.
 *
 * `platformIds` is what the real shim computes from `process.platform` /
 * `process.arch` / libc; injected here so the rule is testable for platforms
 * this test host is not. The real computation is exercised by the subprocess
 * tests below, which run the shipped shim on THIS host.
 */
function addonPath(
    env: Record<string, string | undefined>,
    execDir: string,
    platformIds: readonly string[],
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
    const sharpDirs = read(nativeRoot).filter(
        (pkg) => pkg.startsWith("sharp-") && !pkg.startsWith("sharp-libvips-"),
    );
    // #949: by RUNTIME PLATFORM, never by directory order — `sharp-darwin-arm64`
    // sorts before `sharp-linuxmusl-x64`, and picking it in a linux image is an
    // `Exec format error` crash-loop.
    for (const id of platformIds) {
        const dir = `sharp-${id}`;
        if (!sharpDirs.includes(dir)) continue;
        const lib = join(nativeRoot, dir, "lib");
        for (const file of read(lib)) {
            if (file.startsWith("sharp-") && file.endsWith(".node"))
                return join(lib, file);
        }
    }
    if (sharpDirs.length > 0) {
        throw new Error(
            `no staged sharp addon matches this runtime (wanted sharp-{${platformIds.join(
                "|",
            )}}, staged: ${sharpDirs.join(", ")})`,
        );
    }
    return flat;
}

/** The image's own platform ids for the tests that model the alpine runtime. */
const MUSL_IDS = ["linuxmusl-x64", "linux-x64"] as const;

function stage(): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-sharp-shim-"));
    const lib = join(dir, "native", "sharp-linuxmusl-x64", "lib");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "sharp-linuxmusl-x64-0.35.2.node"), "");
    // libvips ships alongside and ALSO matches `sharp-*` — the discovery must not
    // return its stub. A `find … -name '*.node' | head -1` did exactly that while
    // this was being built, and the binary then dlopened libvips' stub instead of
    // the addon.
    const vips = join(dir, "native", "sharp-libvips-linuxmusl-x64", "lib");
    mkdirSync(vips, { recursive: true });
    writeFileSync(join(vips, "stub.node"), "");
    return dir;
}

describe("the shim the compile injects is VERBATIM and self-contained", () => {
    // Sprint-close root cause, pinned: vinext-compile injects the shim's TEXT
    // as sharp.mjs's contents, so a tsup `import "../chunk-…"` inside the
    // BUNDLED dist shim resolved against sharp's directory and the single-exec
    // compile died with `Could not resolve` — reddening four CI checks, while
    // local runs (which read the chunkless source) stayed green.
    const src = join(
        dirname(import.meta.dirname),
        "adapters",
        "sharp-addon-dlopen.mjs",
    );
    const verbatim = join(
        dirname(dirname(import.meta.dirname)),
        "dist",
        "adapters",
        "sharp-addon-dlopen.source.mjs",
    );

    it("dist ships the verbatim source copy, byte-equal (tsup onSuccess)", () => {
        // dist is a hard requirement here, as in cli-node-runtime.test.ts:
        // skipping when dist is absent is how the bundled-shim poison shipped.
        expect(
            existsSync(verbatim),
            "dist/adapters/sharp-addon-dlopen.source.mjs missing — run the package build; the compile script depends on it",
        ).toBe(true);
        expect(readFileSync(verbatim, "utf8")).toBe(readFileSync(src, "utf8"));
    });

    it("the source shim has NO relative imports — its text is injected into sharp's directory", () => {
        const text = readFileSync(src, "utf8");
        expect(text).not.toMatch(/from\s+["']\.\.?\//);
        expect(text).not.toMatch(/import\s+["']\.\.?\//);
    });

    it("vinext-compile prefers the verbatim copy and refuses a non-self-contained shim", async () => {
        const compile = await Bun.file(
            join(
                dirname(import.meta.dirname),
                "adapters",
                "vinext-compile.mjs",
            ),
        ).text();
        expect(compile).toContain("sharp-addon-dlopen.source.mjs");
        // The refusal is the fail-closed half: without it, the next chunked
        // shim poisons the bundle again and blames sharp.mjs.
        expect(compile).toContain("not self-contained");
        // And the bundled dist entry must never be a candidate again.
        expect(compile).not.toMatch(/sharp-addon-dlopen\.js["']/);
    });

    it("#949 the injection filter is PROVEN against the sharp range the scaffold pins", async () => {
        // Finding C-1b: the onLoad filter matches sharp >=0.35's
        // `dist/sharp.(m|c)js` layout only. sharp 0.34 ships `lib/sharp.js`,
        // so with an 0.34 resolution the shim silently never injects and the
        // compiled binary cannot load sharp. Widening the filter to `lib/` was
        // REJECTED rather than done: 0.34's loader is CJS
        // (`module.exports = <addon>`) and injecting this ESM shim there
        // changes the require-interop shape unmeasured. The no-silent-path fix
        // is a pin the filter is proven against — this test couples the two,
        // so loosening the scaffold's sharp range OR narrowing the filter
        // fails here instead of at a user's first `/_next/image` request.
        const compile = await Bun.file(
            join(
                dirname(import.meta.dirname),
                "adapters",
                "vinext-compile.mjs",
            ),
        ).text();
        const filters = [...compile.matchAll(/filter:\s*\/(.+?)\/\s*\}/g)]
            .map((m) => m[1])
            .filter((p) => p.includes("sharp"));
        expect(filters, "exactly one sharp onLoad filter").toHaveLength(1);
        const filter = new RegExp(filters[0]);

        // The layout every sharp >=0.35 resolution presents:
        expect(filter.test("/x/node_modules/sharp/dist/sharp.mjs")).toBe(true);
        expect(filter.test("/x/node_modules/sharp/dist/sharp.cjs")).toBe(true);
        expect(filter.test("/x/node_modules/sharp/dist/sharp.js")).toBe(true);
        // Never a lookalike from another package's tree:
        expect(filter.test("/x/node_modules/not-sharp/dist/sharp.mjs")).toBe(
            false,
        );

        // And the scaffold pins a range whose floor has that layout. `^0.x.y`
        // stays within 0.x, so asserting the floor's minor is >=35 covers the
        // whole resolvable range.
        const scaffold = JSON.parse(
            await Bun.file(
                join(
                    dirname(dirname(import.meta.dirname)),
                    "templates",
                    "app",
                    "package.json.hbs",
                ),
            ).text(),
        );
        const pin: string = scaffold.dependencies.sharp;
        const floor = /^\^(\d+)\.(\d+)\.\d+$/.exec(pin);
        expect(
            floor,
            `scaffold sharp pin '${pin}' must be a caret range`,
        ).not.toBeNull();
        expect(Number(floor?.[1])).toBe(0);
        expect(Number(floor?.[2])).toBeGreaterThanOrEqual(35);
    });
});

describe("sharp addon path resolution", () => {
    it("an explicit KNEXT_SHARP_ADDON wins", () => {
        const dir = stage();
        expect(
            addonPath({ KNEXT_SHARP_ADDON: "/custom/x.node" }, dir, MUSL_IDS),
        ).toBe("/custom/x.node");
    });

    it('an EMPTY KNEXT_SHARP_ADDON falls back instead of dlopening ""', () => {
        // `??` accepts `""`. A staging step like `KNEXT_SHARP_ADDON=$(find … )` that
        // matches nothing sets exactly that, and the failure read
        // `could not dlopen the sharp addon at ` — a message with a hole in it.
        const dir = stage();
        const resolved = addonPath({ KNEXT_SHARP_ADDON: "" }, dir, MUSL_IDS);
        expect(resolved).not.toBe("");
        expect(resolved.endsWith("sharp-linuxmusl-x64-0.35.2.node")).toBe(true);
    });

    it("discovers the addon inside the staged native tree", () => {
        const dir = stage();
        expect(addonPath({}, dir, MUSL_IDS)).toBe(
            join(
                dir,
                "native",
                "sharp-linuxmusl-x64",
                "lib",
                "sharp-linuxmusl-x64-0.35.2.node",
            ),
        );
    });

    it("never returns the libvips stub, which also matches sharp-*", () => {
        const dir = stage();
        expect(addonPath({}, dir, MUSL_IDS)).not.toContain("libvips");
        expect(addonPath({}, dir, MUSL_IDS)).not.toContain("stub.node");
    });

    it("falls back to a flat sharp.node beside the executable", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-sharp-flat-"));
        writeFileSync(join(dir, "sharp.node"), "");
        expect(addonPath({}, dir, MUSL_IDS)).toBe(join(dir, "sharp.node"));
    });

    it("#949 picks the RUNTIME platform's addon, not the first directory alphabetically", () => {
        // The S3-V finding (C-1c): with darwin AND linuxmusl both staged,
        // `sharp-darwin-arm64` sorts first, the shim dlopened it inside the
        // alpine image, and the pod crash-looped on `Exec format error`.
        const dir = stage();
        const mac = join(dir, "native", "sharp-darwin-arm64", "lib");
        mkdirSync(mac, { recursive: true });
        writeFileSync(join(mac, "sharp-darwin-arm64.node"), "");

        const picked = addonPath({}, dir, MUSL_IDS);
        expect(picked).not.toContain("darwin");
        expect(picked).toContain("sharp-linuxmusl-x64");
    });

    it("#949 prefers the exact libc match when both linux flavours are staged", () => {
        const dir = stage();
        const glibc = join(dir, "native", "sharp-linux-x64", "lib");
        mkdirSync(glibc, { recursive: true });
        writeFileSync(join(glibc, "sharp-linux-x64.node"), "");

        // musl runtime → the musl addon, though `linux-x64` sorts first.
        expect(addonPath({}, dir, MUSL_IDS)).toContain("sharp-linuxmusl-x64");
        // glibc runtime → the glibc addon.
        expect(addonPath({}, dir, ["linux-x64", "linuxmusl-x64"])).toContain(
            `${sep}sharp-linux-x64${sep}`,
        );
    });

    it("#949 FAILS LOUDLY when no staged addon matches the runtime — never dlopens a foreign one", () => {
        // A darwin-only tree in a linux image is the macOS-built deploy. The
        // old behaviour dlopened it and crash-looped; a named error is the fix.
        const dir = tempDir("knext-sharp-foreign-");
        const mac = join(dir, "native", "sharp-darwin-arm64", "lib");
        mkdirSync(mac, { recursive: true });
        writeFileSync(join(mac, "sharp-darwin-arm64.node"), "");

        expect(() => addonPath({}, dir, MUSL_IDS)).toThrow(
            /sharp-darwin-arm64/,
        );
        expect(() => addonPath({}, dir, MUSL_IDS)).toThrow(/linuxmusl-x64/);
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
            // #949: selection is by RUNTIME platform/libc, never directory
            // order — `sharp-darwin-arm64` sorts before `sharp-linuxmusl-x64`
            // and dlopening it in the alpine image is a crash-loop.
            expect(
                text,
                "shim must compute candidate ids from the runtime platform",
            ).toContain("process.platform");
            expect(
                text,
                "shim must know sharp's one-word musl spelling",
            ).toContain("linuxmusl-");
            expect(
                text,
                "shim must fail loudly when no staged addon matches the runtime",
            ).toContain("matches this runtime");
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

/**
 * Run the REAL shim's discovery on this host: `process.execPath` is pointed
 * into a staged temp tree (a plain writable property under both node and bun,
 * verified) and `process.dlopen` is stubbed to print the path it was handed.
 * No `KNEXT_SHARP_ADDON`, so the platform-matching branch itself is on trial —
 * the restated-copy tests above cannot catch the shipped shim disagreeing with
 * them about the RUNTIME platform computation.
 */
function discoverShim(dir: string): {
    status: number;
    stderr: string;
    stdout: string;
} {
    const harness = join(dir, "discover-harness.mjs");
    writeFileSync(
        harness,
        `process.execPath = ${JSON.stringify(join(dir, "knext-exec"))};\n` +
            `process.dlopen = (m, path) => { console.log("KNEXT_PICKED:" + path); m.exports = { KNEXT_STUB: true }; };\n` +
            `await import(${JSON.stringify(`file://${SHIM}`)});\n`,
    );
    const r = spawnSync(process.execPath, [harness], {
        encoding: "utf8",
        env: { ...process.env, KNEXT_SHARP_ADDON: "" },
    });
    return {
        status: r.status ?? -1,
        stderr: r.stderr ?? "",
        stdout: r.stdout ?? "",
    };
}

/** This host's sharp platform ids, either linux libc flavour accepted. */
const HOST_ID_PATTERN =
    process.platform === "linux"
        ? new RegExp(`sharp-linux(musl)?-${process.arch}`)
        : new RegExp(`sharp-${process.platform}-${process.arch}`);

function stageDir(root: string, pkg: string): void {
    const lib = join(root, "native", pkg, "lib");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, `${pkg}.node`), "");
}

describe("#949 the SHIPPED shim selects by runtime platform", () => {
    it("picks this host's addon over an alien one that sorts first", () => {
        const dir = tempDir("knext-sharp-runtime-");
        // `android` sorts before both `darwin` and `linux*`, so directory-order
        // discovery returns it — the exact shape of finding C-1c.
        stageDir(dir, `sharp-android-${process.arch}`);
        stageDir(dir, `sharp-darwin-${process.arch}`);
        stageDir(dir, `sharp-linux-${process.arch}`);
        stageDir(dir, `sharp-linuxmusl-${process.arch}`);

        const r = discoverShim(dir);
        expect(r.stderr).not.toContain("could not dlopen");
        expect(r.status).toBe(0);
        const picked = r.stdout
            .split("\n")
            .find((l) => l.startsWith("KNEXT_PICKED:"));
        expect(picked, "the shim never reached dlopen").toBeDefined();
        expect(picked).not.toContain("sharp-android-");
        expect(picked).toMatch(HOST_ID_PATTERN);
    });

    it("FAILS LOUDLY, naming platforms, when only a foreign addon is staged", () => {
        // The macOS-built image before the staging fix: a darwin-only tree on
        // an alpine runtime. The old shim dlopened it — CrashLoopBackOff with
        // `Exec format error`. A named refusal is diagnosable; that is not.
        const dir = tempDir("knext-sharp-foreignonly-");
        stageDir(dir, `sharp-android-${process.arch}`);

        const r = discoverShim(dir);
        expect(r.status).not.toBe(0);
        expect(r.stdout).not.toContain("KNEXT_PICKED:");
        expect(r.stderr).toContain(`sharp-android-${process.arch}`);
        // The remedy is named: rebuild (staging now follows the image target)
        // or point KNEXT_SHARP_ADDON at the right .node.
        expect(r.stderr).toContain("KNEXT_SHARP_ADDON");
    });
});

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
