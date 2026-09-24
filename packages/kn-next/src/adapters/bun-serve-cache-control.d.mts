export function shouldInstall(
    env: Record<string, string | undefined> | undefined,
    bun: { serve?: unknown } | undefined,
): boolean;
export function normalizeResponse<T>(request: unknown, response: T): T;
/** The wrapper receives the request first (Bun.serve's fetch signature) and forwards all args. */
export function wrapFetch(
    fetchHandler: (...args: unknown[]) => unknown,
): (request: unknown, ...rest: unknown[]) => unknown;
export function wrapServeOptions<T>(options: T): T;
export function install(
    bun: { serve?: (...args: never[]) => unknown } | undefined,
    env: Record<string, string | undefined> | undefined,
): boolean;
