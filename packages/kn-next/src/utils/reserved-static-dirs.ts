/**
 * The static directory names vinext/Next.js write BESIDE the build-id prefix
 * under `_next/static/` — never a build id themselves.
 *
 * Extracted to its own module (round 2 of #1292's storage-mode e2e leg, after
 * PR review): `asset-upload.ts`'s GC/marker refusal logic and any LIVE
 * (already-deployed) storage-mode check that needs to skip these siblings
 * when looking for the build-id segment in a served asset URL both import
 * this — never re-declare it — so the two can never silently drift apart.
 * Given its own tsup entry (see `tsup.config.ts`) precisely so it lands at a
 * STABLE dist path a plain-`node` script outside the TypeScript build (e.g.
 * `apps/file-manager/scripts/storage-mode-checks.mjs`) can import directly.
 *
 * See `asset-upload.ts`'s `checkStaticPrefixDir`/`stageNitroPublicAssets` doc
 * comments for why this is enumerated at all despite the repo's own
 * "prefer scanning to enumerating" rule: it is diagnostic/skip-list use,
 * never how a build id is DISCOVERED — a missing entry here means something
 * is over-kept or a live check is too strict, never a wrong prune or a wrong
 * PASS.
 */
export const RESERVED_STATIC_DIRS: ReadonlySet<string> = new Set([
    "chunks",
    "css",
    "media",
    "webpack",
    "development",
    "_vinext_fonts",
]);
