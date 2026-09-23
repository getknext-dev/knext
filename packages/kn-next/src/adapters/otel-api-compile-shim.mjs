/**
 * `@opentelemetry/api` require shim for the COMPILED vinext single executable
 * (#1309).
 *
 * ## What broke
 *
 * vinext 1.0.0-beta.11 ships new built-in request/rendering/fetch/metadata/
 * response tracing (its own OpenTelemetry instrumentation, cloudflare/vinext
 * changelog "Tracing: add Next.js-compatible OpenTelemetry instrumentation").
 * Like the existing `clientTraceMetadata` feature (`dist/server/client-trace-
 * metadata.js`), the new code resolves `@opentelemetry/api` at RUNTIME via
 * `globalThis.require('@opentelemetry/api')` rather than a static import —
 * `@opentelemetry/api` is deliberately kept an optional peer so apps that
 * don't configure OTel pay nothing and the package is never a hard dependency
 * of the compiled artifact.
 *
 * `Bun.build`'s bundler only follows STATIC `import`/`require(<literal>)`
 * graphs (the same reason `vinext-compile.mjs` has to hand-roll sharp's addon
 * loading rather than let `--compile` find it): a `require()` reached through
 * a variable (`globalThis.require`) is invisible to it, so `@opentelemetry/
 * api` never gets embedded in the compiled binary. At runtime the binary's
 * `require` has no real `node_modules` to fall back to (`/$bunfs/root/…` is a
 * virtual filesystem), so the call throws `Cannot find module
 * '@opentelemetry/api'` — and unlike `client-trace-metadata.js`'s own
 * try/catch, whichever new beta.11 call site does this does NOT swallow it,
 * so every request 500s (compat run: knext adapter smoke, `a` through `f` all
 * red, 100%).
 *
 * ## The fix
 *
 * Bundle a REAL `@opentelemetry/api` into the binary via a plain STATIC
 * import (this file), which `Bun.build` bundles exactly like it bundles
 * sharp's own JS — then serve that instance out of a `globalThis.require`
 * wrapper so any `require('@opentelemetry/api')` call anywhere in the binary
 * (vinext's new tracing code, `@vercel/otel`, or app code) resolves to it
 * instead of falling through to the real (absent) module resolver. Delegates
 * every other specifier to the original `require`, so this touches nothing
 * else.
 *
 * SHIPS only in the COMPILED single executable: `vinext-compile.mjs` injects
 * an `import` of this module (after the keep-alive guard) as one of the
 * FIRST statements of the nitro entry, so the shim installs before any
 * tracing code can run. The uncompiled nitro boot (`KNEXT_COMPILE=0`) needs
 * no shim — Bun's plain `require`/`import` resolves `@opentelemetry/api` from
 * the real on-disk `node_modules` there, exactly as vinext's own optional-
 * peer contract expects.
 */

import * as otelApi from '@opentelemetry/api';

const INSTALLED = Symbol.for('knext.otelApiCompileShim.installed');

/**
 * @param {unknown} globalObj
 * @param {Record<string, unknown>} apiModule
 */
export function installOtelApiRequireShim(globalObj, apiModule) {
  const g = /** @type {Record<PropertyKey, unknown>} */ (globalObj);
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;
  const original =
    typeof g.require === 'function' ? /** @type {(spec: string) => unknown} */ (g.require) : undefined;
  g.require = (specifier) => {
    if (specifier === '@opentelemetry/api') return apiModule;
    if (original) return original(specifier);
    throw new Error(`Cannot find module '${specifier}'`);
  };
}

installOtelApiRequireShim(globalThis, otelApi);
