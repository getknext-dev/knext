/**
 * #188 round 2 — heal Bun-condition export targets in the standalone output.
 *
 * `next build` runs under Node, so output-file-tracing (nft) copies into
 * `.next/standalone/node_modules` only the files Node's resolution conditions
 * touch. Packages whose `exports` map carries a `"bun"` condition (react-dom:
 * `"./server": { "bun": "./server.bun.js", "node": "./server.node.js", … }`)
 * therefore ship an exports map pointing at files the traced tree does NOT
 * contain. Bun's resolver picks the `"bun"` condition, finds the mapped file
 * missing, and fails the WHOLE specifier (no fallback to `"node"`):
 *
 *   ⨯ Error: Failed to load external module react-dom/server: ResolveMessage:
 *     Cannot find module 'react-dom/server' from '…/standalone/.next/server/
 *     chunks/ssr/[root-of-the-server]__….js'
 *
 * — which 500'd every pages-router SSR/API render in the bun compat lane
 * (getserversideprops, module-layer; run 28612654960, surfaced by the
 * teardown server-log tail). Node serving is untouched by the heal: it only
 * ADDS files nft omitted, copied byte-identical from the app's real
 * node_modules, guarded by a package-version equality check.
 */

import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";

export interface HealResult {
    /** `<pkgName>/<relative file>` entries copied into the standalone tree. */
    copied: string[];
    /** human-readable reasons for skipped packages/targets */
    skipped: string[];
}

/** Collect every string target reachable under a `"bun"` condition key. */
export function collectBunConditionTargets(exports: unknown): string[] {
    const targets: string[] = [];
    const walk = (node: unknown, underBun: boolean): void => {
        if (typeof node === "string") {
            if (underBun && node.startsWith("./")) targets.push(node);
            return;
        }
        if (node === null || typeof node !== "object") return;
        for (const [key, value] of Object.entries(
            node as Record<string, unknown>,
        )) {
            walk(value, underBun || key === "bun");
        }
    };
    walk(exports, false);
    return targets;
}

/** Best-effort: relative requires/imports of a copied CJS/ESM file. */
function relativeRequiresOf(file: string): string[] {
    let src: string;
    try {
        src = readFileSync(file, "utf8");
    } catch {
        return [];
    }
    const out: string[] = [];
    const re = /(?:require\(|from\s)\s*['"](\.\.?\/[^'"]+)['"]/g;
    for (let m = re.exec(src); m !== null; m = re.exec(src)) {
        out.push(m[1]);
    }
    return out;
}

/** Find package dirs (dirs containing package.json) under a node_modules dir. */
function packageDirsUnder(nodeModulesDir: string): string[] {
    const dirs: string[] = [];
    if (!existsSync(nodeModulesDir)) return dirs;
    const visit = (dir: string, depth: number): void => {
        if (depth > 6) return;
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const entry of entries) {
            const abs = join(dir, entry);
            if (entry === "package.json") continue;
            // scoped dirs, .pnpm virtual store, nested node_modules
            if (
                entry.startsWith("@") ||
                entry === ".pnpm" ||
                entry === "node_modules"
            ) {
                visit(abs, depth + 1);
                continue;
            }
            if (existsSync(join(abs, "package.json"))) {
                dirs.push(abs);
                // packages can nest their own node_modules (pnpm virtual store)
                visit(join(abs, "node_modules"), depth + 1);
            } else if (existsSync(join(abs, "node_modules"))) {
                // pnpm virtual-store id dirs (.pnpm/<name>@<version>/node_modules/<name>)
                visit(join(abs, "node_modules"), depth + 1);
            }
        }
    };
    visit(nodeModulesDir, 0);
    return dirs;
}

/**
 * Copy missing `"bun"`-condition export targets (and their same-package
 * relative requires, transitively and bounded) from the app's real
 * node_modules into the standalone tree. Additive only; never throws.
 */
export function healBunExportTargets({
    projectDir,
    standaloneDir,
    log = () => {},
}: {
    projectDir: string;
    standaloneDir: string;
    log?: (message: string) => void;
}): HealResult {
    const result: HealResult = { copied: [], skipped: [] };
    try {
        const pkgDirs = packageDirsUnder(join(standaloneDir, "node_modules"));
        for (const standalonePkgDir of pkgDirs) {
            healPackage(standalonePkgDir, projectDir, result, log);
        }
    } catch (err) {
        // The heal must never kill a build — worst case the bun lane keeps
        // its pre-heal behavior and the log names why.
        result.skipped.push(`heal aborted: ${String(err)}`);
        log(`[knext-adapter] bun-exports heal aborted: ${String(err)}`);
    }
    return result;
}

function healPackage(
    standalonePkgDir: string,
    projectDir: string,
    result: HealResult,
    log: (message: string) => void,
): void {
    let pkg: { name?: string; version?: string; exports?: unknown };
    try {
        pkg = JSON.parse(
            readFileSync(join(standalonePkgDir, "package.json"), "utf8"),
        );
    } catch {
        return;
    }
    if (!pkg.name || !pkg.exports) return;

    const targets = collectBunConditionTargets(pkg.exports).filter(
        (t) => !existsSync(join(standalonePkgDir, t)),
    );
    if (targets.length === 0) return;

    // Resolve the SOURCE package from the app's real node_modules. Direct
    // layout lookup first (works regardless of the package's own exports map,
    // and follows pnpm's top-level symlinks); require.resolve as fallback for
    // hoisted/nested layouts.
    const sourcePkgJson = ((): string | null => {
        const direct = join(
            projectDir,
            "node_modules",
            pkg.name as string,
            "package.json",
        );
        if (existsSync(direct)) return direct;
        try {
            const require = createLocalRequire(projectDir);
            return require.resolve(`${pkg.name}/package.json`);
        } catch {
            return null;
        }
    })();
    if (sourcePkgJson === null) {
        result.skipped.push(
            `${pkg.name}: source package not resolvable from ${projectDir}`,
        );
        return;
    }
    const sourcePkgDir = dirname(sourcePkgJson);
    let sourceVersion: string | undefined;
    try {
        sourceVersion = JSON.parse(readFileSync(sourcePkgJson, "utf8")).version;
    } catch {
        result.skipped.push(`${pkg.name}: unreadable source package.json`);
        return;
    }
    if (sourceVersion !== pkg.version) {
        result.skipped.push(
            `${pkg.name}: version mismatch (standalone ${pkg.version} vs source ${sourceVersion})`,
        );
        return;
    }

    // Copy the targets + their same-package relative requires (bounded).
    // Normalize './x' → 'x' so seen/copied keys are stable.
    const queue = targets.map((t) => normalize(t).replace(/\\/g, "/"));
    const seen = new Set<string>();
    let budget = 50;
    while (queue.length > 0 && budget > 0) {
        const rel = queue.shift();
        if (rel === undefined || seen.has(rel)) continue;
        seen.add(rel);
        const source = join(sourcePkgDir, rel);
        const dest = join(standalonePkgDir, rel);
        if (!existsSync(source)) {
            result.skipped.push(
                `${pkg.name}/${rel}: missing in source package`,
            );
            continue;
        }
        if (!existsSync(dest)) {
            budget -= 1;
            mkdirSync(dirname(dest), { recursive: true });
            copyFileSync(source, dest);
            result.copied.push(`${pkg.name}/${rel}`);
            log(
                `[knext-adapter] bun-exports heal: copied ${pkg.name}/${rel} into standalone`,
            );
        }
        for (const req of relativeRequiresOf(source)) {
            const normalized = join(dirname(rel), req).replace(/\\/g, "/");
            const withExt = normalized.endsWith(".js")
                ? normalized
                : `${normalized}.js`;
            if (!seen.has(withExt)) queue.push(withExt);
        }
    }
}

function createLocalRequire(projectDir: string): NodeJS.Require {
    return createRequire(join(projectDir, "package.json"));
}
