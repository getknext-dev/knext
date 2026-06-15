/**
 * Builds the environment object for the spawned Next.js standalone server.
 *
 * All process.env vars (including NODE_COMPILE_CACHE) are inherited via spread.
 * The operator may inject NODE_COMPILE_CACHE pointing at a shared PVC for
 * cross-cold-start bytecode caching — we MUST NOT hardcode or override it here.
 * The Dockerfile CMD supplies a fallback when the env var is unset at runtime.
 *
 * Exported separately so tests can assert forwarding without starting the server
 * or spawning a real child process.
 */
export function buildChildEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PORT: process.env.PORT ?? '3000',
    ...overrides,
  };
}
