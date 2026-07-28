#!/usr/bin/env bun
/**
 * gen-cr-fields.ts — regenerate the CR/CRD compatibility artifacts (T7).
 *
 *   bun scripts/gen-cr-fields.ts            # write
 *   bun scripts/gen-cr-fields.ts --check    # exit 1 if the tree would change
 *
 * Writes:
 *   packages/kn-next/src/cli/schema/emitted-fields.generated.ts  (shipped)
 *   docs/compat/cr-fields.json                                   (published)
 *   docs/compat/cr-fields.md                                     (human)
 *
 * All three are derived by SCANNING `cr-builder.ts`. The equality gate lives in
 * `cr-fields-generated.test.ts`, which calls the same renderers — so `--check`
 * and CI cannot disagree.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { crdSchemaFromCrdObject } from '../packages/kn-next/src/cli/schema/crd-schema';
import { extractEmittedFields } from '../packages/kn-next/src/cli/schema/extract-emitted-fields';
import {
  renderCrFieldsJson,
  renderCrFieldsMarkdown,
  renderEmittedFieldsModule,
} from '../packages/kn-next/src/cli/schema/gen-artifacts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CR_BUILDER = join(REPO, 'packages', 'kn-next', 'src', 'cli', 'cr-builder.ts');
const GENERATED_TS = join(
  REPO,
  'packages',
  'kn-next',
  'src',
  'cli',
  'schema',
  'emitted-fields.generated.ts',
);
const DOC_DIR = join(REPO, 'docs', 'compat');
const CRD_YAML = join(
  REPO,
  'packages',
  'kn-next-operator',
  'config',
  'crd',
  'bases',
  'apps.kn-next.dev_nextapps.yaml',
);

const check = process.argv.includes('--check');

const paths = extractEmittedFields(readFileSync(CR_BUILDER, 'utf-8'));
const crd = YAML.parse(readFileSync(CRD_YAML, 'utf-8')) as unknown;
const schema = crdSchemaFromCrdObject(crd);
if (!schema) {
  throw new Error(`${CRD_YAML}: no v1alpha1 openAPIV3Schema found`);
}

const outputs: [string, string][] = [
  [GENERATED_TS, renderEmittedFieldsModule(paths)],
  [join(DOC_DIR, 'cr-fields.json'), renderCrFieldsJson(paths, schema)],
  [join(DOC_DIR, 'cr-fields.md'), renderCrFieldsMarkdown(paths, schema)],
];

let stale = 0;
for (const [file, content] of outputs) {
  let existing: string | undefined;
  try {
    existing = readFileSync(file, 'utf-8');
  } catch {
    existing = undefined;
  }
  if (existing === content) continue;
  stale++;
  if (check) {
    console.error(`STALE: ${file}`);
    continue;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf-8');
  console.log(`wrote ${file}`);
}

if (check && stale > 0) {
  console.error(
    `${stale} generated artifact(s) are stale — run \`bun scripts/gen-cr-fields.ts\` and commit the result.`,
  );
  process.exit(1);
}
if (!check && stale === 0) console.log('artifacts already up to date');
