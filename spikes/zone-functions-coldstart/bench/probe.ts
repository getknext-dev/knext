// One-off probe: bun probe.ts <zone> <fn> [<fn> ...]  — prints e2e ms + the zone's body.
import { curl, svcUrl } from './k';

const [zone, ...fns] = process.argv.slice(2);
for (const fn of fns) {
  const r = curl(svcUrl(zone, `/api/chain?fn=${fn}`));
  console.log(`${zone} -> ${fn}: e2e=${Math.round(r.ms)}ms code=${r.code} ${r.body}`);
}
