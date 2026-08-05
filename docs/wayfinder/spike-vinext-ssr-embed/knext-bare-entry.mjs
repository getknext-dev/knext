// Bespoke knext entry: NO vinext/server/prod-server. Statically imports the RSC
// entry so bun bundles it, serves dist/client statics, delegates everything else
// to the RSC handler.
import { join, dirname, resolve } from 'node:path';
import * as rscModule from './dist/server/index.js';

const handler = rscModule.default;
const root = process.env.VINEXT_OUT_DIR ? resolve(process.env.VINEXT_OUT_DIR) : join(dirname(process.execPath), 'dist');
const clientDir = join(root, 'client');
console.log(`[bare] clientDir=${clientDir} handler=${typeof handler}`);

Bun.serve({
  port: Number.parseInt(process.env.PORT ?? '3000', 10),
  hostname: process.env.HOST ?? '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    const f = Bun.file(join(clientDir, url.pathname));
    if (url.pathname !== '/' && (await f.exists())) return new Response(f);
    return handler(req);
  },
});
console.log('[bare] listening');
