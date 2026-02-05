import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { KnativeNextConfig } from './config';

export async function loadConfig(configPath: string): Promise<KnativeNextConfig> {
  const fullPath = resolve(process.cwd(), configPath);

  if (!existsSync(fullPath)) {
    throw new Error(`Configuration file not found: ${fullPath}`);
  }

  try {
    // Bun handles TS imports natively
    const module = await import(fullPath);
    const config = module.default;

    if (!config) {
      throw new Error(`Configuration file ${fullPath} must have a default export.`);
    }

    // Basic validation (can be expanded with Zod later)
    if (!config.name || !config.storage || !config.registry) {
      throw new Error(`Invalid configuration: 'name', 'storage', and 'registry' are required.`);
    }

    return config as KnativeNextConfig;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load config from ${fullPath}: ${message}`);
  }
}
