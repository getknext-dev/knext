// Empties the Redis a compat-smoke run uses, and proves it is empty, before
// the run. Next caches the optimized image (and ISR entries) in that Redis,
// so a second smoke against a warm store could serve check (g)'s image from
// the cache and pass without the optimizer running at all.
//
//   REDIS_URL=redis://127.0.0.1:6379 node redis-flush.mjs
//
// FLUSHALL (every database: the runner's DBSIZE evidence reads the default
// one, the app may select another), then DBSIZE must answer 0. Any other
// reply, an unreachable server or no REDIS_URL fails with exit 1. Raw RESP,
// no dependency, like the runner's own Redis probes.
import net from 'node:net';

const url = process.env.REDIS_URL;
if (!url) {
  console.error('redis-flush: REDIS_URL is not set');
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(url);
} catch {
  console.error(`redis-flush: REDIS_URL is not a URL: ${url}`);
  process.exit(1);
}

/** One command, one single-line reply (`+OK`, `:0`, `-ERR …`). */
function command(name) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: parsed.hostname, port: Number(parsed.port || 6379) });
    sock.setTimeout(5000, () => sock.destroy(new Error(`${name}: timeout`)));
    let buf = '';
    sock.on('connect', () => sock.write(`*1\r\n$${name.length}\r\n${name}\r\n`));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const end = buf.indexOf('\r\n');
      if (end === -1) return;
      sock.end();
      resolve(buf.slice(0, end));
    });
    sock.on('error', reject);
  });
}

try {
  const flushed = await command('FLUSHALL');
  if (flushed !== '+OK') throw new Error(`FLUSHALL answered ${JSON.stringify(flushed)}`);
  const size = await command('DBSIZE');
  if (size !== ':0') {
    const n = size.startsWith(':') ? size.slice(1) : JSON.stringify(size);
    throw new Error(`${n} keys survive FLUSHALL`);
  }
  console.log(`redis-flush: ${parsed.host} is empty`);
} catch (err) {
  console.error(`redis-flush: ${parsed.host}: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
