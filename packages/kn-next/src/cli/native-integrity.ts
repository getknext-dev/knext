/**
 * Integrity pinning for the staged `native/` tree (sprint task C2).
 *
 * ## The gap this closes
 *
 * `stageSharpNative` stages the image target's `@img` packages into
 * `native/`, the Dockerfile `COPY`s that verbatim into the image, and the
 * compiled binary `process.dlopen`s it — at native-code privilege, on the first
 * `/_next/image` request. Nothing tied those bytes to anything: not to the
 * lockfile, not to a scanner. A `.node` is an opaque blob, so an SBOM listing
 * the PACKAGE cannot tell a swapped addon from the real one, and the closure
 * SBOM does not cover `/app/native` at all.
 *
 * ## Two claims, of different strength, both recorded
 *
 *   1. **Provenance, from the lockfile.** Every staged `@img` package must have
 *      an entry in the app's lockfile — `bun.lock` (bun) or `package-lock.json`
 *      (npm, #1864: a vinext × node app has no reason to have bun on PATH, so
 *      `knext create`'s own documented `npm install` must be a supported
 *      source of truth here, not just bun's) — for exactly the `name@version`
 *      on disk. No entry, or a different version, is a BUILD FAILURE — not a
 *      skip. The entry's integrity string is copied into the manifest.
 *
 *      Be precise about what this is not: both lockfiles record the integrity
 *      of the packed TARBALL, and what ships is the EXTRACTED tree. The two are
 *      not comparable by construction, so this pins *which package* was
 *      staged, not *which bytes*.
 *
 *   2. **Bytes, from knext.** A sha256 per staged file, computed here and
 *      written to `native/.integrity.json`, which the dlopen shim re-checks
 *      before handing anything to the OS loader. This is the half that detects a
 *      tree mutated after install — the case (1) cannot see.
 *
 * The manifest travels INSIDE `native/`, so every path that ships the tree ships
 * it: `COPY native /app/native` needs no second line, and a tree that arrives
 * without its manifest is a tree someone took apart.
 */

import { createHash } from "node:crypto";
import {
    existsSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { UsageError } from "./shared";

/** Lives inside the tree, so shipping the tree ships the manifest. */
export const INTEGRITY_MANIFEST_NAME = ".integrity.json";

/**
 * The schema version of `.integrity.json`. Written here and asserted by the
 * dlopen shim (`sharp-addon-dlopen.mjs`) before it trusts a manifest, so a
 * schema-incompatible manifest — a future format bump the reader predates, or a
 * corrupted/rogue one — is refused rather than read as if valid (#929).
 *
 * The shim is self-contained (its text is injected into sharp's module slot),
 * so it cannot import this constant; it carries its own literal, and a test
 * (`native-integrity.test.ts`) ties the two so bumping one without the other
 * reds. Any format change must bump BOTH sides together.
 */
export const NATIVE_INTEGRITY_SCHEMA_VERSION = 1;

export interface StagedImgPackage {
    /** The scoped name from the package's own `package.json`. */
    name: string;
    version: string;
    /** Directory under `native/` — the `@img/` segment is gone by then. */
    dir: string;
}

interface IntegrityManifest {
    version: typeof NATIVE_INTEGRITY_SCHEMA_VERSION;
    algorithm: "sha256";
    packages: Record<
        string,
        { version: string; lockfileIntegrity: string | null }
    >;
    /** POSIX-relative path under `native/` → sha256 hex. */
    files: Record<string, string>;
}

/**
 * The staged `@img` packages, read from each directory's own `package.json`.
 *
 * Deliberately not derived from the directory name: the tree is copied from
 * INSIDE `@img`, so the scope segment is already gone, and reconstructing it
 * would be a guess about sharp's naming scheme. This repo has already shipped
 * one wrong guess there (`linuxmusl`, one word, not `linux-musl`).
 */
export function readImgPackageVersions(nativeDir: string): StagedImgPackage[] {
    const found: StagedImgPackage[] = [];
    for (const entry of safeReadDir(nativeDir).sort()) {
        const manifestPath = join(nativeDir, entry, "package.json");
        if (!existsSync(manifestPath)) continue;
        let parsed: { name?: string; version?: string };
        try {
            parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
        } catch (error) {
            throw new UsageError(
                `The staged native package '${entry}' has an unreadable package.json, so its provenance cannot be pinned.\n` +
                    `  ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        if (!parsed.name || !parsed.version) continue;
        found.push({ name: parsed.name, version: parsed.version, dir: entry });
    }
    return found;
}

/**
 * Writes `native/.integrity.json`.
 *
 * `lockfilePath` is `undefined` when no lockfile could be found. That is fine
 * for an EMPTY tree — an app without `next/image` still gets a `native/`
 * directory so the Dockerfile's `COPY` does not fail, and there is nothing to
 * pin — and a hard failure the moment anything is actually staged.
 */
export function writeNativeIntegrityManifest(
    nativeDir: string,
    lockfilePath: string | undefined,
): void {
    const staged = readImgPackageVersions(nativeDir);

    const packages: IntegrityManifest["packages"] = {};
    if (staged.length > 0) {
        if (!lockfilePath || !existsSync(lockfilePath)) {
            throw new UsageError(
                "knext staged native packages but found no lockfile (bun.lock or " +
                    "package-lock.json) to pin them against.\n\n" +
                    `  staged: ${staged.map((p) => `${p.name}@${p.version}`).join(", ")}\n\n` +
                    "Those packages are dlopened at native-code privilege in the image, so the build\n" +
                    "refuses to ship them unverified. Run `npm install` (or `bun install\n" +
                    "--save-text-lockfile`) in the app — a binary bun.lockb carries no readable\n" +
                    "integrity records.",
            );
        }
        const locked = readLockfilePackages(lockfilePath);
        for (const pkg of staged) {
            const versions = locked.get(pkg.name);
            if (!versions) {
                throw new UsageError(
                    `The native package '${pkg.name}' is staged for the image but ${lockfilePath} pins no such package.\n\n` +
                        "An @img package on disk that the lockfile never resolved is exactly the\n" +
                        "injected-dependency case, so this is a build failure rather than a skip.\n" +
                        "Reinstall from the lockfile (`npm install`, or `bun install --frozen-lockfile`)\n" +
                        "and rebuild.",
                );
            }
            // Matched by name AND version: a lockfile can legitimately pin the
            // same package at two versions at once (a scaffold's app sharp
            // ^0.35 next to next's own sharp 0.34 pin, #954), and comparing
            // the staged tree against whichever single entry a name-keyed map
            // kept false-failed brand-new apps.
            const entry = versions.find((v) => v.version === pkg.version);
            if (!entry) {
                throw new UsageError(
                    `The native package '${pkg.name}' is staged at ${pkg.version} but ${lockfilePath} pins only ${formatLockedVersions(versions)}.\n\n` +
                        "The store and the lockfile disagree about what is installed. Reinstall with\n" +
                        "`npm install` (or `bun install --frozen-lockfile`) and rebuild rather than\n" +
                        "shipping the difference.",
                );
            }
            packages[pkg.name] = {
                version: pkg.version,
                lockfileIntegrity: entry.integrity,
            };
        }
    }

    const files: IntegrityManifest["files"] = {};
    for (const abs of walkFiles(nativeDir)) {
        const rel = relative(nativeDir, abs).split(sep).join("/");
        // The manifest cannot hash itself, and a stale one from a previous build
        // must not leak into the new record either.
        if (rel === INTEGRITY_MANIFEST_NAME) continue;
        files[rel] = createHash("sha256")
            .update(readFileSync(abs))
            .digest("hex");
    }

    const manifest: IntegrityManifest = {
        version: NATIVE_INTEGRITY_SCHEMA_VERSION,
        algorithm: "sha256",
        packages: sortKeys(packages),
        files: sortKeys(files),
    };
    writeFileSync(
        join(nativeDir, INTEGRITY_MANIFEST_NAME),
        `${JSON.stringify(manifest, null, 2)}\n`,
    );
}

/**
 * Lockfile basenames this module can read, in preference order. `bun.lock` is
 * checked first at every directory level so an app that happens to carry both
 * (e.g. a bun install run once over an npm-created tree) keeps today's
 * behaviour unchanged; `package-lock.json` is npm's — the installer
 * `knext create`'s own `partingLine()` tells every scaffold to run, `--runtime
 * node` included, so it must be a readable source of pins, not just bun's
 * (#1864).
 */
const LOCKFILE_BASENAMES = ["bun.lock", "package-lock.json"] as const;

/** Nearest `bun.lock` or `package-lock.json` at or above `cwd`, or `undefined`. */
export function findLockfile(cwd: string): string | undefined {
    let dir = cwd;
    for (;;) {
        for (const name of LOCKFILE_BASENAMES) {
            const candidate = join(dir, name);
            if (existsSync(candidate)) return candidate;
        }
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

export interface LockedPackage {
    version: string;
    integrity: string | null;
}

/**
 * `pins only 0.34.5, 0.35.4` — every version the lockfile holds, in
 * numeric-aware order (a lexical sort puts 0.10.0 before 0.9.0, which reads
 * as nonsense in a refusal an operator is expected to act on).
 */
export function formatLockedVersions(versions: LockedPackage[]): string {
    return versions
        .map((v) => v.version)
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
        .join(", ");
}

/**
 * `lockfilePath`'s pinned packages, keyed by package name — each name mapping
 * to EVERY distinct version the lockfile pins for it, canonical resolution
 * first. Dispatches on the lockfile's basename (#1864): `package-lock.json`
 * (npm's own format, structurally different from bun's) goes to
 * {@link readNpmLockfilePackages}; everything {@link findLockfile} can return
 * otherwise is a `bun.lock`, read by {@link readBunLockfilePackages}.
 */
export function readLockfilePackages(
    lockfilePath: string,
): Map<string, LockedPackage[]> {
    if (basename(lockfilePath) === "package-lock.json") {
        return readNpmLockfilePackages(lockfilePath);
    }
    return readBunLockfilePackages(lockfilePath);
}

/**
 * `bun.lock`'s `packages` map, keyed by package name — each name mapping to
 * EVERY distinct version the lockfile pins for it, canonical resolution first.
 *
 * The file is JSONC — trailing commas, which `JSON.parse` rejects — and each
 * value is a tuple whose first element is `"<name>@<version>"` and whose last
 * element, when present, is the registry integrity string. Workspace installs
 * key some entries by path (`apps/x/node_modules/@img/y`), so the trailing
 * package name is what identifies an entry, not the whole key.
 *
 * A name maps to a LIST because two versions of one package coexisting in a
 * lockfile is a legitimate, common state — a fresh scaffold pins the app's
 * sharp ^0.35 beside next's own sharp 0.34 devDependency pin — and collapsing
 * them to one entry made the integrity check compare staged trees against
 * whichever version happened to win (#954). Ordering contract: the bare-key
 * (root/hoisted) resolution is FIRST **when present**; a purely path-keyed
 * shape (workspace installs) has no canonical entry, and `[0]` is then simply
 * the lockfile's first entry in file order. Which of two versions bun hoists
 * to the bare key is bun's choice, not the app's resolution — so `[0]` is a
 * FALLBACK for callers that need one representative version, never an answer
 * to "which version does this app use".
 */
function readBunLockfilePackages(
    lockfilePath: string,
): Map<string, LockedPackage[]> {
    const raw = readFileSync(lockfilePath, "utf8");
    let doc: { packages?: Record<string, unknown> };
    try {
        doc = JSON.parse(stripTrailingCommas(raw));
    } catch (error) {
        throw new UsageError(
            `Could not parse ${lockfilePath} while pinning the native tree's provenance.\n` +
                `  ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const out = new Map<string, LockedPackage[]>();
    for (const [key, value] of Object.entries(doc.packages ?? {})) {
        if (!Array.isArray(value) || typeof value[0] !== "string") continue;
        const descriptor = value[0];
        const at = descriptor.lastIndexOf("@");
        if (at <= 0) continue;
        const name = descriptor.slice(0, at);
        const version = descriptor.slice(at + 1);
        const last = value[value.length - 1];
        const integrity =
            typeof last === "string" &&
            last.includes("-") &&
            last !== descriptor
                ? last
                : null;
        const entries = out.get(name) ?? [];
        if (entries.length === 0) out.set(name, entries);
        // Every distinct version is kept; a canonical (bare-key) record moves
        // to the front, and for a version seen twice the canonical record's
        // integrity string is the one retained.
        const existing = entries.findIndex((e) => e.version === version);
        if (existing !== -1 && key !== name) continue;
        if (existing !== -1) entries.splice(existing, 1);
        if (key === name) entries.unshift({ version, integrity });
        else entries.push({ version, integrity });
    }
    return out;
}

/**
 * npm's `package-lock.json` `packages` map (lockfileVersion 2/3), keyed by
 * package PATH rather than bun's `name@version` descriptor — each key's
 * trailing `node_modules/` segment identifies the package
 * (`"node_modules/@img/sharp-linuxmusl-x64"` -> `@img/sharp-linuxmusl-x64`),
 * since a nested/non-hoisted install keys an entry by its full ancestry
 * (`"node_modules/foo/node_modules/@img/sharp-linuxmusl-x64"`).
 *
 * This is the #1864 fix: npm's lockfile pins EVERY platform of an
 * `optionalDependencies` package it resolved — including ones the current
 * host never downloaded, because npm skips an os/cpu/libc-mismatched optional
 * download but still records its resolution, so the SAME lockfile works on a
 * different host (measured — `npm install` on a darwin host still writes a
 * full `@img/sharp-linuxmusl-x64` entry, version + sha512 integrity, into
 * `package-lock.json`, even though nothing of that name ever reaches
 * `node_modules/@img` on disk there). That is exactly the pin a vinext × node
 * build run anywhere but a musl host needs, and it was unreachable before
 * this function existed: {@link findLockfile} found no `bun.lock` for an app
 * whose `node_modules` came from `npm install` (`knext create`'s own
 * documented install step), so the fetch fallback in `vinext-build.ts` had no
 * lockfile to read and refused outright, for `--runtime node` apps
 * specifically — the ones with the least reason to also have bun on PATH.
 *
 * Root's own entry is keyed `""` and carries no package name — skipped.
 * Ordering mirrors {@link readBunLockfilePackages}: the canonical (hoisted,
 * single `node_modules/` segment) resolution is unshifted to the front when
 * present, matching npm's own meaning of "canonical" (`npm ls`'s notion of
 * the de-duped top-level install).
 */
function readNpmLockfilePackages(
    lockfilePath: string,
): Map<string, LockedPackage[]> {
    const raw = readFileSync(lockfilePath, "utf8");
    let doc: { packages?: Record<string, unknown> };
    try {
        doc = JSON.parse(raw);
    } catch (error) {
        throw new UsageError(
            `Could not parse ${lockfilePath} while pinning the native tree's provenance.\n` +
                `  ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const out = new Map<string, LockedPackage[]>();
    for (const [key, value] of Object.entries(doc.packages ?? {})) {
        if (key === "" || !key.includes("node_modules/")) continue;
        if (
            value === null ||
            typeof value !== "object" ||
            typeof (value as { version?: unknown }).version !== "string"
        ) {
            continue;
        }
        const name = packageNameFromNpmKey(key);
        if (!name) continue;
        const version = (value as { version: string }).version;
        const integrityRaw = (value as { integrity?: unknown }).integrity;
        const integrity =
            typeof integrityRaw === "string" ? integrityRaw : null;
        // The hoisted/top-level entry has exactly one `node_modules/`
        // segment; a nested (non-hoisted) install's key has more than one,
        // from the ancestor chain `lastIndexOf` would otherwise find.
        const canonical = key.lastIndexOf("node_modules/") === 0;

        const entries = out.get(name) ?? [];
        if (entries.length === 0) out.set(name, entries);
        const existing = entries.findIndex((e) => e.version === version);
        if (existing !== -1 && !canonical) continue;
        if (existing !== -1) entries.splice(existing, 1);
        if (canonical) entries.unshift({ version, integrity });
        else entries.push({ version, integrity });
    }
    return out;
}

/**
 * The package name a `package-lock.json` `packages` key identifies — its
 * final `node_modules/` segment, scope-aware (`@img/sharp-linuxmusl-x64` is
 * two path segments, not one, so splitting on the first `/` after
 * `node_modules/` would cut a scoped name in half).
 */
function packageNameFromNpmKey(key: string): string | undefined {
    const marker = "node_modules/";
    const idx = key.lastIndexOf(marker);
    if (idx === -1) return undefined;
    const rest = key.slice(idx + marker.length);
    if (rest.length === 0) return undefined;
    const parts = rest.split("/");
    if (parts[0].startsWith("@") && parts.length > 1) {
        return `${parts[0]}/${parts[1]}`;
    }
    return parts[0];
}

/**
 * Removes JSONC trailing commas, string-aware.
 *
 * A naive `/,(\s*[}\]])/g` also edits the inside of string literals, and this
 * file's strings are base64 integrity hashes — the one place a wrong edit would
 * corrupt a value we are about to record as authoritative.
 */
function stripTrailingCommas(source: string): string {
    let out = "";
    let inString = false;
    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (inString) {
            out += ch;
            if (ch === "\\") {
                out += source[++i] ?? "";
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === ",") {
            let j = i + 1;
            while (j < source.length && /\s/.test(source[j])) j++;
            if (source[j] === "}" || source[j] === "]") continue;
        }
        out += ch;
    }
    return out;
}

function* walkFiles(dir: string): Generator<string> {
    for (const entry of safeReadDir(dir).sort()) {
        const abs = join(dir, entry);
        // `dereference: true` on the copy means the staged tree holds real files,
        // never symlinks — `statSync` is therefore not following anything the
        // build did not already flatten.
        const stat = statSync(abs);
        if (stat.isDirectory()) yield* walkFiles(abs);
        else if (stat.isFile()) yield abs;
    }
}

function safeReadDir(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
    const out: Record<string, T> = {};
    for (const k of Object.keys(o).sort()) out[k] = o[k];
    return out;
}
