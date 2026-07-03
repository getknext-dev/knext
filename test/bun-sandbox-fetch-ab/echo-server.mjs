#!/usr/bin/env node
/**
 * Controlled LOCAL HTTPS echo endpoint for the bun-sandbox-fetch A/B
 * (docs/compat/upstream-bun-sandbox-fetch-bug.md). Mirrors the shape of the
 * public `next-data-api-endpoint.vercel.app/api/echo-headers` endpoint the
 * upstream fixture uses, but runs on 127.0.0.1 so the WAN — proven a confound
 * by the 2026-07-03 local campaign — is out of the picture. TLS (self-signed)
 * stays in the path because the CI signature involves HTTPS.
 *
 * Always run under NODE (the runtime under test is only the standalone Next
 * server); the echo server must be a constant across both lanes.
 *
 * Usage: node echo-server.mjs --port 8743 --cert cert.pem --key key.pem
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg('port', '8743'));
const cert = readFileSync(arg('cert'));
const key = readFileSync(arg('key'));

const server = createServer({ cert, key }, (req, res) => {
  // Drain the request body fully (POST etc.), then echo — like the public
  // endpoint, respond to every method so "resolved" vs "hung" is the only axis.
  req.resume();
  req.on('end', () => {
    const body = JSON.stringify({ url: req.url, method: req.method, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
});

server.listen(port, '127.0.0.1', () => {
  // Readiness marker consumed by run-trials.mjs.
  console.log(`echo-server listening on https://127.0.0.1:${port}`);
});
