/**
 * Test-only preload for the CDN seam guard: routes the purger's request to the
 * cluster-local emulator endpoint (`*.svc.cluster.local`, the only host the
 * emulator row accepts) to the fake CDN on 127.0.0.1:$SEAM_ALIVE_CDN_PORT.
 * Every other request is untouched.
 */
'use strict';
const port = Number(process.env.SEAM_ALIVE_CDN_PORT);
const realFetch = globalThis.fetch;
globalThis.fetch = function routedFetch(input, init) {
  const u = new URL(String(input instanceof Request ? input.url : input));
  if (u.hostname.endsWith('.svc.cluster.local')) {
    return realFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
  }
  return realFetch(input, init);
};
