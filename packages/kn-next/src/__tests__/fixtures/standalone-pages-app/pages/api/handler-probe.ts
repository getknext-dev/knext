// Reports what the custom cacheHandler (../../cache-handler.js) recorded.
export default function handler(
    _req: unknown,
    res: { status(code: number): { json(body: unknown): void } },
) {
    res.status(200).json(
        (globalThis as { __knextCacheHandlerProbe?: unknown })
            .__knextCacheHandlerProbe ?? null,
    );
}
