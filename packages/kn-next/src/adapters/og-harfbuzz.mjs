/**
 * Resolve the HarfBuzz `hb.wasm` that `next/og` needs, for every vinext build
 * target (#1872).
 *
 * `@vercel/og` 1.x inlines harfbuzzjs's Emscripten glue but 1.0.3 — the
 * version vinext 1.0.1 pins — ships no `dist/hb.wasm` (vercel/satori#801).
 * The binary that matches the glue is the one in the exact-pinned chain the
 * glue was built from: `@vercel/og` → `satori` → `harfbuzzjs/hb.wasm` (the
 * same chain vinext's own `vinext:og-harfbuzz` plugin resolves).
 *
 * Shared by the compiled-executable build (`vinext-compile.mjs`, which embeds
 * the binary) and the vinext × node build (`stageOgHarfbuzzForVinextNode`,
 * which stages it into `.output/server`). Runtime-agnostic: runs under Bun
 * and Node, so nothing here uses `Bun.*`.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";

/** The notice file written beside a compiled executable that embeds hb.wasm. */
export const HARFBUZZ_NOTICE_FILE = "knext-third-party-notices.txt";

/**
 * Text of the third-party notice for an embedded `hb.wasm`: a header naming the
 * components, then every licence file (LICENSE / COPYING*) shipped beside the
 * binary in the harfbuzzjs package, verbatim.
 *
 * @param {string} hbWasm resolved path of harfbuzzjs's hb.wasm
 */
export function harfbuzzNoticeText(hbWasm) {
    const dir = dirname(hbWasm);
    const files = readdirSync(dir)
        .filter((n) => /^(LICENSE|LICENCE|COPYING)(\..*)?$/i.test(n))
        .sort();
    const parts = [
        "Third-party notices for this knext executable\n" +
            "=============================================\n\n" +
            "This executable embeds hb.wasm for next/og: HarfBuzz (Old MIT licence),\n" +
            "compiled to WebAssembly and distributed by harfbuzzjs (MIT licence).\n" +
            "The licence texts shipped with harfbuzzjs follow.\n",
    ];
    for (const n of files) {
        parts.push(`\n----- harfbuzzjs/${n} -----\n\n${readFileSync(join(dir, n), "utf8")}`);
    }
    return parts.join("");
}

/** Hard cap on the embedded/staged binary — a build error, never a silent skip. */
export const HARFBUZZ_MAX_BYTES = 16 * 1024 * 1024;

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/**
 * vinext's own `@vercel/og/package.json` (the copy its og plugins resolve), or
 * undefined. vinext is ESM-only — an `"import"`-only export and no
 * `./package.json` export — so neither `require.resolve("vinext")` nor
 * `require.resolve("vinext/package.json")` can see it; the package directory
 * is found by the same `node_modules` walk Node's resolver does.
 */
export function vinextOgPackageJson(appRoot) {
    for (let dir = appRoot; ; dir = dirname(dir)) {
        const vinextPkg = join(dir, "node_modules", "vinext", "package.json");
        if (existsSync(vinextPkg)) {
            try {
                return createRequire(vinextPkg).resolve("@vercel/og/package.json");
            } catch {
                return undefined;
            }
        }
        if (dirname(dir) === dir) return undefined;
    }
}

/** The real `…/node_modules/harfbuzzjs` directory `realPath` sits directly in, or undefined. */
function harfbuzzRootOf(realPath) {
    const parts = realPath.split(sep);
    const idx = parts.lastIndexOf("node_modules");
    if (idx === -1 || parts[idx + 1] !== "harfbuzzjs") return undefined;
    return parts.slice(0, idx + 2).join(sep);
}

/**
 * `harfbuzzjs/hb.wasm` matching the glue in the `@vercel/og` described by
 * `ogPkg`: `satori` is resolved from each of `startPoints` in turn and
 * accepted only at `ogPkg`'s exact `dependencies.satori` pin, then
 * `harfbuzzjs` only at that satori's exact pin.
 *
 * @param {string} ogPkg path of the @vercel/og package.json whose glue this is for
 * @param {string[]} startPoints files to resolve `satori` from, in order
 * @returns {{ path: string, license: string | undefined } | { reason: string }}
 *   `reason` (why nothing matched) when no start point yields the exact chain.
 * @throws on a containment or size violation — never embed/stage those.
 */
export function resolvePinnedHarfbuzzWasm(ogPkg, startPoints) {
    let expectedSatori;
    try {
        expectedSatori = readJson(ogPkg).dependencies?.satori;
    } catch {
        return { reason: `cannot read ${ogPkg}` };
    }
    if (typeof expectedSatori !== "string" || !EXACT_VERSION.test(expectedSatori)) {
        return { reason: `${ogPkg} has no exact satori pin (found ${JSON.stringify(expectedSatori)})` };
    }
    const seen = [];
    for (const start of startPoints) {
        let hbWasm;
        let hbDir;
        try {
            const satoriPkg = createRequire(start).resolve("satori/package.json");
            const satori = readJson(satoriPkg);
            if (satori.version !== expectedSatori) {
                seen.push(`satori ${satori.version}`);
                continue;
            }
            const expectedHb = satori.dependencies?.harfbuzzjs;
            if (typeof expectedHb !== "string" || !EXACT_VERSION.test(expectedHb)) continue;
            const hbPkg = createRequire(satoriPkg).resolve("harfbuzzjs/package.json");
            const hbVersion = readJson(hbPkg).version;
            if (hbVersion !== expectedHb) {
                seen.push(`harfbuzzjs ${hbVersion}`);
                continue;
            }
            hbDir = dirname(hbPkg);
            hbWasm = realpathSync(join(hbDir, "hb.wasm"));
        } catch {
            continue;
        }
        const root = harfbuzzRootOf(hbWasm);
        if (root === undefined || hbWasm !== join(root, "hb.wasm")) {
            throw new Error(
                `hb.wasm resolved to ${hbWasm}, which is not harfbuzzjs's own hb.wasm — refusing to use it`,
            );
        }
        const size = statSync(hbWasm).size;
        if (size > HARFBUZZ_MAX_BYTES) {
            throw new Error(
                `hb.wasm is ${size} bytes, over the ${HARFBUZZ_MAX_BYTES}-byte cap (${hbWasm}) — refusing to use it`,
            );
        }
        const license = join(hbDir, "LICENSE");
        return { path: hbWasm, license: existsSync(license) ? license : undefined };
    }
    return {
        reason:
            `@vercel/og needs satori ${expectedSatori} (and the harfbuzzjs it pins), but the install has ` +
            (seen.length > 0 ? [...new Set(seen)].join(", ") : "no resolvable satori"),
    };
}

/** The one build-time warning text, shared by every target so docs can quote it. */
export function ogHarfbuzzWarning(reason) {
    return (
        `WARNING: next/og will fail at runtime (ImageResponse answers 500): HarfBuzz's hb.wasm could not be ` +
        `bundled — ${reason}. Remove any overrides/resolutions entry for satori or harfbuzzjs and ` +
        "reinstall, so they match the exact versions @vercel/og pins. Apps that never render next/og " +
        "are unaffected."
    );
}
