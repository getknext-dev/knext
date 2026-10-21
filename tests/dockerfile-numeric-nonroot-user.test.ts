import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every image the operator runs must name a NUMERIC, non-zero user, or the
 * NextApp must opt out of `runAsNonRoot`.
 *
 * The operator renders `runAsNonRoot: true` on the serving container. The
 * kubelet cannot check that a user NAME (`USER node`) is non-root, so it refuses
 * to start such a container; an image with no `USER` at all runs as root and is
 * refused the same way. Both surface at pod start, in a cluster, so this is the
 * place that catches them. Three scans, none an enumerated list of files:
 *
 *  1. EVERY Dockerfile / Containerfile tracked in the repo: each terminal build
 *     stage must end with a numeric, non-zero USER. Exemptions are listed with a
 *     reason and each must still exist (a stale exemption fails).
 *  2. Dockerfiles WRITTEN INLINE by shell scripts and workflows (a `FROM` inside
 *     a printf, echo or heredoc): the same rule on the inline text.
 *  3. The images the e2e and nightly lanes deploy as a NextApp or BackendService:
 *     every digest-pinned reference found in a deploying file must be classified
 *     below, by repository AND digest, as a verified numeric non-root image, a
 *     lane that opts out, a build of a Dockerfile scan 1 covers, an image that is
 *     never pulled, or not an app at all. A new image, or a new digest of an old
 *     one, fails until someone verifies it with `crane config` and records it.
 */

const REPO_ROOT = join(__dirname, '..');

const tracked = (): string[] =>
  execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n')
    .filter(Boolean);
const FILES = tracked();
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

// ---------------------------------------------------------------- USER rule

export type Verdict = 'ok' | 'named' | 'root';

/** The single rule every scan and every negative case uses. */
export const classifyUser = (u: string): Verdict => {
  const m = /^(\d+)(?::(\d+))?$/.exec(u.trim());
  if (!m) return 'named';
  return Number(m[1]) > 0 ? 'ok' : 'root';
};

// ------------------------------------------------------- 1. every Dockerfile

const isDockerfile = (f: string): boolean => {
  const base = f.split('/').pop() ?? '';
  if (/dockerignore/i.test(base)) return false;
  return (
    /^(Dockerfile|Containerfile)(\..+)?$/.test(base) || /\.(Dockerfile|Containerfile)$/.test(base)
  );
};

/**
 * Not run by the operator under runAsNonRoot, with the reason. Each path must be
 * a tracked Dockerfile (a stale entry fails), and the reason must be non-trivial.
 */
export const DOCKERFILE_EXEMPTIONS: Record<string, string> = {
  'packages/scale-zero-pg/bakeoff/gateway-exec.Dockerfile':
    'bake-off scratch image for the scale-to-zero database gateway, run by hand; never a NextApp or BackendService',
  'packages/scale-zero-pg/gateway/Dockerfile':
    'the scale-to-zero database gateway: a platform component with its own Deployment, not rendered by the NextApp operator (it sets USER nonroot:nonroot on distroless, which the kubelet accepts for that Deployment, not under this rule)',
  'packages/kn-next-operator/Dockerfile':
    'the operator itself: its own Deployment, which sets runAsNonRoot with an explicit runAsUser in config/manager/manager.yaml',
  'scripts/bench-cold-start-phases/gke/variants/Dockerfile.variants':
    'benchmark scratch variants layered on a scaffolded image for cold-start A/B runs, built and deployed by hand on a benchmark cluster',
  'apps/docs/Dockerfile.trivyscan':
    'scan fixture, never deployed (mirrors apps/docs/Dockerfile, which IS checked)',
  'examples/bun-exec/Dockerfile.node.trivyscan':
    'scan fixture, never deployed (mirrors Dockerfile.node, which IS checked)',
  'packages/kn-next/Dockerfile.standalone-bun.trivyscan':
    'scan fixture, never deployed (mirrors the standalone template, which IS checked)',
  'packages/kn-next/Dockerfile.standalone-self-contained.trivyscan':
    'scan fixture, never deployed (mirrors the standalone template, which IS checked)',
};

interface Stage {
  name: string;
  from: string;
  users: string[];
  line: number;
}

/** Parse a Dockerfile into stages: the FROM, its alias, and every USER in it. */
export function parseStages(text: string): Stage[] {
  const lines = text.replace(/\\\r?\n/g, ' ').split('\n');
  const stages: Stage[] = [];
  lines.forEach((raw, i) => {
    const l = raw.trim();
    const from = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(l);
    if (from) {
      stages.push({
        name: (from[2] ?? '').toLowerCase(),
        from: from[1] ?? '',
        users: [],
        line: i + 1,
      });
      return;
    }
    const user = /^USER\s+(\S+)/i.exec(l);
    if (user && stages.length > 0) stages[stages.length - 1]?.users.push(user[1] ?? '');
  });
  return stages;
}

/** Stages nothing else builds on or copies from: the images that can be run. */
export function terminalStages(text: string): Stage[] {
  const stages = parseStages(text);
  const referenced = new Set<string>();
  for (const s of stages) referenced.add(s.from.toLowerCase());
  for (const m of text.matchAll(/--from=(\S+)/gi)) referenced.add((m[1] ?? '').toLowerCase());
  return stages.filter((s) => s.name === '' || !referenced.has(s.name));
}

/** The USER a terminal stage runs as: its own last USER, else its parent stage's. */
export function effectiveUser(text: string, stage: Stage): string | undefined {
  const stages = parseStages(text);
  let cur: Stage | undefined = stage;
  const seen = new Set<Stage>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const last = cur.users[cur.users.length - 1];
    if (last !== undefined) return last;
    cur = stages.find((s) => s.name !== '' && s.name === cur?.from.toLowerCase());
  }
  return undefined;
}

const DOCKERFILES = FILES.filter(isDockerfile);

describe('1. every Dockerfile and Containerfile in the repo', () => {
  it('finds a representative set (the scan is not vacuous)', () => {
    expect(DOCKERFILES.length).toBeGreaterThanOrEqual(20);
    expect(DOCKERFILES).toContain('templates/go/Dockerfile');
    expect(DOCKERFILES).toContain(
      'packages/kn-next/templates/runtime-standalone/Dockerfile.standalone.hbs',
    );
  });

  it('every exemption names a tracked Dockerfile and gives a real reason', () => {
    for (const [f, why] of Object.entries(DOCKERFILE_EXEMPTIONS)) {
      expect(DOCKERFILES, `${f}: exempt but not a tracked Dockerfile (stale entry)`).toContain(f);
      expect(why.length, `${f}: reason too short`).toBeGreaterThan(30);
    }
  });

  for (const f of DOCKERFILES.filter((d) => !(d in DOCKERFILE_EXEMPTIONS))) {
    it(`${f}: every runnable stage ends as a numeric, non-zero user`, () => {
      const text = read(f);
      const terminals = terminalStages(text);
      expect(terminals.length, `${f}: no FROM found`).toBeGreaterThan(0);
      for (const s of terminals) {
        const u = effectiveUser(text, s);
        expect(
          u,
          `${f}:${s.line} stage ${s.name || s.from} has no USER (it would run as root)`,
        ).toBeDefined();
        expect(
          classifyUser(u ?? ''),
          `${f}:${s.line} stage ${s.name || s.from}: USER ${u}: the kubelet refuses a named or root user under runAsNonRoot`,
        ).toBe('ok');
      }
    });
  }
});

// ------------------------------------------------- 2. inline Dockerfile text

const INLINE_SCAN_EXTENSIONS = /\.(sh|bash|ya?ml|mjs|cjs|js|ts|go)$|(^|\/)Makefile$/;
const INLINE_SKIP =
  /^(docs\/|apps\/docs\/content\/|\.claude\/)|\.test\.ts$|(^|\/)mutation-prove|(^|\/)mutate-/;
const FROM_IMAGE =
  /\bFROM\s+(?:--\S+\s+)*(scratch|__BASE[A-Z_]*__|[\w.-]+(?::\d+)?\/[\w./-]+|[\w.-]+:[\w.-]+|[\w.-]+@sha256:\S+)/;

/**
 * Inline Dockerfiles that are NOT run under runAsNonRoot, with the reason. The
 * key is `<path>`; each must still contain an inline FROM.
 */
export const INLINE_EXEMPTIONS: Record<string, string> = {
  'benchmarks/image-prewarm-oke/build-unique-image.job.yaml':
    'benchmark job that appends a layer to a base image to defeat caching; the base image is the one the benchmark pulls, and the resulting image is only pulled, never started',
  'scripts/check-base-images-pinned.sh':
    'a checker that parses Dockerfile FROM lines; the matches are its own messages',
};

export interface InlineDockerfile {
  file: string;
  line: number;
  text: string;
}

/** Find Dockerfile text written by a script: heredocs, and printf/echo strings. */
export function inlineDockerfiles(file: string, text: string): InlineDockerfile[] {
  const out: InlineDockerfile[] = [];
  const lines = text.split('\n');
  // heredocs
  for (let i = 0; i < lines.length; i++) {
    const h = /<<-?\s*['"]?(\w+)['"]?/.exec(lines[i] ?? '');
    if (!h) continue;
    const delim = h[1] as string;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && (lines[j] ?? '').trim() !== delim) body.push(lines[j] ?? ''), j++;
    if (body.some((l) => /^\s*FROM\s/.test(l) && FROM_IMAGE.test(l))) {
      out.push({ file, line: i + 1, text: body.join('\n') });
    }
    i = j;
  }
  // printf / echo / string-literal Dockerfiles: group consecutive lines that
  // carry Dockerfile instructions or a FROM-with-image.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (!/(printf|echo)\b/.test(l) || !FROM_IMAGE.test(l)) continue;
    let block = l;
    let j = i + 1;
    while (j < lines.length && /(printf|echo)\b/.test(lines[j] ?? ''))
      (block += `\n${lines[j]}`), j++;
    out.push({ file, line: i + 1, text: block });
    i = j - 1;
  }
  // YAML/other block scalars that hold a Dockerfile verbatim (a line that begins
  // with FROM <image> and is not inside a heredoc already found).
  const covered = new Set(out.map((o) => o.line));
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (!/^\s*FROM\s/.test(l) || !FROM_IMAGE.test(l)) continue;
    if ([...covered].some((c) => Math.abs(c - (i + 1)) < 40)) continue;
    const block: string[] = [l];
    let j = i + 1;
    const indent = (/^\s*/.exec(l) ?? [''])[0].length;
    while (
      j < lines.length &&
      (lines[j] ?? '').trim() !== '' &&
      (/^\s*/.exec(lines[j] ?? '') ?? [''])[0].length >= indent
    ) {
      block.push(lines[j] ?? '');
      j++;
    }
    out.push({ file, line: i + 1, text: block.join('\n') });
  }
  return out;
}

/** The user an inline Dockerfile text ends as (a printf's `\n` is expanded). */
export function inlineUser(text: string): string | undefined {
  const expanded = text.replace(/\\n/g, '\n').replace(/^[^\n]*?(?=\bFROM\s)/, '');
  const stages = parseStages(expanded);
  return stages.length > 0
    ? effectiveUser(expanded, stages[stages.length - 1] as Stage)
    : undefined;
}

const INLINE_CANDIDATES = FILES.filter(
  (f) => INLINE_SCAN_EXTENSIONS.test(f) && !INLINE_SKIP.test(f) && !isDockerfile(f),
);
const INLINE_FOUND = INLINE_CANDIDATES.flatMap((f) => {
  const t = read(f);
  return /\bFROM\b/.test(t) ? inlineDockerfiles(f, t) : [];
});

describe('2. Dockerfiles written inline by scripts and workflows', () => {
  it('finds the networkpolicy drill image (the scan is not vacuous)', () => {
    expect(INLINE_FOUND.map((i) => i.file)).toContain(
      'packages/kn-next-operator/test/networkpolicy-enforcement-drill.sh',
    );
  });

  it('every exemption still contains an inline FROM and gives a real reason', () => {
    for (const [f, why] of Object.entries(INLINE_EXEMPTIONS)) {
      expect(FILES, `${f}: exempt but not tracked`).toContain(f);
      expect(why.length).toBeGreaterThan(30);
    }
  });

  for (const d of INLINE_FOUND.filter((i) => !(i.file in INLINE_EXEMPTIONS))) {
    it(`${d.file}:${d.line}: the inline Dockerfile ends as a numeric, non-zero user`, () => {
      const u = inlineUser(d.text);
      expect(
        u,
        `${d.file}:${d.line}: inline Dockerfile has no USER (it would run as root)`,
      ).toBeDefined();
      expect(classifyUser(u ?? ''), `${d.file}:${d.line}: USER ${u}`).toBe('ok');
    });
  }
});

// ------------------------------------- 3. images the e2e lanes deploy as apps

type Disposition =
  /** Verified with `crane config`: a numeric non-root user (`user`). */
  | { kind: 'non-root'; user: string; note: string }
  /** Runs as root; every deploying file for it must carry `runAsNonRoot: false`. */
  | { kind: 'opt-out'; user: 'root'; optOutIn: string[]; note: string }
  /** Built from a Dockerfile that scan 1 checks. */
  | { kind: 'built'; dockerfile: string; note: string }
  /** A placeholder digest that is never pulled (all one hex digit). */
  | { kind: 'placeholder'; note: string }
  /** Not a NextApp or BackendService: an infrastructure Deployment/Pod. */
  | { kind: 'infra'; note: string };

export const IMAGE_TABLE: Record<string, Disposition> = {
  // --- apps, verified non-root (crane config, 2026-10-21)
  'quay.io/openshift/origin-hello-openshift@sha256:3d2cc2be080ec48a5a1a2cc1d0a762b944665212591e271a5ed6a481f885b1e3':
    {
      kind: 'non-root',
      user: '1001',
      note: 'serves on $PORT; used by the asset-GC e2e, the upgrade e2e and the published-bundle nightly',
    },
  'docker.io/mendhak/http-https-echo@sha256:a265f55c86cb3baead76fdf379dc8e9e6440ed121874e101e60b833e05bce8d4':
    {
      kind: 'non-root',
      user: '1000',
      note: 'platform e2e: echoes its environment, so the revision marker rides in GREETING; HTTP_PORT moves it to 3000',
    },
  // --- apps, root, with the opt-out exercised live
  'ghcr.io/knative/helloworld-go@sha256:c2b7412fbea6f1ef24a0cac60698e88df7ae3c4278e42d0cb34fe7d4b2641bba':
    {
      kind: 'opt-out',
      user: 'root',
      optOutIn: ['packages/kn-next-operator/test/e2e/rollback_e2e_test.go'],
      note: 'config.User is null (root). The rollback e2e needs its "Hello ${TARGET}!" marker, and is the one lane that renders spec.security.runAsNonRoot: false',
    },
};

/** Repositories that are infrastructure in the deploying files, not apps. */
const INFRA_REPOS = [
  /^(docker\.io\/|mirror\.gcr\.io\/library\/)?redis:/,
  /^(docker\.io\/)?bitnamilegacy\/minio@/,
  /^(docker\.io\/)?bitnamilegacy\/minio-client@/,
  /^registry:2/,
  /^(mirror\.gcr\.io\/library\/)?postgres:/,
  /^oven\/bun:/,
  /^node:/,
  /^curlimages\/curl@/,
  /^gcr\.io\/distroless\//,
];
/** Built by the lane from a Dockerfile scan 1 checks, or published from one. */
const BUILT_REPOS: [RegExp, string][] = [
  [/^ghcr\.io\/getknext-dev\/file-manager@/, 'apps/file-manager/Dockerfile'],
  [/^dev\.local\/file-manager@/, 'apps/file-manager/Dockerfile'],
  [/^localhost:5001\/file-manager/, 'apps/file-manager/Dockerfile'],
  [
    /^ghcr\.io\/getknext-dev\/webhook-readiness-probe@/,
    'packages/kn-next-operator/test/utils/webhook.go',
  ],
  [/^ghcr\.io\/getknext-dev\/db-demo@/, 'packages/scale-zero-pg/demo/app/Dockerfile'],
  [/^me-abudhabi-1\.ocir\.io\/axfqznklsd2t\/pg-demo/, 'packages/scale-zero-pg/demo/app/Dockerfile'],
  [
    /^ghcr\.io\/getknext-dev\/bench-cells-/,
    'packages/kn-next/templates/runtime-standalone/Dockerfile.standalone.hbs',
  ],
  [
    /^us-central1-docker\.pkg\.dev\/gsw-mcp\/knative-next-repo\/bc-/,
    'packages/kn-next/templates/runtime-standalone/Dockerfile.standalone.hbs',
  ],
  [/^registry\.example\.com\//, 'packages/kn-next-operator/test/utils/webhook.go'],
];

/** Files that deploy a NextApp or BackendService. */
const DEPLOYING =
  /kind:\s*(NextApp|BackendService)\b|\bkn?ext(\s+|\/)deploy\b|\bdeploy\s+(--[\w-]+\s+\S+\s+)*--image\b|NextApp\{|nextapp\b.*\bapply\b/;
const DEPLOY_SCAN_ROOTS =
  /^(packages\/kn-next-operator\/test\/|packages\/grpc\/e2e\/|scripts\/|\.github\/workflows\/|apps\/file-manager\/scripts\/|packages\/scale-zero-pg\/demo\/manifests\/|packages\/kn-next-operator\/config\/samples\/)/;
const DEPLOY_SKIP = /(^|\/)mutation-prove|(^|\/)mutate-|\.test\.ts$|README\.md$/;

const IMAGE_REF =
  /(?:[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?\/|[a-z0-9][\w.-]*\/)?[a-z0-9][\w./-]*(?::[\w.-]+)?@sha256:[0-9a-f]{64}/gi;

/** Image references in a file, with Go's `"repo@sha256:" + "digest"` splits joined. */
export function imageRefs(text: string): string[] {
  const joined = text.replace(/"\s*\+\s*\n\s*"/g, '');
  return [...new Set([...joined.matchAll(IMAGE_REF)].map((m) => m[0]))];
}

const isPlaceholderDigest = (ref: string): boolean => {
  const d = /@sha256:([0-9a-f]{64})$/.exec(ref)?.[1] ?? '';
  return (
    /^(.)\1{63}$/.test(d) ||
    /^(0123456789abcdef)+$/.test(d) ||
    /^abc123def456abc123def456abc123def456abc123def456abc123def456abc1$/.test(d)
  );
};

export function classify(ref: string): Disposition | undefined {
  if (IMAGE_TABLE[ref]) return IMAGE_TABLE[ref];
  if (isPlaceholderDigest(ref))
    return { kind: 'placeholder', note: 'all-one-digit digest: unpullable by construction' };
  for (const [re, dockerfile] of BUILT_REPOS)
    if (re.test(ref))
      return { kind: 'built', dockerfile, note: 'built or published from a checked Dockerfile' };
  if (INFRA_REPOS.some((re) => re.test(ref))) return { kind: 'infra', note: 'infrastructure' };
  return undefined;
}

const DEPLOYERS = FILES.filter(
  (f) => DEPLOY_SCAN_ROOTS.test(f) && !DEPLOY_SKIP.test(f) && /\.(go|sh|ya?ml|mjs|ts|js)$/.test(f),
);
const DEPLOYING_FILES = DEPLOYERS.filter((f) => DEPLOYING.test(read(f)));
const DEPLOYED_REFS = DEPLOYING_FILES.flatMap((f) =>
  imageRefs(read(f)).map((ref) => ({ file: f, ref })),
);

describe('3. images the e2e and nightly lanes deploy', () => {
  it('finds the deploying files and the helloworld-go sites (the scan is not vacuous)', () => {
    expect(DEPLOYING_FILES.length).toBeGreaterThanOrEqual(10);
    const hello = DEPLOYED_REFS.filter((r) => r.ref.startsWith('ghcr.io/knative/helloworld-go@'));
    expect(hello.map((r) => r.file)).toContain(
      'packages/kn-next-operator/test/e2e/rollback_e2e_test.go',
    );
  });

  it('every table row is still referenced by a deploying file (no stale rows)', () => {
    const seen = new Set(DEPLOYED_REFS.map((r) => r.ref));
    for (const ref of Object.keys(IMAGE_TABLE))
      expect(seen.has(ref), `${ref}: in the table, deployed by nothing`).toBe(true);
  });

  it('every verified-non-root row names a numeric non-zero user', () => {
    for (const [ref, d] of Object.entries(IMAGE_TABLE)) {
      if (d.kind === 'non-root') expect(classifyUser(d.user), `${ref}: ${d.user}`).toBe('ok');
    }
  });

  it('every built row points at a Dockerfile or generator scan 1 covers', () => {
    for (const [, dockerfile] of BUILT_REPOS) {
      expect(FILES, `${dockerfile}: not tracked`).toContain(dockerfile);
    }
  });

  it('every digest-pinned image in a deploying file is classified', () => {
    const unknown = DEPLOYED_REFS.filter((r) => classify(r.ref) === undefined).map(
      (r) => `${r.file}: ${r.ref}`,
    );
    expect(
      unknown,
      'unclassified image(s): run `crane config <ref>`, then add a row to IMAGE_TABLE (numeric non-root user, or an opt-out lane)',
    ).toEqual([]);
  });

  it('every root image is opted out in every file that deploys it', () => {
    for (const [ref, d] of Object.entries(IMAGE_TABLE)) {
      if (d.kind !== 'opt-out') continue;
      const deployers = DEPLOYED_REFS.filter((r) => r.ref === ref).map((r) => r.file);
      expect(deployers.length, `${ref}: no deployer found`).toBeGreaterThan(0);
      for (const f of deployers) {
        expect(
          d.optOutIn,
          `${f} deploys root image ${ref} but is not a declared opt-out lane`,
        ).toContain(f);
        expect(read(f), `${f}: declared opt-out lane but renders no runAsNonRoot: false`).toMatch(
          /runAsNonRoot:\s*false/,
        );
      }
    }
  });

  it('exactly one lane exercises the opt-out live', () => {
    const lanes = new Set(
      Object.values(IMAGE_TABLE)
        .filter((d): d is Extract<Disposition, { kind: 'opt-out' }> => d.kind === 'opt-out')
        .flatMap((d) => d.optOutIn),
    );
    expect([...lanes]).toEqual(['packages/kn-next-operator/test/e2e/rollback_e2e_test.go']);
  });
});

describe('the checkers can say no', () => {
  it.each([
    ['65532:65532', 'ok'],
    ['1000', 'ok'],
    ['node', 'named'],
    ['nonroot:nonroot', 'named'],
    ['0', 'root'],
    ['0:0', 'root'],
  ] as [string, Verdict][])('USER %s -> %s', (u, want) => {
    expect(classifyUser(u)).toBe(want);
  });

  it('a stage with no USER, a named USER, or root fails; a stage inheriting a good parent passes', () => {
    const user = (df: string) => {
      const t = terminalStages(df);
      return effectiveUser(df, t[t.length - 1] as Stage);
    };
    expect(user('FROM a\nRUN true\n')).toBeUndefined();
    expect(user('FROM a\nUSER node\n')).toBe('node');
    expect(user('FROM a AS base\nUSER 65532:65532\nFROM base\nRUN true\n')).toBe('65532:65532');
    // a builder stage that is copied from is not a runnable stage
    expect(
      terminalStages('FROM a AS build\nRUN true\nFROM b\nCOPY --from=build /x /x\nUSER 1\n').map(
        (s) => s.from,
      ),
    ).toEqual(['b']);
  });

  it('finds inline Dockerfiles in printf lines and heredocs, and reads their USER', () => {
    const printf = `printf 'FROM scratch\\nCOPY x /x\\nENTRYPOINT ["/x"]\\n' > Dockerfile\n`;
    const a = inlineDockerfiles('a.sh', printf);
    expect(a).toHaveLength(1);
    expect(inlineUser(a[0]?.text ?? '')).toBeUndefined();
    const heredoc = `cat > Dockerfile <<EOF\nFROM alpine:3.22\nUSER 65532:65532\nEOF\n`;
    const b = inlineDockerfiles('b.sh', heredoc);
    expect(b).toHaveLength(1);
    expect(inlineUser(b[0]?.text ?? '')).toBe('65532:65532');
    // SQL is not a Dockerfile
    expect(
      inlineDockerfiles('c.sql', 'SELECT 1 FROM pg_catalog.pg_locks blocked_locks\n'),
    ).toHaveLength(0);
  });

  it('classifies a known image, a placeholder and infrastructure, and refuses an unknown real digest', () => {
    const real = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    expect(classify(`quay.io/evil/app@sha256:${real}`)).toBeUndefined();
    expect(classify(`ghcr.io/knative/helloworld-go@sha256:${real}`)).toBeUndefined();
    expect(classify(`ghcr.io/x/y@sha256:${'0'.repeat(64)}`)?.kind).toBe('placeholder');
    expect(classify(`redis:7-alpine@sha256:${real}`)?.kind).toBe('infra');
    expect(classify(Object.keys(IMAGE_TABLE)[0] as string)?.kind).toBe('non-root');
  });

  it('joins a Go string split across lines into one image reference', () => {
    const go = `x = "ghcr.io/a/b@sha256:" +\n\t\t"${'a'.repeat(64)}"\n`;
    expect(imageRefs(go)).toEqual([`ghcr.io/a/b@sha256:${'a'.repeat(64)}`]);
  });
});
