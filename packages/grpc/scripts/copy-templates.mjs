#!/usr/bin/env node
// Copies templates/go and templates/rust into this package so the published
// tarball carries the templates `knext add function` scaffolds from. Run by
// `build`.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

// [directory, a file that proves it is the template, top-level build output a
// local run leaves next to it (git-ignored; never shipped)]
const TEMPLATES = [
  ['go', 'go.mod', []],
  ['rust', 'Cargo.toml', ['target', '.codegen']],
];

for (const [lang, marker, buildOutput] of TEMPLATES) {
  const src = resolve(root, 'templates', lang);
  const dest = resolve(here, '..', 'templates', lang);
  if (!existsSync(resolve(src, marker))) {
    console.error(`templates/${lang} not found at ${src}`);
    process.exit(1);
  }
  const skip = new Set(buildOutput.map((name) => resolve(src, name)));
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true, filter: (path) => !skip.has(path) });
}
