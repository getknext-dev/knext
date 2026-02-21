import { createServer } from 'node:http';
import type { InternalEvent, InternalResult } from '@opennextjs/aws/types/open-next';
import type { Converter, OpenNextHandler, Wrapper } from '@opennextjs/aws/types/overrides';
import {
  initBytecodeCacheMetrics,
  metricsRegistry,
  recordServerReady,
} from './bytecode-metrics.js';

const PORT = Number.parseInt(process.env.PORT || '8080', 10);

/**
 * Node.js HTTP server wrapper handler for Knative.
 * Runs the OpenNext handler as a standalone HTTP server instead of Lambda.
 * Includes Prometheus metrics endpoint at /metrics.
 */
const wrapperHandler = async (
  handler: OpenNextHandler<InternalEvent, InternalResult>,
  converter: Converter<InternalEvent, InternalResult>,
) => {
  // Initialize bytecode cache metrics before the server starts
  initBytecodeCacheMetrics();

  const server = createServer(async (req, res) => {
    try {
      // Prometheus metrics endpoint
      if (req.url === '/metrics' && req.method === 'GET') {
        res.setHeader('Content-Type', metricsRegistry.contentType);
        const metrics = await metricsRegistry.metrics();
        res.end(metrics);
        return;
      }

      // Convert Node.js request to internal event format
      const internalEvent = await converter.convertFrom(req);

      // Run the handler
      const result = await handler(internalEvent);

      // Convert result back to Node.js response
      const response = await converter.convertTo(result);

      // Set status code
      res.statusCode = response.statusCode || 200;

      // Set headers
      if (response.headers) {
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined) {
            res.setHeader(key, value as string | number | readonly string[]);
          }
        }
      }

      // Handle different body types
      const body = response.body;

      if (body === null || body === undefined) {
        res.end();
      } else if (typeof body === 'string' || Buffer.isBuffer(body)) {
        res.end(body);
      } else if (body instanceof ReadableStream) {
        // Web ReadableStream - use web streams API to pipe
        const reader = body.getReader();
        const pump = async (): Promise<void> => {
          const { done, value } = await reader.read();
          if (done) {
            res.end();
            return;
          }
          const ok = res.write(value);
          if (ok) {
            return pump();
          }
          // Handle backpressure
          return new Promise<void>((resolve) => {
            res.once('drain', () => pump().then(resolve));
          });
        };
        await pump();
      } else if (typeof (body as NodeJS.ReadableStream).pipe === 'function') {
        // Node.js Readable stream
        (body as NodeJS.ReadableStream).pipe(res);
      } else if (body instanceof Uint8Array) {
        res.end(Buffer.from(body));
      } else {
        // Unknown type, try to stringify
        res.end(String(body));
      }
    } catch (error) {
      console.error('[node-server] Request error:', error);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });

  server.listen(PORT, () => {
    // Record startup duration metric
    recordServerReady();
    console.info(`[kn-next] Server listening on port ${PORT}`);
    console.info(`[kn-next] Prometheus metrics at http://localhost:${PORT}/metrics`);
  });

  // Handle graceful shutdown
  const shutdown = () => {
    console.info('[kn-next] Shutting down gracefully...');
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Return HTTP handler for potential programmatic use
  return () => server;
};

/**
 * Wrapper export matching OpenNext's expected interface.
 */
const wrapper: Wrapper<InternalEvent, InternalResult> = {
  name: 'node-server',
  wrapper: wrapperHandler,
  supportStreaming: false,
};

export default wrapper;
