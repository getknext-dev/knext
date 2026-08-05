// e1-probe.mjs <base> — hit the standard route set and report status + cache header + bytes.
const base = process.argv[2];
const routes = [
  '/',
  '/blog/alpha',
  '/blog/beta',
  '/blog/gamma',
  '/isr',
  '/img',
  '/api/health',
  '/blog/spike-dynamic-not-prerendered',
  '/definitely-not-a-route',
];
for (const r of routes) {
  try {
    const res = await fetch(base + r, { redirect: 'manual' });
    const body = Buffer.from(await res.arrayBuffer());
    const cache = res.headers.get('x-vinext-cache') ?? '-';
    const snippet = body.subarray(0, 140).toString('utf8').replace(/\s+/g, ' ');
    console.log(
      `${r.padEnd(38)} ${String(res.status).padEnd(4)} cache=${cache.padEnd(6)} ${String(body.length).padStart(7)}B  ${res.status >= 400 ? snippet : ''}`,
    );
  } catch (e) {
    console.log(`${r.padEnd(38)} ERR  ${e.message}`);
  }
}
