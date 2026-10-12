import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NODE_BIN } from './helpers/runtime-binaries';

/**
 * GUARD: the docker e2e assertions that prove the baked V8 compile cache for the
 * standalone entry is USED match the log line the running Node actually prints.
 *
 * Node 24 changed the `NODE_DEBUG_NATIVE=COMPILE_CACHE` form from
 * `cache for <path> was accepted` to
 * `V8 code cache for CommonJS <path> was accepted, keeping the in-memory entry`.
 * The two docker e2e files (which need a Docker build and run in CI only) kept the
 * old form and went red on the Node 24 images while chunk caches were being
 * accepted. This runs in the ordinary suite: it asks the real Node for the line,
 * relocates it under /app/.next/standalone, and requires the regexes literally
 * written in those e2e files to match it. A regex that no longer matches reality
 * fails here, not only after a Docker image build.
 */

const ROOT = resolve(import.meta.dir, '..');
const E2E_FILES = [
  'packages/kn-next/src/__tests__/standalone-drain.docker-e2e.test.ts',
  'packages/kn-next/src/__tests__/standalone-webpack-build.docker-e2e.test.ts',
];

/** Run a cached CJS entry twice (bake, then hit) and return the second run's cache log. */
function realNodeAcceptedLines(): string[] {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'knext-cc-form-')));
  try {
    writeFileSync(join(dir, 'server.js'), 'require("./dep");\n');
    writeFileSync(join(dir, 'dep.js'), 'module.exports = 1;\n');
    const env = {
      ...process.env,
      NODE_OPTIONS: '',
      NODE_COMPILE_CACHE: join(dir, 'cache'),
      NODE_DEBUG_NATIVE: 'COMPILE_CACHE',
    };
    spawnSync(NODE_BIN, [join(dir, 'server.js')], { env, encoding: 'utf8' });
    const hit = spawnSync(NODE_BIN, [join(dir, 'server.js')], { env, encoding: 'utf8' });
    return `${hit.stdout}\n${hit.stderr}`
      .split('\n')
      .filter((l) => / was accepted/.test(l))
      .map((l) => l.split(dir).join('/app/.next/standalone'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The regex literals in a file that assert on a compile-cache `was accepted` line. */
function acceptedRegexes(file: string): RegExp[] {
  const text = readFileSync(resolve(ROOT, file), 'utf8');
  const out: RegExp[] = [];
  for (const m of text.matchAll(/^\s*\/(.+ was accepted.*)\/,?\s*$/gm)) {
    out.push(new RegExp(m[1]));
  }
  return out;
}

describe('docker e2e compile-cache assertions match the running Node log form', () => {
  const lines = realNodeAcceptedLines();

  it('the running Node reports accepted entries for the entry file', () => {
    expect(
      lines.some((l) => l.endsWith('/server.js was accepted, keeping the in-memory entry')),
    ).toBe(true);
  });

  for (const file of E2E_FILES) {
    const regexes = acceptedRegexes(file);
    it(`${file}: finds its entry-file accepted-line regex`, () => {
      expect(regexes.some((r) => r.source.includes('server'))).toBe(true);
    });
    it(`${file}: every entry-file regex matches the real log line`, () => {
      const entryRegexes = regexes.filter((r) => r.source.includes('server'));
      expect(entryRegexes.length).toBeGreaterThan(0);
      for (const r of entryRegexes) {
        expect(
          lines.some((l) => r.test(l)),
          `${r} matches no line of: ${lines.join(' | ')}`,
        ).toBe(true);
      }
    });
  }
});
