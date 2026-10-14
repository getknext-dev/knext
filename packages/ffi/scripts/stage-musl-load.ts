// Stages one leg of the musl load matrix (ADR-0069 D20) from a library that
// `cargo zigbuild` cross-built for a musl triple, using the product's own code
// for every step a real build takes:
//   - the libc check `knext ffi build` runs (@getknext/ffi elf.ts): only musl
//     and libgcc DT_NEEDED entries;
//   - the wrapper `knext ffi generate` renders from the library's embedded
//     manifest (@getknext/ffi generate.ts);
//   - `native/ffi/<triple>/lib<name>.so` and the integrity manifest core writes
//     over native/ (packages/kn-next native-integrity.ts), which the loader
//     verifies fail-closed.
//
//   bun stage-musl-load.ts --lib <lib.so> --triple <triple> --out <dir>
//                          [--stage-triple <triple>]
//
// <dir>/app     driver.ts (ffi-musl-driver.ts), src/generated/ffi/, and a
//               `server-only` package resolved under the react-server condition
// <dir>/app-leak  the same app with a MUTATED wrapper that never calls
//               knext_ffi_v1_free on a returned buffer: a real native leak
//               through the real wrapper, which the leak check must flag
// <dir>/native  ffi/<stage-triple>/lib<name>.so + .integrity.json
// <dir>/needed  the library's DT_NEEDED entries, one per line
//
// --stage-triple stages the library under a different triple than it was
// built for: the mutation the matrix must turn red on (the loader refuses a
// native/ffi/ that holds only another platform's library).

import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { writeNativeIntegrityManifest } from '../../kn-next/src/cli/native-integrity';
import { assertMuslLibrary } from '../src/elf';
import { generateFiles } from '../src/generate';

const { values } = parseArgs({
  options: {
    lib: { type: 'string' },
    triple: { type: 'string' },
    out: { type: 'string' },
    'stage-triple': { type: 'string' },
  },
  strict: true,
});
const lib = values.lib;
const triple = values.triple;
const outArg = values.out;
if (!lib || !triple || !outArg) {
  console.error(
    'usage: stage-musl-load.ts --lib <lib.so> --triple <triple> --out <dir> [--stage-triple <t>]',
  );
  process.exit(2);
}
const out = resolve(outArg);
const stageTriple = values['stage-triple'] ?? triple;
const here = dirname(new URL(import.meta.url).pathname);

// The libc check, exactly as `knext ffi build` runs it.
const bytes = readFileSync(lib);
const needed = assertMuslLibrary(bytes, triple, `${basename(lib)} (${triple})`);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'needed'), `${needed.join('\n')}\n`);

// The wrapper, as `knext ffi generate` renders it.
const app = join(out, 'app');
const files = generateFiles(lib, { version: 1, crate: 'rust', out: 'src/generated/ffi' });
mkdirSync(join(app, 'src', 'generated', 'ffi'), { recursive: true });
for (const [rel, text] of files) writeFileSync(join(app, 'src', 'generated', 'ffi', rel), text);
copyFileSync(join(here, 'ffi-musl-driver.ts'), join(app, 'driver.ts'));
writeFileSync(join(app, 'package.json'), '{ "type": "module", "private": true }\n');
// Next's `server-only`: empty under the react-server condition, a throw otherwise.
const so = join(app, 'node_modules', 'server-only');
mkdirSync(so, { recursive: true });
writeFileSync(
  join(so, 'package.json'),
  `${JSON.stringify({ name: 'server-only', exports: { '.': { 'react-server': './empty.js', default: './index.js' } } })}\n`,
);
writeFileSync(join(so, 'empty.js'), '');
writeFileSync(
  join(so, 'index.js'),
  "throw new Error('This module cannot be imported from a Client Component module.');\n",
);

// The leak mutant. Exactly two frees exist (the string and the bytes
// readers; records come back through the string reader); anything else means
// the generator changed and this mutation would no longer be the one claimed.
const FREE_CALL = '$lib.knext_ffi_v1_free(p, len);';
const wrapper = readFileSync(join(app, 'src', 'generated', 'ffi', 'index.ts'), 'utf8');
const frees = wrapper.split(FREE_CALL).length - 1;
if (frees !== 2) {
  console.error(`stage-musl-load: expected 2 "${FREE_CALL}" in the wrapper, found ${frees}`);
  process.exit(1);
}
const leakApp = join(out, 'app-leak');
cpSync(app, leakApp, { recursive: true });
writeFileSync(
  join(leakApp, 'src', 'generated', 'ffi', 'index.ts'),
  wrapper.split(FREE_CALL).join('/* knext_ffi_v1_free removed: leak mutant */'),
);

// native/, as the image carries it.
const native = join(out, 'native');
mkdirSync(join(native, 'ffi', stageTriple), { recursive: true });
copyFileSync(lib, join(native, 'ffi', stageTriple, basename(lib)));
writeNativeIntegrityManifest(native, undefined);

console.log(
  `staged ${basename(lib)} (${triple}) under native/ffi/${stageTriple}/; DT_NEEDED: ${needed.join(', ') || 'none'}`,
);
