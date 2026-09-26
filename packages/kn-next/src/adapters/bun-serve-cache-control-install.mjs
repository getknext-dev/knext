/**
 * Side-effect module injected by vinext-compile into the compiled executable's
 * entry (after the keep-alive guard and the sidecar resolver): installs the
 * deployed-platform Cache-Control normalization on `Bun.serve`, and turns on
 * vinext's own deploy Cache-Control switch by default (#1322). Both run at
 * process start, before any request. See bun-serve-cache-control.mjs.
 */
// @knext-shim bun-serve-cache-control
import { applyVinextDeployDefault, install } from "./bun-serve-cache-control.mjs";

const env = typeof process !== "undefined" ? process.env : undefined;
applyVinextDeployDefault(env);
install(typeof globalThis !== "undefined" ? globalThis.Bun : undefined, env);
