// Probe a running server on PORT. Prints one line per check.
// usage: node probe.mjs <port> <label>
const port = process.argv[2];
const label = process.argv[3] ?? '';
const base = `http://127.0.0.1:${port}`;

const IMG = '/_next/image?url=%2Fknext-optimize-fixture.png&w=640&q=75';

async function hit(path, headers = {}) {
  const r = await fetch(base + path, { headers });
  const buf = Buffer.from(await r.arrayBuffer());
  return {
    status: r.status,
    type: r.headers.get('content-type'),
    bytes: buf.length,
    body: buf,
  };
}

function row(name, r, extra = '') {
  console.log(`${label}\t${name}\t${r.status}\t${r.type}\t${r.bytes}${extra ? `\t${extra}` : ''}`);
}

const results = {};

// 1. image, default Accept (browser-like, prefers avif/webp)
const acceptModern = { accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' };
results.imgModern = await hit(IMG, acceptModern);
row('image w=640 q=75 (avif,webp accept)', results.imgModern);

// 2. image, Accept: image/* only (no modern formats)
results.imgPlain = await hit(IMG, { accept: 'image/*' });
row('image w=640 q=75 (accept image/*)', results.imgPlain);

// 3. width honoured: w=64
results.imgSmall = await hit(
  '/_next/image?url=%2Fknext-optimize-fixture.png&w=64&q=75',
  acceptModern,
);
row('image w=64 q=75', results.imgSmall);

// 4. quality honoured: w=640 q=20
results.imgQ20 = await hit(
  '/_next/image?url=%2Fknext-optimize-fixture.png&w=640&q=20',
  acceptModern,
);
row('image w=640 q=20', results.imgQ20);

// 5. invalid width (not in deviceSizes/imageSizes) -> expect 400
results.imgBadW = await hit(
  '/_next/image?url=%2Fknext-optimize-fixture.png&w=637&q=75',
  acceptModern,
);
row('image w=637 (invalid) expect 400', results.imgBadW);

// 6. missing url -> expect 400
results.imgNoUrl = await hit('/_next/image?w=640&q=75', acceptModern);
row('image no url expect 400', results.imgNoUrl);

// 7. external/absolute url not in remotePatterns -> expect 400
results.imgRemote = await hit(
  '/_next/image?url=https%3A%2F%2Fexample.com%2Fa.png&w=640&q=75',
  acceptModern,
);
row('image remote url expect 400', results.imgRemote);

// 8. SSR root
results.ssr = await hit('/');
row(
  'GET / (SSR)',
  results.ssr,
  results.ssr.body.toString().includes('SSR-OK') ? 'HAS_SSR_OK' : 'NO_SSR_OK',
);

// 9. route handler
results.api = await hit('/api/hello');
row('GET /api/hello', results.api, results.api.body.toString().slice(0, 40));

// 10. dynamic route param binding
results.slug = await hit('/blog/spike-42');
row(
  'GET /blog/spike-42',
  results.slug,
  results.slug.body.toString().includes('spike-42') ? 'HAS_SLUG' : 'NO_SLUG',
);

// 11. 404
results.miss = await hit('/definitely-not-here');
row('GET /definitely-not-here (expect 404)', results.miss);

// 12. static asset passthrough
results.staticPng = await hit('/knext-optimize-fixture.png');
row('GET /knext-optimize-fixture.png (raw static)', results.staticPng);

// magic-byte sniff for the modern-accept image
const b = results.imgModern.body;
let sniff = 'unknown';
if (b.length > 12) {
  if (b[0] === 0x89 && b[1] === 0x50) sniff = 'PNG';
  else if (b[0] === 0xff && b[1] === 0xd8) sniff = 'JPEG';
  else if (
    b.slice(0, 4).toString('ascii') === 'RIFF' &&
    b.slice(8, 12).toString('ascii') === 'WEBP'
  )
    sniff = 'WEBP';
  else if (b.slice(4, 8).toString('ascii') === 'ftyp')
    sniff = `AVIF/HEIF(${b.slice(8, 12).toString('ascii')})`;
}
console.log(`${label}\tSNIFF image w=640 q=75\t${sniff}`);
