import { loadConfig } from '../packages/cn-next/src/loader';

async function main() {
  try {
    // Load and validate config using the existing loader
    // We assume this script is run from project root, or we pass path
    const _config = await loadConfig('cn-next.config.ts');
    process.exit(0);
  } catch (error) {
    console.error('Failed to load config:', error);
    process.exit(1);
  }
}

main();
