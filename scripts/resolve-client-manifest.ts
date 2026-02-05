import { readFileSync } from 'fs';

const manifestPath = process.argv[2];

if (!manifestPath) {
  console.error('Usage: bun scripts/resolve-client-manifest.ts <path-to-manifest.js>');
  process.exit(1);
}

// Mock globalThis.__RSC_MANIFEST to capture the output
globalThis.__RSC_MANIFEST = {};

try {
  // Read and unsafe eval the manifest file (it's trusted build output)
  const content = readFileSync(manifestPath, 'utf-8');
  eval(content);

  // The key is dynamic (e.g. "/dashboard/page"), so we just grab the first value
  const manifestValues = Object.values(globalThis.__RSC_MANIFEST);
  if (manifestValues.length === 0) {
    console.error('No manifest entry found in __RSC_MANIFEST');
    process.exit(1);
  }

  const manifest = manifestValues[0];

  // We need to extract:
  // 1. entryJSFiles: lists of chunks
  // 2. clientModules: lists of chunks
  const chunks = new Set<string>();

  // Helper to add chunks
  const addChunks = (fileList: any[]) => {
    if (!fileList) return;
    fileList.forEach((c) => {
      if (typeof c === 'string') {
        chunks.add(c);
      } else if (c && typeof c === 'object' && c.path) {
        chunks.add(c.path);
      }
    });
  };

  // 1. Entry JS Files (Recursively search the object potentially?)
  // Structure: entryJSFiles: { [path]: [chunks...] }
  if (manifest.entryJSFiles) {
    Object.values(manifest.entryJSFiles).forEach((list: any) => addChunks(list));
  }

  // 2. Client Modules
  // Structure: clientModules: { [id]: { chunks: [] } }
  if (manifest.clientModules) {
    Object.values(manifest.clientModules).forEach((mod: any) => addChunks(mod.chunks));
  }

  // 3. Entry CSS Files
  if (manifest.entryCSSFiles) {
    Object.values(manifest.entryCSSFiles).forEach((list: any) => addChunks(list));
  }

  console.log(JSON.stringify(Array.from(chunks)));
} catch (err) {
  console.error('Failed to parse manifest:', err);
  process.exit(1);
}
