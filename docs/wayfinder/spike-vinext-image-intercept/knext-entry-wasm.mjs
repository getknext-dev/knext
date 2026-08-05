// SPIKE ONLY — knext-owned entry that intercepts /_next/image in-process using a
// pure-WASM codec stack (@jsquash), so it survives `bun build --compile --bytecode`.
//
// Mechanism (identical to the sharp variant): startProdServer() returns { server };
// take its single 'request' listener, remove it, install ours, delegate the rest.

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import encodeAvif, { init as initAvif } from '@jsquash/avif/encode.js';
import avifWasmPath from '@jsquash/avif/codec/enc/avif_enc.wasm';
import decodeJpeg, { init as initJpegDec } from '@jsquash/jpeg/decode.js';
import jpegDecWasmPath from '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm';
import encodeJpeg, { init as initJpegEnc } from '@jsquash/jpeg/encode.js';
import jpegEncWasmPath from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm';
import decodePng, { init as initPngDec } from '@jsquash/png/decode.js';
import pngWasmPath from '@jsquash/png/codec/pkg/squoosh_png_bg.wasm';
import encodePng from '@jsquash/png/encode.js';
import resize, { initResize } from '@jsquash/resize';
import resizeWasmPath from '@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm';
import encodeWebp, { init as initWebp } from '@jsquash/webp/encode.js';
import webpWasmPath from '@jsquash/webp/codec/enc/webp_enc.wasm';
import {
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  handleImageOptimization,
  isImageOptimizationPath,
} from 'vinext/server/image-optimization';
import { sendWebResponse, startProdServer } from 'vinext/server/prod-server';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';
// In a --compile binary import.meta.dirname points inside the embedded FS, so the
// asset root has to come from outside. knext would set this in the image.
const outDir = process.env.KNEXT_OUT_DIR
  ? path.resolve(process.env.KNEXT_OUT_DIR)
  : path.join(import.meta.dirname, 'dist');
const clientDir = path.join(outDir, 'client');

// --- config knext would emit at build time from next.config -----------------
const ALLOWED_WIDTHS = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
const IMAGE_CONFIG = { qualities: [20, 75] };

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// --- resource bounds (Q4) ---------------------------------------------------
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 40_000_000;
const MAX_CONCURRENT_TRANSFORMS = Number.parseInt(process.env.KNEXT_IMAGE_CONCURRENCY ?? '4', 10);
let inFlight = 0;
const waiters = [];
async function acquire() {
  if (inFlight < MAX_CONCURRENT_TRANSFORMS) {
    inFlight++;
    return;
  }
  await new Promise((r) => waiters.push(r));
  inFlight++;
}
function release() {
  inFlight--;
  const next = waiters.shift();
  if (next) next();
}

async function wasmModule(p) {
  return WebAssembly.compile(await readFile(p));
}

async function initCodecs() {
  await Promise.all([
    initPngDec(await wasmModule(pngWasmPath)),
    initJpegDec(await wasmModule(jpegDecWasmPath)),
    initJpegEnc(await wasmModule(jpegEncWasmPath)),
    initResize(await wasmModule(resizeWasmPath)),
    initWebp(await wasmModule(webpWasmPath)),
    initAvif(await wasmModule(avifWasmPath)),
  ]);
}

/** Read a local asset out of the built client dir. Path traversal is refused. */
async function fetchAsset(assetPath) {
  const decoded = decodeURIComponent(assetPath.split('?')[0]);
  const resolved = path.resolve(clientDir, `.${decoded}`);
  if (resolved !== clientDir && !resolved.startsWith(clientDir + path.sep)) {
    return new Response('Not found', { status: 404 });
  }
  let st;
  try {
    st = await stat(resolved);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  if (!st.isFile()) return new Response('Not found', { status: 404 });
  if (st.size > MAX_SOURCE_BYTES) return new Response('Image too large', { status: 400 });
  const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
  return new Response(Readable.toWeb(createReadStream(resolved)), {
    status: 200,
    headers: { 'Content-Type': type, 'Content-Length': String(st.size) },
  });
}

function sniff(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  return null;
}

/** WASM-backed transform. `format` is the IANA type vinext negotiated. */
async function transformImage(body, { width, format, quality }) {
  await acquire();
  try {
    const src = new Uint8Array(await new Response(body).arrayBuffer());
    const kind = sniff(src);
    if (!kind) throw new Error(`unsupported source encoding`);
    const ab = src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength);
    const image = kind === 'png' ? await decodePng(ab) : await decodeJpeg(ab);
    if (image.width * image.height > MAX_SOURCE_PIXELS) throw new Error('source too many pixels');

    // Match Next: never enlarge.
    const target = Math.min(width, image.width);
    const out =
      target === image.width
        ? image
        : await resize(image, {
            width: target,
            height: Math.max(1, Math.round((target * image.height) / image.width)),
          });

    switch (format) {
      case 'image/avif':
        // NB: the option is `quality` (0..100). Passing `cqLevel` is silently
        // ignored and every request lands on the default quality 50 — measured.
        return new Response(await encodeAvif(out, { quality }), {
          status: 200,
          headers: { 'Content-Type': 'image/avif' },
        });
      case 'image/webp':
        return new Response(await encodeWebp(out, { quality }), {
          status: 200,
          headers: { 'Content-Type': 'image/webp' },
        });
      case 'image/png':
        return new Response(await encodePng(out), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      default:
        return new Response(await encodeJpeg(out, { quality }), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        });
    }
  } finally {
    release();
  }
}

async function main() {
  await initCodecs();
  const { server } = await startProdServer({ port, host, outDir });

  const originalListeners = server.listeners('request');
  if (originalListeners.length !== 1) {
    throw new Error(
      `[knext] expected exactly 1 'request' listener from startProdServer, got ${originalListeners.length}`,
    );
  }
  const delegate = originalListeners[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return delegate(req, res);
    }
    if (!isImageOptimizationPath(pathname)) return delegate(req, res);

    const request = new Request(new URL(req.url ?? '/', 'http://localhost'), {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) =>
        Array.isArray(v) ? v.map((x) => [k, x]) : v === undefined ? [] : [[k, v]],
      ),
    });
    handleImageOptimization(request, { fetchAsset, transformImage }, ALLOWED_WIDTHS, IMAGE_CONFIG)
      .then((response) => sendWebResponse(response, req, res, false))
      .catch((error) => {
        console.error('[knext] image optimization failed', error);
        if (!res.headersSent) res.writeHead(500);
        res.end('Internal Server Error');
      });
  });

  console.log(`[knext] wasm image interception active on ${host}:${port}`);
}

main().catch((error) => {
  console.error('[knext] failed to start', error);
  process.exit(1);
});
