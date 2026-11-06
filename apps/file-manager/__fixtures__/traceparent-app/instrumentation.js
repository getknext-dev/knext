// Mirrors how apps/file-manager/src/instrumentation-node.ts wires OTel
// (ADR-0027): span processors are passed DIRECTLY into `registerOTel` next to
// 'auto' — never through a module-state setter seam. 'auto' is what installs
// the OTLP exporter from OTEL_EXPORTER_OTLP_* env, so the test can point a real
// export at a loopback receiver.
//
// The inline processor stands in for the app's CorrelationSpanProcessor /
// GoldenSignalMetricsProcessor: it stamps a marker on every span at start, so the
// test can prove a direct-passed processor actually ran and its attribute reached
// the export. (The app's own processors are not imported: this fixture is built
// hermetically, without the @getknext/core workspace closure.)
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerOTel } = await import('@vercel/otel');
    registerOTel({
      serviceName: 'traceparent-fixture',
      spanProcessors: [
        'auto',
        {
          onStart(span) {
            span.setAttribute('knext.fixture.processor', 'ran');
          },
          onEnd() {},
          forceFlush: () => Promise.resolve(),
          shutdown: () => Promise.resolve(),
        },
      ],
    });
  }
}
