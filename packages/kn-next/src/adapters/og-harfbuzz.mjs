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
 * HarfBuzz's licence, verbatim: harfbuzz/harfbuzz `COPYING` on its default
 * branch, fetched 2026-10-07. harfbuzzjs's own LICENSE does not reproduce it
 * and its package ships no COPYING; the exact HarfBuzz revision harfbuzzjs
 * bundles is not recorded in the package, so this is main, not a pinned tag.
 */
const HARFBUZZ_COPYING = `
----- HarfBuzz (Old MIT): harfbuzz/harfbuzz COPYING -----

HarfBuzz is licensed under the so-called "Old MIT" license.  Details follow.
For parts of HarfBuzz that are licensed under different licenses see individual
files names COPYING in subdirectories where applicable.

Copyright © 2010-2022  Google, Inc.
Copyright © 2015-2020  Ebrahim Byagowi
Copyright © 2019,2020  Facebook, Inc.
Copyright © 2012,2015  Mozilla Foundation
Copyright © 2011  Codethink Limited
Copyright © 2008,2010  Nokia Corporation and/or its subsidiary(-ies)
Copyright © 2009  Keith Stribley
Copyright © 2011  Martin Hosken and SIL International
Copyright © 2007  Chris Wilson
Copyright © 2005,2006,2020,2021,2022,2023  Behdad Esfahbod
Copyright © 2004,2007,2008,2009,2010,2013,2021,2022,2023  Red Hat, Inc.
Copyright © 1998-2005  David Turner and Werner Lemberg
Copyright © 2016  Igalia S.L.
Copyright © 2022  Matthias Clasen
Copyright © 2018,2021  Khaled Hosny
Copyright © 2018,2019,2020  Adobe, Inc
Copyright © 2013-2015  Alexei Podtelezhnikov

For full copyright notices consult the individual files in the package.


Permission is hereby granted, without written agreement and without
license or royalty fees, to use, copy, modify, and distribute this
software and its documentation for any purpose, provided that the
above copyright notice and the following two paragraphs appear in
all copies of this software.

IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE TO ANY PARTY FOR
DIRECT, INDIRECT, SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES
ARISING OUT OF THE USE OF THIS SOFTWARE AND ITS DOCUMENTATION, EVEN
IF THE COPYRIGHT HOLDER HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH
DAMAGE.

THE COPYRIGHT HOLDER SPECIFICALLY DISCLAIMS ANY WARRANTIES, INCLUDING,
BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS FOR A PARTICULAR PURPOSE.  THE SOFTWARE PROVIDED HEREUNDER IS
ON AN "AS IS" BASIS, AND THE COPYRIGHT HOLDER HAS NO OBLIGATION TO
PROVIDE MAINTENANCE, SUPPORT, UPDATES, ENHANCEMENTS, OR MODIFICATIONS.
`;

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
    // harfbuzzjs's own LICENSE covers harfbuzzjs only (it does not reproduce
    // HarfBuzz's licence and the package ships no COPYING), so HarfBuzz's
    // Old MIT terms are carried here.
    parts.push(HARFBUZZ_COPYING);
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
