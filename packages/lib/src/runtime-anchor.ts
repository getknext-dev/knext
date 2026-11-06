/**
 * Where this code is running FROM, as a `createRequire` anchor - without
 * `import.meta.url`.
 *
 * ## Why not `createRequire(import.meta.url)`
 *
 * A webpack build (Next standalone) rewrites `import.meta.url` to a string
 * literal, `file:///<build machine path>/packages/lib/dist/chunk-*.js`, and
 * ships it in the server chunk. That leaks the build machine's directory layout
 * and makes the output differ between two machines building the same commit.
 * It is also the WRONG base at runtime: that directory does not exist in the
 * deployed image, so the lookup only worked by walking a path that was never
 * there. `import.meta.dirname` and `const m = import.meta` are rewritten the
 * same way, so there is no spelling of `import.meta` that stays out of it.
 *
 * ## What it does instead
 *
 * Asks the engine for this module's own file name at CALL time, from the stack
 * (V8's `CallSite.getFileName()`, which Bun implements too):
 *
 *   - unbundled (`node_modules/@getknext/lib/dist`): the real dist file, so
 *     resolution is relative to the lib exactly as `import.meta.url` gave -
 *     the lib's own dependencies stay visible under strict/isolated installs;
 *   - bundled (`.next/server/chunks/*.js`): the chunk's real, deployed path, so
 *     resolution walks up into the standalone `node_modules`.
 *
 * When the engine reports nothing usable (an empty stack or a virtual
 * `webpack-internal:` / Bun `$bunfs` name; a `stackTraceLimit` of 0 is not a
 * case, the helper raises it to 1 for the capture) it falls back to the working
 * directory, which for a standalone server is the standalone root.
 *
 * Known trade-off: under `next dev --webpack` server modules are evaluated with
 * `webpack-internal:` names, so resolution is from the app's working directory,
 * not the lib's folder. An app on a strict install must then depend on the
 * optional SDK (ioredis, pino-pretty, minio, cerbos) itself; knext scaffolds
 * already add ioredis.
 *
 * The result is a path or `file:` URL string, which is all `createRequire`
 * takes. Evaluated lazily and never at module scope, so it costs nothing until
 * a loader runs.
 */

/** The slice of V8's CallSite this needs. */
interface CallSiteLike {
  getFileName(): string | null | undefined;
}

/** A real location on disk: a `file:` URL, a POSIX absolute path or a Windows drive path. */
const REAL_LOCATION = /^(?:file:\/\/|\/(?!\$bunfs\/)|[A-Za-z]:[\\/])/;
/** Bun's virtual filesystem inside a `--compile` executable; nothing resolves from it. */
const BUN_VIRTUAL = /(?:\$bunfs|~BUN)/;

function ownFileName(): string | undefined {
  const previousPrepare = Error.prepareStackTrace;
  const previousLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 1;
    Error.prepareStackTrace = (_error, sites) => sites;
    const sites = new Error().stack as unknown as CallSiteLike[] | string | undefined;
    if (!Array.isArray(sites)) return undefined;
    return sites[0]?.getFileName() ?? undefined;
  } catch {
    return undefined;
  } finally {
    Error.prepareStackTrace = previousPrepare;
    Error.stackTraceLimit = previousLimit;
  }
}

export function runtimeAnchor(): string {
  const file = ownFileName();
  if (file !== undefined && REAL_LOCATION.test(file) && !BUN_VIRTUAL.test(file)) return file;
  return `${process.cwd()}/`;
}
