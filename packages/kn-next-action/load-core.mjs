/**
 * Resolve an `@getknext/core` internal subpath from the APP's node_modules —
 * the step's working directory, where the app installed its dependencies —
 * never from this file's own location. A bare `import('@getknext/core/…')`
 * here would resolve relative to THIS file (the action's own checkout, which
 * has no node_modules), which failed for every consumer (#1481).
 *
 * Shared by `kubeconfig-check.mjs` and `preflight.mjs`. Exits 1 (fail closed)
 * when the module cannot be loaded: a check that cannot load its classifier
 * has not checked anything.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadFromCore(subpath, whatFor) {
  try {
    const fromApp = createRequire(join(process.cwd(), 'package.json'));
    const entry = fromApp.resolve(`@getknext/core/internal/${subpath}`);
    return await import(pathToFileURL(entry).href);
  } catch (err) {
    console.error(`::error::Could not load ${whatFor} from @getknext/core.`);
    console.error(
      `Looked from ${process.cwd()}. Install your app's dependencies (e.g. \`npm ci\`) ` +
        'before this action, so `@getknext/core` is resolvable from `working-directory`.',
    );
    console.error(`\nunderlying error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
