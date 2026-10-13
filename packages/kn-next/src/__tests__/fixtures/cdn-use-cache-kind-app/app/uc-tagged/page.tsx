import { cacheLife, cacheTag } from "next/cache";

// The page's ONLY tag comes from this 'use cache' function: no fetch, no
// unstable_cache. Next copies a 'use cache' function's tags (and its cache life)
// into the page entry, so the page is an ISR page (s-maxage 3600 from "hours")
// whose entry carries `cdn-e2e-uc`, and revalidateTag("cdn-e2e-uc") purges it at
// the edge. The stamp changes on every run of the function, so a fresh render
// after the purge is visible in the body.
async function stamp() {
    "use cache";
    cacheTag("cdn-e2e-uc");
    cacheLife("hours");
    return `${new Date().toISOString()}#${Math.random().toString(36).slice(2, 10)}`;
}

export default async function UseCacheTagged() {
    const s = await stamp();
    return (
        <main>
            <h1>uc-tagged</h1>
            <p id="stamp">{s}</p>
        </main>
    );
}
