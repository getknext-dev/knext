#!/usr/bin/env bun
/**
 * `bun probe.ts --base <url> --host <fn host> --rpc put|get|health --auth <mode> ...`
 *
 * One Connect call to a zone function, printed as one JSON line:
 * `{"status":401,"code":"unauthenticated","kid":"..."}`. With `--twice` the SAME
 * token is sent in two calls, one after the other, and one line is printed for
 * each (a function must refuse the second: a token is single-use). Exit 0 when the
 * function answered (whatever the status), 2 when it did not (nothing
 * listening, no response). Never prints a token or a key. See probe-lib.ts.
 */

import { parseArgs } from 'node:util';
import { type AuthMode, authorizationHeader, callFunction, summarize } from './probe-lib';

const RPCS = {
  put: '/example.v1.ExampleService/PutItem',
  get: '/example.v1.ExampleService/GetItem',
  health: '/grpc.health.v1.Health/Check',
} as const;

const MODES: readonly AuthMode[] = ['none', 'garbage', 'signer', 'foreign', 'forged', 'raw'];

function usage(message: string): never {
  console.error(`probe: ${message}`);
  process.exit(64);
}

const { values } = parseArgs({
  options: {
    base: { type: 'string' },
    host: { type: 'string' },
    rpc: { type: 'string' },
    auth: { type: 'string', default: 'none' },
    'key-dir': { type: 'string' },
    issuer: { type: 'string' },
    audience: { type: 'string' },
    'token-method': { type: 'string' },
    sub: { type: 'string', default: 'alice' },
    id: { type: 'string', default: 'item' },
    value: { type: 'string', default: 'value' },
    'age-seconds': { type: 'string', default: '0' },
    lifetime: { type: 'string' },
    kid: { type: 'string' },
    twice: { type: 'boolean', default: false },
  },
  strict: true,
});

const rpc = values.rpc as keyof typeof RPCS | undefined;
if (!rpc || !(rpc in RPCS)) usage(`--rpc must be one of ${Object.keys(RPCS).join(', ')}`);
const mode = values.auth as AuthMode;
if (!MODES.includes(mode)) usage(`--auth must be one of ${MODES.join(', ')}`);
if (!values.base || !values.host) usage('--base and --host are required');

const host = values.host as string;
// The function's cluster-local host is <service>.<namespace>.svc.cluster.local,
// which is also where its audience comes from: knext:fn:<namespace>/<service>.
const hostParts = /^([^.]+)\.([^.]+)\.svc\.cluster\.local$/.exec(host);
const procedure = RPCS[rpc];
const needsToken = rpc !== 'health';

const auth = needsToken
  ? await authorizationHeader({
      mode,
      keyDir: values['key-dir'],
      issuer: values.issuer ?? '',
      audience: values.audience ?? (hostParts ? `knext:fn:${hostParts[2]}/${hostParts[1]}` : ''),
      method: values['token-method'] ?? procedure,
      sub: values.sub as string,
      ageSeconds: Number(values['age-seconds']),
      lifetimeSeconds: values.lifetime === undefined ? undefined : Number(values.lifetime),
      kid: values.kid,
    })
  : { header: undefined, kid: undefined };

const body =
  rpc === 'put' ? { id: values.id, value: values.value } : rpc === 'get' ? { id: values.id } : {};

try {
  // The same Authorization header, sent again after the first answer: a replay.
  for (let call = 0; call < (values.twice ? 2 : 1); call++) {
    const outcome = await callFunction({
      base: values.base,
      host,
      procedure,
      body,
      authorization: auth.header,
    });
    console.log(summarize(outcome, auth.kid));
  }
} catch (err) {
  console.error(`probe: no response from ${host}: ${(err as Error).message}`);
  process.exit(2);
}
