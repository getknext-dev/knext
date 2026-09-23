/**
 * platform-e2e-http.mjs — the one HTTP client the platform e2e uses (#1282).
 *
 * Every request goes to ONE base address (the Kourier port-forward on the CI
 * runner, or a fake server in the self-test) and carries an explicit `Host`
 * header: the ksvc's own host from `status.url`. That is how a request reaches
 * the app THROUGH the platform — Kourier routes on Host, then the activator or
 * queue-proxy, then the app. Talking to a pod IP would skip exactly the layers
 * this suite exists to cover.
 *
 * `node:http`, not `fetch`: undici treats `Host` as a forbidden header, and
 * the streaming check needs per-chunk ARRIVAL times, which only a raw
 * `data` listener gives.
 *
 * Nothing here decides pass or fail. It returns what came back and throws
 * only on a transport error, which the caller reports as a failure.
 */

import http from 'node:http';

/**
 * @typedef {{
 *   status: number,
 *   headers: import('node:http').IncomingHttpHeaders,
 *   body: Buffer,
 *   text: string,
 *   chunks: { at: number, text: string }[],
 * }} HttpResult
 */

/**
 * Build a client bound to `baseUrl` that sends `host` as the Host header.
 *
 * @param {{ baseUrl: string, host: string, timeoutMs?: number }} opts
 */
export function createClient({ baseUrl, host, timeoutMs = 30000 }) {
  if (!baseUrl) throw new Error('createClient: baseUrl is required');
  if (!host) throw new Error('createClient: host is required (the ksvc host from status.url)');
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:') {
    throw new Error(`createClient: only http:// is supported, got ${base.protocol}`);
  }

  /**
   * @param {string} path
   * @param {{ method?: string, headers?: Record<string,string>, body?: Buffer|string }} [opts]
   * @returns {Promise<HttpResult>}
   */
  function request(path, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const finalHeaders = { host, ...headers };
      if (body !== undefined) finalHeaders['content-length'] = String(Buffer.byteLength(body));
      const req = http.request(
        {
          hostname: base.hostname,
          port: base.port || 80,
          path,
          method,
          headers: finalHeaders,
          // No connection reuse: every request is its own socket, so a reset on
          // one cannot be misattributed to the next (the bun keep-alive history).
          agent: false,
        },
        (res) => {
          /** @type {Buffer[]} */
          const bufs = [];
          /** @type {{ at: number, text: string }[]} */
          const chunks = [];
          res.on('data', (d) => {
            bufs.push(d);
            chunks.push({ at: Date.now() - t0, text: d.toString('utf8') });
          });
          res.on('end', () => {
            const buf = Buffer.concat(bufs);
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: buf,
              text: buf.toString('utf8'),
              chunks,
            });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.setTimeout(timeoutMs, () =>
        req.destroy(new Error(`request timeout after ${timeoutMs}ms: ${method} ${path}`)),
      );
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  return { request, host, baseUrl };
}

/**
 * Encode a `multipart/form-data` body. Values are strings or
 * `{ filename, contentType, data }` file parts.
 *
 * @param {Array<[string, string | { filename: string, contentType: string, data: Buffer }]>} fields
 * @returns {{ boundary: string, body: Buffer }}
 */
export function encodeMultipart(fields) {
  const boundary = `----knextplatforme2e${Math.random().toString(36).slice(2)}`;
  /** @type {Buffer[]} */
  const parts = [];
  for (const [name, value] of fields) {
    if (typeof value === 'string') {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      );
    } else {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.filename}"\r\n` +
            `Content-Type: ${value.contentType}\r\n\r\n`,
        ),
        value.data,
        Buffer.from('\r\n'),
      );
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}
