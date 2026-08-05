// Cost of one optimisation, and whether repeated identical requests are cached.
const port = process.argv[2];
const label = process.argv[3];
const base = `http://127.0.0.1:${port}`;
const A = { accept: 'image/avif,image/webp,image/*,*/*;q=0.8' };

async function timed(path) {
  const t0 = performance.now();
  const r = await fetch(base + path, { headers: A });
  const b = await r.arrayBuffer();
  return { ms: Math.round(performance.now() - t0), status: r.status, bytes: b.byteLength };
}

const W = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];

// serial, distinct widths (each a real encode)
const serial = [];
for (const w of W) {
  serial.push(await timed(`/_next/image?url=%2Fknext-optimize-fixture.png&w=${w}&q=75`));
}
console.log(`${label}\tserial distinct widths ms\t${serial.map((s) => s.ms).join(',')}`);

// same URL three times — is it cached?
const repeat = [];
for (let i = 0; i < 3; i++) {
  repeat.push(await timed('/_next/image?url=%2Fknext-optimize-fixture.png&w=1920&q=75'));
}
console.log(`${label}\tsame url x3 ms\t${repeat.map((s) => s.ms).join(',')}`);

// 16 concurrent distinct requests
const t0 = performance.now();
const conc = await Promise.all(
  Array.from({ length: 16 }, (_, i) =>
    timed(
      `/_next/image?url=%2Fknext-optimize-fixture.png&w=${W[i % W.length]}&q=${i % 2 ? 20 : 75}`,
    ),
  ),
);
console.log(
  `${label}\t16 concurrent: wall ${Math.round(performance.now() - t0)}ms, per-req ${Math.min(...conc.map((c) => c.ms))}..${Math.max(...conc.map((c) => c.ms))}ms, statuses ${[...new Set(conc.map((c) => c.status))].join('/')}`,
);

// control: cost of a plain SSR request for scale
const ssr = await timed('/');
console.log(`${label}\tSSR / for scale\t${ssr.ms}ms ${ssr.status}`);
