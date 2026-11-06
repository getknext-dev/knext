import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Engine for the image half of the R8 supply-chain guard (#2044): every
 * workflow that PUBLISHES an image (discovered by what it does, under any
 * trigger) and every function-template image. The npm half lives in
 * `publish-lane-supply-chain.ts`.
 *
 * Everything is DERIVED by scanning `.github/workflows`, local composite
 * actions and `templates/`. A workflow, reusable workflow or local action that
 * cannot be read, parsed or resolved is a FINDING or a throw, never a pass.
 *
 * WHAT IS TIED TO THE IMAGE, and what cannot be: see `tieFindings`. YAML cannot
 * prove two steps handle the same bytes; the guard ties by name (the layout
 * directory `crane push` publishes must be the one Trivy scans, or be derived
 * from it by a script that names both; a cosign command must address a
 * digest). It cannot tie the SBOM to the image, nor prove a derived layout is
 * byte-equal to the scanned one.
 */

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

export type Step = Record<string, unknown>;
export type Job = Record<string, unknown>;
export interface Workflow {
  file: string;
  doc: Record<string, unknown>;
}
export interface Finding {
  subject: string;
  check: string;
  detail: string;
}

// ───────────────────────── reading ─────────────────────────

/** Read and parse every workflow. Throws (fail closed) on anything unreadable. */
export function loadWorkflows(dir = resolve(REPO_ROOT, '.github/workflows')): Workflow[] {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  if (files.length === 0) throw new Error(`no workflows found in ${dir}`);
  return files.sort().map((file) => {
    const doc = parse(readFileSync(resolve(dir, file), 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc))
      throw new Error(`${file}: workflow did not parse to a mapping`);
    return { file, doc: doc as Record<string, unknown> };
  });
}

export function jobsOf(wf: Workflow): Record<string, Job> {
  const j = wf.doc.jobs;
  if (j === undefined) return {};
  if (!j || typeof j !== 'object' || Array.isArray(j))
    throw new Error(`${wf.file}: \`jobs\` is not a mapping`);
  return j as Record<string, Job>;
}

export function stepsOf(file: string, id: string, job: Job): Step[] {
  const s = job.steps;
  if (s === undefined) return [];
  if (!Array.isArray(s)) throw new Error(`${file}#${id}: \`steps\` is not a list`);
  return s as Step[];
}

/** Resolves a local `./path` composite action to its steps, or null when it cannot. */
export type ActionResolver = (path: string) => Step[] | null;

export const fsActionResolver: ActionResolver = (path) => {
  for (const name of ['action.yml', 'action.yaml']) {
    const p = resolve(REPO_ROOT, path, name);
    if (!existsSync(p)) continue;
    const doc = parse(readFileSync(p, 'utf8')) as { runs?: { steps?: Step[] } } | null;
    if (!doc || typeof doc !== 'object') throw new Error(`${path}: action did not parse`);
    return doc.runs?.steps ?? [];
  }
  return null;
};

function needsOf(job: Job): string[] {
  const n = job.needs;
  if (n === undefined) return [];
  if (typeof n === 'string') return [n];
  if (Array.isArray(n)) return n.map(String);
  throw new Error('`needs` is neither a string nor a list');
}

/** Jobs reachable from `id` through `needs` (upstream) or through who needs it (downstream), plus itself. */
function reach(jobs: Record<string, Job>, id: string, dir: 'upstream' | 'downstream'): Set<string> {
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.pop() as string;
    const next =
      dir === 'upstream'
        ? needsOf(jobs[cur] ?? {})
        : Object.keys(jobs).filter((o) => needsOf(jobs[o]).includes(cur));
    for (const n of next) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

// ───────────────────────── step classification ─────────────────────────

/** Run text with comment lines removed and continuations joined. */
function code(step: Step): string {
  const run = typeof step.run === 'string' ? step.run : '';
  return run
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
    .replace(/\\\n/g, ' ');
}
const uses = (s: Step) => (typeof s.uses === 'string' ? s.uses : '');
const withOf = (s: Step): Record<string, unknown> =>
  s.with && typeof s.with === 'object' ? (s.with as Record<string, unknown>) : {};

// A script's text (synthetic `x-script` step) is read to find PUSHES; it never
// satisfies a gate, because a mention of syft/trivy/cosign in a script is not
// proof the step runs, in order, with its exit status honoured.
const fromScript = (s: Step) => s['x-script'] !== undefined;

export const isSbom = (s: Step) =>
  !fromScript(s) &&
  (/^anchore\/sbom-action@/.test(uses(s)) || /\b(syft|cyclonedx-npm)\b/.test(code(s)));

/** Only an IMAGE scan satisfies "image scanned": not fs, config, repo, rootfs, sbom or vm. */
export const isTrivy = (s: Step) => {
  if (fromScript(s)) return false;
  if (/^aquasecurity\/trivy-action@/.test(uses(s))) {
    const t = withOf(s)['scan-type'];
    return t === undefined || String(t).trim().toLowerCase() === 'image';
  }
  return /\btrivy\s+image\b/.test(code(s));
};
// `cosign sign-blob` / `attest-blob` sign a FILE, not an image: not a match.
export const isCosign = (s: Step) =>
  !fromScript(s) && /\bcosign\s+(?:sign|attest)(?![\w-])/.test(code(s));

/** A `trivy` run line whose exit status is discarded: `|| true`, `; true`, a pipe without pipefail, `set +e`. */
function trivySwallowed(s: Step): boolean {
  if (uses(s)) return false;
  const text = code(s);
  if (/\bset\s+\+e\b/.test(text)) return true;
  const piped = !/pipefail/.test(text) && s.shell !== 'bash';
  for (const line of text.split('\n')) {
    const at = line.search(/\btrivy\s+image\b/);
    if (at === -1) continue;
    const rest = line.slice(at);
    if (/\|\|/.test(rest) || /;\s*(?:true|:|exit\s+0)\b/.test(rest)) return true;
    if (piped && /[^|]\|[^|]/.test(rest)) return true;
  }
  return false;
}

const PUSH_RUN = new RegExp(
  [
    String.raw`\b(?:docker|podman)\s+(?:image\s+)?push\b`,
    String.raw`\bcrane\s+(?:push|copy|cp|append|mutate|tag|index)\b`,
    String.raw`\bbuildah\s+(?:push|manifest\s+push)\b`,
    String.raw`\bko\s+(?:publish|build|apply|resolve)\b`,
    String.raw`\bregctl\s+(?:image|manifest|index|artifact)\s+(?:copy|import|put|create|push)\b`,
    String.raw`\bgcloud\s+builds\s+submit\b[^\n]*--tag\b`,
    String.raw`\bdocker\s+(?:buildx\s+)?(?:build|bake)\b[^\n]*(?:--push\b|--output[ =][^\n]*type=registry|--set[ =]\S*output=type=registry)`,
    String.raw`--output[ =]\S*type=registry`,
    String.raw`\bimagetools\s+create\b`,
    String.raw`\bskopeo\s+copy\b`,
    String.raw`\boras\s+push\b`,
    String.raw`\bdocker\s+compose\s+push\b`,
  ].join('|'),
);
const PUSH_ACTION =
  /(?:^|\/)(?:push-to-registry|ko-action|kaniko|buildah-build)\b|\/(?:push|publish)[\w-]*@/;

const LOCAL_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/;

/** Value a shell variable is assigned in `text`, or null. */
function assignedValue(text: string, name: string): string | null {
  const m = new RegExp(`(?:^|[\\s;])${escapeRe(name)}=("?)([^\\s"]+)\\1`, 'm').exec(text);
  return m ? m[2] : null;
}

/**
 * Destination of a `crane push|copy` / `docker push` command when it is
 * provably the LOCAL registry (a literal localhost/127.x/0.0.0.0 host, or a
 * variable the same run assigns one). Anything unreadable is NOT local.
 */
function localDestination(dest: string, text: string): boolean {
  let d = dest.replace(/^["']|["']$/g, '');
  const v = /^\$\{?([A-Za-z_]\w*)\}?/.exec(d);
  if (v) {
    const val = assignedValue(text, v[1]);
    if (val === null) return false;
    d = val;
  }
  return LOCAL_HOST.test(d);
}

/** One recognised image push: where it goes, and what layout it publishes. */
export interface PushRef {
  layout?: string;
  name?: string;
  kind: string;
}

/** Push commands in a run step, with destinations when they can be read. */
function runPushes(s: Step): PushRef[] {
  const text = code(s);
  const out: PushRef[] = [];
  for (const line of text.split('\n')) {
    // Prose is not a command: skip lines that merely print.
    if (/^\s*(?:echo|printf|logger)\b/.test(line)) continue;
    if (!PUSH_RUN.test(line)) continue;
    const crane = /\bcrane\s+(push|copy|cp)\s+((?:-\S+\s+)*)(\S+)(?:\s+(\S+))?/.exec(line);
    if (crane) {
      const [, verb, , a, b] = crane;
      out.push(
        verb === 'push' ? { kind: 'crane', layout: a, name: b } : { kind: 'crane', name: b },
      );
      continue;
    }
    const dock = /\b(?:docker|podman)\s+(?:image\s+)?push\s+((?:-\S+\s+)*)(\S+)/.exec(line);
    if (dock) {
      out.push({ kind: 'docker', name: dock[2] });
      continue;
    }
    out.push({ kind: 'other' });
  }
  return out;
}

/** Image names a `docker/build-push-action` step tags (one per line or comma). */
function actionTags(s: Step): string[] {
  const t = withOf(s).tags;
  return typeof t === 'string'
    ? t
        .split(/[\n,]/)
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
}

/** Every image push in a step (run text, or a push-capable action). */
export function pushRefs(s: Step): PushRef[] {
  const u = uses(s);
  if (/^docker\/build-push-action@/.test(u) || /^docker\/bake-action@/.test(u)) {
    const w = withOf(s);
    const out = `${String(w.outputs ?? '')} ${String(w.set ?? '')}`;
    const p = w.push;
    const pushes =
      /type=registry|push=true/.test(out) ||
      (p !== undefined && p !== false && String(p).trim().toLowerCase() !== 'false');
    if (!pushes) return [];
    const tags = actionTags(s);
    return tags.length ? tags.map((name) => ({ kind: 'action', name })) : [{ kind: 'action' }];
  }
  if (u && !u.startsWith('./') && PUSH_ACTION.test(u)) return [{ kind: 'action' }];
  const text = code(s);
  const refs = runPushes(s);
  // A push whose destination is provably the local registry publishes nothing.
  return refs.filter((r) => !(r.name !== undefined && localDestination(r.name, text)));
}

/** Does this step publish an image to a (non-local) registry? */
export function pushesImage(s: Step): boolean {
  return pushRefs(s).length > 0;
}

/** Severities Trivy reports. Absent = Trivy's own default, which is all of them. */
function trivySeverity(s: Step): string[] | null {
  const raw = uses(s) ? withOf(s).severity : /--severity[ =](\S+)/.exec(code(s))?.[1];
  if (raw === undefined || raw === null) return null;
  return String(raw)
    .toUpperCase()
    .split(/[\s,]+/)
    .filter(Boolean);
}

// ───────────────────────── expression evaluator ─────────────────────────

/**
 * A deliberately small GitHub-expression evaluator, three-valued: true, false,
 * or UNKNOWN. It exists so a ref-gated `continue-on-error` or `if` can be
 * judged on the refs a lane publishes from. Anything it does not understand is
 * UNKNOWN, and every caller treats UNKNOWN as "cannot prove it is safe".
 */
export const UNKNOWN = Symbol('unknown');
type Val = string | boolean | typeof UNKNOWN;
export interface Ctx {
  ref: string;
  event: string;
  /** extra dotted lookups, e.g. `steps.channel.outputs.publish` */
  vars: Record<string, string>;
}

function tokenize(src: string): string[] | null {
  const toks: string[] = [];
  const re = /\s*(?:('(?:[^']|'')*')|(&&|\|\||==|!=|[()!,])|([A-Za-z_][\w.-]*\(?|\d+))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) return null;
    toks.push(m[1] ?? m[2] ?? m[3]);
    i = re.lastIndex;
  }
  return toks;
}

const truthy = (v: Val): boolean | typeof UNKNOWN =>
  v === UNKNOWN ? UNKNOWN : typeof v === 'boolean' ? v : v !== '';

export function evalExpr(input: unknown, ctx: Ctx): boolean | typeof UNKNOWN {
  if (typeof input === 'boolean') return input;
  if (typeof input !== 'string') return UNKNOWN;
  let src = input.trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(src);
  if (wrapped) src = wrapped[1].trim();
  const toks = tokenize(src);
  if (!toks) return UNKNOWN;
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];

  const lookup = (path: string): Val => {
    if (path === 'github.ref') return ctx.ref;
    if (path === 'github.ref_name') return ctx.ref.replace(/^refs\/(heads|tags)\//, '');
    if (path === 'github.ref_type') return ctx.ref.startsWith('refs/tags/') ? 'tag' : 'branch';
    if (path === 'github.event_name') return ctx.event;
    if (path === 'github.repository') return 'getknext-dev/knext';
    if (path in ctx.vars) return ctx.vars[path];
    return UNKNOWN;
  };
  const eq = (a: Val, b: Val): Val =>
    a === UNKNOWN || b === UNKNOWN ? UNKNOWN : String(a).toLowerCase() === String(b).toLowerCase();
  const or = (a: Val, b: Val): Val => {
    const x = truthy(a);
    const y = truthy(b);
    if (x === true || y === true) return true;
    if (x === UNKNOWN || y === UNKNOWN) return UNKNOWN;
    return false;
  };
  const and = (a: Val, b: Val): Val => {
    const x = truthy(a);
    const y = truthy(b);
    if (x === false || y === false) return false;
    if (x === UNKNOWN || y === UNKNOWN) return UNKNOWN;
    return true;
  };

  function primary(): Val {
    const t = next();
    if (t === undefined) throw new Error('eof');
    if (t === '(') {
      const v = orExpr();
      if (next() !== ')') throw new Error('paren');
      return v;
    }
    if (t === '!') {
      const v = truthy(primary());
      return v === UNKNOWN ? UNKNOWN : !v;
    }
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t.endsWith('(')) {
      const name = t.slice(0, -1);
      const args: Val[] = [];
      if (peek() !== ')') {
        args.push(orExpr());
        while (peek() === ',') {
          next();
          args.push(orExpr());
        }
      }
      if (next() !== ')') throw new Error('call');
      const [a, b] = args;
      switch (name) {
        case 'always':
        case 'success':
          return true;
        case 'failure':
        case 'cancelled':
          return false;
        case 'startsWith':
          return a === UNKNOWN || b === UNKNOWN
            ? UNKNOWN
            : String(a).toLowerCase().startsWith(String(b).toLowerCase());
        case 'endsWith':
          return a === UNKNOWN || b === UNKNOWN
            ? UNKNOWN
            : String(a).toLowerCase().endsWith(String(b).toLowerCase());
        case 'contains':
          return a === UNKNOWN || b === UNKNOWN
            ? UNKNOWN
            : String(a).toLowerCase().includes(String(b).toLowerCase());
        default:
          return UNKNOWN;
      }
    }
    if (/^[A-Za-z_]/.test(t)) return lookup(t);
    return UNKNOWN;
  }
  function cmp(): Val {
    let v = primary();
    while (peek() === '==' || peek() === '!=') {
      const op = next();
      const r = eq(v, primary());
      v = op === '==' ? r : r === UNKNOWN ? UNKNOWN : !r;
    }
    return v;
  }
  function andExpr(): Val {
    let v = cmp();
    while (peek() === '&&') {
      next();
      v = and(v, cmp());
    }
    return v;
  }
  function orExpr(): Val {
    let v = andExpr();
    while (peek() === '||') {
      next();
      v = or(v, andExpr());
    }
    return v;
  }
  try {
    const v = orExpr();
    if (p !== toks.length) return UNKNOWN;
    return truthy(v);
  } catch {
    return UNKNOWN;
  }
}

// ───────────────────────── publishing contexts ─────────────────────────

const channelCache = new Map<string, Record<string, string>>();

/**
 * Output of hack/release-channel.sh for a ref, as `steps.channel.outputs.*`
 * lookups.
 */
export function channelVars(ref: string): Record<string, string> {
  const hit = channelCache.get(ref);
  if (hit) return hit;
  const script = resolve(REPO_ROOT, 'packages/kn-next-operator/hack/release-channel.sh');
  const vars: Record<string, string> = {};
  if (existsSync(script)) {
    const r = spawnSync('bash', [script, ref, ref.replace(/^refs\/(heads|tags)\//, '')], {
      encoding: 'utf8',
    });
    if (r.status === 0) {
      for (const line of r.stdout.split('\n')) {
        const m = /^([a-z_]+)=(.*)$/.exec(line);
        if (m) vars[`steps.channel.outputs.${m[1]}`] = m[2];
      }
    }
  }
  channelCache.set(ref, vars);
  return vars;
}

function onOf(wf: Workflow): Record<string, unknown> | null {
  const on = wf.doc.on ?? (wf.doc as Record<string, unknown>).true;
  if (typeof on === 'string') return { [on]: {} };
  if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [String(e), {}]));
  return on && typeof on === 'object' ? (on as Record<string, unknown>) : null;
}

const TAG_SAMPLE = 'refs/tags/v1.0.0';

/**
 * Every (event, ref) a workflow can run on, sampled:
 *  - `push`: each named branch/tag pattern; an UNFILTERED push also fires for any
 *    branch and any tag, so a feature branch and a `v*` tag are sampled too;
 *  - `workflow_dispatch` / `workflow_call` from main, a tag and a release branch;
 *  - `schedule` (default branch), `release` (a tag), `workflow_run` (default
 *    branch), `pull_request`, `merge_group`.
 * An expression whose verdict depends on a context NOT sampled here is UNKNOWN
 * to the evaluator, and an unprovable gate reds.
 */
export function candidateContexts(
  wf: Workflow,
  varsFor: (ref: string) => Record<string, string> = channelVars,
): Ctx[] {
  const on = onOf(wf) ?? {};
  const out: Ctx[] = [];
  const seen = new Set<string>();
  const add = (event: string, ref: string) => {
    if (seen.has(`${event} ${ref}`)) return;
    seen.add(`${event} ${ref}`);
    out.push({ event, ref, vars: varsFor(ref) });
  };
  const push = on.push as Record<string, unknown> | null | undefined;
  add('push', 'refs/heads/main');
  const filters = push && typeof push === 'object' ? push : {};
  const branches = (filters.branches as string[] | undefined) ?? [];
  const tags = (filters.tags as string[] | undefined) ?? [];
  for (const b of branches) add('push', `refs/heads/${String(b).replace(/\*+/g, 'x')}`);
  for (const t of tags) add('push', `refs/tags/${String(t).replace(/\*+/g, '1.0.0')}`);
  const unfiltered = !('branches' in filters) && !('tags' in filters);
  if (unfiltered || 'tags-ignore' in filters) add('push', TAG_SAMPLE);
  if (unfiltered || 'branches-ignore' in filters) add('push', 'refs/heads/feature-x');
  for (const ev of ['workflow_dispatch', 'workflow_call']) {
    if (ev in on) {
      add(ev, 'refs/heads/main');
      add(ev, TAG_SAMPLE);
      add(ev, 'refs/heads/release/1.x');
    }
  }
  if ('schedule' in on) add('schedule', 'refs/heads/main');
  if ('release' in on) add('release', TAG_SAMPLE);
  if ('workflow_run' in on) add('workflow_run', 'refs/heads/main');
  if ('pull_request' in on || 'pull_request_target' in on) add('pull_request', 'refs/pull/1/merge');
  if ('merge_group' in on) add('merge_group', 'refs/heads/gh-readonly-queue/main/pr-1-abc');
  return out;
}

// ───────────────────────── publish lanes ─────────────────────────

interface Located {
  id: string;
  job: Job;
  step: Step;
}

/** Reads a repo-relative script, or null when it cannot be read. */
export type ScriptReader = (path: string) => string | null;

export const fsScriptReader: ScriptReader = (path) => {
  const p = resolve(REPO_ROOT, path);
  if (!p.startsWith(REPO_ROOT) || !existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

const SCRIPT_INTERP =
  /(?:^|[;&|(]\s*|\s)(?:bash|sh|zsh|node|bun|tsx|python3?|source|\.)\s+(?:-\S+\s+)*(["']?)([^\s"';&|)]+\.(?:sh|mjs|cjs|js|ts|py))\1/g;
const SCRIPT_DIRECT = /(?:^|[;&|(]\s*)(\.\/[^\s"';&|)]+)/g;

/** Repo-local scripts a run step invokes. `bad` lists ones whose path cannot be resolved. */
function scriptsInvoked(
  step: Step,
  /** checkout `path:` dirs, mapped to whether they hold ANOTHER repository */
  checkouts: Map<string, boolean>,
  jobCwd: string,
): { paths: string[][]; bad: string[] } {
  const text = code(step);
  const paths: string[][] = [];
  const bad: string[] = [];
  const cwd = typeof step['working-directory'] === 'string' ? step['working-directory'] : jobCwd;
  const consider = (raw: string) => {
    const p = raw
      .replace(/\$\{?GITHUB_WORKSPACE\}?\//g, '')
      .replace(/\$\{\{\s*github\.workspace\s*\}\}\//g, '');
    if (p.startsWith('/') || p.startsWith('~') || p.includes('node_modules/')) return;
    if (/\$|\{\{/.test(p)) {
      bad.push(raw);
      return;
    }
    // Written by this very step (generated at run time): nothing in the repo to read.
    if (new RegExp(`(?:>|tee\\s+(?:-a\\s+)?)\\s*"?${escapeRe(p)}`).test(text)) return;
    const first = p.replace(/^\.\//, '').split('/')[0];
    // A script inside another repository's checkout is not this repo's to read.
    if (checkouts.get(first) === true) return;
    const cands = [resolve('/', cwd, p).slice(1), resolve('/', p).slice(1)];
    // `cd some/dir` earlier in the same run changes where a relative script resolves.
    for (const cd of text.matchAll(/(?:^|[;&|]\s*)cd\s+"?([^\s"';&|]+)/gm))
      if (!/\$|\{\{/.test(cd[1])) cands.push(resolve('/', cd[1], p).slice(1));
    // `knext/scripts/x` under a checkout with `path: knext` is `scripts/x` in this repo.
    if (checkouts.get(first) === false)
      cands.push(p.replace(/^\.\//, '').split('/').slice(1).join('/'));
    paths.push([...new Set(cands)]);
  };
  for (const re of [SCRIPT_INTERP, SCRIPT_DIRECT]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) consider(re === SCRIPT_INTERP ? m[2] : m[1]);
  }
  return { paths, bad };
}

/**
 * Secret names that look like a registry / signing credential. Matching ANY
 * secret would over-fire (a deploy-preview kubeconfig cannot push an image), so
 * only names carrying a registry token count: registry, docker, ghcr, ocir, ecr,
 * gcr, acr, quay, harbor, cosign, sigstore, push, or the GitHub-packages `CR_PAT`.
 * `GITHUB_TOKEN` never does. Every secret the repo's workflows reference today
 * (NPM_TOKEN, CODECOV_TOKEN, *_KUBECONFIG*, OCIR_*) classifies correctly under
 * this pattern. Known limit: a registry secret with a name that carries none of
 * these tokens (e.g. `DEPLOY_KEY`) is NOT detected by name; the guards that
 * catch it are the permission and login-step rules, and `secrets: inherit` /
 * `toJSON(secrets)` / dynamic `secrets[...]` are treated as credentialed.
 */
const REGISTRY_SECRET_NAME =
  /(?:^|_)(?:REGISTRY|DOCKER(?:HUB)?|GHCR|OCIR|ECR|GCR|ACR|QUAY|HARBOR|COSIGN|SIGSTORE|PUSH)(?:_|$)|(?:^|_)CR_PAT(?:_|$)/i;

/** Names a string reads through `secrets.NAME` or `secrets['NAME']`; `*` = the whole/dynamic secrets object. */
function secretNamesIn(s: string): string[] {
  const names = [...s.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  for (const m of s.matchAll(/\bsecrets\s*\[\s*(?:'([^']*)'|"([^"]*)")\s*\]/g))
    names.push(m[1] ?? m[2]);
  // toJSON(secrets), a bare `secrets` argument or `secrets[<expression>]`: every secret is reachable.
  if (/\btoJSON\(\s*secrets\s*\)|\bsecrets\s*\[\s*[^\s'"]/.test(s)) names.push('*');
  return names;
}

/** A registry-looking secret (not `GITHUB_TOKEN`) referenced anywhere in a value tree. */
function referencesSecret(v: unknown): boolean {
  if (typeof v === 'string')
    return secretNamesIn(v).some(
      (n) => n === '*' || (n !== 'GITHUB_TOKEN' && REGISTRY_SECRET_NAME.test(n)),
    );
  if (Array.isArray(v)) return v.some(referencesSecret);
  if (v && typeof v === 'object') return Object.values(v).some(referencesSecret);
  return false;
}

/**
 * Could this job push to a registry at all? It needs a credential. Judged on
 * what the job can actually reach, not only its own raw keys:
 *  - `packages`/`id-token` write, or a login / cosign in a step, INCLUDING steps
 *    inside local composite actions (followed to depth 5);
 *  - no `permissions` block at job or workflow level: the job inherits the repo
 *    default `GITHUB_TOKEN`, whose scope is a repo setting this file cannot see,
 *    so it is assumed read/write (fail closed);
 *  - a registry-named secret (`REGISTRY_SECRET_NAME`; any other secret, e.g. a
 *    kubeconfig, does not count) read in job env or step env/with/run, in either
 *    `secrets.NAME` or `secrets['NAME']` form, or the whole object via
 *    `toJSON(secrets)` / a dynamic index;
 *  - ANY non-`GITHUB_TOKEN` secret in `container.credentials` or
 *    `services.*.credentials` (a registry login by definition);
 *  - any declared `on.workflow_call.secrets`, or being the callee of a caller job
 *    passing `secrets: inherit` / a registry-named secret (`inheritedSecrets`).
 */
function credentialed(
  job: Job,
  wfDoc: Record<string, unknown> | undefined,
  resolveAction: ActionResolver,
  inheritedSecrets = false,
): boolean {
  if (inheritedSecrets) return true;
  const perms = [job.permissions, wfDoc?.permissions];
  if (perms.every((pm) => pm === undefined)) return true;
  const cred = (c: unknown): boolean =>
    !!c &&
    typeof c === 'object' &&
    Object.values((c as Record<string, unknown>).credentials ?? {}).some(
      (x) => typeof x === 'string' && secretNamesIn(x).some((n) => n !== 'GITHUB_TOKEN'),
    );
  if (cred(job.container)) return true;
  if (
    job.services &&
    typeof job.services === 'object' &&
    Object.values(job.services as Record<string, unknown>).some(cred)
  )
    return true;
  for (const pm of perms) {
    if (pm === 'write-all') return true;
    if (pm && typeof pm === 'object') {
      const o = pm as Record<string, unknown>;
      if (o.packages === 'write' || o['id-token'] === 'write') return true;
    }
  }
  const on = onOf({ file: '', doc: wfDoc ?? {} });
  const call = on?.workflow_call;
  if (call && typeof call === 'object') {
    const declared = (call as Record<string, unknown>).secrets;
    if (declared && typeof declared === 'object' && Object.keys(declared).length > 0) return true;
  }
  if (referencesSecret(job.env)) return true;
  // #2756: google-github-actions/auth only mints a cloud credential, so it counts as a registry
  // login ONLY when the same job also uses a registry: `docker push`, a *.pkg.dev / gcr.io
  // image, or `gcloud auth configure-docker`. Alone it is not credentialed.
  // Known gap: only the job's own steps are read, so a registry use inside a local composite
  // action or a repo script does not make the auth step count.
  const jobSteps = Array.isArray(job.steps) ? (job.steps as Step[]) : [];
  const usesGcpRegistry = jobSteps.some((x) =>
    /\bdocker\s+push\b|\b[\w.-]*pkg\.dev\b|\bgcr\.io\b|\bgcloud\s+auth\s+configure-docker\b/.test(
      `${code(x)}\n${JSON.stringify(x.with ?? {})}`,
    ),
  );
  const credStep = (st: Step, depth: number): boolean => {
    if (/^google-github-actions\/auth@/.test(uses(st)) && usesGcpRegistry) return true;
    if (
      /^docker\/login-action@/.test(uses(st)) ||
      /^aws-actions\/amazon-ecr-login@/.test(uses(st)) ||
      /^azure\/docker-login@/.test(uses(st)) ||
      /\baz\s+acr\s+login\b/.test(code(st)) ||
      /\bhelm\s+registry\s+login\b/.test(code(st)) ||
      /\bgcloud\s+auth\s+configure-docker\b/.test(code(st)) ||
      /\baws\s+ecr(?:-public)?\s+get-login-password\b/.test(code(st)) ||
      /\b(?:buildah|nerdctl)\s+login\b/.test(code(st)) ||
      /\b(?:docker|podman|crane|regctl|skopeo|oras)\s+(?:auth\s+)?login\b|\bcosign\b/.test(
        code(st),
      ) ||
      referencesSecret(st.env) ||
      referencesSecret(st.with) ||
      referencesSecret(st.run)
    )
      return true;
    const u = uses(st);
    if (u.startsWith('./') && !u.includes('/.github/workflows/') && depth < 5) {
      const inner = resolveAction(u);
      return inner !== null && inner.some((i) => credStep(i, depth + 1));
    }
    return false;
  };
  const steps = Array.isArray(job.steps) ? (job.steps as Step[]) : [];
  return steps.some((st) => credStep(st, 0));
}

/**
 * Steps of a job with local composite actions AND repo-local scripts expanded
 * (a script's text becomes a synthetic step inheriting the invoker's `if` and
 * `continue-on-error`). An unresolvable local action is always reported in
 * `problems`; an unreadable script or a script path built from a variable is
 * reported only for a CREDENTIALED job (one that could push at all) — a job with
 * no registry credential cannot publish, whatever its scripts do.
 */
function expandedSteps(
  file: string,
  id: string,
  job: Job,
  opts: LaneAuditOptions,
  problems: Finding[],
  wfDoc?: Record<string, unknown>,
  inheritedSecrets = false,
): Step[] {
  const resolveAction = opts.resolveAction ?? fsActionResolver;
  const scriptProblems = credentialed(job, wfDoc, resolveAction, inheritedSecrets) ? problems : [];
  const checkouts = new Map<string, boolean>();
  for (const st of stepsOf(file, id, job)) {
    if (/^actions\/checkout@/.test(uses(st)) && typeof withOf(st).path === 'string') {
      const repo = withOf(st).repository;
      checkouts.set(
        String(withOf(st).path).replace(/\/$/, ''),
        typeof repo === 'string' && !/getknext-dev\/knext|github\.repository/.test(repo),
      );
    }
  }
  const defaults = job.defaults as { run?: { 'working-directory'?: string } } | undefined;
  const jobCwd = defaults?.run?.['working-directory'] ?? '';
  const readScript = opts.readScript ?? fsScriptReader;
  const out: Step[] = [];
  const subject = `${file}#${id}`;
  const walk = (steps: Step[], depth: number, seen: Set<string>) => {
    for (const s of steps) {
      out.push(s);
      const u = uses(s);
      if (u.startsWith('./') && !u.includes('/.github/workflows/')) {
        const inner = resolveAction(u);
        if (inner === null)
          problems.push({
            subject,
            check: 'unresolved',
            detail: `local action \`${u}\` cannot be resolved, so its steps cannot be scanned`,
          });
        else if (depth < 5) walk(inner, depth + 1, seen);
      }
      if (typeof s.run === 'string' && depth < 5) {
        // `gcloud builds submit --config F`: Cloud Build pushes whatever F lists under `images:`
        // (or pushes in a step). Read F; an unreadable config is assumed to push (fail closed).
        for (const cfg of code(s).matchAll(
          /\bgcloud\s+builds\s+submit\b[^\n]*--config[ =]"?([^\s"]+)/g,
        )) {
          const rel = cfg[1].replace(/^\.\//, '');
          const body = /\$|\{\{/.test(rel) ? null : readScript(rel);
          const pushes =
            body === null ||
            /^images:/m.test(body) ||
            PUSH_RUN.test(body.replace(/^\s*#.*$/gm, ''));
          if (pushes)
            out.push({ run: 'gcloud builds submit --tag cloudbuild:config', 'x-script': rel });
        }
        const { paths, bad } = scriptsInvoked(s, checkouts, jobCwd);
        for (const b of bad)
          scriptProblems.push({
            subject,
            check: 'unresolved-script',
            detail: `script \`${b}\` has a path built from a variable, so it cannot be scanned for pushes`,
          });
        for (const cands of paths) {
          if (cands.some((c) => seen.has(c))) continue;
          const path = cands.find((c) => readScript(c) !== null) ?? cands[0];
          const body = readScript(path);
          if (body === null) {
            scriptProblems.push({
              subject,
              check: 'unresolved-script',
              detail: `repo-local script \`${cands[0]}\` cannot be read, so it cannot be scanned for pushes`,
            });
            continue;
          }
          const js = /\.(?:mjs|cjs|js|ts)$/.test(path);
          const text = (js ? body.replace(/\/\*[\s\S]*?\*\//g, '') : body)
            .split('\n')
            .filter((l) => !/^\s*(#|\/\/)/.test(l))
            .join('\n');
          const syn: Step = { run: text, 'x-script': path };
          if (s.if !== undefined) syn.if = s.if;
          if (s['continue-on-error'] !== undefined)
            syn['continue-on-error'] = s['continue-on-error'];
          walk([syn], depth + 1, new Set([...seen, path]));
        }
      }
    }
  };
  walk(stepsOf(file, id, job), 0, new Set());
  return out;
}

export interface LaneAuditOptions {
  resolveAction?: ActionResolver;
  readScript?: ScriptReader;
  varsFor?: (ref: string) => Record<string, string>;
}

export function discoverImageLanes(
  wfs: Workflow[],
  opts: LaneAuditOptions = {},
): { lanes: Array<{ wf: Workflow; id: string }>; findings: Finding[] } {
  const findings: Finding[] = [];
  const lanes: Array<{ wf: Workflow; id: string }> = [];
  // Callee workflow files a caller hands registry secrets to (`secrets: inherit`, or a
  // map naming a registry secret): the callee need not declare them to receive them.
  const inheritedCallees = new Set<string>();
  for (const wf of wfs)
    for (const job of Object.values(jobsOf(wf))) {
      const local = /^\.\/\.github\/workflows\/([^@]+\.ya?ml)$/.exec(
        typeof job.uses === 'string' ? job.uses : '',
      );
      if (!local) continue;
      const s = job.secrets;
      const passes =
        s === 'inherit' ||
        (!!s &&
          typeof s === 'object' &&
          Object.entries(s as Record<string, unknown>).some(
            ([k, val]) => REGISTRY_SECRET_NAME.test(k) || referencesSecret(val),
          ));
      if (passes) inheritedCallees.add(local[1]);
    }
  for (const wf of wfs) {
    for (const [id, job] of Object.entries(jobsOf(wf))) {
      const ju = typeof job.uses === 'string' ? job.uses : '';
      if (ju) {
        const local = /^\.\/\.github\/workflows\/([^@]+\.ya?ml)$/.exec(ju);
        if (!local || !wfs.some((w) => w.file === local[1]))
          findings.push({
            subject: `${wf.file}#${id}`,
            check: 'unresolved',
            detail: `reusable workflow \`${ju}\` cannot be resolved to a local workflow, so what it publishes cannot be scanned`,
          });
        continue; // a resolvable callee is scanned as a workflow in its own right
      }
      const steps = expandedSteps(
        wf.file,
        id,
        job,
        opts,
        findings,
        wf.doc,
        inheritedCallees.has(wf.file),
      );
      if (steps.some(pushesImage)) lanes.push({ wf, id });
    }
  }
  return { lanes, findings };
}

/** Why a gate step would not actually gate on the given publishing contexts (empty = it does). */
function gateProblems(
  kind: 'trivy' | 'sbom' | 'cosign',
  step: Step,
  job: Job,
  ctxs: Ctx[],
  /** The job's own `if` cannot disable the gate relative to the push (see `irrelevantJobIf`). */
  jobIfIrrelevant = false,
): string[] {
  const out: string[] = [];
  for (const [label, coe] of [
    ['step', step['continue-on-error']],
    ['job', job['continue-on-error']],
  ] as const) {
    if (coe === undefined) continue;
    for (const ctx of ctxs) {
      const v = evalExpr(coe, ctx);
      if (v !== false) {
        out.push(
          `${label}-level continue-on-error is ${v === true ? 'true' : 'unprovable'} on ${ctx.event} ${ctx.ref}`,
        );
        break;
      }
    }
  }
  if (step.if !== undefined) {
    for (const ctx of ctxs) {
      if (evalExpr(step.if, ctx) !== true) {
        out.push(`step \`if\` is not provably true on ${ctx.event} ${ctx.ref}`);
        break;
      }
    }
  }
  if (job.if !== undefined && !jobIfIrrelevant) {
    for (const ctx of ctxs) {
      if (evalExpr(job.if, ctx) !== true) {
        out.push(`job \`if\` is not provably true on ${ctx.event} ${ctx.ref}`);
        break;
      }
    }
  }
  if (kind === 'trivy') {
    const sev = trivySeverity(step);
    if (sev && !(sev.includes('HIGH') && sev.includes('CRITICAL')))
      out.push(`severity ${sev.join(',')} does not cover both HIGH and CRITICAL`);
    const enforced = uses(step)
      ? String(withOf(step)['exit-code']) === '1'
      : /--exit-code[ =]1\b/.test(code(step));
    if (!enforced) out.push('Trivy does not enforce exit-code 1');
    if (trivySwallowed(step))
      out.push('the Trivy exit status is discarded (`|| true`, `; true`, pipe, `set +e`)');
  }
  return out;
}

/** Normalise an image reference for comparison: no quotes, `$VAR` form, no digest, no tag. */
export function normName(raw: string): string {
  let n = raw.trim().replace(/^["']|["']$/g, '');
  n = n.replace(/\$\{\{\s*env\.(\w+)\s*\}\}/g, '$$$1').replace(/\$\{(\w+)\}/g, '$$$1');
  n = n.replace(/@.*$/, '');
  n = n.replace(/:[^/]*$/, '');
  return n;
}
const literalName = (n: string) => n !== '' && !/\$|\{\{/.test(n);

/** Image names a Trivy step scans (not layout paths), when readable. */
function scannedNames(step: Step): string[] {
  if (uses(step)) {
    const r = withOf(step)['image-ref'];
    return typeof r === 'string' ? [normName(r)] : [];
  }
  const m = /\btrivy\s+image\b.*\s(\S+)\s*$/m.exec(code(step));
  return m && !m[1].startsWith('-') ? [normName(m[1])] : [];
}

/** Layouts a Trivy step scans (`input:`), when readable. */
function scannedLayouts(step: Step): string[] {
  if (uses(step)) {
    const r = withOf(step).input;
    return typeof r === 'string' ? [r] : [];
  }
  const m = /\btrivy\s+image\b.*--input[ =](\S+)/m.exec(code(step));
  return m ? [m[1]] : [];
}

/**
 * Audit every discovered publish lane. A lane is a job with a push step.
 * Needs, in the lane's own workflow: an enforcing Trivy IMAGE gate in or
 * upstream of the push job; an SBOM step in, upstream or downstream of it; a
 * cosign step in or downstream of it and (in the same job) after the push. Gate
 * steps must be unable to be disabled on the lane's publishing contexts.
 * Local-registry pushes (`crane copy ... localhost:5001/...`) publish nothing and
 * are not lanes; a non-local push added beside one makes the job a lane.
 */
export function auditImageLanes(wfs: Workflow[], opts: LaneAuditOptions = {}): Finding[] {
  const { lanes, findings } = discoverImageLanes(wfs, opts);
  const out: Finding[] = [...findings];
  for (const { wf, id } of lanes) {
    const subject = `${wf.file}#${id}`;
    const f = (check: string, detail: string) => out.push({ subject, check, detail });
    const jobs = jobsOf(wf);
    const ctxsAll = candidateContexts(wf, opts.varsFor);
    const ownSteps = expandedSteps(wf.file, id, jobs[id], opts, []);
    const pushSteps = ownSteps.filter(pushesImage);
    // Contexts on which a push can run (UNKNOWN counts as can-run).
    const ctxs = ctxsAll.filter(
      (c) =>
        evalExpr(jobs[id].if ?? true, c) !== false &&
        pushSteps.some((p) => evalExpr(p.if ?? true, c) !== false),
    );
    if (!ctxs.length) {
      f('never-runs', 'the push step is disabled on every ref this workflow can publish from');
      continue;
    }
    const upstreamIds = reach(jobs, id, 'upstream');
    const pushIfSurvivesFailure = /\b(always|failure|cancelled)\s*\(/.test(
      String(jobs[id].if ?? ''),
    );
    // A gate job's own `if` is irrelevant when it is the push job, or an upstream job whose
    // skip also skips the push (a skipped `needs` skips its dependents unless the dependent
    // opts in with always()/failure()).
    const irrelevantJobIf = (jid: string) =>
      jid === id || (upstreamIds.has(jid) && !pushIfSurvivesFailure);
    const collect = (ids: Set<string>) =>
      [...ids].flatMap((jid) =>
        expandedSteps(wf.file, jid, jobs[jid], opts, []).map(
          (step): Located => ({ id: jid, job: jobs[jid], step }),
        ),
      );
    const up = collect(upstreamIds);
    const down = collect(reach(jobs, id, 'downstream'));
    const problemsOf = (kind: 'trivy' | 'sbom' | 'cosign', x: Located) =>
      gateProblems(kind, x.step, x.job, ctxs, irrelevantJobIf(x.id));
    const gate = (
      kind: 'trivy' | 'sbom' | 'cosign',
      pool: Located[],
      match: (s: Step) => boolean,
    ): Located[] => {
      const cands = pool.filter((x) => match(x.step));
      if (!cands.length) {
        f(
          kind,
          kind === 'cosign'
            ? 'no `cosign sign`/`cosign attest` in or after the push job'
            : kind === 'trivy'
              ? 'no Trivy IMAGE scan (`trivy image`, or trivy-action with scan-type image) in or before the push job'
              : 'no SBOM step in or around the push job',
        );
        return [];
      }
      const valid = cands.filter((x) => problemsOf(kind, x).length === 0);
      if (!valid.length) {
        const x = cands[0];
        f(kind, `\`${x.id}\`: ${problemsOf(kind, x).join('; ')}`);
      }
      return valid;
    };
    const trivy = gate('trivy', up, isTrivy);
    gate('sbom', [...up, ...down], isSbom);
    const sign = gate('cosign', [...collect(new Set([id])), ...down], isCosign);

    // Ordering inside the push job: a cosign step in the same job runs after the push.
    const pushAt = ownSteps.findIndex(pushesImage);
    const signAt = ownSteps.findIndex(isCosign);
    if (signAt !== -1 && signAt < pushAt) f('cosign-order', 'cosign runs before the push step');

    // ── ties: scan <-> pushed image, signature <-> pushed image ──
    const pushed = pushSteps.flatMap(pushRefs);
    const runsUp = up.map((x) => code(x.step)).join('\n');
    for (const p of pushed) {
      if (trivy.length === 0) break;
      if (p.layout) {
        // crane push LAYOUT: the layout pushed must be the one Trivy scans, or be derived from it.
        const layout = p.layout;
        const scanned = trivy.flatMap((x) => scannedLayouts(x.step));
        const derived = scanned.some(
          (sc) =>
            sc && new RegExp(`${escapeRe(sc)}\\b[^\\n]*\\b${escapeRe(layout)}\\b`).test(runsUp),
        );
        if (scanned.length > 0 && !scanned.includes(layout) && !derived)
          f(
            'tie-trivy',
            `pushes layout \`${layout}\` but Trivy scans ${scanned.map((x) => `\`${x}\``).join(', ')} and no step derives \`${layout}\` from it`,
          );
      } else if (p.name) {
        // docker push / build-push-action: compare image NAMES when both are literal.
        const names = trivy.flatMap((x) => scannedNames(x.step));
        const n = normName(p.name);
        if (literalName(n) && names.length > 0 && names.every(literalName) && !names.includes(n))
          f(
            'tie-trivy',
            `pushes \`${n}\` but Trivy scans ${names.map((x) => `\`${x}\``).join(', ')}`,
          );
      }
    }
    const pushedNames = pushed.filter((p) => p.name).map((p) => normName(p.name as string));
    const signedNames: string[] = [];
    for (const x of sign) {
      for (const l of code(x.step)
        .split('\n')
        .filter((l) => /\bcosign\s+(?:sign|attest)(?![\w-])/.test(l))) {
        if (!/@\S*(?:digest|DIGEST|sha256)/i.test(l))
          f('tie-cosign', 'a cosign command does not address the image by digest (`ref@digest`)');
        const last = l.trim().split(/\s+/).pop() ?? '';
        if (last) signedNames.push(normName(last));
      }
    }
    if (pushedNames.length && signedNames.length) {
      for (const sn of signedNames)
        if (!pushedNames.includes(sn))
          f(
            'tie-cosign-name',
            `signs \`${sn}\` but the lane pushes ${pushedNames.map((n) => `\`${n}\``).join(', ')}`,
          );
      for (const pn of pushedNames)
        if (!signedNames.includes(pn))
          f('tie-cosign-name', `pushes \`${pn}\` but never signs that name`);
    }
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ───────────────────────── operator tag trigger ─────────────────────────

export function operatorTagWorkflows(wfs: Workflow[]): Workflow[] {
  return wfs.filter((wf) => {
    const push = onOf(wf)?.push;
    if (!push || typeof push !== 'object') return false;
    const tags = (push as Record<string, unknown>).tags;
    return Array.isArray(tags) && tags.some((t) => /^operator-v/.test(String(t)));
  });
}

/**
 * The operator-v* tag trigger must fire for a tag cut from ANY branch, and the
 * lane it starts must still publish on that tag. Gate content (Trivy, SBOM,
 * cosign) is `auditImageLanes`' job, discovered by behaviour.
 */
export function auditOperatorTags(wfs: Workflow[], opts: LaneAuditOptions = {}): Finding[] {
  const lanes = operatorTagWorkflows(wfs);
  if (lanes.length === 0)
    return [
      {
        subject: 'operator',
        check: 'discovered',
        detail: 'no workflow publishes operator-v* tags',
      },
    ];
  const out: Finding[] = [];
  for (const wf of lanes) {
    const f = (check: string, detail: string) => out.push({ subject: wf.file, check, detail });
    const push = (onOf(wf) as Record<string, unknown>).push as Record<string, unknown>;
    for (const k of ['paths', 'paths-ignore', 'branches-ignore', 'tags-ignore']) {
      if (k in push)
        f('any-branch', `push trigger carries \`${k}\`, so a tag from some branch may not fire`);
    }
    const tagCtx = candidateContexts(wf, opts.varsFor).find((c) => c.ref.startsWith('refs/tags/'));
    const jobs = jobsOf(wf);
    const pushJobs = Object.entries(jobs).filter(([jid, job]) =>
      expandedSteps(wf.file, jid, job, opts, []).some(pushesImage),
    );
    if (!pushJobs.length) f('no-publish', 'the operator-v* workflow has no image push step');
    for (const [jid, job] of pushJobs) {
      if (tagCtx && evalExpr(job.if ?? true, tagCtx) === false)
        f(
          'any-branch',
          `\`${jid}\` is disabled on ${tagCtx.ref} (a tag from another branch is not published)`,
        );
    }
  }
  return out;
}

// ───────────────────────── function template images ─────────────────────────

/** Template dirs that have a Dockerfile, derived from the filesystem. */
export function templateDirs(root = resolve(REPO_ROOT, 'templates')): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(root, d.name, 'Dockerfile')))
    .map((d) => d.name)
    .sort();
}

const BUILD_CMD = /\bdocker\s+(?:buildx\s+)?build\b[^\n]*?\btemplates\/([\w.-]+)/;

function builtTemplate(step: Step): string | null {
  const ctx = withOf(step).context;
  if (/^docker\/build-push-action@/.test(uses(step)) && typeof ctx === 'string') {
    const m = ctx.match(/^\.?\/?templates\/([\w.-]+)/);
    if (m) return m[1];
  }
  const m = code(step).match(BUILD_CMD);
  return m ? m[1] : null;
}

export function auditTemplateImages(
  wfs: Workflow[],
  templates: string[],
  opts: LaneAuditOptions = {},
): Finding[] {
  const out: Finding[] = [];
  const built = new Map<string, Array<{ wf: Workflow; id: string }>>();
  for (const wf of wfs) {
    for (const [id, job] of Object.entries(jobsOf(wf))) {
      for (const step of stepsOf(wf.file, id, job)) {
        const t = builtTemplate(step);
        if (t) built.set(t, [...(built.get(t) ?? []), { wf, id }]);
      }
    }
  }
  for (const t of templates) {
    const subject = `template:${t}`;
    const builders = built.get(t) ?? [];
    if (!builders.length) {
      out.push({ subject, check: 'built', detail: 'no workflow job builds this template image' });
      continue;
    }
    // The image job itself plus every job downstream of it (a separate publish job).
    const located = builders.flatMap((b) => {
      const jobs = jobsOf(b.wf);
      const ctxs = candidateContexts(b.wf, opts.varsFor);
      return [...reach(jobs, b.id, 'downstream')].flatMap((jid) =>
        stepsOf(b.wf.file, jid, jobs[jid]).map((step) => ({ id: jid, job: jobs[jid], step, ctxs })),
      );
    });
    for (const [kind, match] of [
      ['sbom', isSbom],
      ['cosign', isCosign],
    ] as const) {
      const cands = located.filter((x) => match(x.step));
      const valid = cands.filter((x) => gateProblems(kind, x.step, x.job, x.ctxs).length === 0);
      if (valid.length) continue;
      out.push({
        subject,
        check: kind,
        detail: cands.length
          ? `\`${cands[0].id}\`: ${gateProblems(kind, cands[0].step, cands[0].job, cands[0].ctxs).join('; ')}`
          : kind === 'cosign'
            ? 'no `cosign sign`/`cosign attest` in or after the image job'
            : 'no SBOM step in or after the image job',
      });
    }
  }
  return out;
}
