/**
 * The opt-in, knext-patched Bun toolchain for the `bun build --compile` step.
 *
 *   // knext.config.ts
 *   compile: { bun: "knext-patched", include: ["./plugins/**"] }
 *
 * The default is stock Bun on PATH, unchanged: with no `compile` block (or
 * `bun: "stock"`) nothing here fetches, caches or runs anything.
 *
 * Opted in, `knext build` downloads ONE pinned release asset —
 * `bun-v1.4.2` plus the `--compile --include` patch (oven-sh/bun#44059),
 * built from `deploy/bun-patched/` — into a per-user cache, checks it against
 * the sha256 EMBEDDED below, and runs the compile script with it. The check is
 * fail-closed: a mismatch, an HTTP error or a network error is a build error,
 * never a silent fall back to stock Bun (a build that quietly drops the
 * patched toolchain would ship a binary without its `--include` files). A
 * cached binary is re-hashed on every use, so a tampered cache is re-fetched,
 * not trusted.
 *
 * What this does NOT verify: the release's cosign signature. Verifying a
 * sigstore bundle offline needs the sigstore trust root and a verifier knext
 * does not ship; the embedded sha256 is the binding check, and it was itself
 * taken from the build the signature covers. Verify the signature manually
 * with the `cosign verify-blob` command in the docs.
 *
 * The patched binary is used for the COMPILE STEP ONLY. The shipped
 * executable's runtime is still the stock Bun base for the target: the ship
 * target is `bun-linux-*-musl`, which Bun cross-compiles by downloading its own
 * stock base for that target, never by copying the (glibc) patched compiler.
 *
 * RETIREMENT: delete this module, the `compile.bun` option and
 * `deploy/bun-patched/` once a stock Bun release ships oven-sh/bun#44059. The
 * `bun-patched-toolchain` probe in tests/upstream-retirement/registry.ts goes
 * red on the first stock Bun that embeds through `--compile --include`.
 *
 * ADR-0001: this module writes only to the local build cache.
 */
// Retirement probe: `bun-patched-toolchain` (tests/upstream-retirement/registry.ts).

import { createHash, randomBytes } from "node:crypto";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BunToolchainId, CompileConfigShape } from "./compile-config";
import { UsageError } from "./shared";
import { detectLinuxLibc, type LinuxLibc } from "./vinext-build";

export {
    BUN_TOOLCHAINS,
    type BunToolchainId,
    validateCompileConfig,
} from "./compile-config";

export interface BunToolchainAsset {
    /** Release asset name. */
    readonly file: string;
    /** sha256 of the asset bytes, lowercase hex. The binding check. */
    readonly sha256: string;
}

export interface BunToolchainPins {
    /** The GitHub release tag the assets hang off. */
    readonly tag: string;
    /** The stock Bun release the patch is applied to. */
    readonly bunVersion: string;
    /** `https://github.com/<repo>/releases/download/<tag>`. */
    readonly baseUrl: string;
    /** Keyed by `patchedBunPlatformKey()`. */
    readonly assets: Readonly<Record<string, BunToolchainAsset>>;
}

/**
 * The pinned patched toolchain. Built by `deploy/bun-patched/` on Cloud Build,
 * published and signed by `.github/workflows/bun-patched-release.yml`. A new
 * build is a new tag and new sha256s here, in the same change.
 */
export const PATCHED_BUN: BunToolchainPins = {
    tag: "bun-patched-1.4.2-knext.1",
    bunVersion: "1.4.2",
    baseUrl:
        "https://github.com/getknext-dev/knext/releases/download/bun-patched-1.4.2-knext.1",
    assets: {
        "linux-x64": {
            file: "bun-linux-x64",
            // Cloud Build 67b747f8 (gsw-mcp): bun-v1.4.2 + patch 001, HEAD cc97fa834.
            sha256: "2f1bb84ad480fce9e618b8bf4b7eb4553d5a1179d2013c7d22cbe054ca271df3",
        },
    },
};

/** The keyless-signing identity of the release workflow, for `cosign verify-blob`. */
export const PATCHED_BUN_SIGNER = `https://github.com/getknext-dev/knext/.github/workflows/bun-patched-release.yml@refs/tags/${PATCHED_BUN.tag}`;

/** The resolved compiler for the `bun build --compile` step. */
export interface CompileBun {
    readonly id: BunToolchainId;
    /** What to exec: `bun` (PATH) for stock, an absolute verified path otherwise. */
    readonly bin: string;
}

export interface HostPlatform {
    readonly platform: string;
    readonly arch: string;
    readonly libc: LinuxLibc;
}

type FetchLike = (url: string) => Promise<{
    ok: boolean;
    status: number;
    arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface ToolchainDeps {
    readonly fetch?: FetchLike;
    readonly host?: HostPlatform;
    readonly cacheDir?: string;
    readonly pins?: BunToolchainPins;
    readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Which pinned asset this host can run, or undefined. glibc linux only: the
 * builds link against glibc 2.31. musl hosts are refused on purpose — a musl
 * host compiling for the musl ship target would embed the compiler ITSELF as
 * the shipped runtime, and this toolchain is for the compile step only.
 */
export function patchedBunPlatformKey(host: HostPlatform): string | undefined {
    if (host.platform !== "linux" || host.libc !== "gnu") return undefined;
    if (host.arch === "x64") return "linux-x64";
    if (host.arch === "arm64") return "linux-arm64";
    return undefined;
}

export function currentHost(): HostPlatform {
    return {
        platform: process.platform,
        arch: process.arch,
        libc: process.platform === "linux" ? detectLinuxLibc() : "gnu",
    };
}

/** `$KNEXT_CACHE_DIR` → `$XDG_CACHE_HOME/knext` → `~/.cache/knext`, then `bun-patched/<tag>`. */
export function patchedBunCacheDir(
    env: Readonly<Record<string, string | undefined>>,
    home: string,
    tag: string,
): string {
    const root = env.KNEXT_CACHE_DIR
        ? env.KNEXT_CACHE_DIR
        : env.XDG_CACHE_HOME
          ? join(env.XDG_CACHE_HOME, "knext")
          : join(home, ".cache", "knext");
    return join(root, "bun-patched", tag);
}

const sha256Hex = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");

/**
 * Download (or reuse) the pinned patched Bun for this host and return its
 * absolute path. Every path out of here either returns bytes whose sha256
 * equals the embedded pin, or throws.
 */
export async function ensurePatchedBun(
    deps: ToolchainDeps = {},
): Promise<string> {
    const pins = deps.pins ?? PATCHED_BUN;
    const host = deps.host ?? currentHost();
    const key = patchedBunPlatformKey(host);
    const supported = Object.keys(pins.assets).join(", ");
    if (!key) {
        throw new UsageError(
            `compile.bun: 'knext-patched' is not available on ${host.platform}-${host.arch}` +
                `${host.platform === "linux" ? ` (${host.libc})` : ""}. ` +
                `The patched Bun toolchain is published for: ${supported} (glibc).\n\n` +
                "Remove `compile.bun` (or set it to 'stock') to build with the Bun on PATH, " +
                "or run `knext build` on a supported host (for example a linux-x64 CI runner).",
        );
    }
    const asset = pins.assets[key];
    if (!asset) {
        throw new UsageError(
            `compile.bun: 'knext-patched' has no pinned build for ${key} in ${pins.tag} ` +
                `(pinned: ${supported}). Remove \`compile.bun\` or build on a pinned platform.`,
        );
    }

    const dir =
        deps.cacheDir ??
        patchedBunCacheDir(deps.env ?? process.env, homedir(), pins.tag);
    const target = join(dir, asset.file);
    if (existsSync(target)) {
        if (sha256Hex(readFileSync(target)) === asset.sha256) return target;
        // Never trust a cache entry that no longer matches: drop it and re-fetch.
        rmSync(target, { force: true });
    }

    const url = `${pins.baseUrl}/${asset.file}`;
    const fetchFn: FetchLike =
        deps.fetch ??
        ((u: string) => globalThis.fetch(u) as ReturnType<FetchLike>);
    let bytes: Uint8Array;
    try {
        const res = await fetchFn(url);
        if (!res.ok) {
            throw new UsageError(
                `Downloading the patched Bun toolchain failed: HTTP ${res.status} for ${url}. ` +
                    "Nothing was installed; the build does not fall back to stock Bun.",
            );
        }
        bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
        if (err instanceof UsageError) throw err;
        throw new UsageError(
            `Downloading the patched Bun toolchain failed for ${url}: ` +
                `${err instanceof Error ? err.message : String(err)}. ` +
                "Nothing was installed; the build does not fall back to stock Bun.",
        );
    }

    const got = sha256Hex(bytes);
    if (got !== asset.sha256) {
        throw new UsageError(
            `The patched Bun toolchain failed verification: sha256 mismatch for ${url}\n` +
                `  expected ${asset.sha256} (embedded in knext)\n` +
                `  got      ${got}\n` +
                "The download was discarded and nothing was installed. The build does not fall back to stock Bun.",
        );
    }

    mkdirSync(dir, { recursive: true });
    const partial = join(
        dir,
        `.${asset.file}.${randomBytes(6).toString("hex")}.partial`,
    );
    try {
        writeFileSync(partial, bytes, { mode: 0o755 });
        chmodSync(partial, 0o755);
        renameSync(partial, target);
    } finally {
        rmSync(partial, { force: true });
    }
    return target;
}

/** Which Bun runs the compile step for this config. Default: stock `bun` on PATH. */
export async function resolveCompileBun(
    config: CompileConfigShape,
    deps: ToolchainDeps = {},
): Promise<CompileBun> {
    const compile = config.compile as { bun?: unknown } | undefined;
    if (compile?.bun !== "knext-patched") return { id: "stock", bin: "bun" };
    return { id: "knext-patched", bin: await ensurePatchedBun(deps) };
}

/** Did this config opt in to the patched toolchain? */
export function wantsPatchedBun(config: CompileConfigShape): boolean {
    return (
        (config.compile as { bun?: unknown } | undefined)?.bun ===
        "knext-patched"
    );
}

/**
 * Everything the compile step needs from the `compile` block: which Bun to run
 * and the user's include globs. The default config resolves to `{}` — the
 * compile argv is then exactly the pre-option one.
 */
export async function resolveCompileToolchain(
    config: CompileConfigShape,
    deps: ToolchainDeps = {},
): Promise<{ bin?: string; include?: string[] }> {
    if (!wantsPatchedBun(config)) return {};
    const bun = await resolveCompileBun(config, deps);
    const include = compileIncludeGlobs(config);
    return include.length > 0 ? { bin: bun.bin, include } : { bin: bun.bin };
}

/** The user-declared `--include` globs, or none. */
export function compileIncludeGlobs(config: CompileConfigShape): string[] {
    const compile = config.compile as { include?: unknown } | undefined;
    return Array.isArray(compile?.include) ? [...compile.include] : [];
}
