/**
 * Shared CLI utilities for kn-next build and deploy commands.
 * Single source of truth for config loading.
 *
 * NOTE: copyAdapters and getNitroPreset were removed as part of the
 * vinext → official Next.js Adapter migration. The CLI now runs plain
 * `npm run build` which invokes `next build` with output:'standalone'.
 * Adapters are no longer copied to a Nitro .output/ directory.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { KnativeNextConfig } from '../config';
import { validateConfig } from './validate';

const CONFIG_FILE = 'kn-next.config.ts';

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
