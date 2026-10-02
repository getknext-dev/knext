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
    rmSync,
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
    | { kind: "disabled" }
    | {
          kind: "version-mismatch";
          dir: string;
          installed: string;
          expected: string;
      }
    | { kind: "patched"; dir: string; results: PatchResult[] };

/** A patch that neither applies cleanly nor is already present. */
export class VinextPatchConflictError extends UsageError {}

/** Writing a patch's files failed; every file it touched was left as it was. */
export class VinextPatchWriteError extends UsageError {}

/**
 * Writing a patch's files failed AND restoring the ones already replaced also
 * failed (a double fault): vinext may now be inconsistent on disk.
 */
export class VinextPatchRollbackError extends UsageError {}

/** The environment variable that turns the bundled fixes off entirely. */
export const VINEXT_PATCHES_ENV = "KNEXT_VINEXT_PATCHES";

const OPT_OUT_HINT = `To build without knext's bundled vinext fixes instead, set ${VINEXT_PATCHES_ENV}=0.`;

/** `KNEXT_VINEXT_PATCHES=0` (or `false`/`off`/`no`) disables the bundled fixes. */
export function vinextPatchesDisabled(
    env: Record<string, string | undefined> = process.env,
): boolean {
    const v = env[VINEXT_PATCHES_ENV]?.trim().toLowerCase();
    return v === "0" || v === "false" || v === "off" || v === "no";
}

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

/** The filesystem calls a patch commit makes; injectable for failure tests. */
export interface PatchFs {
    writeFile: (path: string, text: string) => void;
    rename: (from: string, to: string) => void;
    remove: (path: string) => void;
}

const REAL_FS: PatchFs = {
    writeFile: (path, text) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
    },
    rename: renameSync,
    remove: (path) => rmSync(path, { force: true }),
};

interface PlannedWrite {
    abs: string;
    /** The file's text before this patch (`null` = the patch creates it). */
    original: string | null;
    text: string;
}

/**
 * Write one patch's files all-or-nothing, never in place (bun hardlinks
 * node_modules to its global cache on Linux; a rename breaks the link, an
 * in-place write would patch every project sharing it).
 *
 *   1. stage every new file as a temp file beside its target — if any staging
 *      write fails, delete the temps: no target was touched;
 *   2. rename each temp over its target — if a rename fails, restore the
 *      targets already renamed from their in-memory originals (or delete the
 *      ones this patch created) and delete the remaining temps.
 */
function commitPatch(
    entry: VinextPatchEntry,
    writes: PlannedWrite[],
    fs: PatchFs,
): void {
    const tmpOf = (abs: string) => `${abs}.knext-patch-${process.pid}.tmp`;
    const fail = (stage: string, err: unknown): never => {
        throw new VinextPatchWriteError(
            `knext could not ${stage} its bundled vinext fix ${entry.file} (${entry.upstream}): ${err instanceof Error ? err.message : String(err)}.\n\n` +
                "No file was left half-patched: the fix was rolled back. Check that node_modules is writable, then run `knext vinext-patches` again.\n" +
                OPT_OUT_HINT,
        );
    };
    const staged: PlannedWrite[] = [];
    try {
        for (const w of writes) {
            fs.writeFile(tmpOf(w.abs), w.text);
            staged.push(w);
        }
    } catch (err) {
        // Including the write that failed: it may have left a partial temp.
        for (const w of writes) {
            try {
                fs.remove(tmpOf(w.abs));
            } catch {}
        }
        fail("write", err);
    }
    const renamed: PlannedWrite[] = [];
    try {
        for (const w of writes) {
            fs.rename(tmpOf(w.abs), w.abs);
            renamed.push(w);
        }
    } catch (err) {
        // Every restore step must succeed for "rolled back" to be true.
        const inconsistent: string[] = [];
        for (const w of renamed) {
            try {
                if (w.original === null) {
                    fs.remove(w.abs);
                } else {
                    fs.writeFile(tmpOf(w.abs), w.original);
                    fs.rename(tmpOf(w.abs), w.abs);
                }
            } catch {
                inconsistent.push(w.abs);
            }
        }
        for (const w of writes.slice(renamed.length)) {
            try {
                fs.remove(tmpOf(w.abs));
            } catch {}
        }
        if (inconsistent.length > 0) {
            throw new VinextPatchRollbackError(
                `knext could not install its bundled vinext fix ${entry.file} (${entry.upstream}): ${err instanceof Error ? err.message : String(err)}, ` +
                    "and restoring the files it had already replaced ALSO failed. These files may now be inconsistent:\n" +
                    inconsistent.map((f) => `  ${f}`).join("\n") +
                    "\n\nReinstall vinext to get the unmodified package back (`rm -rf node_modules/vinext`, then run your package manager's install, e.g. `npm install` or `bun install`).\n" +
                    OPT_OUT_HINT,
            );
        }
        fail("install", err);
    }
}

/**
 * Apply every manifest patch, in order, to the vinext package at `vinextDir`.
 * All of a patch's files are computed before any is written, so a conflict
 * in its second file cannot leave its first half-written.
 */
export function applyVinextPatches(
    vinextDir: string,
    opts: { patchesDir?: string; check?: boolean; fs?: PatchFs } = {},
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
        const writes: PlannedWrite[] = [];
        for (const fp of files) {
            let out: { status: "patch" | "present"; text: string };
            try {
                out = applyFilePatchToText(read(fp.path), fp);
            } catch (err) {
                if (err instanceof VinextPatchConflictError) {
                    throw new VinextPatchConflictError(
                        `knext could not apply its bundled vinext fix ${entry.file} (${entry.upstream}) to ${vinextDir}: ${err.message}.\n\n` +
                            "If you did not change vinext yourself, reinstall dependencies (delete node_modules and install again) so vinext is the unmodified published package, then retry.\n" +
                            `If you patch vinext yourself and want to keep your change, set ${VINEXT_PATCHES_ENV}=0 to build without knext's bundled vinext fixes.`,
                    );
                }
                throw err;
            }
            if (out.status === "patch") {
                changed = true;
                writes.push({
                    abs: join(vinextDir, fp.path),
                    original: read(fp.path),
                    text: out.text,
                });
            }
        }
        if (!opts.check && writes.length > 0) {
            commitPatch(entry, writes, opts.fs ?? REAL_FS);
        }
        for (const fp of files) {
            const w = writes.find((x) => x.abs === join(vinextDir, fp.path));
            if (w) staged.set(fp.path, w.text);
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
    opts: {
        patchesDir?: string;
        check?: boolean;
        env?: Record<string, string | undefined>;
    } = {},
): EnsureResult {
    if (vinextPatchesDisabled(opts.env)) return { kind: "disabled" };
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
    if (res.kind === "disabled") {
        return [
            `knext: ${VINEXT_PATCHES_ENV}=0 is set — knext's bundled vinext fixes were NOT applied.`,
        ];
    }
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
before \`knext build\`; safe to re-run. Set ${VINEXT_PATCHES_ENV}=0 to turn
the bundled fixes off (both here and in \`knext build\`).

Options:
  --check   report whether the fixes are applied, without changing files
            (exit 1 when any is missing)
  -h, --help
`;

export async function vinextPatchesMain(
    argv: string[],
    io: {
        cwd?: string;
        stdout?: (text: string) => void;
        stderr?: (text: string) => void;
    } = {},
): Promise<number> {
    const out = io.stdout ?? ((text: string) => process.stdout.write(text));
    const writeErr =
        io.stderr ?? ((text: string) => process.stderr.write(text));
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
            writeErr,
        );
        writeErr(USAGE);
        return 1;
    }
    if (values.help) {
        out(USAGE);
        return 0;
    }
    try {
        const res = ensureVinextPatches(io.cwd ?? process.cwd(), {
            check: values.check,
        });
        for (const line of describeEnsureResult(res, {
            check: values.check,
        })) {
            out(`${line}\n`);
        }
        if (
            values.check &&
            res.kind === "patched" &&
            res.results.some((r) => r.status === "applied")
        ) {
            out(
                "knext: some bundled vinext fixes are not applied — run `knext vinext-patches`.\n",
            );
            return 1;
        }
        return 0;
    } catch (err) {
        if (err instanceof UsageError) {
            handleUsageError(err, writeErr);
            return 1;
        }
        throw err;
    }
}
