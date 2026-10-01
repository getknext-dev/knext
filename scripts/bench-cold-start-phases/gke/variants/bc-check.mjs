// Prove (or disprove) that a compiled standalone executable carries bytecode
// for knext's entry, using the repo's own verifier. The marker is discovered
// from the binary (knext-standalone-exec:<24 hex>), so this works on an image
// whose build marker was never recorded.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifyBytecodeExec } from './bytecode-exec-verify.mjs';

const file = process.argv[2];
const bytes = readFileSync(file);
const latin = bytes.toString('latin1');
const markers = [...new Set(latin.match(/knext-standalone-exec:[0-9a-f]{24}/g) ?? [])];
const out = {
  file,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  markers,
  pragma_bytecode: (latin.match(/\/\/ @bun @bytecode/g) ?? []).length,
  pragma_plain: (latin.match(/\/\/ @bun @bun-cjs/g) ?? []).length,
};
out.verdicts = markers.map((m) => ({ marker: m, ...verifyBytecodeExec(bytes, m) }));
// biome-ignore lint/suspicious/noConsole: bench script, stdout is its output contract
console.log(JSON.stringify(out));
