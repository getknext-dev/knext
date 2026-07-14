/**
 * Shared CLI utilities for kn-next build and deploy commands.
 * Single source of truth for config loading.
 *
 * NOTE: copyAdapters and getNitroPreset were removed as part of the
 * vinext → official Next.js Adapter migration. The CLI now runs plain
 * `npm run build` which invokes `next build` with output:'standalone'.
 * Adapters are no longer copied to a Nitro .output/ directory.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { KnativeNextConfig } from "../config";
import { validateConfig } from "./validate";

const CONFIG_FILE = "kn-next.config.ts";

/** Default cap for {@link excerpt} — keeps a hint line to one terminal row-ish. */
const DEFAULT_EXCERPT_MAX = 160;

/**
 * Build a bounded, whitespace-collapsed one-line excerpt of raw text (typically
 * kubectl stderr) for embedding in an error/hint message.
 *
 * Single source of truth for what `doctor.ts` and `status.ts` previously
 * hand-rolled (inconsistently — status did a bare `.slice` and did NOT collapse
 * whitespace). Steps: trim → collapse every run of whitespace (newlines, tabs,
 * spaces) to a single space → slice to `max`.
 *
 * The slice is by CODE POINT (`Array.from`), not UTF-16 unit, so a multi-byte
 * character (emoji, etc.) is never split into a lone surrogate at the cap.
 *
 * @param raw - the source text (may contain newlines / control-adjacent bytes)
 * @param max - maximum length in code points (default {@link DEFAULT_EXCERPT_MAX})
 */
export function excerpt(raw: string, max = DEFAULT_EXCERPT_MAX): string {
    const collapsed = raw.trim().replace(/\s+/g, " ");
    return Array.from(collapsed).slice(0, max).join("");
}

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
