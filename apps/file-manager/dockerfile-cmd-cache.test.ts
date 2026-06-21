import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression test for f100deb (A2-1).
 *
 * The bug: the container CMD used `: ${NODE_COMPILE_CACHE:=…}`, which sets a
 * *shell* variable but never exports it, so the spawned `node` process never
 * received NODE_COMPILE_CACHE — the bytecode cache silently never filled. It
 * passed CI + unit tests + two reviews because node-compile-cache.test.ts sets
 * the var directly in the child env, so it never exercised the CMD's shell.
 *
 * This test covers the real container CMD path: it extracts the runtime CMD
 * from the Dockerfile, runs its shell with NODE_COMPILE_CACHE *unset*, and
 * asserts the var is actually EXPORTED to the node process. It is RED against
 * the old `:=`-without-export form and GREEN against the `export …` fix.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = resolve(__dirname, 'Dockerfile');

// Probe: replace the real `exec node …server.js` with a node one-liner that
// prints whether NODE_COMPILE_CACHE crossed the shell→process boundary.
const PROBE = `exec node -e "process.stdout.write(process.env.NODE_COMPILE_CACHE || '__UNSET__')"`;

/** Extract the runtime `CMD ["sh","-c","…"]` shell string from the Dockerfile. */
function dockerfileRuntimeCmd(): string {
  const df = readFileSync(DOCKERFILE, 'utf8');
  // Match CMD ["sh", "-c", "<escaped string>"] — the JSON-array exec form.
  const m = df.match(/CMD\s*\[\s*"sh"\s*,\s*"-c"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]/);
  if (!m) {
    throw new Error('Could not find a CMD ["sh","-c", …] runtime command in the Dockerfile');
  }
  // Unescape the JSON-string escapes (\" and \\).
  return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/** Run a shell command with NODE_COMPILE_CACHE removed from the environment. */
function runWithoutPresetCache(shellCmd: string): string {
  const env = { ...process.env };
  delete env.NODE_COMPILE_CACHE;
  // Strip the broken cmux NODE_OPTIONS preload if present (harness artifact),
  // so the child `node -e` starts cleanly in any environment.
  delete env.NODE_OPTIONS;
  return execFileSync('sh', ['-c', shellCmd], { encoding: 'utf8', env }).trim();
}

describe('Dockerfile CMD exports NODE_COMPILE_CACHE to the node process (regression: f100deb)', () => {
  it("the container CMD's node process actually receives NODE_COMPILE_CACHE", () => {
    const cmd = dockerfileRuntimeCmd().replace(/exec node \S*server\.js/, PROBE);
    // Guard: the substitution must have happened, else the test could pass
    // vacuously if the CMD format ever changes.
    expect(cmd).toContain(PROBE);
    const seen = runWithoutPresetCache(cmd);

    expect(seen).not.toBe('__UNSET__');
    expect(seen.length).toBeGreaterThan(0);
  });

  it('proves the guard works: an un-exported shell assignment leaves the node process UNSET', () => {
    // The pre-f100deb pattern — sets a shell var but never exports it.
    const buggy = `: \${NODE_COMPILE_CACHE:=apps/file-manager/.next/compile-cache}; ${PROBE}`;
    const seen = runWithoutPresetCache(buggy);

    // The child node never inherits the un-exported var — this is the bug
    // the first test catches against the real Dockerfile.
    expect(seen).toBe('__UNSET__');
  });
});
