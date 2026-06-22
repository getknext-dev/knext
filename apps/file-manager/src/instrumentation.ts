import { resolveOtelOptions } from '@knext/core/adapters/otel-config';
import { registerOTel } from '@vercel/otel';

// NOTE: setCacheHandler is not exported from next/cache in Next.js 16.0.3.
// The Redis CacheHandler is registered via the `cacheHandler` field in
// next.config.ts (the correct mechanism for ISR caching).
// If Next.js adds a runtime setCacheHandler API in future versions, wire it here.

export function register() {
  // OTel tracing is DEFAULT-OFF (#30, ADR-0012). `resolveOtelOptions` returns
  // null unless the operator set OTEL_TRACING_ENABLED=true (from
  // spec.observability.tracing.enabled on the NextApp CR). When null we return
  // WITHOUT initializing OTel — zero overhead, no exporter, no span processors.
  const otel = resolveOtelOptions(process.env);
  if (!otel) {
    return;
  }

  // @vercel/otel reads the OTLP endpoint from OTEL_EXPORTER_OTLP_ENDPOINT and
  // the sampler arg from OTEL_TRACES_SAMPLER_ARG (both set by the operator).
  // We pass the resolved service name + Knative resource attributes explicitly,
  // and use ratio-based head sampling. The exporter target is a self-hostable
  // OTLP collector — never a SaaS default (CLAUDE.md §8: no lock-in).
  registerOTel({
    serviceName: otel.serviceName,
    attributes: otel.resourceAttributes,
    traceSampler: otel.sampleRate >= 1 ? 'always_on' : 'parentbased_traceidratio',
  });
}
