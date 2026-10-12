import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Scans over the CDN purge module's SOURCE (ADR-0068 D1, D10).
 *
 * Each one is a negative claim that behavioural tests cannot make: the absence
 * of a dependency, of an inbound route, of a second place the provider URL could
 * come from. They SCAN the module directory rather than enumerate files, so a
 * file added next month is covered without anyone remembering to list it. An
 * empty scan fails — a scan over zero files reads as a clean tree.
 */
const here = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(here, "../..");
const REPO = resolve(PKG, "../..");
const MODULE_DIR = resolve(PKG, "src/adapters/cdn-purge");

function sources(): { file: string; text: string }[] {
    const files = readdirSync(MODULE_DIR).filter((f) =>
        /\.(js|mjs|cjs)$/.test(f),
    );
    return files.map((f) => ({
        file: f,
        text: readFileSync(join(MODULE_DIR, f), "utf8"),
    }));
}

/** Source with comments removed, so prose cannot satisfy or trip a scan. */
function code(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:'"`\\])\/\/.*$/gm, "$1");
}

/**
 * The argument text of every `say(`, `sayOnce(` and `log.<level>(` call, found
 * by balancing parentheses (a message spans lines, so a per-line grep would
 * inspect only the opening line). Quoted/template text is skipped when counting.
 */
function logCalls(src: string): string[] {
    const out: string[] = [];
    for (const m of src.matchAll(
        /\b(?:say|sayOnce|log\.(?:info|warn|error))\(/g,
    )) {
        let depth = 1;
        let quote = "";
        let i = (m.index ?? 0) + m[0].length;
        const start = i;
        for (; i < src.length && depth > 0; i++) {
            const ch = src[i] as string;
            if (quote) {
                if (ch === "\\") i++;
                else if (ch === quote) quote = "";
            } else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
            else if (ch === "(") depth++;
            else if (ch === ")") depth--;
        }
        out.push(src.slice(start, i));
    }
    return out;
}

describe("no cloud SDK, no signer, no dependency (ADR-0068 D1.1)", () => {
    it("the module is non-empty (a scan over nothing proves nothing)", () => {
        expect(sources().length).toBeGreaterThanOrEqual(4);
    });

    it("imports only node: builtins and sibling files", () => {
        const specifiers: string[] = [];
        for (const { text } of sources()) {
            const c = code(text);
            for (const m of c.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g))
                specifiers.push(m[1] as string);
            for (const m of c.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g))
                specifiers.push(m[1] as string);
            for (const m of c.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g))
                specifiers.push(m[1] as string);
        }
        expect(specifiers.length).toBeGreaterThan(0);
        const bad = specifiers.filter(
            (s) =>
                !(
                    s.startsWith("node:") ||
                    s.startsWith("./") ||
                    s.startsWith("../")
                ),
        );
        expect(bad).toEqual([]);
    });

    it("computes no request signature (no HMAC / sign / SigV4 / OAuth)", () => {
        for (const { file, text } of sources()) {
            const c = code(text);
            expect({
                file,
                hit: /createHmac|createSign|sigv4|oauth|aws4/i.test(c),
            }).toEqual({
                file,
                hit: false,
            });
        }
    });

    it("packages/kn-next gains no cloud-SDK dependency", () => {
        const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
        const names = Object.keys({
            ...pkg.dependencies,
            ...pkg.devDependencies,
            ...pkg.optionalDependencies,
            ...pkg.peerDependencies,
        });
        // `@google-cloud/storage` pre-dates this module (GCS asset upload).
        const sdk =
            /^(@aws-sdk\/|aws-sdk$|aws4|@azure\/|google-auth-library$|googleapis$|@google-cloud\/(?!storage$)|oci-|cloudflare$)/;
        expect(names.filter((n) => sdk.test(n))).toEqual([]);
    });

    it("the operator gains no CDN-provider SDK (it carries no cloud-specific purge, D1.4)", () => {
        const gomod = readFileSync(
            join(REPO, "packages/kn-next-operator/go.mod"),
            "utf8",
        );
        // The AWS S3 client pre-dates this work (object-storage integration).
        const forbidden = [
            "aws-sdk-go-v2/service/cloudfront",
            "cloud.google.com/go/compute",
            "google.golang.org/api",
            "Azure/azure-sdk-for-go",
            "oracle/oci-go-sdk",
            "cloudflare/cloudflare-go",
        ];
        expect(forbidden.filter((f) => gomod.includes(f))).toEqual([]);
    });
});

describe("no new inbound route (ADR-0068 D10)", () => {
    it("the module opens no listener and serves nothing", () => {
        for (const { file, text } of sources()) {
            const c = code(text);
            expect({
                file,
                hit: /createServer|\.listen\(|Bun\.serve|http\.Server|node:http2?['"]|node:net['"]/.test(
                    c,
                ),
            }).toEqual({ file, hit: false });
        }
    });
});

describe("the provider URL is a constant (ADR-0068 D10)", () => {
    it("the Cloudflare API base appears as a literal exactly once across the module", () => {
        const all = sources()
            .map((s) => code(s.text))
            .join("\n");
        expect(all.match(/https:\/\/api\.cloudflare\.com/g)?.length).toBe(1);
    });

    it("the only env var that can carry a URL is KNEXT_CDN_EMULATOR_ENDPOINT", () => {
        const names = new Set<string>();
        for (const { text } of sources()) {
            for (const m of code(text).matchAll(
                /\b(KNEXT_CDN_[A-Z_]+|CLOUDFLARE_[A-Z_]+)\b/g,
            )) {
                names.add(m[1] as string);
            }
        }
        expect([...names].sort()).toEqual(
            [
                "KNEXT_CDN_EMULATOR_ENDPOINT",
                "KNEXT_CDN_PROVIDER",
                "KNEXT_CDN_PURGE_RPM",
                "KNEXT_CDN_PURGE_TARGET",
                "KNEXT_CDN_PURGE_TOKEN",
                "KNEXT_CDN_TAG_PREFIX",
            ].sort(),
        );
    });

    it("every fetch is made with redirect handling that cannot forward the token", () => {
        const all = sources()
            .map((s) => code(s.text))
            .join("\n");
        expect(all).toMatch(/redirect:\s*['"](manual|error)['"]/);
        expect(all).not.toMatch(/redirect:\s*['"]follow['"]/);
    });
});

describe("the token is read in one place and never interpolated into a message", () => {
    it("KNEXT_CDN_PURGE_TOKEN is referenced exactly once", () => {
        const all = sources()
            .map((s) => code(s.text))
            .join("\n");
        expect(all.match(/KNEXT_CDN_PURGE_TOKEN/g)?.length).toBe(1);
    });

    it("no log call formats an error message, a stack, a cause, a header or the credential", () => {
        let inspected = 0;
        for (const { file, text } of sources()) {
            for (const call of logCalls(code(text))) {
                inspected += 1;
                expect({
                    file,
                    call,
                    hit: /\.message|\.stack|\.cause|headers|authorization|bearer|token|bearer\(/i.test(
                        call,
                    ),
                }).toEqual({ file, call, hit: false });
            }
        }
        // A scan over zero calls would read as a clean tree.
        expect(inspected).toBeGreaterThan(4);
    });
});
