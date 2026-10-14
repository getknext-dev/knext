import { createRequire } from "node:module";

/**
 * This core's version: the nearest `package.json` above this module that IS
 * `@getknext/core`. Walked, not a fixed `../../`: the bundler splits the
 * lazily-imported dispatch modules into chunks at `dist/` (one level above
 * `dist/cli/`), while the source sits at `src/cli/` — a fixed relative path is
 * right for one and wrong for the other (it read `0.0.0` from the bin, which
 * every peer range refuses).
 */
export function coreVersion(from: string = import.meta.url): string {
    const req = createRequire(from);
    for (const rel of [
        "../package.json",
        "../../package.json",
        "../../../package.json",
    ]) {
        try {
            const pkg = req(rel) as { name?: string; version?: string };
            if (pkg.name === "@getknext/core" && pkg.version)
                return pkg.version;
        } catch {
            // not at this level
        }
    }
    return "0.0.0";
}
