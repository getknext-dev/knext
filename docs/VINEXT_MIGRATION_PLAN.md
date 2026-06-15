# HISTORICAL / SUPERSEDED — Migration Plan: OpenNext & Turbopack ➡️ Vinext

> **This document is SUPERSEDED.** The Vinext migration was an intermediate step that
> has been retired. knext now runs on the **official Next.js Deployment Adapter API**
> (`experimental.adapterPath`, `NextAdapter`) with `output:'standalone'`. See:
> - `docs/ARCHITECTURE.md` — current architecture
> - `docs/adr/` — ADR-0001 (operator), ADR-0002/0003/0004 (gRPC layer)
> - `apps/file-manager/next-adapter.ts` — reference NextAdapter implementation
>
> Retained for historical context only.

---

# Migration Plan: OpenNext & Turbopack ➡️ Vinext (HISTORICAL)

This document outlines the original strategy for migrating the `Knative-open-nextjs`
architecture from Turbopack + OpenNext to Vinext (Vite-based Next.js reimplementation).
That path was superseded by the official adapter approach described above.

## 1. Dependency Updates
*   **Remove OpenNext:** Uninstall `@opennextjs/aws` from `apps/file-manager` and `packages/kn-next`.
*   **Install Vinext:** Add `vinext` and `vite` to `apps/file-manager`.
*   **Remove Old Scripts:** Remove `open-next-config.ts` generator from `packages/kn-next`.

## 2. Configuration Migration
*   **Delete OpenNext Config:** Remove the auto-generation of `open-next.config.ts`.
*   **Clean `next.config.ts`:**
    *   Remove the `turbopack` block (e.g., `resolveAlias` for `pino-elasticsearch`).
    *   Remove the `webpack` overrides that bypass Turbopack errors.
*   **Initialize Vinext:** Run `npx vinext init` in `apps/file-manager` to generate `vite.config.ts`.
*   **Replicate Aliases:** Move the Node.js module mocks (`pino-elasticsearch`, `thread-stream`) into Vite's `resolve.alias` configuration within `vite.config.ts`.
*   **Package Scripts:** Update `dev`, `build`, and `start` scripts in `apps/file-manager/package.json` to use `vinext dev`, `vinext build`, and `vinext start`.

## 3. Build Pipeline Updates (`kn-next` CLI)
The custom CLI (`packages/kn-next/src/cli/build.ts` & `deploy.ts`) requires significant pruning:
*   **Remove OpenNext Steps:** Strip out the `npx open-next build` execution and the `generateOpenNextConfig` step.
*   **Update Asset Paths:** Change the static asset upload source from `.open-next/assets` to Vinext's output directory (typically `.vite/client` or `.vinext`).
*   **Remove Turbopack Hacks (CRITICAL):** Delete the massive block of Turbopack patching logic in `deploy.ts` (lines 140-300). Vinext uses Vite/Rollup for bundling, so the RSC flight data and chunk pathing hacks are no longer necessary.

## 4. Runtime Adapter (Knative Integration)
Currently, `packages/kn-next/src/adapters/node-server.ts` is an `OpenNextHandler` wrapper.
*   **New HTTP Wrapper:** Rewrite the Knative entry point to consume Vinext's output server instead of OpenNext's internal handler. Vinext compiles to a standard Web Request/Response handler. You will need to wrap Node's `http.createServer` to convert Node `IncomingMessage` to a standard web `Request` to pass to Vinext's handler (or see if Vinext provides a Node-compatible entry point).

## 5. Cache & ISR Re-Architecture
*   **OpenNext Providers:** The current setup injects custom Redis/GCS/Kafka providers into OpenNext via `incrementalCache`, `tagCache`, and `queue` in `open-next.config.ts`.
*   **Vinext Approach:** Vinext does not use OpenNext's custom provider interfaces. We must evaluate how Vinext handles the standard Next.js `cacheHandler` (which is already defined in `next.config.ts` via `./cache-handler.js`) and ISR queues. The Kafka-based ISR queue might need to be rewritten to trigger standard Next.js revalidation routes instead of OpenNext SQS/Lambda interfaces.

## 6. Known Risks & Considerations
*   **Target Platform:** Vinext is primarily designed and tested for **Cloudflare Workers**. Running its output natively on a Node.js HTTP server inside a Knative Docker container will require ensuring that Vite's server build is strictly Node-compatible (avoiding Edge-only APIs).
*   **Next.js Compatibility:** Vinext is an experimental reimplementation. While it covers ~94% of the Next.js API, certain edge cases, Image Optimization (`next/image`), and Font optimization might behave differently or be entirely unsupported compared to the official Turbopack/Next.js compiler.
