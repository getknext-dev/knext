export function normalizeResponse<T>(request: unknown, response: T): T;
export function applyVinextDeployDefault(env: Record<string, string | undefined> | undefined): void;
export function cacheControlMiddleware(
    env: Record<string, string | undefined> | undefined,
): <T>(request: Request, next: () => T | Promise<T>) => Promise<T>;
