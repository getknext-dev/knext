import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = process.cwd();
const APP_DIR = path.join(PROJECT_ROOT, 'apps/file-manager');
const NFT_PATH = path.join(APP_DIR, '.next/server/app/dashboard/page.js.nft.json');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist-isolated');
const SOURCE_BASE = path.join(APP_DIR, '.next/server/app/dashboard'); // Base for relative paths in NFT

// We need to resolve where the files actually ARE relative to the NFT file.
// The NFT contains paths like "../../../../../node_modules/pg/package.json"
// Resolving from ".next/server/app/dashboard"

if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true });
}
fs.mkdirSync(DIST_DIR, { recursive: true });

const nftContent = JSON.parse(fs.readFileSync(NFT_PATH, 'utf-8'));
const files = nftContent.files;

console.log(`Found ${files.length} files in NFT trace.`);

files.forEach((file) => {
  const srcPath = path.resolve(SOURCE_BASE, file);

  // meaningful path inside dist
  // We want to mimic the standalone structure somewhat or just flat?
  // The runner expects files in specific places relative to PROJECT_ROOT usually.
  // The NFT paths go all the way back to root.

  // Let's try to preserve the relative structure from PROJECT_ROOT
  const relToRoot = path.relative(PROJECT_ROOT, srcPath);

  if (relToRoot.startsWith('..')) {
    // These are outside the project? Ignore or panic.
    console.warn('Skipping outside file:', relToRoot);
    return;
  }

  const destPath = path.join(DIST_DIR, relToRoot);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
});

// Also copy global error/not-found to prevent crashes on 404/500
const globalPages = ['_not-found', '_global-error'];
globalPages.forEach((p) => {
  const src = path.join(SOURCE_BASE, '../', p); // ../ relative to dashboard
  const relToRoot = path.relative(PROJECT_ROOT, src);
  const dest = path.join(DIST_DIR, relToRoot);
  if (fs.existsSync(src)) {
    console.log(`Copying global page: ${p}`);
    copyDir(src, dest);
  }
});

// CRITICAL: Copy the Entry Point files themselves (page.js) because NFT excludes them!
const entryFiles = ['page.js', 'page_client-reference-manifest.js'];
entryFiles.forEach((f) => {
  const src = path.join(SOURCE_BASE, f);
  const relToRoot = path.relative(PROJECT_ROOT, src);
  const dest = path.join(DIST_DIR, relToRoot);
  if (fs.existsSync(src)) {
    console.log(`Explicitly copying entry file: ${f}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  } else {
    console.warn(`Entry file not found: ${src}`);
  }
});

// Also copy layout files IF they exist (search in parent dirs manually if needed, but for now just dashboard)
// If dashboard has no layout, it uses root layout? We should try to find root layout.
const appDir = path.join(APP_DIR, '.next/server/app');
if (fs.existsSync(appDir)) {
  ['layout.js', 'layout.css', 'error.js', 'loading.js'].forEach((f) => {
    const src = path.join(appDir, f);
    if (fs.existsSync(src)) {
      const relToRoot = path.relative(PROJECT_ROOT, src);
      const dest = path.join(DIST_DIR, relToRoot);
      console.log(`Copying root file: ${f}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  });
}

// Copy server.js (Next.js Standalone Runner)
const serverSrc = path.join(APP_DIR, 'server.js');
const serverDest = path.join(DIST_DIR, 'apps/file-manager/server.js');
if (fs.existsSync(serverSrc)) {
  fs.copyFileSync(serverSrc, serverDest);
} else {
  console.warn("Warning: server.js not found. Run 'bun run build' first.");
}

// Ensure .next/server is copied entirely to support all pages
const serverDirSrc = path.join(APP_DIR, '.next/server');
const serverDirDest = path.join(DIST_DIR, 'apps/file-manager/.next/server');
if (fs.existsSync(serverDirSrc)) {
  console.log(`Copying full server directory from ${serverDirSrc}`);
  fs.mkdirSync(serverDirDest, { recursive: true });
  // Recursive copy of server directory
  fs.cpSync(serverDirSrc, serverDirDest, { recursive: true });
}

// Copy essential manifests that NFT misses
const manifestFiles = [
  'BUILD_ID',
  'routes-manifest.json',
  'prerender-manifest.json',
  'required-server-files.json',
  'build-manifest.json', // REQUIRED for hydration
  'react-loadable-manifest.json', // REQUIRED for dynamic imports
  'package.json', // .next/package.json
  'server/middleware-manifest.json', // often needed
  'server/functions-config-manifest.json', // REQUIRED
  'server/app-paths-manifest.json',
  'server/pages-manifest.json',
  'server/next-font-manifest.json',
  'server/next-font-manifest.js',
  'app-path-routes-manifest.json',
];

manifestFiles.forEach((f) => {
  const src = path.join(APP_DIR, '.next', f);
  const dest = path.join(DIST_DIR, 'apps/file-manager/.next', f);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
});

// Force-include Next.js Server Runtime files (missed by Page NFT)
// We need 'next/dist/server/lib/start-server.js' and likely 'next/dist/server/next-server.js'
// Since this is a prototype, let's just copy the whole 'next/dist' folder from PROJECT ROOT node_modules
// because local app node_modules might be partial or hoisted.
const nextDistSrc = path.join(PROJECT_ROOT, 'node_modules/next/dist');
const nextDistDest = path.join(DIST_DIR, 'apps/file-manager/node_modules/next/dist');

// Recursive copy helper
function copyDir(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  // console.log(`Copying dir ${src} -> ${dest}`);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      // console.log(`Copying file ${entry.name}`);
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

if (fs.existsSync(nextDistSrc)) {
  console.log('Copying full Next.js runtime...');
  copyDir(nextDistSrc, nextDistDest);
}

// Copy package.json for next
const nextPkgSrc = path.join(APP_DIR, 'node_modules/next/package.json');
const nextPkgDest = path.join(DIST_DIR, 'apps/file-manager/node_modules/next/package.json');
fs.copyFileSync(nextPkgSrc, nextPkgDest);

// Protocol: Copy .next/static (CSS, JS chunks, Media) - Critical for client-side rendering
// These are immutable hashed files, safe to copy entirely.
const staticSrc = path.join(APP_DIR, '.next/static');
const staticDest = path.join(DIST_DIR, 'apps/file-manager/.next/static');
if (fs.existsSync(staticSrc)) {
  console.log(`Copying static assets from ${staticSrc} to ${staticDest}`);
  fs.mkdirSync(staticDest, { recursive: true });
  fs.cpSync(staticSrc, staticDest, { recursive: true });
} else {
  console.warn('Warning: .next/static not found! Client-side assets will 404.');
}

// Copy styled-jsx (peer dependency required by Next.js Standalone)
const styledJsxSrc = path.join(PROJECT_ROOT, 'node_modules/styled-jsx');
const styledJsxDest = path.join(DIST_DIR, 'apps/file-manager/node_modules/styled-jsx');
if (fs.existsSync(styledJsxSrc)) {
  console.log('Copying styled-jsx...');
  copyDir(styledJsxSrc, styledJsxDest);
}

// AUTOMATED Dependency Copy using Standalone Trace
// The standalone build already traced ALL dependencies for ALL pages.
// We use that as the base, then overlay any fixes.
const standaloneBase = path.join(APP_DIR, '.next/standalone');
const standaloneNodeModules = path.join(standaloneBase, 'node_modules');
const targetNodeModules = path.join(DIST_DIR, 'apps/file-manager/node_modules');

if (fs.existsSync(standaloneNodeModules)) {
  console.log(`Copying traced node_modules from Standalone build...`);
  // We copy to DIST_DIR/apps/file-manager/node_modules initially to structure it?
  // Wait, the tarball logic zips `DIST_DIR/apps/file-manager/node_modules`.
  // So we copy there.
  if (fs.existsSync(targetNodeModules)) {
    fs.rmSync(targetNodeModules, { recursive: true });
  }
  fs.mkdirSync(path.dirname(targetNodeModules), { recursive: true });
  fs.cpSync(standaloneNodeModules, targetNodeModules, { recursive: true });
} else {
  console.error("Error: .next/standalone/node_modules not found. Run 'bun run build' first!");
  process.exit(1);
}

// Copy server.js and app code from Standalone
// The standalone folder contains "apps/file-manager/server.js" and "apps/file-manager/.next/..."
// We should overwrite our manual copy with this.
const standaloneAppDir = path.join(standaloneBase, 'apps/file-manager');
const targetAppDir = path.join(DIST_DIR, 'apps/file-manager');

if (fs.existsSync(standaloneAppDir)) {
  console.log(`Copying application code from Standalone build...`);
  fs.cpSync(standaloneAppDir, targetAppDir, { recursive: true, force: true });
}

// Generate Dockerfile
const dockerfileContent = `
FROM oven/bun:1.0.25-alpine

WORKDIR /app

# Install runtime dependencies (Alpine)
RUN apk add --no-cache bash

# Copy the application structure
ADD node_modules.tar.gz .
COPY apps/file-manager /app/apps/file-manager

# Symlink node_modules to project root so server.js can find them
# We link /app/node_modules -> /app/apps/file-manager/node_modules
RUN ln -s /app/node_modules /app/apps/file-manager/node_modules

WORKDIR /app/apps/file-manager

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Server.js is the standard Next.js standalone entrypoint
CMD ["bun", "server.js"]
`;

fs.writeFileSync(path.join(DIST_DIR, 'Dockerfile.prototype'), dockerfileContent.trim());

console.log('Isolation complete. Try running with bun.');
