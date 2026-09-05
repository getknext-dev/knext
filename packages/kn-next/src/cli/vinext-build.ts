/**
 * The vinext → single-executable build path (ADR-0048).
 *
 * `kn-next build` previously ran only the app's `npm run build` and looked for
 * `.next/standalone`. ADR-0048 makes `build: vinext` + `runtime: bun` the only
 * supported target, so the CLI has to be able to PRODUCE that artifact rather
 * than merely describe where it lands.
 *
 * Two steps, mirroring `examples/bun-exec/build.sh`, which is the recipe this
 * was measured against:
 *
 *   1. `vite build`  — vinext emits a nitro **bun-preset** `.output`, entry
 *                      `.output/server/index.mjs`.
 *   2. `bun build --compile --minify --bytecode --target=<t>` — bakes that
 *      entry, every route it reaches, and V8 bytecode into one executable.
 *
 * The bytecode flag is not optional here and is the reason for the measured
 * cold start: 61 ms median against node-standalone's 884 ms on an identical
 * app (`docs/benchmarks/vinext-bun14-single-exec-2026-08-27.md`).
 *
 * ## The Bun floor is 1.4.0, and it is a floor rather than a preference
 *
 * Measured, both directions:
 *   - Bun 1.3.5 compiles a working binary but is **2× slower to cold start**
 *     (121 ms vs 61 ms) on the same source.
 *   - Bun 1.3.5 cannot serve a Next standalone tree at all (HTTP 500,
 *     `Expected CommonJS module to have a function`), which is why the retired
 *     `runtime: bun` + turbopack combination was never viable on it.
 *
 * So the build refuses to run under < 1.4.0 rather than silently producing a
 * slower artifact whose provenance nobody records.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runQuiet } from "./exec";
import {
    findLockfile,
    formatLockedVersions,
    INTEGRITY_MANIFEST_NAME,
    type LockedPackage,
    readLockfilePackages,
    writeNativeIntegrityManifest,
} from "./native-integrity";
import { UsageError } from "./shared";

/** The first Bun that ADR-0048 accepts. See the docstring for the measurements. */
export const MIN_BUN_MAJOR = 1;
export const MIN_BUN_MINOR = 4;

/**
 * `bun build --compile` target triples, keyed by knext's arch names.
 *
 * The bare `linux-*` keys are MUSL, because that is what the shipped image is
 * (`FROM alpine` + `apk add libstdc++ libgcc` — see the reference Dockerfile and
 * `alpine-image.docker-e2e.test.ts`). The `-gnu` keys exist only for the
 * post-compile smoke (#894): those binaries are dynamically linked against musl
 * and a glibc host cannot execute them at all, so a smoke on a Debian/Ubuntu
 * runner has to compile against glibc or it would report a boot failure for
 * every CORRECT build. Nothing SHIPS a `-gnu` binary.
 */
const COMPILE_TARGETS: Record<string, string> = {
    "linux-x64": "bun-linux-x64-musl",
    "linux-arm64": "bun-linux-arm64-musl",
    "linux-x64-gnu": "bun-linux-x64",
    "linux-arm64-gnu": "bun-linux-arm64",
    "darwin-arm64": "bun-darwin-arm64",
    "darwin-x64": "bun-darwin-x64",
};

/** Smoke-only, glibc-linked: never put one of these in the alpine image. */
const SMOKE_ONLY_ARCHES = ["linux-x64-gnu", "linux-arm64-gnu"] as const;

/** Derived, never a second hand-maintained list — the two must stay disjoint. */
const SHIPPABLE_ARCHES = Object.keys(COMPILE_TARGETS).filter(
    (a) => !SMOKE_ONLY_ARCHES.includes(a as (typeof SMOKE_ONLY_ARCHES)[number]),
);

/**
 * `major.minor` of a Bun version string, or undefined if unreadable.
 *
 * Leading digits only, so a prerelease (`1.4.0-canary.x`) reads as 1.4 — a
 * canary of a release that carries the fix does carry it. NUMERIC compare:
 * `"1.10.0" < "1.4.0"` lexically, and a string comparison would reject a newer
 * Bun forever.
 */
export function parseBunVersion(
    version: string,
): { major: number; minor: number } | undefined {
    const m = /^(\d+)\.(\d+)/.exec(version.trim());
    if (!m) return undefined;
    return { major: Number(m[1]), minor: Number(m[2]) };
}

/** Does this Bun meet ADR-0048's floor? Unparseable is NOT accepted. */
export function bunMeetsFloor(version: string): boolean {
    const v = parseBunVersion(version);
    if (!v) return false;
    if (v.major !== MIN_BUN_MAJOR) return v.major > MIN_BUN_MAJOR;
    return v.minor >= MIN_BUN_MINOR;
}

/**
 * The `bun build --compile` argv for this target and entry.
 *
 * Exported so a test can assert the flags rather than trusting prose: dropping
 * `--bytecode` would still produce a working binary, just a slow one, and that
 * is exactly the regression nobody would notice without an assertion.
 */
export function compileArgv(
    arch: string,
    entry: string,
    outFile: string,
): string[] {
    const target = COMPILE_TARGETS[arch];
    if (!target) {
        // The two lists are kept APART on purpose. Advertising the `-gnu` keys
        // as buildable invites someone to compile one and put it in the image,
        // where the alpine base has no glibc and it cannot run at all — the
        // exact class of failure the alpine e2e exists to catch. They are
        // reachable only through `hostSmokeArch()`.
        throw new UsageError(
            `Unknown build arch '${arch}'. Shippable targets: ${SHIPPABLE_ARCHES.join(", ")}.\n\n` +
                `(${SMOKE_ONLY_ARCHES.join(", ")} also compile, but exist ONLY for the post-compile smoke's\n` +
                "host-arch binary — they are glibc-linked and the shipped alpine image cannot run them.)",
        );
    }
    // `bun run <script>`, not `bun build`. The compile needs BUILD PLUGINS and
    // the CLI has no `--plugin`:
    //
    //   - `--bytecode` emits CommonJS, where the nitro bundle's `import.meta` is
    //     a syntax error — the bare command fails with `Failed to generate
    //     bytecode for ./index.js`;
    //   - sharp's native addon cannot be resolved from inside a compiled binary,
    //     so its loader is swapped for a `process.dlopen` shim. Without that,
    //     `/_next/image` silently serves unoptimized originals.
    //
    // The script ships in this package, so a user's `kn-next build` gets the same
    // treatment knext's own reference app does rather than a second copy that
    // drifts.
    return [
        "bun",
        "run",
        compileScriptPath(),
        "--entry",
        entry,
        "--outfile",
        outFile,
        "--target",
        target,
    ];
}

/**
 * The shipped compile script, resolved from THIS module rather than by package
 * name: the CLI is bundled to `dist/cli/`, and the script sits in
 * `dist/adapters/`, so a bare specifier would resolve against the consumer's
 * tree instead of ours.
 */
export function compileScriptPath(): string {
    return join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "adapters",
        "vinext-compile.js",
    );
}

/** glibc or musl, for a linux host. Injectable so both branches are testable. */
export type LinuxLibc = "gnu" | "musl";

/**
 * Which libc this linux host runs.
 *
 * `process.report` carries `glibcVersionRuntime` on a glibc build and omits it
 * on musl — the same signal node's own `detect-libc` consumers use. The
 * loader-path fallback covers a runtime that does not expose the report.
 */
export function detectLinuxLibc(): LinuxLibc {
    try {
        const report = process.report?.getReport();
        const header =
            typeof report === "object" && report !== null
                ? (report as { header?: { glibcVersionRuntime?: string } })
                      .header
                : undefined;
        if (header?.glibcVersionRuntime) return "gnu";
    } catch {
        // fall through to the loader probe
    }
    const muslLoaders = [
        "/lib/ld-musl-x86_64.so.1",
        "/lib/ld-musl-aarch64.so.1",
    ];
    return muslLoaders.some((p) => existsSync(p)) ? "musl" : "gnu";
}

/**
 * The arch key whose binary THIS machine can actually execute (#894).
 *
 * The smoke has to boot the thing it just compiled, and the ship target is
 * `bun-linux-*-musl` — unrunnable on a darwin host and on a glibc linux host
 * alike. Rather than a container run (which would put docker on the critical
 * path of every build), the smoke compiles a second, HOST-arch binary and boots
 * that; the cross-compiled linux-musl artifact stays proved by the alpine
 * container e2e, which is where a cross-target claim belongs.
 *
 * Throws rather than guessing on an unsupported host: a wrong guess produces a
 * binary that cannot exec, which the smoke would then report as a broken app.
 */
export function hostSmokeArch(
    platform: string = process.platform,
    arch: string = process.arch,
    libc: () => LinuxLibc = detectLinuxLibc,
): string {
    const key =
        platform === "darwin"
            ? `darwin-${arch}`
            : platform === "linux"
              ? libc() === "musl"
                  ? `linux-${arch}`
                  : `linux-${arch}-gnu`
              : "";
    if (!key || !COMPILE_TARGETS[key]) {
        throw new UsageError(
            `The post-compile smoke cannot run on ${platform}/${arch} — knext has no bun compile target for it.\n\n` +
                `Known targets: ${Object.keys(COMPILE_TARGETS).join(", ")}.\n` +
                "Pass --skip-smoke to build anyway; the binary will be UNVERIFIED.",
        );
    }
    return key;
}

/** What the smoke should boot: the ship binary itself, or a host-arch twin. */
export interface SmokeBinaryPlan {
    readonly arch: string;
    readonly outFile: string;
    readonly reuseShipBinary: boolean;
}

/**
 * Reuse the ship binary when the host IS the ship target, else plan a second
 * compile. The second compile costs seconds and is the price of booting the
 * artifact at all on a developer machine; reusing it when the arch matches
 * keeps the linux-musl CI path down to one.
 *
 * The name never contains a runtime word (`bun`, `node`): the asset-root
 * resolver classifies a compiled binary by basename, and those names make it
 * read the BUILD TREE's assets silently.
 */
export function smokeBinaryPlan(
    shipArch: string,
    hostArch: string,
): SmokeBinaryPlan {
    if (shipArch === hostArch) {
        return {
            arch: shipArch,
            outFile: `knext-exec-${shipArch}`,
            reuseShipBinary: true,
        };
    }
    return {
        arch: hostArch,
        outFile: `knext-smoke-${hostArch}`,
        reuseShipBinary: false,
    };
}

export interface VinextBuildOptions {
    /** App root. */
    readonly cwd: string;
    /** Target arch; defaults to the ship target. */
    readonly arch?: string;
    /** Output binary path, relative to cwd. */
    readonly outFile?: string;
    /** Injectable for tests; the real runner inherits stderr. */
    readonly run?: (argv: readonly string[]) => void;
    /** Injectable for tests. */
    readonly bunVersion?: string;
    /**
     * Skip step 1 (`vite build`) and compile an EXISTING `.output`. The caller
     * that sets this is `kn-next build`, which has just run the app's own
     * build script — running vite twice would double the slowest part of the
     * build for nothing. The `.output` existence check still runs either way.
     */
    readonly skipViteBuild?: boolean;
}

/**
 * Run the two-step vinext build. Returns the produced binary's path.
 *
 * Never names the output after a runtime (`bun`, `node`, …): the asset-root
 * resolver classifies a compiled binary by basename, so those names make it
 * read the BUILD TREE's assets silently.
 */
export function buildVinextExecutable(opts: VinextBuildOptions): string {
    const run = opts.run ?? runQuiet;
    const arch = opts.arch ?? "linux-x64";
    const outFile = opts.outFile ?? `knext-exec-${arch}`;

    const version = opts.bunVersion ?? detectBunVersion(run);
    if (!bunMeetsFloor(version)) {
        throw new UsageError(
            `The vinext single-executable target requires Bun ${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}.0 or newer; found '${version}'.\n\n` +
                "Bun 1.3.x compiles a binary that boots roughly twice as slowly (121ms vs 61ms measured),\n" +
                "so knext refuses it rather than shipping a slower artifact silently. Upgrade with `bun upgrade`.",
        );
    }

    // 1. vinext → nitro bun-preset .output
    if (!opts.skipViteBuild) {
        run(["npx", "vite", "build"]);
    }

    const entry = join(".output", "server", "index.mjs");
    if (!existsSync(join(opts.cwd, entry))) {
        throw new UsageError(
            `The vinext build finished but '${entry}' is not there.\n\n` +
                "That entry is what gets compiled into the executable, so the image would have nothing to run.\n" +
                "Check that this app's vite config uses the nitro bun preset.",
        );
    }

    // 2. compile + bytecode
    run(compileArgv(arch, entry, outFile));

    // 3. stage sharp's native module beside the binary — for the arch being
    // compiled, which is NOT necessarily the host's (#949).
    stageSharpNative(opts.cwd, { arch });

    return outFile;
}

/**
 * sharp's per-platform package suffix (`@img/sharp-<id>`) for each knext arch.
 *
 * The linux entries are `linuxmusl` — one word, sharp's own spelling, which
 * this repo has already guessed wrong once — because the runtime image is
 * alpine and the compile triples are `-musl`. A glibc addon in that image
 * cannot load, so the map is the compile-target map's shadow: an arch added to
 * one belongs in the other, and a test derives the pairing from
 * `compileArgv`'s own known-arch list rather than an enumerated copy.
 */
export const SHARP_PLATFORM_IDS: Record<string, string> = {
    "linux-x64": "linuxmusl-x64",
    "linux-arm64": "linuxmusl-arm64",
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
};

export interface StageSharpNativeOptions {
    /** Image target arch; defaults to the ship target, like the compile. */
    readonly arch?: string;
    /** Injectable for tests; the real one fetches from the npm registry. */
    readonly fetchPackage?: (
        pkg: { name: string; version: string; integrity: string | null },
        destDir: string,
    ) => void;
}

/**
 * Stage sharp's native packages for the IMAGE TARGET into `<cwd>/native`, which
 * the generated Dockerfile COPYs into the image.
 *
 * A compiled binary cannot resolve a package from disk, so sharp's addon has to
 * be a real file next to the executable, opened by absolute path. And it has to
 * be the addon the IMAGE can run: this function used to copy whatever the build
 * host's install held under `node_modules/@img`, which on a mac is the darwin
 * set — the alpine image then shipped with no linuxmusl addon at all and every
 * macOS-built deploy crash-looped at import (#949, S3-V finding C-1a). So the
 * target's package pair is selected by name, taken from the host install when
 * it is there and fetched at the lockfile-pinned version when it is not, and
 * the host's own platform addons are never staged for a foreign target.
 *
 * The directory is created even when the app has no sharp, because the
 * Dockerfile's `COPY native` would otherwise fail the build for every app that
 * does not use `next/image`. It is also cleared first: a rebuild must not
 * inherit a previous build's (possibly foreign-platform) addons.
 *
 * Whatever lands here is then PINNED — every staged `@img` package checked
 * against the app's `bun.lock` and every staged file hashed into
 * `native/.integrity.json`, which the dlopen shim re-checks in the image. This
 * copy is otherwise an unguarded path from the install store to native-code
 * privilege, and the closure SBOM does not cover `/app/native`.
 */
export function stageSharpNative(
    cwd: string,
    opts: StageSharpNativeOptions = {},
): void {
    const arch = opts.arch ?? "linux-x64";
    const platformId = SHARP_PLATFORM_IDS[arch];
    if (!platformId) {
        throw new UsageError(
            `Unknown build arch '${arch}'. Known: ${Object.keys(SHARP_PLATFORM_IDS).join(", ")}.`,
        );
    }

    const dest = join(cwd, "native");
    clearStagedNative(dest);
    mkdirSync(dest, { recursive: true });

    const imgRoot = findImgPackages(cwd);
    const lockfilePath = findLockfile(cwd);
    const locked = lockfilePath
        ? readLockfilePackages(lockfilePath)
        : undefined;

    // Every directory THIS run writes, so a mid-staging failure can unwind
    // them (#958 round 3, I1). Without the unwind, a failed second fetch (or a
    // manifest refusal after the copies) left native/ holding content with no
    // manifest — and the NEXT build's ownership refusal then blamed the user
    // for knext's own residue, permanently, since every retry re-hit it.
    const stagedThisRun: string[] = [];
    try {
        if (appUsesSharp(cwd, imgRoot, locked)) {
            // Read once, used by the fetch path to disambiguate a lockfile
            // that pins an @img package at two versions at once (#954).
            const resolvedSharp = readResolvedSharpManifest(cwd);
            // The addon links libvips by RELATIVE rpath, so the pair ships
            // together in its original layout or `dlopen` fails resolving
            // `libvips-cpp` after finding the addon.
            for (const dir of [
                `sharp-${platformId}`,
                `sharp-libvips-${platformId}`,
            ]) {
                const hostDir =
                    imgRoot === undefined ? undefined : join(imgRoot, dir);
                const destDir = join(dest, dir);
                // Enrolled BEFORE the write, so even a half-finished copy or
                // fetch is unwound.
                stagedThisRun.push(destDir);
                if (hostDir !== undefined && existsSync(hostDir)) {
                    // `dereference` follows the symlinks a bun/pnpm isolated
                    // store uses; copying the links would put dangling
                    // pointers in the image.
                    cpSync(hostDir, destDir, {
                        recursive: true,
                        dereference: true,
                    });
                    continue;
                }
                // The host install lacks the target's package — a macOS build
                // host, or an install layout the candidate walk cannot see
                // (pnpm's `.pnpm` store). Fetch the exact version the lockfile
                // pins, or fail the build NAMING the missing addon; the one
                // outcome that is never acceptable is an image that cannot
                // load sharp (#949).
                const name = `@img/${dir}`;
                if (!lockfilePath || locked === undefined) {
                    throw new UsageError(
                        `This app uses sharp, the image targets ${platformId}, and this host's install has no '${name}' — and there is no bun.lock to fetch a pinned version from.\n\n` +
                            "Run `bun install --save-text-lockfile` in the app and rebuild.",
                    );
                }
                const versions = locked.get(name);
                if (!versions || versions.length === 0) {
                    throw new UsageError(
                        `The image targets ${platformId}, but neither this host's install nor ${lockfilePath} has '${name}' — the image would ship unable to load sharp.\n\n` +
                            "sharp resolves its native addons as optionalDependencies, so the lockfile\n" +
                            "normally pins every platform's package. Reinstall from a clean lockfile\n" +
                            "(`bun install --save-text-lockfile`) with a sharp version that publishes\n" +
                            `'${name}', and rebuild.`,
                    );
                }
                const entry = pickFetchVersion(
                    name,
                    versions,
                    resolvedSharp,
                    lockfilePath,
                );
                (opts.fetchPackage ?? fetchImgPackage)(
                    {
                        name,
                        version: entry.version,
                        integrity: entry.integrity,
                    },
                    destDir,
                );
            }
        }

        // Unconditional, including the empty case: a `native/` with no
        // manifest is indistinguishable from one whose manifest was stripped,
        // and the shim reads absence as "legacy image, load unverified".
        // Inside the try because its refusals (lockfile pin disagreements)
        // throw AFTER the copies — the same wedge, one step later.
        writeNativeIntegrityManifest(dest, lockfilePath);
    } catch (error) {
        for (const d of stagedThisRun) {
            rmSync(d, { recursive: true, force: true });
        }
        // Any manifest present is this run's partial product — the previous
        // build's was removed by clearStagedNative above.
        rmSync(join(dest, INTEGRITY_MANIFEST_NAME), { force: true });
        throw error;
    }
}

/**
 * Does this app pull sharp into its bundle? ANY signal counts:
 *
 *   - an installed `@img` tree (the original signal),
 *   - the lockfile resolving `sharp` or any `@img/*` package,
 *   - the app's own `package.json` declaring `sharp`.
 *
 * The union matters because the first two are LAYOUT-dependent: a pnpm install
 * keeps `@img` under `.pnpm` where the candidate walk cannot see it, and
 * inferring "no sharp" from that absence ships an empty `native/` — the exact
 * silent crash-loop class #949 closes. With the signal true and no source
 * findable, staging fails NAMING the missing addon instead of staging nothing.
 */
function appUsesSharp(
    cwd: string,
    imgRoot: string | undefined,
    locked: ReturnType<typeof readLockfilePackages> | undefined,
): boolean {
    if (
        imgRoot !== undefined &&
        readdirSync(imgRoot).some((entry) => entry.startsWith("sharp-"))
    ) {
        return true;
    }
    if (
        locked !== undefined &&
        (locked.has("sharp") ||
            [...locked.keys()].some((k) => k.startsWith("@img/")))
    ) {
        return true;
    }
    try {
        const pkg = JSON.parse(
            readFileSync(join(cwd, "package.json"), "utf8"),
        ) as Record<string, Record<string, string> | undefined>;
        return ["dependencies", "devDependencies", "optionalDependencies"].some(
            (field) => pkg[field]?.sharp !== undefined,
        );
    } catch {
        // No readable package.json — nothing left to say sharp is here.
        return false;
    }
}

/**
 * Clear the PREVIOUS build's staging out of `native/` — and only that.
 *
 * `native/` is a standard N-API convention, so the name alone does not make the
 * directory knext's to delete: a hand-written `native/` holds someone's source.
 * The ownership marker is the `.integrity.json` manifest every `kn-next build`
 * writes — present, the manifest's own file list says exactly what knext staged
 * and only those entries (plus the manifest) are removed; absent with content,
 * the build REFUSES rather than deleting what it cannot prove it created.
 */
function clearStagedNative(dest: string): void {
    if (!existsSync(dest)) return;
    const entries = readdirSync(dest);
    if (entries.length === 0) return;

    const manifestPath = join(dest, INTEGRITY_MANIFEST_NAME);
    if (!existsSync(manifestPath)) {
        throw new UsageError(
            `Refusing to stage into ${dest}: it has content but no ${INTEGRITY_MANIFEST_NAME}, so knext did not stage it.\n\n` +
                "`kn-next build` stages sharp's native addons into 'native/' beside the compiled\n" +
                "binary and clears its own previous staging on rebuild — but this tree was not\n" +
                "written by knext, and deleting it could destroy your files. Move it aside (or\n" +
                "delete it yourself if it is disposable) and rebuild.",
        );
    }
    let files: Record<string, unknown>;
    try {
        files =
            (
                JSON.parse(readFileSync(manifestPath, "utf8")) as {
                    files?: Record<string, unknown>;
                }
            ).files ?? {};
    } catch (error) {
        throw new UsageError(
            `Refusing to stage into ${dest}: its ${INTEGRITY_MANIFEST_NAME} is unreadable, so what the previous build staged cannot be told apart from your files.\n\n` +
                `  underlying error: ${error instanceof Error ? error.message : String(error)}\n\n` +
                "Move the directory aside (or delete it yourself) and rebuild.",
        );
    }
    // Top-level entries the previous manifest covers. Guarded against a
    // manifest whose keys escape the tree — those are nobody's to delete.
    const owned = new Set<string>();
    for (const rel of Object.keys(files)) {
        const seg = rel.split("/")[0];
        if (seg && seg !== "." && seg !== ".." && !seg.includes("\\")) {
            owned.add(seg);
        }
    }
    for (const seg of owned) {
        rmSync(join(dest, seg), { recursive: true, force: true });
    }
    rmSync(manifestPath, { force: true });
}

/**
 * Fetch one `@img` package from the npm registry at its lockfile-pinned
 * version, verify the tarball against the lockfile's integrity string, and
 * extract it to `destDir`.
 *
 * `npm pack` rather than an install: bun refuses to install another platform's
 * optional packages (measured — that refusal is WHY the darwin host has no
 * linuxmusl set to copy), and npm's platform-override install flags drag a full
 * node_modules with them. A tarball download is the smallest thing that works,
 * and the lockfile pin keeps it exactly as verified as the install path.
 */
export function fetchImgPackage(
    pkg: { name: string; version: string; integrity: string | null },
    destDir: string,
): void {
    // Refused BEFORE any network: an unverifiable fetch would ship whatever
    // the registry answered, at native-code privilege. bun.lock records a
    // sha512 for every registry package, so a missing one means the entry is
    // not a registry resolution at all.
    if (!pkg.integrity?.startsWith("sha512-")) {
        throw new UsageError(
            `Refusing to fetch '${pkg.name}@${pkg.version}': its lockfile entry has no sha512 integrity to verify the download against.\n\n` +
                "Reinstall from the registry (`bun install --save-text-lockfile`) so the\n" +
                "lockfile carries one, and rebuild.",
        );
    }
    const tmp = mkdtempSync(join(tmpdir(), "knext-img-fetch-"));
    try {
        try {
            execFileSync(
                "npm",
                [
                    "pack",
                    `${pkg.name}@${pkg.version}`,
                    "--pack-destination",
                    tmp,
                ],
                { stdio: ["ignore", "pipe", "pipe"] },
            );
        } catch (error) {
            throw new UsageError(
                `Could not fetch '${pkg.name}@${pkg.version}' from the registry (needed because this host's install has no ${pkg.name} and the image target requires it).\n\n` +
                    `  underlying error: ${error instanceof Error ? error.message : String(error)}\n\n` +
                    "Check network/registry access, or install the package on a matching host and rebuild.",
            );
        }
        const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
        if (!tgz) {
            throw new UsageError(
                `npm pack reported success for '${pkg.name}@${pkg.version}' but left no tarball in ${tmp}.`,
            );
        }
        extractVerifiedTarball(join(tmp, tgz), pkg, destDir);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

/**
 * Verify a packed tarball against the lockfile pin, then extract its
 * `package/` payload to `destDir`. Exported for the offline half of the test:
 * the network step above is a thin shell-out, this is where the guarantee is.
 */
export function extractVerifiedTarball(
    tgzPath: string,
    pkg: { name: string; version: string; integrity: string | null },
    destDir: string,
): void {
    const actual = `sha512-${createHash("sha512")
        .update(readFileSync(tgzPath))
        .digest("base64")}`;
    if (actual !== pkg.integrity) {
        throw new UsageError(
            `The fetched tarball for '${pkg.name}@${pkg.version}' does not match the lockfile pin.\n\n` +
                `  expected ${pkg.integrity}\n` +
                `  actual   ${actual}\n\n` +
                "The registry served different bytes than the install the lockfile records.\n" +
                "That is exactly what this check exists to refuse; do not work around it by\n" +
                "editing the lockfile.",
        );
    }
    const extractDir = mkdtempSync(join(tmpdir(), "knext-img-extract-"));
    try {
        execFileSync("tar", ["-xzf", tgzPath, "-C", extractDir], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        const payload = join(extractDir, "package");
        if (!existsSync(payload)) {
            throw new UsageError(
                `The tarball for '${pkg.name}@${pkg.version}' has no 'package/' payload — not an npm registry tarball.`,
            );
        }
        cpSync(payload, destDir, { recursive: true });
    } finally {
        rmSync(extractDir, { recursive: true, force: true });
    }
}

/** `node_modules/@img`, wherever this install layout put it. */
function findImgPackages(cwd: string): string | undefined {
    const candidates = [
        join(cwd, "node_modules", "@img"),
        // bun's isolated store, and the workspace root above an app.
        join(cwd, "node_modules", ".bun", "node_modules", "@img"),
        join(cwd, "..", "..", "node_modules", "@img"),
        join(cwd, "..", "..", "node_modules", ".bun", "node_modules", "@img"),
    ];
    return candidates.find((c) => existsSync(c));
}

/**
 * The app's RESOLVED sharp manifest — the version its bundle actually loads,
 * and sharp's own `optionalDependencies` pins for every `@img/*` platform
 * package (sharp publishes those as exact versions).
 *
 * This is the #954 disambiguator for the fetch path: a fresh scaffold's
 * lockfile legitimately pins each @img package at TWO versions (the app's
 * sharp ^0.35 beside next's own 0.34 devDependency pin), and which one bun
 * hoists to the bare lockfile key is bun's layout choice — NOT a statement of
 * what the app's `require('sharp')` resolves. Only the installed sharp's own
 * manifest says which addon version its loader expects, and fetching any
 * other one would pass the integrity manifest (that version IS in the lock)
 * and fail only at dlopen, inside the image.
 */
function readResolvedSharpManifest(
    cwd: string,
): { version: string; imgPins: Record<string, string> } | undefined {
    // The same candidate walk as `findImgPackages`: the app's own install,
    // bun's isolated store, then a workspace root above the app.
    const candidates = [
        join(cwd, "node_modules", "sharp", "package.json"),
        join(
            cwd,
            "node_modules",
            ".bun",
            "node_modules",
            "sharp",
            "package.json",
        ),
        join(cwd, "..", "..", "node_modules", "sharp", "package.json"),
        join(
            cwd,
            "..",
            "..",
            "node_modules",
            ".bun",
            "node_modules",
            "sharp",
            "package.json",
        ),
    ];
    for (const candidate of candidates) {
        if (!existsSync(candidate)) continue;
        try {
            const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
                version?: unknown;
                optionalDependencies?: Record<string, string>;
            };
            if (typeof parsed.version !== "string") continue;
            return {
                version: parsed.version,
                imgPins: parsed.optionalDependencies ?? {},
            };
        } catch {
            // Unreadable manifest — keep walking. Total absence is handled by
            // the caller's documented fallback, not silently here.
        }
    }
    return undefined;
}

/**
 * Which lockfile entry to FETCH for `name`, when the host install lacks it.
 *
 * One pinned version is no decision at all. With two or more (#954), the
 * installed sharp's own exact pin selects; knowing that pin and NOT finding
 * it in the lock is the store-vs-lockfile disagreement and fails closed. Only
 * when nothing can disambiguate — no findable sharp manifest (a pnpm `.pnpm`
 * store), or one that does not pin this package — does `[0]` (the bare-key
 * resolution when present, first-in-file otherwise) get used, and then
 * LOUDLY: it is a guess between two legitimate pins, and a wrong guess ships
 * an addon the bundled sharp never resolved.
 */
function pickFetchVersion(
    name: string,
    versions: readonly LockedPackage[],
    resolvedSharp:
        | { version: string; imgPins: Record<string, string> }
        | undefined,
    lockfilePath: string,
): LockedPackage {
    if (versions.length === 1) return versions[0];
    const pinned = resolvedSharp?.imgPins[name];
    if (resolvedSharp !== undefined && pinned !== undefined) {
        const match = versions.find((v) => v.version === pinned);
        if (match) return match;
        throw new UsageError(
            `The installed sharp@${resolvedSharp.version} pins '${name}' at ${pinned}, but ${lockfilePath} pins only ${formatLockedVersions([...versions])}.\n\n` +
                "The store and the lockfile disagree about what is installed. Reinstall with\n" +
                "`bun install --frozen-lockfile` and rebuild rather than shipping the difference.",
        );
    }
    process.stderr.write(
        `knext: ${lockfilePath} pins '${name}' at multiple versions (${formatLockedVersions([...versions])}) and no installed sharp manifest was found to disambiguate.\n` +
            `Staging ${versions[0].version} — the lockfile's root resolution when present, its first entry otherwise. If the image fails to load sharp,\n` +
            `pin a single sharp version via package.json "overrides" and rebuild.\n`,
    );
    return versions[0];
}

/**
 * Reads `bun --version`. Separate so the floor check is testable without a Bun.
 *
 * `execFileSync` comes from the STATIC top-level import, never a lazy
 * `require(...)`: tsup's ESM bundle turns a dynamic require into the esbuild
 * `__require` shim, which THROWS under Node — and a bare catch here then
 * mislabelled that throw as "bun not found" on every node-run vinext build,
 * bun present or not (#948, S3-V Finding B-1). The static import spawns
 * nothing by itself, so tests that inject `bunVersion` still never spawn.
 */
function detectBunVersion(run: (argv: readonly string[]) => void): string {
    // `runQuiet` does not capture stdout, so the version is read via
    // execFileSync directly. The unused seam parameter stays so the injection
    // point remains explicit rather than pretending.
    void run;
    try {
        return execFileSync("bun", ["--version"], {
            encoding: "utf8",
            // stderr is CAPTURED, never inherited: a failing bun's own words
            // must land IN the error message below (which the docs promise),
            // not scroll past on the terminal detached from the failure.
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch (err) {
        // Only a spawn that never found a binary means "bun is missing".
        // Anything else — a bun that crashed, a shim that exited non-zero —
        // surfaces its own failure; mislabelling it as absence sends the user
        // chasing an install they already have (#948).
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
            throw new UsageError(
                "The vinext single-executable target needs `bun` on PATH (https://bun.sh), and it was not found.\n\n" +
                    `Install Bun ${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}+ (https://bun.sh/docs/installation) and re-run \`kn-next build\`.\n` +
                    "(The kn-next CLI itself runs under plain Node — only this compile step shells out to Bun.)",
            );
        }
        const detail = err instanceof Error ? err.message : String(err);
        const stderrRaw = (err as { stderr?: unknown }).stderr;
        const stderrText =
            typeof stderrRaw === "string" ? stderrRaw.trim() : "";
        throw new UsageError(
            "Detecting Bun failed: `bun --version` did not return a version.\n\n" +
                `Underlying error: ${detail}\n` +
                (stderrText ? `bun's stderr: ${stderrText}\n` : "") +
                "\nBun IS on PATH (this is not a missing install) — check that `bun --version` runs in this shell.",
        );
    }
}
