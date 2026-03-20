import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request context propagation via AsyncLocalStorage.
 *
 * Provides request-scoped context (request ID, trace ID) that flows through
 * the entire call chain without explicit parameter passing.
 *
 * Cloud-agnostic: works on any Kubernetes cluster (EKS, AKS, GKE, bare-metal).
 */

export interface RequestContext {
	/** Unique request identifier (UUID v4) */
	requestId: string;
	/** Start time for duration tracking */
	startTime: number;
	/** HTTP method */
	method?: string;
	/** Request path */
	path?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current request context, or undefined if not in a request scope.
 */
export function getRequestContext(): RequestContext | undefined {
	return storage.getStore();
}

/**
 * Get the current request ID, or "no-request-context" if outside a request scope.
 */
export function getRequestId(): string {
	return storage.getStore()?.requestId ?? "no-request-context";
}

/**
 * Run a function within a request context.
 * Extracts or generates a request ID from the `x-request-id` header.
 *
 * Standard header priority:
 * 1. `x-request-id` (most common across cloud providers)
 * 2. `x-trace-id` (alternative)
 * 3. Generate a new UUID v4
 */
export function withRequestContext<T>(
	req: { headers: Record<string, string | string[] | undefined> },
	fn: () => T,
): T {
	const incomingId =
		getHeader(req.headers, "x-request-id") ??
		getHeader(req.headers, "x-trace-id");

	const ctx: RequestContext = {
		requestId: incomingId || randomUUID(),
		startTime: Date.now(),
		method: undefined,
		path: undefined,
	};

	return storage.run(ctx, fn);
}

function getHeader(
	headers: Record<string, string | string[] | undefined>,
	name: string,
): string | undefined {
	const val = headers[name];
	return Array.isArray(val) ? val[0] : val;
}
