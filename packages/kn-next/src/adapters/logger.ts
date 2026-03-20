import { getRequestContext } from "./request-context.ts";

/**
 * Structured JSON logger for kn-next applications.
 *
 * Automatically enriches every log line with:
 * - requestId (from AsyncLocalStorage)
 * - traceId / spanId (from OpenTelemetry active span)
 * - timestamp (ISO 8601)
 * - severity level
 * - service name and version
 *
 * Output format: Standard JSON — compatible with any log aggregator
 * (ELK, Loki, CloudWatch, Stackdriver, Datadog, etc.)
 *
 * Cloud-agnostic: no vendor-specific fields or formats.
 */

interface LogEntry {
	timestamp: string;
	severity: string;
	message: string;
	requestId?: string;
	traceId?: string;
	spanId?: string;
	service?: string;
	durationMs?: number;
	[key: string]: unknown;
}

const SERVICE_NAME =
	process.env.OTEL_SERVICE_NAME ||
	process.env.KN_APP_NAME ||
	process.env.npm_package_name ||
	"unknown";

/** Original console methods (saved before override) */
const originalConsole = {
	log: console.log.bind(console),
	info: console.info.bind(console),
	warn: console.warn.bind(console),
	error: console.error.bind(console),
	debug: console.debug.bind(console),
};

/**
 * Extract trace context from the active OpenTelemetry span (if available).
 * Uses dynamic import to avoid hard dependency on @opentelemetry/api.
 */
function getTraceContext(): { traceId?: string; spanId?: string } {
	try {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic OTel API access
		const api = (globalThis as any).__kn_otel_api;
		if (!api) return {};

		const span = api.trace.getActiveSpan?.();
		if (!span) return {};

		const ctx = span.spanContext?.();
		if (!ctx) return {};

		return {
			traceId: ctx.traceId,
			spanId: ctx.spanId,
		};
	} catch {
		return {};
	}
}

/**
 * Build a structured log entry with request context and trace correlation.
 */
function buildLogEntry(
	severity: string,
	args: unknown[],
): LogEntry {
	const reqCtx = getRequestContext();
	const traceCtx = getTraceContext();

	const message = args
		.map((arg) =>
			typeof arg === "object" ? JSON.stringify(arg) : String(arg),
		)
		.join(" ");

	const entry: LogEntry = {
		timestamp: new Date().toISOString(),
		severity,
		message,
		service: SERVICE_NAME,
	};

	// Add request context if available
	if (reqCtx) {
		entry.requestId = reqCtx.requestId;
		if (reqCtx.startTime) {
			entry.durationMs = Date.now() - reqCtx.startTime;
		}
	}

	// Add trace context if available
	if (traceCtx.traceId) {
		entry.traceId = traceCtx.traceId;
		entry.spanId = traceCtx.spanId;
	}

	return entry;
}

/**
 * Install structured logging by overriding console methods.
 * Call once at server startup when observability is enabled.
 *
 * All console.log/info/warn/error calls will output structured JSON
 * with automatic request ID and trace correlation.
 */
export function installStructuredLogging(): void {
	console.log = (...args: unknown[]) => {
		originalConsole.log(JSON.stringify(buildLogEntry("INFO", args)));
	};

	console.info = (...args: unknown[]) => {
		originalConsole.info(JSON.stringify(buildLogEntry("INFO", args)));
	};

	console.warn = (...args: unknown[]) => {
		originalConsole.warn(JSON.stringify(buildLogEntry("WARNING", args)));
	};

	console.error = (...args: unknown[]) => {
		originalConsole.error(JSON.stringify(buildLogEntry("ERROR", args)));
	};

	console.debug = (...args: unknown[]) => {
		originalConsole.debug(JSON.stringify(buildLogEntry("DEBUG", args)));
	};

	originalConsole.info(
		JSON.stringify(
			buildLogEntry("INFO", [
				"[kn-next] Structured JSON logging enabled",
			]),
		),
	);
}

/**
 * Restore original console methods.
 * Useful for testing or disabling structured logging.
 */
export function restoreConsole(): void {
	console.log = originalConsole.log;
	console.info = originalConsole.info;
	console.warn = originalConsole.warn;
	console.error = originalConsole.error;
	console.debug = originalConsole.debug;
}

/** Export originals for internal framework use */
export { originalConsole };
