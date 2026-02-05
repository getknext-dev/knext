import { loadConfig } from '../packages/cn-next/src/loader';

async function main() {
  try {
    // Load and validate config using the existing loader
    // We assume this script is run from project root, or we pass path
    const config = await loadConfig('cn-next.config.ts');

    // Output JSON to stdout for the Go CLI to read
    console.log(JSON.stringify(config, null, 2));
    process.exit(0);
  } catch (error) {
    console.error('Failed to load config:', error);
    process.exit(1);
  }
}

main();
