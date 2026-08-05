// Does the entry's resource cap REFUSE, or does it silently degrade to a year-cached
// passthrough of the full source? Usage: node cap-probe.mjs <baseUrl>
//
// Setup, into the built client dir (`dist/client`):
//   python3 make-bomb.py dist/client/knext-bomb.png
//   printf 'not an image\n' > dist/client/knext-notanimage.png
//   cp <repo>/apps/file-manager/public/knext-optimize-fixture.png dist/client/
//
// This is the mutation proof for the fail-closed fix. Against the entry as FIRST
// written, both refusal rows came back 200 with the full source and
// `Cache-Control: public, max-age=31536000, immutable`; after moving the checks
// into `fetchAsset` (outside vinext's swallowing try/catch) both are 404, and the
// control still returns exactly 1,463 B of AVIF.
const base = process.argv[2] ?? 'http://127.0.0.1:3401';
const ACCEPT = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';

const cases = [
  ['40 MP cap (10000x10000 bomb, 97,276 B on disk)', '/knext-bomb.png'],
  ['unsupported source encoding (text named .png)', '/knext-notanimage.png'],
  ['control: the real 256x256 fixture', '/knext-optimize-fixture.png'],
];

let failures = 0;
for (const [label, url] of cases) {
  const res = await fetch(`${base}/_next/image?url=${encodeURIComponent(url)}&w=640&q=75`, {
    headers: { Accept: ACCEPT },
  });
  const bytes = (await res.arrayBuffer()).byteLength;
  const ct = res.headers.get('content-type');
  const cc = res.headers.get('cache-control');
  const isControl = url.includes('fixture');
  // A cap that works refuses. A cap that fails open returns 200 + the whole source.
  const refused = res.status >= 400;
  const ok = isControl ? res.status === 200 && ct === 'image/avif' : refused;
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}\n      status=${res.status} type=${ct} bytes=${bytes} cache-control=${cc}`,
  );
}
console.log(failures === 0 ? 'all pass' : `${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
