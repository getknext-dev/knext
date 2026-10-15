/**
 * `protoc-gen-knext-glue` — the Next.js glue on top of the function clients
 * protoc-gen-knext writes. For every .proto file with services it writes, next
 * to `<file>_knext.ts`:
 *
 * - `<file>_knext_server.ts` (`import "server-only"`):
 *   - a **query** per unary `NO_SIDE_EFFECTS` RPC. It runs the app's
 *     authorize() hook OUTSIDE the cache, then calls a `'use cache'` function
 *     keyed on (subject, served contract version, request). The subject is the
 *     verified user's `sub` (or the public subject for `AUTH_PUBLIC`), never a
 *     token: the token is minted INSIDE the cached function. Tagged with the
 *     service's tag.
 *   - an **async generator** per server-streaming RPC, for a Server Component
 *     or a route handler. Never cached, never an action.
 * - `<file>_knext_actions.ts` (`'use server'`): a **Server Action** per other
 *   unary RPC. It runs authorize() first (the fail-closed end-user check),
 *   calls the function with the caller's idempotency key, then `updateTag`s
 *   the service's tag so every cached read of the service is refreshed.
 *
 * Refused, with the RPC named, and nothing written:
 * - an RPC that does not state `(knext.v1.auth)`, or states anything but
 *   `AUTH_USER` or `AUTH_PUBLIC` (no public write exists);
 * - `AUTH_PUBLIC` on an RPC that is not `NO_SIDE_EFFECTS`;
 * - a client-streaming or bidi-streaming RPC;
 * - two RPCs in one file that would export the same name;
 * - no authorize() hook (`authorize` in knext.grpc.json).
 *
 * Like protoc-gen-knext, the output is a pure function of the contract and
 * the parameters; the header names a format version, not the package version.
 */

import { posix } from 'node:path';
import { type DescExtension, type DescMethod, getOption, hasOption } from '@bufbuild/protobuf';
import { MethodOptions_IdempotencyLevel } from '@bufbuild/protobuf/wkt';
import {
  createEcmaScriptPlugin,
  type GeneratedFile,
  type ImportSymbol,
  type Schema,
} from '@bufbuild/protoplugin';
import { protoVersionEnvFor } from './config';
import { FORMAT_VERSION, RUNTIME_MODULE } from './plugin';

export const GLUE_PLUGIN_NAME = 'protoc-gen-knext-glue';

export interface GluePluginOptions {
  /** The authorize() module, relative to the output root, without extension. */
  readonly authorize: string | undefined;
}

/** `(knext.v1.auth)` values the generator accepts. */
const AUTH_USER = 1;
const AUTH_PUBLIC = 2;

type Auth = 'user' | 'public';
type Shape = 'query' | 'action' | 'stream';

interface PlannedMethod {
  readonly method: DescMethod;
  readonly shape: Shape;
  readonly auth: Auth;
}

function parseOptions(raw: { key: string; value: string }[]): GluePluginOptions {
  let authorize: string | undefined;
  for (const { key, value } of raw) {
    if (key === 'authorize') authorize = value;
    else throw new Error(`${GLUE_PLUGIN_NAME}: unknown option "${key}"`);
  }
  return { authorize };
}

function rpcName(method: DescMethod): string {
  return `${method.parent.typeName}.${method.name}`;
}

/** The tag every read of a service carries and every write of it updates. */
export function serviceTag(fn: string, method: DescMethod): string {
  return `knext:${fn}:${method.parent.typeName}`;
}

/**
 * The shape an RPC is generated as. A client-streaming or bidi-streaming RPC
 * has none, and is refused.
 */
function shapeOf(method: DescMethod): Shape | string {
  switch (method.methodKind) {
    case 'unary':
      return method.idempotency === MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS
        ? 'query'
        : 'action';
    case 'server_streaming':
      return 'stream';
    default:
      return (
        `${rpcName(method)} is ${method.methodKind.replace('_', '-')}: only unary and ` +
        'server-streaming RPCs get zone glue'
      );
  }
}

/**
 * The refusal at the one place an action is written: an action is a public
 * POST endpoint returning one value, so a streaming RPC never becomes one,
 * whatever planned it.
 */
export function emitActionGuard(method: DescMethod): void {
  if (method.methodKind !== 'unary') {
    throw new Error(
      `${rpcName(method)} is a ${method.methodKind.replace('_', '-')} RPC: a streaming RPC is ` +
        'never generated as a Server Action; call it from a Server Component or a route handler',
    );
  }
}

function authOf(method: DescMethod, ext: DescExtension): Auth | string {
  if (!hasOption(method, ext)) {
    return (
      `${rpcName(method)} does not say who may call it: add ` +
      '`option (knext.v1.auth) = AUTH_USER;` (a signed-in user) or, on a ' +
      'NO_SIDE_EFFECTS read only, `option (knext.v1.auth) = AUTH_PUBLIC;`'
    );
  }
  const value = getOption(method, ext as DescExtension & { fieldKind: 'enum' }) as number;
  if (value === AUTH_USER) return 'user';
  if (value === AUTH_PUBLIC) {
    if (method.idempotency !== MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS) {
      return (
        `${rpcName(method)} is AUTH_PUBLIC but is not a read: AUTH_PUBLIC is allowed only with ` +
        '`option idempotency_level = NO_SIDE_EFFECTS;`. A write needs a user (AUTH_USER); ' +
        'for an anonymous write, have authorize() return an anonymous principal after your own check'
      );
    }
    return 'public';
  }
  const name =
    ext.fieldKind === 'enum'
      ? (ext.enum.values.find((v) => v.number === value)?.name ?? String(value))
      : String(value);
  return `${rpcName(method)} states (knext.v1.auth) = ${name}: the only values are AUTH_USER or AUTH_PUBLIC`;
}

/** Plan every RPC of every service in the files to generate, or throw every refusal. */
function plan(schema: Schema<GluePluginOptions>): Map<string, PlannedMethod[]> {
  const ext = schema.allFiles
    .flatMap((f) => f.extensions)
    .find((e) => e.typeName === 'knext.v1.auth');
  const problems: string[] = [];
  const planned = new Map<string, PlannedMethod[]>();
  for (const file of schema.files) {
    if (file.services.length === 0) continue;
    if (!ext) {
      problems.push(
        `${file.name}: the knext options contract (knext/v1/options.proto) has no (knext.v1.auth) ` +
          'option. Replace your copy with the current one from @getknext/grpc ' +
          '(node_modules/@getknext/grpc/proto/knext/v1/options.proto), then state the auth of every RPC',
      );
      continue;
    }
    const methods: PlannedMethod[] = [];
    const names = new Map<string, string>();
    for (const service of file.services) {
      for (const method of service.methods) {
        const shape = shapeOf(method);
        const auth = authOf(method, ext);
        if (shape !== 'query' && shape !== 'action' && shape !== 'stream') problems.push(shape);
        if (auth !== 'user' && auth !== 'public') problems.push(auth);
        const clash = names.get(method.localName);
        if (clash) {
          problems.push(
            `${rpcName(method)} and ${clash} would both be exported as ${method.localName} from ` +
              `the glue for ${file.name}: rename one, or move one service to its own file`,
          );
        }
        names.set(method.localName, rpcName(method));
        if (
          (shape === 'query' || shape === 'action' || shape === 'stream') &&
          (auth === 'user' || auth === 'public')
        ) {
          methods.push({ method, shape, auth });
        }
      }
    }
    planned.set(file.name, methods);
  }
  if (problems.length === 0 && planned.size > 0 && schema.options.authorize === undefined) {
    problems.push(
      'no authorize() hook: set "authorize" in knext.grpc.json to the module that exports ' +
        'authorize() (for example "src/knext/authorize.ts"). Every generated call runs it first',
    );
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return planned;
}

/** Imports printed by hand, so a `'use server'` directive can come before them. */
class Imports {
  private readonly byModule = new Map<string, Map<string, string>>();
  private readonly typeOnly = new Map<string, Set<string>>();

  add(from: string, name: string, alias = name, typeOnly = false): string {
    const names = this.byModule.get(from) ?? new Map<string, string>();
    names.set(name, alias);
    this.byModule.set(from, names);
    if (typeOnly) {
      const t = this.typeOnly.get(from) ?? new Set<string>();
      t.add(name);
      this.typeOnly.set(from, t);
    }
    return alias;
  }

  print(f: GeneratedFile): void {
    for (const from of [...this.byModule.keys()].sort()) {
      const names = this.byModule.get(from) as Map<string, string>;
      const types = this.typeOnly.get(from) ?? new Set<string>();
      const parts = [...names]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, alias]) => {
          const t = types.has(name) ? 'type ' : '';
          return alias === name ? `${t}${name}` : `${t}${name} as ${alias}`;
        });
      f.print(`import { ${parts.join(', ')} } from ${JSON.stringify(from)};`);
    }
  }
}

/** A path relative to the output root, as an import from `fileName`. */
function relativeImport(fileName: string, target: string): string {
  const rel = posix.relative(
    posix.dirname(fileName),
    target.replace(/^\.\//, '').replace(/\.js$/, ''),
  );
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function symbol(imports: Imports, fileName: string, sym: ImportSymbol): string {
  return imports.add(relativeImport(fileName, sym.from), sym.name, sym.name, sym.typeOnly);
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

interface FileCtx {
  readonly f: GeneratedFile;
  readonly name: string;
  readonly imports: Imports;
  readonly fn: string;
  readonly version: string;
  readonly authorize: string | undefined;
  readonly lines: string[];
}

function clientFor(ctx: FileCtx, method: DescMethod): string {
  const base = ctx.name.replace(/_knext_(server|actions)\.ts$/, '_knext');
  return ctx.imports.add(
    `./${posix.basename(base)}`,
    `${lowerFirst(method.parent.name)}Client`,
    `$${lowerFirst(method.parent.name)}`,
  );
}

function subjectExpr(ctx: FileCtx, p: PlannedMethod, kind: string): string {
  if (p.auth === 'public')
    return `${ctx.imports.add(RUNTIME_MODULE, 'PUBLIC_SUBJECT', '$PUBLIC_SUBJECT')}`;
  const authorize = ctx.imports.add(
    relativeImport(ctx.name, ctx.authorize as string),
    'authorize',
    '$authorize',
  );
  const userSubject = ctx.imports.add(RUNTIME_MODULE, 'userSubject', '$userSubject');
  return (
    `await ${userSubject}(${authorize}, { function: ${JSON.stringify(ctx.fn)}, ` +
    `service: ${JSON.stringify(p.method.parent.typeName)}, method: ${JSON.stringify(p.method.name)}, ` +
    `kind: ${JSON.stringify(kind)} })`
  );
}

function servedVersionExpr(ctx: FileCtx): string {
  const served = ctx.imports.add(RUNTIME_MODULE, 'servedVersion', '$servedVersion');
  return `${served}(${JSON.stringify(ctx.fn)}, ${JSON.stringify(protoVersionEnvFor(ctx.fn))}, ${JSON.stringify(ctx.version)})`;
}

function mintExpr(ctx: FileCtx, method: DescMethod, subject: string): string {
  const mint = ctx.imports.add(RUNTIME_MODULE, 'mintCallToken', '$mintCallToken');
  const sub = ctx.imports.add(RUNTIME_MODULE, 'subjectSub', '$subjectSub');
  return (
    `await ${mint}({ function: ${JSON.stringify(ctx.fn)}, ` +
    `method: ${JSON.stringify(`/${method.parent.typeName}/${method.name}`)}, sub: ${sub}(${subject}) })`
  );
}

function emitQuery(ctx: FileCtx, p: PlannedMethod): void {
  const { method } = p;
  const name = method.localName;
  const input = symbol(ctx.imports, ctx.name, ctx.f.importSchema(method.input));
  const output = symbol(ctx.imports, ctx.name, ctx.f.importShape(method.output));
  const initShape = ctx.imports.add(
    '@bufbuild/protobuf',
    'MessageInitShape',
    'MessageInitShape',
    true,
  );
  const encode = ctx.imports.add(RUNTIME_MODULE, 'encodeRequest', '$encodeRequest');
  const decode = ctx.imports.add(RUNTIME_MODULE, 'decodeRequest', '$decodeRequest');
  const life = ctx.imports.add(RUNTIME_MODULE, 'QUERY_CACHE_LIFE', '$QUERY_CACHE_LIFE');
  const cacheLife = ctx.imports.add('next/cache', 'cacheLife', '$cacheLife');
  const cacheTag = ctx.imports.add('next/cache', 'cacheTag', '$cacheTag');
  const client = clientFor(ctx, method);
  const who =
    p.auth === 'user' ? 'the signed-in user (authorize() runs first)' : 'anyone (AUTH_PUBLIC)';
  ctx.lines.push(
    '/**',
    ` * ${rpcName(method)}: a cached read for ${who}.`,
    ' *',
    ' * Cached per user, per served contract version and per request; a write to',
    ` * ${method.parent.typeName} refreshes it. Call it from a Server Component,`,
    ' * a route handler or a Server Action.',
    ' */',
    `export async function ${name}(request: ${initShape}<typeof ${input}>): Promise<${output}> {`,
    `  const subject = ${subjectExpr(ctx, p, 'read')};`,
    `  return ${name}$cached(subject, ${servedVersionExpr(ctx)}, ${encode}(${input}, request));`,
    '}',
    '',
    `async function ${name}$cached(subject: string, protoVersion: string, request: string): Promise<${output}> {`,
    '  "use cache";',
    `  ${cacheLife}(${life});`,
    `  ${cacheTag}(${JSON.stringify(serviceTag(ctx.fn, method))});`,
    '  // protoVersion is part of the cache key only: a function rollout is a new entry.',
    '  void protoVersion;',
    `  const token = ${mintExpr(ctx, method, 'subject')};`,
    `  return ${client}.${name}(${decode}(${input}, request), { token });`,
    '}',
    '',
  );
}

function emitStream(ctx: FileCtx, p: PlannedMethod): void {
  const { method } = p;
  const name = method.localName;
  const input = symbol(ctx.imports, ctx.name, ctx.f.importSchema(method.input));
  const output = symbol(ctx.imports, ctx.name, ctx.f.importShape(method.output));
  const initShape = ctx.imports.add(
    '@bufbuild/protobuf',
    'MessageInitShape',
    'MessageInitShape',
    true,
  );
  const normalize = ctx.imports.add(RUNTIME_MODULE, 'normalizeRequest', '$normalizeRequest');
  const client = clientFor(ctx, method);
  ctx.lines.push(
    '/**',
    ` * ${rpcName(method)}: a stream, for a Server Component or a route handler.`,
    ' * Never cached, and never a Server Action.',
    ' */',
    `export async function* ${name}(request: ${initShape}<typeof ${input}>, options?: { readonly signal?: AbortSignal }): AsyncGenerator<${output}> {`,
    `  const subject = ${subjectExpr(ctx, p, 'stream')};`,
    `  ${servedVersionExpr(ctx)};`,
    `  const token = ${mintExpr(ctx, method, 'subject')};`,
    `  yield* ${client}.${name}(${normalize}(${input}, request), { token, signal: options?.signal });`,
    '}',
    '',
  );
}

function emitAction(ctx: FileCtx, p: PlannedMethod): void {
  const { method } = p;
  emitActionGuard(method);
  const name = method.localName;
  const input = symbol(ctx.imports, ctx.name, ctx.f.importSchema(method.input));
  const output = symbol(ctx.imports, ctx.name, ctx.f.importShape(method.output));
  const initShape = ctx.imports.add(
    '@bufbuild/protobuf',
    'MessageInitShape',
    'MessageInitShape',
    true,
  );
  const normalize = ctx.imports.add(RUNTIME_MODULE, 'normalizeRequest', '$normalizeRequest');
  const updateTag = ctx.imports.add('next/cache', 'updateTag', '$updateTag');
  const client = clientFor(ctx, method);
  ctx.lines.push(
    '/**',
    ` * ${rpcName(method)}: a Server Action. authorize() runs first; the call is`,
    ' * never retried and carries your idempotency key (reuse it when re-submitting',
    ` * the same write); then every cached read of ${method.parent.typeName} is refreshed.`,
    ' */',
    `export async function ${name}(request: ${initShape}<typeof ${input}>, options: { readonly idempotencyKey: string }): Promise<${output}> {`,
    `  const subject = ${subjectExpr(ctx, p, 'mutation')};`,
    `  ${servedVersionExpr(ctx)};`,
    `  const token = ${mintExpr(ctx, method, 'subject')};`,
    `  const response = await ${client}.${name}(${normalize}(${input}, request), { idempotencyKey: options?.idempotencyKey, token });`,
    `  ${updateTag}(${JSON.stringify(serviceTag(ctx.fn, method))});`,
    '  return response;',
    '}',
    '',
  );
}

function stringFileOption(
  schema: Schema<GluePluginOptions>,
  file: { name: string },
  typeName: string,
): string {
  const ext = schema.allFiles.flatMap((f) => f.extensions).find((e) => e.typeName === typeName);
  const desc = schema.files.find((f) => f.name === file.name);
  if (!ext || !desc) return '';
  const value = getOption(desc, ext as DescExtension & { fieldKind: 'scalar' });
  return typeof value === 'string' ? value : '';
}

function generateTs(schema: Schema<GluePluginOptions>): void {
  const planned = plan(schema);
  for (const file of schema.files) {
    const methods = planned.get(file.name);
    if (!methods || methods.length === 0) continue;
    // protoc-gen-knext has already refused a file without these.
    const fn = stringFileOption(schema, file, 'knext.v1.function');
    const version = stringFileOption(schema, file, 'knext.v1.contract_version');
    for (const [suffix, shapes] of [
      ['_knext_server.ts', ['query', 'stream']],
      ['_knext_actions.ts', ['action']],
    ] as const) {
      const selected = methods.filter((m) => (shapes as readonly Shape[]).includes(m.shape));
      if (selected.length === 0) continue;
      const name = `${file.name}${suffix}`;
      const f = schema.generateFile(name);
      f.preamble(file);
      const ctx: FileCtx = {
        f,
        name,
        imports: new Imports(),
        fn,
        version,
        authorize: schema.options.authorize,
        lines: [],
      };
      for (const p of selected) {
        if (p.shape === 'query') emitQuery(ctx, p);
        else if (p.shape === 'stream') emitStream(ctx, p);
        else emitAction(ctx, p);
      }
      if (suffix === '_knext_actions.ts') {
        f.print('"use server";');
        f.print();
      }
      f.print('import "server-only";');
      ctx.imports.print(f);
      f.print();
      for (const line of ctx.lines) f.print(line);
    }
  }
}

export const knextGluePlugin = createEcmaScriptPlugin<GluePluginOptions>({
  name: GLUE_PLUGIN_NAME,
  version: FORMAT_VERSION,
  parseOptions,
  generateTs,
});
