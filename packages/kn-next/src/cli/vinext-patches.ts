/**
 * Bundled vinext fixes — `knext vinext-patches`.
 *
 * knext ships fixes it has sent upstream to vinext before vinext releases
 * them, so users do not wait on upstream review. Each fix is a unified diff
 * against the PUBLISHED vinext dist (one file per upstream PR, in
 * `templates/vinext-patches/`, each naming its retirement condition), and
 * `manifest.json` names the one vinext version they were validated against.
 *
 * Delivery is knext-owned rather than a package-manager feature on purpose:
 * bun's `patchedDependencies` holds exactly one patch per package, npm has no
 * native patching, and running bun's mechanism alongside `patch-package` would
 * double-apply under bun. One pure-JS applier works the same under both, needs
 * no `patch` binary, and runs from two places:
 *
 *   - the scaffolded app's `postinstall` (`knext vinext-patches`), so
 *     `vinext dev` and a plain `vite build` see the fixes;
 *   - `knext build`'s vinext path (project-build.ts), so an app scaffolded
 *     before this existed, or installed with scripts disabled, still builds
 *     with them.
 *
 * Applying is deliberately strict:
 *   - a hunk is located by its exact context (never by line number, never
 *     fuzzily) and must match exactly once;
 *   - a patch whose hunks are all already present is "already-applied", so
 *     re-running is a no-op;
 *   - anything else (some hunks present, a context missing or ambiguous) is a
 *     conflict and fails loudly — a stale patch must never half-apply;
 *   - a vinext version other than the manifest's is left untouched (the user
 *     moved off the pin; those fixes may already be upstream);
 *   - files are replaced (write a temp file, then rename), never written in
 *     place: bun hardlinks node_modules files to its global cache on Linux,
 *     and an in-place write would patch every project sharing that cache.
 */

import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { packageRoot } from "./create";
import { handleUsageError, UsageError } from "./shared";

export interface VinextPatchEntry {
    /** Patch file name inside the patches directory. */
    file: string;
    /** The upstream vinext PR this ports. */
    upstream: string;
    /** One-line description of the user-visible fix. */
    summary: string;
}

export interface VinextPatchManifest {
    /** The ONLY vinext version the patches were validated against. */
    vinext: string;
    patches: VinextPatchEntry[];
    /** sha256 of every patched file in that version's published tarball. */
    pristine: Record<string, string>;
}

export interface Hunk {
    oldLines: string[];
    newLines: string[];
}

export interface FilePatch {
    /** Path relative to the vinext package root, e.g. `dist/index.js`. */
    path: string;
    /** The patch creates this file (`--- /dev/null`). */
    isNew: boolean;
    hunks: Hunk[];
}

export interface PatchResult {
    file: string;
    upstream: string;
    /** `applied` = this run changed (or, in check mode, would change) files. */
    status: "applied" | "already-applied";
}

export type EnsureResult =
    | { kind: "no-vinext" }
    | {
          kind: "version-mismatch";
          dir: string;
          installed: string;
          expected: string;
      }
    | { kind: "patched"; dir: string; results: PatchResult[] };

/** A patch that neither applies cleanly nor is already present. */
export class VinextPatchConflictError extends UsageError {}

/** Where the bundled patches live inside the installed @getknext/core. */
export function vinextPatchesDir(): string {
    return join(packageRoot(), "templates", "vinext-patches");
}

export function loadVinextPatchManifest(
    dir = vinextPatchesDir(),
): VinextPatchManifest {
    return JSON.parse(
        readFileSync(join(dir, "manifest.json"), "utf8"),
    ) as VinextPatchManifest;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Strip the `a/` / `b/` prefix a unified diff puts on its paths. */
function diffPath(raw: string): string {
    const path = raw.split("\t")[0] ?? raw;
    return path.replace(/^[ab]\//, "");
}

/**
 * Parse a unified diff. Everything before the first `--- ` line is a header
 * (the human-readable provenance block) and is ignored.
 */
export function parseUnifiedPatch(text: string): FilePatch[] {
    const lines = text.split("\n");
    const files: FilePatch[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i] ?? "";
        if (!line.startsWith("--- ")) {
            i++;
            continue;
        }
        const from = line.slice(4);
        const to = lines[i + 1] ?? "";
        if (!to.startsWith("+++ ")) {
            throw new Error(
                `malformed patch: '--- ' without '+++ ' at line ${i + 1}`,
            );
        }
        const isNew = from.startsWith("/dev/null");
        const fp: FilePatch = { path: diffPath(to.slice(4)), isNew, hunks: [] };
        i += 2;
        while (i < lines.length && (lines[i] ?? "").startsWith("@@")) {
            const m = HUNK_HEADER.exec(lines[i] ?? "");
            if (!m) throw new Error(`malformed hunk header: ${lines[i]}`);
            let oldLeft = m[2] === undefined ? 1 : Number(m[2]);
            let newLeft = m[4] === undefined ? 1 : Number(m[4]);
            const hunk: Hunk = { oldLines: [], newLines: [] };
            i++;
            while (oldLeft > 0 || newLeft > 0) {
                const body = lines[i];
                if (body === undefined) {
                    throw new Error(`truncated hunk in patch for ${fp.path}`);
                }
                const tag = body[0];
                const content = body.slice(1);
                if (tag === " ") {
                    hunk.oldLines.push(content);
                    hunk.newLines.push(content);
                    oldLeft--;
                    newLeft--;
                } else if (tag === "-") {
                    hunk.oldLines.push(content);
                    oldLeft--;
                } else if (tag === "+") {
                    hunk.newLines.push(content);
                    newLeft--;
                } else if (tag !== "\\") {
                    throw new Error(
                        `unexpected line in hunk for ${fp.path}: ${JSON.stringify(body)}`,
                    );
                }
                i++;
            }
            fp.hunks.push(hunk);
        }
        files.push(fp);
    }
    return files;
}

/** Every index where `needle` occurs as a contiguous run of `haystack`. */
function occurrences(haystack: string[], needle: string[]): number[] {
    const out: number[] = [];
    if (needle.length === 0) return out;
    for (let i = 0; i + needle.length <= haystack.length; i++) {
        let match = true;
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) {
                match = false;
                break;
            }
        }
        if (match) out.push(i);
    }
    return out;
}

/**
 * Apply one file's hunks to its current text (`null` = the file is absent).
 * Returns `present` when every hunk is already present (text unchanged),
 * `patch` with the new text when every hunk applies, and throws a
 * {@link VinextPatchConflictError} otherwise.
 */
export function applyFilePatchToText(
    original: string | null,
    fp: FilePatch,
): { status: "patch" | "present"; text: string } {
    if (fp.isNew) {
        const wanted = `${fp.hunks.flatMap((h) => h.newLines).join("\n")}\n`;
        if (original === null) return { status: "patch", text: wanted };
        if (original === wanted) return { status: "present", text: original };
        throw new VinextPatchConflictError(
            `${fp.path} already exists with different content`,
        );
    }
    if (original === null) {
        throw new VinextPatchConflictError(`${fp.path} is missing`);
    }
    let lines = original.split("\n");
    const states = fp.hunks.map((h) => {
        const oldAt = occurrences(lines, h.oldLines);
        const newAt = occurrences(lines, h.newLines);
        if (oldAt.length === 1) return "patch" as const;
        if (oldAt.length === 0 && newAt.length === 1) return "present" as const;
        return "conflict" as const;
    });
    if (states.every((s) => s === "present")) {
        return { status: "present", text: original };
    }
    if (!states.every((s) => s === "patch")) {
        throw new VinextPatchConflictError(
            `${fp.path}: the patch neither applies cleanly nor is already applied (hunk states: ${states.join(", ")})`,
        );
    }
    for (const h of fp.hunks) {
        const [at] = occurrences(lines, h.oldLines);
        if (at === undefined) {
            throw new VinextPatchConflictError(
                `${fp.path}: hunk context vanished while applying`,
            );
        }
        lines = [
            ...lines.slice(0, at),
            ...h.newLines,
            ...lines.slice(at + h.oldLines.length),
        ];
    }
    return { status: "patch", text: lines.join("\n") };
}

/** Replace a file without writing through a hardlink to a shared cache. */
function replaceFile(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.knext-patch-${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
}

/**
 * Apply every manifest patch, in order, to the vinext package at `vinextDir`.
 * All of a patch's files are computed before any is written, so a conflict
 * in its second file cannot leave its first half-written.
 */
export function applyVinextPatches(
    vinextDir: string,
    opts: { patchesDir?: string; check?: boolean } = {},
): PatchResult[] {
    const patchesDir = opts.patchesDir ?? vinextPatchesDir();
    const manifest = loadVinextPatchManifest(patchesDir);
    const results: PatchResult[] = [];
    // In check mode later patches must see earlier ones, so stage in memory.
    const staged = new Map<string, string | null>();
    const read = (rel: string): string | null => {
        if (staged.has(rel)) return staged.get(rel) ?? null;
        const abs = join(vinextDir, rel);
        return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    };
    for (const entry of manifest.patches) {
        const files = parseUnifiedPatch(
            readFileSync(join(patchesDir, entry.file), "utf8"),
        );
        let changed = false;
        const writes: [string, string][] = [];
        for (const fp of files) {
            let out: { status: "patch" | "present"; text: string };
            try {
                out = applyFilePatchToText(read(fp.path), fp);
            } catch (err) {
                if (err instanceof VinextPatchConflictError) {
                    throw new VinextPatchConflictError(
                        `knext could not apply its bundled vinext fix ${entry.file} (${entry.upstream}) to ${vinextDir}: ${err.message}.\n\n` +
                            "Reinstall dependencies (delete node_modules and install again) so vinext is the unmodified published package, then retry.",
                    );
                }
                throw err;
            }
            if (out.status === "patch") {
                changed = true;
                writes.push([fp.path, out.text]);
            }
        }
        for (const [rel, text] of writes) {
            staged.set(rel, text);
            if (!opts.check) replaceFile(join(vinextDir, rel), text);
        }
        results.push({
            file: entry.file,
            upstream: entry.upstream,
            status: changed ? "applied" : "already-applied",
        });
    }
    return results;
}

/**
 * The vinext package directory Node would load for an app at `cwd`: the first
 * `node_modules/vinext` walking up. (vinext's `exports` hides its
 * package.json, so `require.resolve('vinext/package.json')` cannot be used.)
 */
export function findVinextDir(cwd: string): string | undefined {
    let dir = resolve(cwd);
    for (;;) {
        const candidate = join(dir, "node_modules", "vinext");
        if (existsSync(join(candidate, "package.json"))) return candidate;
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/** Apply the bundled patches to the app's vinext when it is the validated version. */
export function ensureVinextPatches(
    cwd: string,
    opts: { patchesDir?: string; check?: boolean } = {},
): EnsureResult {
    const dir = findVinextDir(cwd);
    if (!dir) return { kind: "no-vinext" };
    const manifest = loadVinextPatchManifest(opts.patchesDir);
    const installed = (
        JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
            version?: unknown;
        }
    ).version;
    if (installed !== manifest.vinext) {
        return {
            kind: "version-mismatch",
            dir,
            installed: String(installed),
            expected: manifest.vinext,
        };
    }
    return { kind: "patched", dir, results: applyVinextPatches(dir, opts) };
}

/** One human line per outcome; shared by the verb and `knext build`. */
export function describeEnsureResult(
    res: EnsureResult,
    opts: { check?: boolean } = {},
): string[] {
    if (res.kind === "no-vinext") return [];
    if (res.kind === "version-mismatch") {
        return [
            `knext: vinext ${res.installed} is installed; knext's bundled vinext fixes target ${res.expected} only, so they were not applied.`,
        ];
    }
    const applied = res.results.filter((r) => r.status === "applied").length;
    return [
        applied === 0
            ? `knext: bundled vinext fixes already applied (${res.results.length}).`
            : opts.check
              ? `knext: ${applied} of ${res.results.length} bundled vinext fix(es) are not applied yet.`
              : `knext: applied ${applied} bundled vinext fix(es) (${res.results.length} total).`,
    ];
}

const USAGE = `Usage: knext vinext-patches [--check]

Apply the vinext fixes knext bundles ahead of upstream vinext releases to this
app's installed vinext. Runs automatically from a knext app's postinstall and
before \`knext build\`; safe to re-run.

Options:
  --check   report whether the fixes are applied, without changing files
            (exit 1 when any is missing)
  -h, --help
`;

export async function vinextPatchesMain(argv: string[]): Promise<number> {
    let values: { check?: boolean; help?: boolean };
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                check: { type: "boolean", default: false },
                help: { type: "boolean", short: "h", default: false },
            },
            allowPositionals: false,
        }));
    } catch (err) {
        handleUsageError(
            new UsageError(err instanceof Error ? err.message : String(err)),
        );
        process.stderr.write(USAGE);
        return 1;
    }
    if (values.help) {
        process.stdout.write(USAGE);
        return 0;
    }
    try {
        const res = ensureVinextPatches(process.cwd(), {
            check: values.check,
        });
        for (const line of describeEnsureResult(res, {
            check: values.check,
        })) {
            process.stdout.write(`${line}\n`);
        }
        if (
            values.check &&
            res.kind === "patched" &&
            res.results.some((r) => r.status === "applied")
        ) {
            process.stdout.write(
                "knext: some bundled vinext fixes are not applied — run `knext vinext-patches`.\n",
            );
            return 1;
        }
        return 0;
    } catch (err) {
        if (err instanceof UsageError) {
            handleUsageError(err);
            return 1;
        }
        throw err;
    }
}
