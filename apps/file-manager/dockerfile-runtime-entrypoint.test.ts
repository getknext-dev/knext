import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression test: the REFERENCE container must boot the knext runtime entry,
 * not bare `node server.js`.
 *
 * The bug: the runtime image CMD was `exec node apps/file-manager/server.js`,
 * which starts the Next.js standalone server DIRECTLY. That bypasses
 * @getknext/core's node-server runtime entry — the only place that:
 *   - installs the SIGTERM handler that FORWARDS the signal so Next drains
 *     in-flight requests + runs `after()` callbacks (security.md graceful
 *     shutdown), and
 *   - serves the Prometheus metrics sidecar on :9091.
 *
 * So in the shipped container, graceful shutdown + metrics were NOT in the
 * entrypoint path — they were only unit-tested in the library. A real knext
 * deploy must run the runtime entry. This test asserts the Dockerfile CMD
 * invokes the @getknext/core node-server runtime (via its published package
 * entry) and points it at the standalone server.js through
 * STANDALONE_SERVER_PATH, rather than exec'ing server.js itself.
 *
 * Written RED-first: it fails against the old bare `node server.js` CMD.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = resolve(__dirname, 'Dockerfile');

/** Extract the runtime `CMD ["sh","-c","…"]` shell string from the Dockerfile. */
function dockerfileRuntimeCmd(): string {
  const df = readFileSync(DOCKERFILE, 'utf8');
  const m = df.match(/CMD\s*\[\s*"sh"\s*,\s*"-c"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]/);
  if (!m) {
    throw new Error('Could not find a CMD ["sh","-c", …] runtime command in the Dockerfile');
  }
  return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

describe('Dockerfile runtime entrypoint runs the knext runtime (SIGTERM-drain + metrics live)', () => {
  it('does NOT bare-exec the Next standalone server.js (which skips the drain handler)', () => {
    const cmd = dockerfileRuntimeCmd();
    // The old, buggy form. server.js must be launched BY the runtime entry, not
    // directly as the container process.
    expect(cmd).not.toMatch(/exec\s+node\s+\S*apps\/file-manager\/server\.js/);
  });

  it('invokes the @getknext/core node-server runtime entry as the container process', () => {
    const cmd = dockerfileRuntimeCmd();
    // The runtime entry is published at @getknext/core/internal/node-server and
    // traced into the standalone node_modules. The CMD must exec it.
    expect(cmd).toMatch(/@getknext\/core\/internal\/node-server/);
    expect(cmd).toMatch(/exec\s+node/);
  });

  it('points the runtime entry at the standalone server.js via STANDALONE_SERVER_PATH', () => {
    const cmd = dockerfileRuntimeCmd();
    // node-server defaults STANDALONE_SERVER_PATH to ".next/standalone/server.js";
    // the container layout puts it at apps/file-manager/server.js, so the CMD
    // must override it.
    expect(cmd).toMatch(/STANDALONE_SERVER_PATH=[^;]*apps\/file-manager\/server\.js/);
  });

  it('still exports NODE_COMPILE_CACHE so the bytecode cache fills (regression: f100deb)', () => {
    const cmd = dockerfileRuntimeCmd();
    expect(cmd).toMatch(/export NODE_COMPILE_CACHE=/);
  });
});
