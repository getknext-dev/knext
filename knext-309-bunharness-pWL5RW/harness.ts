
import { getCompileCacheDir } from "node:module";
import { warnOnDegradedCompileCache } from "/Users/banna/alpheya/pocs/knext/packages/kn-next/src/adapters/compile-cache-health.ts";

const warns = [];
const status = warnOnDegradedCompileCache({
    env: process.env,
    log: { warn: (obj, msg) => warns.push(msg) },
});
console.log(JSON.stringify({
    runtime: process.versions.bun ? "bun" : "node",
    probeType: typeof getCompileCacheDir,
    probeValue: (typeof getCompileCacheDir === "function" ? getCompileCacheDir() : undefined) ?? null,
    status,
    warns,
}));
