/**
 * platform-e2e FIXTURE — full-route-cached (static) page, invalidated ONLY via
 * `revalidateTag` targeting the implicit `_N_T_<path>` tag (#1764).
 *
 * `/cache-tests/on-demand` (the pre-existing on-demand fixture) is
 * `force-dynamic` — it exercises only the DATA cache (`unstable_cache`'s
 * `ctx.tags`, which `cache-handler.js` already indexed correctly). It cannot
 * catch a defect in how the FULL-ROUTE cache (APP_PAGE) is tagged, because it
 * never writes to that cache at all.
 *
 * This page is genuinely static (`revalidate = false`, no `unstable_cache`),
 * so the only way its value ever changes is on-demand invalidation of the
 * page's own implicit path tag — which Next.js carries ONLY on
 * `value.headers['x-next-cache-tags']`, never on `ctx.tags`, for this route
 * kind. `scripts/platform-e2e.mjs` busts it via `POST /api/cache/invalidate`
 * with `tag: "_N_T_/cache-tests/static-revalidate"`.
 */
export const revalidate = false;

export default async function StaticRevalidatePage() {
  const value = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return (
    <main className="p-8">
      <h1 className="text-xl font-bold">platform-e2e static full-route-cache fixture</h1>
      <div id="static-revalidate-value" data-static-revalidate-value={value}>
        static-revalidate-value
      </div>
    </main>
  );
}
