import { unstable_cache } from "next/cache";

// An ISR page: Next emits `s-maxage` for it and records its own page-entry tags
// (the implicit `_N_T_/tagged` path tag plus `cdn-e2e-page` from the cached
// function), so with spec.cdn it is edge-cacheable and carries a Cache-Tag.
export const revalidate = 3600;

const stamp = unstable_cache(
    async () => `${new Date().toISOString()}#${Math.random().toString(36).slice(2, 10)}`,
    ["cdn-e2e-stamp"],
    { tags: ["cdn-e2e-page"] },
);

export default async function Tagged() {
    const s = await stamp();
    return (
        <main>
            <h1>tagged</h1>
            <p id="build">{process.env.KNEXT_E2E_BUILD_MARK}</p>
            <p id="stamp">{s}</p>
        </main>
    );
}
