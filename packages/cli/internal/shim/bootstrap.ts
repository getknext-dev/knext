// Bootstrap Loader - Option 3 Architecture
// Lazy-loads everything from object storage, no VFS

import { spawn } from 'node:child_process';
import { CacheManager } from './cache_manager';
import { ModuleMonitor } from './module_monitor';

const PAGE_ROUTE = process.env.PAGE_ROUTE || 'home';
const STORAGE_URL =
  process.env.STORAGE_URL || 'https://storage.googleapis.com/knative-next-assets-banna';

console.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.info('🚀 Bootstrap Loader - Option 3 Architecture');
console.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.info(`📄 Page: ${PAGE_ROUTE}`);
console.info(`☁️  Storage: ${STORAGE_URL}`);
console.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

async function downloadAndExtract(url: string, dest: string) {
  console.info(`[Bootstrap] ⬇️  Downloading artifacts from ${url}...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch artifacts: ${resp.statusText}`);

  // Save tar.gz to /tmp
  const tmpFile = `/tmp/${PAGE_ROUTE}.tar.gz`;
  await Bun.write(tmpFile, await resp.blob());

  console.info(`[Bootstrap] 📦 Extracting to ${dest}...`);

  // Use tar command to extract
  const proc = spawn('tar', ['-xzf', tmpFile, '-C', dest]);

  return new Promise<void>((resolve, reject) => {
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar extraction failed with code ${code}`));
    });
    proc.on('error', reject);
  });
}

async function boot() {
  const startTime = Date.now();

  try {
    const cache = new CacheManager(PAGE_ROUTE, STORAGE_URL);

    // Setup native require just in case
    try {
      const { createRequire } = await import('node:module');
      (globalThis as any).__native_require = createRequire(import.meta.url);
    } catch (_e) {}

    const monitor = new ModuleMonitor(cache);

    // 1. Load runtime dependencies/script
    console.info('[Bootstrap] Step 1: Loading runtime bundle...');
    await monitor.loadWithProgress([`${STORAGE_URL}/runtime/next-runtime.bundle.js`]);

    // 2. Download Page Artifacts (Standalone Bundle)
    console.info('\n[Bootstrap] Step 2: Loading page artifacts (Standalone)...');

    // Extract to current directory (.)
    // Standalone bundle contains: node_modules/, apps/file-manager/server.js, etc.
    await downloadAndExtract(`${STORAGE_URL}/pages/${PAGE_ROUTE}-assets.tar.gz`, '.');
    console.info('[Bootstrap] ✅ Artifacts extracted to ./');

    const bootTime = Date.now() - startTime;
    console.info(`\n⏱️  Boot time: ${bootTime}ms`);

    // 3. Start Next.js server
    console.info('[Bootstrap] Starting Next.js server...');

    const loadedModules = (globalThis as any).__loaded_modules || {};
    const runtimeModule = Object.values(loadedModules).find(
      (m: any) => typeof m.start === 'function',
    );

    if (runtimeModule) {
      await (runtimeModule as any).start();
    } else {
      throw new Error('Runtime start function not found');
    }
  } catch (error) {
    console.error('\n❌ Bootstrap Failed:', error);
    process.exit(1);
  }
}

boot();
