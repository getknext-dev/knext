// Spawned by health-refused-runtimes.test.ts under REAL node and REAL bun, with
// no timing env set. Prints one RESULT line: which driver the lib picked, how
// long the deep check took, and its verdict.
import { selectDbDriver } from '../../clients';
import { checkDeepHealth } from '../../health';

const started = Date.now();
const res = await checkDeepHealth();
console.log(
  `RESULT:${JSON.stringify({ driver: selectDbDriver(), elapsedMs: Date.now() - started, res })}`,
);
process.exit(0);
