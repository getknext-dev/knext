#!/usr/bin/env node
// Copies templates/go into this package so the published tarball carries the
// template `knext add function --lang go` scaffolds from. Run by `build`.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', '..', '..', 'templates', 'go');
const dest = resolve(here, '..', 'templates', 'go');
if (!existsSync(resolve(src, 'go.mod'))) {
  console.error(`templates/go not found at ${src}`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
