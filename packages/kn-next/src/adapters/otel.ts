/**
 * Opinionated OpenTelemetry setup for Next.js on Knative.
 *
 * Provides automatic instrumentation of:
 * - HTTP server requests (incoming)
 * - HTTP client requests (outgoing fetch/http)
 * - DNS resolution
 * - Net connections (for Redis, PostgreSQL drivers)
 *
 * Exports telemetry to:
 * - OTLP/gRPC endpoint (OTel Collector) for traces and metrics
 * - Prometheus /metrics endpoint for backward compatibility
 *
 * Cloud-agnostic: works on any Kubernetes cluster.
 * The OTel Collector handles vendor-specific export (if needed).
 *
 * Resource attributes follow OpenTelemetry semantic conventions:
 * - service.name, service.version
 * - k8s.pod.name, k8s.namespace.name
 * - knative.revision (from Knative labels)
 */

import { getRequestId } from "./request-context.ts";

const APP_NAME =
	process.env.OTEL_SERVICE_NAME ||
	process.env.KN_APP_NAME ||
	process.env.npm_package_name ||
	"unknown";

const COLLECTOR_ENDPOINT =
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector.monitoring:4317";

const SAMPLING_RATE = Number.parseFloat(
	process.env.OTEL_TRACES_SAMPLER_ARG ||
	(process.env.NODE_ENV === "production" ? "0.1" : "1.0"),
);

/**
 * Initialize OpenTelemetry SDK with opinionated defaults for Next.js.
 *
 * Must be called BEFORE any other imports to ensure instrumentation
 * patches are applied to http, net, dns modules.
 *
 * Uses dynamic imports to keep OTel as an optional dependency —
 * if packages are missing, falls back gracefully to prom-client only.
 */
export async function initOtel(): Promise<boolean> {
	try {
		const [
			{ NodeSDK },
			{ OTLPTraceExporter },
			{ OTLPMetricExporter },
			{ PeriodicExportingMetricReader },
			{ Resource },
			{ ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
			otelApi,
			{ getNodeAutoInstrumentations },
			{ TraceIdRatioBasedSampler },
		] = await Promise.all([
			import("@opentelemetry/sdk-node"),
			import("@opentelemetry/exporter-trace-otlp-grpc"),
			import("@opentelemetry/exporter-metrics-otlp-grpc"),
			import("@opentelemetry/sdk-metrics"),
			import("@opentelemetry/resources"),
			import("@opentelemetry/semantic-conventions"),
			import("@opentelemetry/api"),
			import("@opentelemetry/auto-instrumentations-node"),
			import("@opentelemetry/sdk-trace-base"),
		]);

		// Store API reference for logger trace context extraction
		// biome-ignore lint/suspicious/noExplicitAny: global OTel API store
		(globalThis as any).__kn_otel_api = otelApi;

		const resource = new Resource({
			[ATTR_SERVICE_NAME]: APP_NAME,
			[ATTR_SERVICE_VERSION]: process.env.BUILD_ID || "dev",
			// Kubernetes resource attributes (populated by Kubernetes downward API)
			"k8s.pod.name": process.env.HOSTNAME || "unknown",
			"k8s.namespace.name": process.env.K8S_NAMESPACE || "default",
			// Knative-specific
			"knative.revision": process.env.K_REVISION || "unknown",
			"knative.service": process.env.K_SERVICE || APP_NAME,
			"knative.configuration": process.env.K_CONFIGURATION || "unknown",
		});

		const traceExporter = new OTLPTraceExporter({
			url: COLLECTOR_ENDPOINT,
		});

		const metricExporter = new OTLPMetricExporter({
			url: COLLECTOR_ENDPOINT,
		});

		const metricReader = new PeriodicExportingMetricReader({
			exporter: metricExporter,
			exportIntervalMillis: 15000,
		});

		const sdk = new NodeSDK({
			resource,
			traceExporter,
			metricReader,
			sampler: new TraceIdRatioBasedSampler(SAMPLING_RATE),
			instrumentations: [
				getNodeAutoInstrumentations({
					// HTTP instrumentation: add request ID to spans
					"@opentelemetry/instrumentation-http": {
						requestHook: (span) => {
							const requestId = getRequestId();
							if (requestId !== "no-request-context") {
								span.setAttribute("http.request_id", requestId);
							}
						},
					},
					// DNS: useful for debugging service mesh routing
					"@opentelemetry/instrumentation-dns": {
						enabled: true,
					},
					// Net: captures Redis/PostgreSQL driver connections
					"@opentelemetry/instrumentation-net": {
						enabled: true,
					},
					// Disable FS instrumentation (too noisy for serverless)
					"@opentelemetry/instrumentation-fs": {
						enabled: false,
					},
				}),
			],
		});

		sdk.start();

		// Graceful shutdown
		const shutdown = async () => {
			await sdk.shutdown();
		};
		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);

		console.info(
			`[kn-next] OpenTelemetry initialized (service=${APP_NAME}, ` +
			`collector=${COLLECTOR_ENDPOINT}, sampling=${SAMPLING_RATE})`,
		);

		return true;
	} catch (err) {
		console.warn(
			"[kn-next] OpenTelemetry SDK not available, falling back to prom-client only. " +
			`Install @opentelemetry/sdk-node for full observability. Error: ${err}`,
		);
		return false;
	}
}
