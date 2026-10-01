// Resolver timing from INSIDE a freshly woken app container (node or bun).
// Each name is looked up once, in order, through the platform resolver
// (dns.lookup -> getaddrinfo, the path an app's fetch()/pg/redis client takes),
// and timed with performance.now(). The unrooted FQDN and the short name walk
// the pod's resolv.conf search list (ndots:5); the rooted names do not.
const dns = require('node:dns');
const names = [
  'kubernetes.default.svc.cluster.local.',
  'kubernetes.default.svc.cluster.local',
  'kubernetes.default',
  'registry.npmjs.org',
  'registry.npmjs.org.',
];
const lookup = (n) =>
  new Promise((resolve, reject) => dns.lookup(n, (e, a) => (e ? reject(e) : resolve(a))));
(async () => {
  const out = { runtime: typeof Bun === 'undefined' ? 'node' : 'bun' };
  for (const n of names) {
    const t = performance.now();
    try {
      await lookup(n);
      out[n] = Math.round((performance.now() - t) * 10) / 10;
    } catch (e) {
      out[n] = `ERR ${e.code} ${Math.round(performance.now() - t)}ms`;
    }
  }
  try {
    out.resolv = require('node:fs')
      .readFileSync('/etc/resolv.conf', 'utf8')
      .split('\n')
      .filter((l) => /^(search|options|nameserver)/.test(l))
      .join(' | ');
  } catch {}
  process.stdout.write(`${JSON.stringify(out)}\n`);
})();
