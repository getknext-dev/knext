import { spawn } from 'child_process';
import fs from 'fs';
import { build } from 'bun';

async function createTarball(srcDir: string, destFile: string) {
  // tar -czf destFile -C srcDir .
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('tar', ['-czf', destFile, '-C', srcDir, '.']);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed with code ${code}`));
    });
    proc.on('error', reject);
  });
}

async function bundle() {
  console.log('📦 Bundling Assets for GKE deployment...');

  // 1. Runtime Bundle (Wrapper to start server.js)
  console.log('  Bundling Runtime...');
  const runtimeBuild = await build({
    entrypoints: ['packages/cli/internal/shim/runtime-entry.ts'],
    outdir: 'dist-assets/runtime',
    target: 'bun',
    minify: true,
    naming: 'next-runtime.bundle.js',
    // Externalize everything so we rely on standalone node_modules
    external: ['*'],
  });

  if (!runtimeBuild.success) {
    console.error('Runtime build failed:', runtimeBuild.logs);
    process.exit(1);
  }

  // 2. Page Artifacts (Standalone Output)
  console.log('  Bundling Page Artifacts (Standalone)...');
  const buildDir = 'apps/file-manager/.next/standalone';
  if (!fs.existsSync(buildDir)) {
    console.error(
      `❌ Build directory ${buildDir} not found! Run 'cd apps/file-manager && bun run build' first.`,
    );
    process.exit(1);
  }

  // Create dist-assets/pages if needed
  fs.mkdirSync('dist-assets/pages', { recursive: true });

  const pages = ['home', 'dashboard', 'users'];

  for (const pageName of pages) {
    console.log(`  Creating artifact for ${pageName}...`);
    const dest = `dist-assets/pages/${pageName}-assets.tar.gz`;

    // We tar the CONTENT of .next/standalone
    // This includes node_modules and apps/file-manager/server.js
    await createTarball(buildDir, dest);
    console.log(`  ✅ Created ${dest}`);
  }

  // 3. Static Assets (Client hydration)
  console.log('  Bundling Static Assets (Client hydration)...');
  const staticSrc = 'apps/file-manager/.next/static';
  if (fs.existsSync(staticSrc)) {
    const staticDest = 'dist-assets/static';
    // Use cp -r
    const proc = spawn('cp', ['-r', staticSrc, staticDest]);
    await new Promise<void>((resolve, reject) => {
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`cp failed with code ${code}`));
      });
    });
    console.log(`  ✅ Copied static assets to ${staticDest}`);
    console.log('     (Upload this folder to gs://BUCKET/_next/static)');
  } else {
    console.warn(`  ⚠️  Static assets not found at ${staticSrc}`);
  }
}

bundle().catch(console.error);
