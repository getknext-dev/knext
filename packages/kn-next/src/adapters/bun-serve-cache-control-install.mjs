/**
 * Side-effect module injected by vinext-compile into the compiled executable's
 * entry (right after the keep-alive guard): installs the deployed-platform
 * Cache-Control normalization on `Bun.serve` (#1322). See
 * bun-serve-cache-control.mjs.
 */
import { install } from "./bun-serve-cache-control.mjs";

install(
    typeof globalThis !== "undefined" ? globalThis.Bun : undefined,
    typeof process !== "undefined" ? process.env : undefined,
);
