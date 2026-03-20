/**
 * Shared CLI utilities for kn-next build and deploy commands.
 * Single source of truth for config loading and adapter copying.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { KnativeNextConfig } from "../config";
import { createLogger } from "../utils/logger";
import { validateConfig } from "./validate";

const log = createLogger({ module: "cli" });

const CONFIG_FILE = "kn-next.config.ts";

/**
 * Loads kn-next.config.ts from the current working directory.
 * Runs validation after loading — fails fast with clear error messages.
 */
export async function loadConfig(): Promise<KnativeNextConfig> {
    const configPath = resolve(process.cwd(), CONFIG_FILE);

    if (!existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
    }

    const module = await import(configPath);
    const config: KnativeNextConfig = module.default;

    validateConfig(config);

    return config;
}

/**
 * Copies framework adapters to the Nitro output directory.
 * Both build.ts and deploy.ts need this — single implementation here.
 */
export async function copyAdapters(outputDir: string): Promise<void> {
    const adaptersDir = join(outputDir, "adapters");
    mkdirSync(adaptersDir, { recursive: true });

    // Resolve adapter source relative to this file's location
    const sourceDir = resolve(dirname(import.meta.path), "..", "adapters");

    const adaptersToCopy = ["node-server.ts"];

    for (const adapter of adaptersToCopy) {
        const src = join(sourceDir, adapter);
        const dest = join(adaptersDir, adapter);
        if (existsSync(src)) {
            copyFileSync(src, dest);
            log.info({ adapter }, "Copied adapter");
        }
    }

    // Copy custom cache handler if it exists in the app directory
    const cacheHandlerSrc = join(process.cwd(), "cache-handler.js");
    if (existsSync(cacheHandlerSrc)) {
        copyFileSync(cacheHandlerSrc, join(adaptersDir, "cache-handler.js"));
        log.info("Copied cache-handler.js");
    }
}

/**
 * Returns the Nitro preset based on config.runtime.
 * Default: 'bun' (matches Dockerfile and deploy pipeline).
 */
export function getNitroPreset(config: KnativeNextConfig): string {
    const runtime = config.runtime ?? "bun";
    return runtime === "bun" ? "bun" : "node-server";
}
