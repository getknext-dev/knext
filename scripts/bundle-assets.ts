import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
    const dest = `dist-assets/pages/${pageName}-assets.tar.gz`;

    // We tar the CONTENT of .next/standalone
    // This includes node_modules and apps/file-manager/server.js
    await createTarball(buildDir, dest);
  }
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
  } else {
    console.warn(`  ⚠️  Static assets not found at ${staticSrc}`);
  }
}

bundle().catch(console.error);
