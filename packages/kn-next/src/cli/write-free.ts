/**
 * Write-free runtime facts the CLI hands the CR builder.
 *
 * The operator mounts a writable `emptyDir` under the read-only root
 * filesystem for two build shapes it cannot otherwise tell are safe without
 * one: `/tmp` for a vinext build (a SELF-CONTAINED vinext binary unpacks
 * sharp's native libraries there), and `.next/standalone/.next/cache` for a
 * storage-configured standalone build (Next's image optimizer writes
 * `.next/cache/images`). Each emptyDir costs pod-sandbox setup time on every
 * cold wake, so the CLI states, from what it actually built, when neither is
 * needed: `spec.security.writeFree`.
 *
 * Only the CLI that built the image can vouch for it — a `--image` or
 * `--skip-build` deploy never sets the field.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface WriteFreeFacts {
    /** The CLI built the image in this run (false for `--image` / `--skip-build`). */
    builtThisRun: boolean;
    /**
     * The built standalone app routes Next's optimized-image cache through the
     * knext cache handler (`images.customCacheHandler: true` in the built
     * config) instead of writing `.next/cache/images`.
     */
    imageCacheRouted?: boolean;
}

/**
 * Whether THIS standalone build routes the image-optimizer cache through the
 * cache handler. Reads the build's own `.next/required-server-files.json` (the
 * config the standalone server starts with) and trusts it only when
 * `.next/BUILD_ID` is this deploy's tag, so a stale build output can never
 * claim a write-free image. Any read or parse failure is `false`: a missing
 * fact keeps the operator's mount, it never drops one.
 */
export function readImageCacheRouted(
    appDir: string,
    buildId: string,
    readFile: (path: string) => string = (p) => readFileSync(p, "utf-8"),
): boolean {
    try {
        const built = readFile(join(appDir, ".next", "BUILD_ID")).trim();
        if (built !== buildId) return false;
        const rsf = JSON.parse(
            readFile(join(appDir, ".next", "required-server-files.json")),
        ) as { config?: { images?: { customCacheHandler?: unknown } } };
        return rsf.config?.images?.customCacheHandler === true;
    } catch {
        return false;
    }
}
