// SPIKE ONLY — knext-owned entry that intercepts /_next/image in-process using a
// pure-WASM codec stack (@jsquash), so it survives `bun build --compile --bytecode`.
//
// Mechanism (identical to the sharp variant): startProdServer() returns { server };
// take its single 'request' listener, remove it, install ours, delegate the rest.

import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import avifWasmPath from '@jsquash/avif/codec/enc/avif_enc.wasm';
import encodeAvif, { init as initAvif } from '@jsquash/avif/encode.js';
import jpegDecWasmPath from '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm';
import jpegEncWasmPath from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm';
import decodeJpeg, { init as initJpegDec } from '@jsquash/jpeg/decode.js';
import encodeJpeg, { init as initJpegEnc } from '@jsquash/jpeg/encode.js';
import pngWasmPath from '@jsquash/png/codec/pkg/squoosh_png_bg.wasm';
import decodePng, { init as initPngDec } from '@jsquash/png/decode.js';
import resize, { initResize } from '@jsquash/resize';
import resizeWasmPath from '@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm';
import webpWasmPath from '@jsquash/webp/codec/enc/webp_enc.wasm';
import encodeWebp, { init as initWebp } from '@jsquash/webp/encode.js';
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
//
// WHERE these are enforced is the whole point, and the first cut got it wrong.
// `handleImageOptimization` wraps the call to `transformImage` in
//   try { ... } catch (e) { console.error(...) }
// and then FALLS THROUGH to `createPassthroughImageResponse`
// (`image-optimization.js:213-233`). So a cap that throws from inside
// `transformImage` does not refuse anything: it returns HTTP 200 with the full
// unoptimised source and `Cache-Control: public, max-age=31536000, immutable`.
// Measured: a 10000x10000 PNG bomb (97,276 B on disk, 100 MP) came back 200 /
// image/png / 97,276 B / year-immutable, as did a text file named `.png`.
//
// Therefore every cap that must REFUSE is enforced in `fetchAsset`, which
// vinext calls OUTSIDE that try/catch — a non-ok Response there short-circuits
// to a 404 before any transform is attempted. The checks inside
// `transformImage` are kept only as defence in depth and are NOT refusals.
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 40_000_000;
// Header prefix read for dimension extraction. A JPEG whose SOF marker is not
// within this window is refused rather than admitted — fail closed.
const HEADER_PROBE_BYTES = 1024 * 1024;
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

function sniff(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  return null;
}

/**
 * Pixel dimensions from a HEADER PREFIX ONLY — no decode. This is the point:
 * the decode is the expensive step of a decompression bomb, so a pixel cap that
 * runs after `decodePng` bounds nothing it was meant to bound.
 *
 * Returns `null` when the dimensions cannot be established, and the caller
 * treats `null` as a refusal.
 */
function headerDimensions(kind, buf) {
  if (kind === 'png') {
    // 8-byte signature, then the IHDR chunk: length(4) + "IHDR"(4) + w(4) + h(4).
    if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: walk the marker segments to the first SOFn, which carries h then w.
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const segLength = buf.readUInt16BE(i + 2);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (segLength < 2) return null;
    i += 2 + segLength;
  }
  return null; // SOF not within HEADER_PROBE_BYTES -> refuse
}

/**
 * Read a local asset out of the built client dir.
 *
 * vinext calls this OUTSIDE its try/catch, so every refusal here is a real
 * refusal: a non-ok Response makes `handleImageOptimization` return before it
 * ever reaches the transform, rather than degrading to a year-cached
 * passthrough. All fail-closed checks therefore live here.
 *
 * (vinext normalises any non-ok status from this callback to `404 Image not
 * found`, so the statuses below are the intent, not the wire response.)
 */
async function fetchAsset(assetPath) {
  // NB: `assetPath` reaches us already percent-decoded, because vinext read it
  // out of `URLSearchParams`. Decoding again is a second decode of the same
  // value, so `%252e%252e%252f` arrives here as `../`. The `startsWith` check
  // below is what stops it, and it is the ONLY thing that does — there is no
  // `realpath`, so a symlink under `dist/client` pointing outside is followed.
  // Neither is a bug in this spike (nothing there is a symlink, and the check
  // holds), but a production port must not inherit either silently.
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

  // --- fail-closed source checks, before any decode --------------------------
  const probe = Buffer.alloc(Math.min(HEADER_PROBE_BYTES, st.size));
  const fh = await open(resolved, 'r');
  try {
    await fh.read(probe, 0, probe.length, 0);
  } finally {
    await fh.close();
  }
  const kind = sniff(probe);
  if (!kind) {
    return new Response('Unsupported source encoding', { status: 400 });
  }
  const dims = headerDimensions(kind, probe);
  if (!dims || dims.width < 1 || dims.height < 1) {
    return new Response('Unreadable image header', { status: 400 });
  }
  if (dims.width * dims.height > MAX_SOURCE_PIXELS) {
    return new Response('Image has too many pixels', { status: 400 });
  }

  const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
  return new Response(Readable.toWeb(createReadStream(resolved)), {
    status: 200,
    headers: { 'Content-Type': type, 'Content-Length': String(st.size) },
  });
}

/**
 * WASM-backed transform. `format` is the IANA type vinext negotiated.
 *
 * Everything that throws in here is a DEGRADATION, not a refusal: vinext
 * catches it and passthroughs the full source with a year-long immutable
 * cache header. The checks below are duplicated from `fetchAsset` purely as
 * defence in depth for a caller that does not go through it; the enforcing
 * copies are the ones in `fetchAsset`.
 */
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
      // NO `case 'image/png'`, deliberately. `negotiateImageFormat`
      // (`image-optimization.js:130-135`) returns ONLY avif / webp / jpeg, so a
      // png branch is unreachable — and `encodePng` is the one @jsquash codec
      // `initCodecs` never initialises, so reaching it would throw, and vinext
      // would swallow that throw into a year-cached passthrough. The earlier
      // revision of this file carried exactly that branch.
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
