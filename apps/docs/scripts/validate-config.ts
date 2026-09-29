/**
 * config:validate — run the REAL kn-next validator against this repo's
 * knext.config.ts, so the dogfood config is checked with the same code path
 * `kn-next deploy` uses (packages/kn-next/src/cli/validate.ts).
 *
 * Run: npm run config:validate
 */
import { validateConfig } from '@getknext/core/validate';
import config from '../knext.config';

try {
  validateConfig(config);
  // eslint-disable-next-line no-console
  console.log('✓ knext.config.ts is valid (validateConfig passed).');
  process.exit(0);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('✗ knext.config.ts failed validation:');
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
