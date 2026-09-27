/**
 * Upstream-retirement registry (#1450): one entry per knext shim that exists
 * only because of an upstream bug or missing feature.
 *
 * Each entry carries a `repro` that runs against the PINNED toolchain and
 * reports whether the upstream problem is still there. retirement.test.ts
 * requires `stillBroken === true` for every entry, so a Bun or vinext bump that
 * fixes the problem goes red with "upstream fixed — delete shim <id>". The rule
 * (plan: "Patch carrier"): a shim is deleted in the SAME PR as the bump that
 * turns its probe red — never kept "just in case".
 *
 * `kind` says what the marker sits on: 'shim' (code to delete) or 'constraint'
 * (a documented limitation + its pinned test; e.g. bun-cjs-dirname-inlined).
 *
 * Each shim's source carries a one-line `// @upstream-shim <id>` marker; the
 * marker scan in retirement.test.ts ties markers and entries in both
 * directions, so a shim cannot exist without a probe, nor a probe without a
 * shim.
 *
 * A repro is an ORACLE, not a smoke test: each one runs a CONTROL that must
 * behave as expected before the verdict counts. A probe whose control fails
 * throws ("probe inconclusive") rather than reporting either way — an
 * environment problem must never read as "upstream fixed", or as "still
 * broken".
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detectCompileInclude } from '../../packages/kn-next/src/adapters/compile-embed.mjs';
import { bunOnPath, pinnedVinext, REPO_ROOT, sandbox } from './probe-kit';

export type UpstreamRef = `${'oven-sh/bun' | 'cloudflare/vinext' | 'vercel/next.js'}#${number}`;

export type Probe = { stillBroken: boolean; evidence: string };

export type RetirementEntry = {
  /** The id used by the `// @upstream-shim <id>` marker(s). */
  id: string;
  /** The upstream issue or PR whose fix retires the shim. */
  upstream: UpstreamRef;
  /**
   * A fragment of the upstream title, checked against GitHub by
   * retirement.test.ts — an existing-but-wrong number (a typo) must red.
   */
  upstreamTitle: string;
  /** An upstream PR that fixes `upstream`, when one exists (verified by the probe). */
  fixedBy?: { ref: UpstreamRef; title: string };
  /** The knext issue that tracks the retirement. */
  issue: `#${number}`;
  /**
   * `shim` = code that is deleted on the upstream fix; `constraint` = what the
   * marker sits on is a documented limitation plus its pinned test (the
   * upstream fix retires the documented workaround, not a code path).
   */
  kind: 'shim' | 'constraint';
  /** Which single-exec shape ships the shim. */
  shape: 'next' | 'vinext' | 'both';
  /** Which pinned dependency the repro runs against. */
  against: 'bun' | 'vinext';
  repro: () => Promise<Probe>;
};

const inconclusive = (id: string, why: string): never => {
  throw new Error(`probe ${id} inconclusive (control failed): ${why}`);
};

/** `@img/sharp-<platform>` + `@img/sharp-libvips-<platform>` of the installed sharp. */
function sharpNativeDirs(): {
  addon: string;
  libvipsLib: string;
  libvipsFile: string;
  platform: string;
} {
  // A missing optional native dep is an environment problem, not a verdict.
  const resolvePkg = (pkg: string, from: string): string => {
    try {
      return dirname(Bun.resolveSync(`${pkg}/package.json`, from));
    } catch {
      return inconclusive('sharp-addon-dlopen', `${pkg} not installed (resolved from ${from})`);
    }
  };
  const sharpDir = resolvePkg('sharp', join(REPO_ROOT, 'apps/file-manager'));
  const libc =
    process.platform === 'linux' &&
    !(process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined)
      ?.header?.glibcVersionRuntime
      ? 'musl'
      : '';
  const platform = `${process.platform}${libc}-${process.arch}`;
  const addonPkg = resolvePkg(`@img/sharp-${platform}`, sharpDir);
  const libvipsPkg = resolvePkg(`@img/sharp-libvips-${platform}`, addonPkg);
  const addonFile = readdirSync(join(addonPkg, 'lib')).find((f) => f.endsWith('.node'));
  const libvipsFile = readdirSync(join(libvipsPkg, 'lib')).find((f) => /^libvips-cpp\./.test(f));
  if (!addonFile || !libvipsFile) {
    return inconclusive(
      'sharp-addon-dlopen',
      `sharp native payload not found for ${platform} (addon ${addonFile}, libvips ${libvipsFile})`,
    );
  }
  return {
    addon: join(addonPkg, 'lib', addonFile),
    libvipsLib: join(libvipsPkg, 'lib'),
    libvipsFile,
    platform,
  };
}

/** oven-sh/bun#44068's oracle, shared by the constraint and the shim it retires. */
async function dirnameInlinedRepro(id: string): Promise<Probe> {
  const box = sandbox('44068');
  try {
    box.write(
      {
        'main.cjs':
          'const { dirname, join } = require("node:path");\n' +
          'const l = require(join(dirname(process.argv[1]), "chunks", "loader.js"));\n' +
          'let rel, abs;\n' +
          'try { rel = l.relative("n1"); } catch (e) { rel = "fail"; }\n' +
          'try { abs = l.dirnameJoin("n1"); } catch (e) { abs = "fail " + String(e.message).split("\\n")[0]; }\n' +
          'console.log("RESULT " + JSON.stringify({ rel, abs }));\n',
        'chunks/loader.cjs':
          'const { join } = require("node:path");\n' +
          'exports.relative = (n) => require("./" + n + ".cjs");\n' +
          'exports.dirnameJoin = (n) => require(join(__dirname, n + ".cjs"));\n',
        'chunks/n1.cjs': 'module.exports = "n1-ok";\n',
      },
      'src',
    );
    const built = box.compile(
      'src',
      '{ entrypoints: ["./main.cjs", "./chunks/loader.cjs", "./chunks/n1.cjs"], root: ".", target: "bun", format: "cjs", naming: "[dir]/[name].[ext]", compile: { outfile: "../bin/app" } }',
    );
    if (built.status !== 'built') inconclusive(id, built.detail);
    box.remove('src');
    box.write({ '.keep': '' }, 'empty');
    const raw = box.run([join(box.dir, 'bin/app')], join(box.dir, 'empty')).result;
    const { rel, abs } = JSON.parse(raw) as { rel: string; abs: string };
    // Control: the RELATIVE computed require resolves inside `$bunfs`, so
    // the chunk IS embedded and a miss below is the `__dirname` anchor alone.
    if (rel !== 'n1-ok') inconclusive(id, `relative computed require: ${raw}`);
    if (abs !== 'n1-ok' && !/^fail Cannot find module/.test(abs))
      inconclusive(id, `join(__dirname) failed oddly: ${raw}`);
    return {
      stillBroken: abs !== 'n1-ok',
      evidence: `relative require → ${rel}; require(join(__dirname, …)) → ${abs} (fix: oven-sh/bun#29066)`,
    };
  } finally {
    box.dispose();
  }
}

export type CacheShape = 'A' | 'B' | 'C' | 'D';

/**
 * "Fixed" needs EVERY probed shape normalised: a partial upstream fix leaves
 * the shim needed, so it must stay "still broken", never order a delete.
 */
export function cacheControlVerdict(shapes: Record<CacheShape, string | null>): {
  stillBroken: boolean;
  leaking: CacheShape[];
} {
  const leaking = (Object.keys(shapes) as CacheShape[]).filter((k) =>
    /s-maxage/.test(shapes[k] ?? ''),
  );
  return { stillBroken: leaking.length > 0, leaking };
}

export const REGISTRY: RetirementEntry[] = [
  {
    id: 'sidecar-cjs-resolve',
    upstream: 'oven-sh/bun#44053',
    upstreamTitle: 'an --external package is resolved from process.cwd()',
    issue: '#1463',
    kind: 'shim',
    shape: 'vinext',
    against: 'bun',
    // A compiled binary resolves a bare `require` of an --external package from
    // the CWD only, never from beside the executable. The sidecar hook in
    // sidecar-runtime.mjs resolves from `<dir of the binary>/.output/server/node_modules`.
    repro: async () => {
      const box = sandbox('44053');
      try {
        box.write({
          'src/main.cjs':
            'try { console.log("RESULT ok " + require("dep")); } catch (e) { console.log("RESULT fail " + (e.code || e.message)); }\n',
          'bin/node_modules/dep/package.json': '{ "name": "dep", "version": "1.0.0" }\n',
          'bin/node_modules/dep/index.js': 'module.exports = "dep-loaded";\n',
          'elsewhere/.keep': '',
        });
        const built = box.compile(
          'src',
          '{ entrypoints: ["./main.cjs"], external: ["dep"], target: "bun", compile: { outfile: "../bin/app" } }',
        );
        if (built.status !== 'built') inconclusive('sidecar-cjs-resolve', built.detail);
        const app = join(box.dir, 'bin/app');
        const control = box.run([app], join(box.dir, 'bin')).result;
        if (control !== 'ok dep-loaded')
          inconclusive('sidecar-cjs-resolve', `cwd=binary dir: ${control}`);
        const probe = box.run([app], join(box.dir, 'elsewhere')).result;
        return {
          stillBroken: probe !== 'ok dep-loaded',
          evidence: `cwd=binary dir → ${control}; cwd=elsewhere (package beside the binary) → ${probe}`,
        };
      } finally {
        box.dispose();
      }
    },
  },
  {
    id: 'sharp-addon-dlopen',
    upstream: 'oven-sh/bun#44063',
    upstreamTitle: 'an embedded native addon is extracted alone',
    issue: '#1463',
    kind: 'shim',
    shape: 'vinext',
    against: 'bun',
    // An embedded `.node` is extracted ALONE to a temp file before dlopen, so
    // its relative rpath to libvips (embedded beside it, layout intact) does not
    // resolve. sharp-addon-dlopen.mjs dlopens a real on-disk @img tree instead.
    repro: async () => {
      const { addon, libvipsLib, libvipsFile, platform } = sharpNativeDirs();
      const box = sandbox('44063');
      try {
        const addonRel = `@img/sharp-${platform}/lib/addon.node`;
        const libRel = `@img/sharp-libvips-${platform}/lib/${libvipsFile}`;
        box.copy(addon, `fx/${addonRel}`);
        box.copy(join(libvipsLib, libvipsFile), `fx/${libRel}`);
        box.write(
          {
            'main.mjs': `import lib from "./${libRel}" with { type: "file" };\nawait import("./load.cjs");\n`,
            'load.cjs':
              `try { const m = require("./${addonRel}"); console.log("RESULT loaded " + Object.keys(m).length); }\n` +
              'catch (e) { console.log("RESULT fail " + String(e.message).split("\\n")[0]); }\n',
            'control.cjs':
              `try { const m = { exports: {} }; process.dlopen(m, require("node:path").join(__dirname, "${addonRel}")); console.log("RESULT loaded " + Object.keys(m.exports).length); }\n` +
              'catch (e) { console.log("RESULT fail " + String(e.message).split("\\n")[0]); }\n',
            'empty/.keep': '',
          },
          'fx',
        );
        const control = box.run([bunOnPath(), 'control.cjs'], join(box.dir, 'fx')).result;
        if (!control.startsWith('loaded'))
          inconclusive('sharp-addon-dlopen', `on-disk dlopen: ${control}`);
        const built = box.compile(
          'fx',
          '{ entrypoints: ["./main.mjs"], root: ".", target: "bun", naming: { entry: "[dir]/[name].[ext]", asset: "[dir]/[name].[ext]" }, compile: { outfile: "../bin/app" } }',
        );
        if (built.status !== 'built') inconclusive('sharp-addon-dlopen', built.detail);
        const probe = box.run([join(box.dir, 'bin/app')], join(box.dir, 'fx/empty')).result;
        if (probe.startsWith('fail') && !/libvips/.test(probe)) {
          inconclusive(
            'sharp-addon-dlopen',
            `embedded load failed for a reason other than libvips: ${probe}`,
          );
        }
        return {
          stillBroken: probe.startsWith('fail'),
          evidence: `on-disk dlopen → ${control}; embedded addon + embedded libvips → ${probe}`,
        };
      } finally {
        box.dispose();
      }
    },
  },
  {
    id: 'bun-serve-keepalive',
    upstream: 'oven-sh/bun#43848',
    upstreamTitle: 'send Keep-Alive: timeout=<idleTimeout> by default',
    issue: '#1463',
    kind: 'shim',
    shape: 'vinext',
    against: 'bun',
    // Bun.serve keeps HTTP/1.1 connections alive but never announces its idle
    // deadline (`Keep-Alive: timeout=…`), so pooling clients can reuse a socket
    // the server is closing. bun-serve-keepalive-guard.mjs stamps
    // `Connection: close` instead.
    repro: async () => {
      const box = sandbox('43848');
      try {
        box.write({
          'src/main.mjs':
            'import { connect } from "node:net";\n' +
            'const head = async (headers) => {\n' +
            '  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok", { headers }) });\n' +
            '  const raw = await new Promise((res, rej) => {\n' +
            '    const s = connect(server.port, "127.0.0.1", () => s.write("GET / HTTP/1.1\\r\\nHost: probe\\r\\n\\r\\n"));\n' +
            '    let b = ""; s.on("data", (d) => { b += d; if (b.includes("\\r\\n\\r\\n")) { s.destroy(); res(b); } }); s.on("error", rej);\n' +
            '  });\n' +
            '  server.stop(true);\n' +
            '  return raw.split("\\r\\n\\r\\n")[0];\n' +
            '};\n' +
            'const verdict = (h) => !/^HTTP\\/1\\.1 200 /.test(h) ? "bad-response" : /^connection:\\s*close/im.test(h) ? "closes" : /^keep-alive:/im.test(h) ? "keep-alive-announced" : "no-keep-alive";\n' +
            // Control: an app-set `Keep-Alive` header reaches the wire and the
            // oracle sees it — so "no-keep-alive" below means Bun sent none.
            'const control = await head({ "keep-alive": "timeout=5" });\n' +
            'const probe = await head({});\n' +
            'console.log("RESULT " + verdict(probe) + " control=" + verdict(control) + " " + JSON.stringify(probe));\n',
        });
        const built = box.compile(
          'src',
          '{ entrypoints: ["./main.mjs"], target: "bun", compile: { outfile: "../bin/app" } }',
        );
        if (built.status !== 'built') inconclusive('bun-serve-keepalive', built.detail);
        const probe = box.run([join(box.dir, 'bin/app')], box.dir).result;
        if (!/ control=keep-alive-announced /.test(probe))
          inconclusive('bun-serve-keepalive', `control (app-set Keep-Alive header): ${probe}`);
        if (!/^(no-keep-alive|keep-alive-announced|closes) /.test(probe))
          inconclusive('bun-serve-keepalive', probe);
        return { stillBroken: probe.startsWith('no-keep-alive'), evidence: probe };
      } finally {
        box.dispose();
      }
    },
  },
  {
    id: 'bun-serve-cache-control',
    upstream: 'cloudflare/vinext#3487',
    upstreamTitle: 'also normalise an app-set s-maxage',
    issue: '#1437',
    kind: 'shim',
    shape: 'vinext',
    against: 'vinext',
    // With VINEXT_NEXT_DEPLOY_CACHE_CONTROL=1, vinext normalises the shared-cache
    // Cache-Control it COMPUTES, but passes an app-set `s-maxage` through
    // untouched — and so does a `headers()` s-maxage from next.config, applied
    // later, and a response already MARKED config-headers-applied (metadata
    // routes, the response-stage path), which returns early through
    // normalizeExplicitNonCacheablePolicy only. bun-serve-cache-control.mjs
    // normalises every response. Red only when A+B+C+D ALL normalise. KNOWN
    // BLIND SPOT: the Pages-router handler needs a full page-render harness and
    // is not probed, so a fix landing on every probed App path but not Pages
    // would turn this red while Pages still leaks — whoever acts on the red
    // must confirm the upstream fix covers the Pages path before deleting the
    // shim.
    repro: async () => {
      const { dir } = pinnedVinext();
      const box = sandbox('3487');
      try {
        const server = join(dir, 'dist/server');
        for (const f of ['app-rsc-response-finalizer.js', 'cache-control.js']) {
          if (!existsSync(join(server, f)))
            inconclusive('bun-serve-cache-control', `pinned vinext has no dist/server/${f}`);
        }
        box.write({
          'probe.mjs':
            `const fin = await import(${JSON.stringify(join(server, 'app-rsc-response-finalizer.js'))});\n` +
            `const cc = await import(${JSON.stringify(join(server, 'cache-control.js'))});\n` +
            'const SHARED = "s-maxage=2, stale-while-revalidate=31535998";\n' +
            'const h = new Headers(); cc.applyCdnResponseHeaders(h, { cacheControl: SHARED });\n' +
            'console.log("CONTROL " + h.get("cache-control"));\n' +
            // Three response shapes, all through the finalizer every App Router
            // response passes: (A) an app-set s-maxage with no config headers,
            // (B) next.config `headers()` setting s-maxage on a response with
            // no Cache-Control of its own (applied later, by
            // applyAppRscConfigHeaders), (C) `headers()` over an app-set policy.
            // The shim normalises ALL of them, so upstream has only caught up
            // when every one is normalised.
            'const CH = [{ source: "/api/:path*", headers: [{ key: "Cache-Control", value: SHARED }] }];\n' +
            'const req = () => new Request("http://localhost/api/probe");\n' +
            'const D = await fin.finalizeAppRscResponse(fin.markAppRscResponseConfigHeadersApplied(new Response("ok", { headers: { "cache-control": SHARED } })), req(), { configHeaders: CH });\n' +
            'const A = await fin.finalizeAppRscResponse(new Response("ok", { headers: { "cache-control": SHARED } }), req(), { configHeaders: [] });\n' +
            'const B = await fin.finalizeAppRscResponse(new Response("ok"), req(), { configHeaders: CH });\n' +
            'const C = await fin.finalizeAppRscResponse(new Response("ok", { headers: { "cache-control": "public, max-age=5" } }), req(), { configHeaders: CH });\n' +
            'console.log("RESULT " + JSON.stringify({ A: A.headers.get("cache-control"), B: B.headers.get("cache-control"), C: C.headers.get("cache-control"), D: D.headers.get("cache-control") }));\n',
        });
        const { result, output } = box.run([bunOnPath(), 'probe.mjs'], box.dir, {
          VINEXT_NEXT_DEPLOY_CACHE_CONTROL: '1',
        });
        const control = /^CONTROL (.*)$/m.exec(output)?.[1];
        if (control !== 'public, max-age=0, must-revalidate') {
          inconclusive(
            'bun-serve-cache-control',
            `the deploy switch did not normalise a COMPUTED shared policy: ${control}`,
          );
        }
        const { stillBroken, leaking } = cacheControlVerdict(
          JSON.parse(result) as Record<CacheShape, string | null>,
        );
        return {
          stillBroken,
          evidence: `computed policy → ${control}; still leaking s-maxage in [${leaking.join(',')}] of A(app-set)/B(config headers())/C(config over app-set)/D(marked, config already applied): ${result}`,
        };
      } finally {
        box.dispose();
      }
    },
  },
  {
    id: 'embed-extra-entrypoints',
    upstream: 'oven-sh/bun#44059',
    upstreamTitle: '--include embeds extra files',
    issue: '#1478',
    kind: 'shim',
    shape: 'both',
    against: 'bun',
    // Stock Bun has no `compile.include`, so compile-embed.mjs passes the
    // embed set as extra entrypoints. The same detection compile-embed runs at
    // build time decides here, with its controls (extra-entrypoint embed must
    // load, no embed must not). The probe is red once ANY landing shape embeds
    // — `compile.include` as a file list (what embedBuildOptions passes) or a
    // directory, or the CLI `--include=<dir>` — so a CLI-only landing is not
    // missed.
    repro: async () => {
      const detected = await detectCompileInclude();
      if (!detected.conclusive) inconclusive('embed-extra-entrypoints', detected.evidence);
      return { stillBroken: !detected.landed, evidence: detected.evidence };
    },
  },
  {
    id: 'bun-cjs-dirname-inlined',
    upstream: 'oven-sh/bun#44068',
    upstreamTitle: '__dirname/__filename in an included CommonJS entrypoint are inlined',
    fixedBy: {
      ref: 'oven-sh/bun#29066',
      title: 'Use the virtual $bunfs path for __dirname/__filename',
    },
    issue: '#1451',
    kind: 'constraint',
    shape: 'both',
    against: 'bun',
    // The bundler inlines `__dirname` in an embedded CommonJS module as the
    // BUILD directory, so `require(join(__dirname, x))` misses `$bunfs` from
    // an empty directory; compile-embed.mjs documents the constraint (CJS
    // trees use a RELATIVE computed require). Fixed by oven-sh/bun#29066
    // (verified on a from-source build: this probe flips).
    repro: () => dirnameInlinedRepro('bun-cjs-dirname-inlined'),
  },
  {
    id: 'bun-cjs-dirname-rebind',
    upstream: 'oven-sh/bun#44068',
    upstreamTitle: '__dirname/__filename in an included CommonJS entrypoint are inlined',
    fixedBy: {
      ref: 'oven-sh/bun#29066',
      title: 'Use the virtual $bunfs path for __dirname/__filename',
    },
    issue: '#1456',
    kind: 'shim',
    shape: 'next',
    against: 'bun',
    // The self-contained standalone build rebinds `__dirname`/`__filename` of
    // every embedded CommonJS module that uses them to its embedded path
    // (standalone-embed.mjs rebindDirnameSource) — the code form of the
    // constraint above, needed because Next's own modules and the turbopack
    // runtime anchor on `__dirname`. Same upstream bug, same oracle.
    repro: () => dirnameInlinedRepro('bun-cjs-dirname-rebind'),
  },
  {
    id: 'embedded-bare-specifier',
    upstream: 'oven-sh/bun#44101',
    upstreamTitle:
      'bun build --compile: a bare specifier required from an embedded module never resolves inside $bunfs',
    issue: '#1456',
    kind: 'shim',
    shape: 'next',
    against: 'bun',
    // A BARE specifier required from an embedded CommonJS chunk does not
    // resolve inside `$bunfs` — not even with the package's `package.json`
    // embedded and `autoloadPackageJson` on. The self-contained standalone
    // build therefore rewrites every import between embedded modules to a
    // relative path, and turbopack's hashed external aliases to absolute
    // embedded paths (standalone-compile.mjs resolveFromEmbedded,
    // standalone-embed.mjs rewriteExternalAliases). Filed upstream as
    // oven-sh/bun#44101 (not oven-sh/bun#44059 — that PR's own "explicitly
    // out of scope" note says it "does not touch resolver lookup order",
    // so it is not a candidate fix for this).
    //
    // NOT retirable on this probe alone even once #44101 lands: the rewrite
    // does two independent jobs, and BOTH must hold for the shim to go away.
    // (1) makes a bare specifier resolve (this probe's target) — but (2) it
    // also DEDUPES Next's `*.external` singletons (two embedded chunks
    // requiring the same module must share one instance, proven by the
    // mutation in the round-1 review: rewriting `relativeSpecifier` to a
    // non-shared path fails the self-contained compile closed). A bare
    // specifier resolving upstream would still load each embedded chunk's
    // own copy of a bare-required module rather than the ONE shared instance
    // the relative rewrite guarantees, so the rewrite stays load-bearing for
    // (2) independent of whether (1) is ever fixed.
    repro: async () => {
      const box = sandbox('bare-in-bunfs');
      try {
        box.write(
          {
            'main.cjs':
              'const { dirname, join } = require("node:path");\n' +
              'const root = dirname(process.argv[1]);\n' +
              'const c = require(join(root, "chunks", "c.js"));\n' +
              'let rel, bare;\n' +
              'try { rel = c.load("../node_modules/dep/index.js"); } catch (e) { rel = "fail " + String(e.message).split("\\n")[0]; }\n' +
              'try { bare = c.load("dep"); } catch (e) { bare = "fail " + String(e.message).split("\\n")[0]; }\n' +
              'console.log("RESULT " + JSON.stringify({ rel, bare }));\n',
            'chunks/c.cjs': 'exports.load = (n) => require(n);\n',
            'node_modules/dep/index.js': 'module.exports = "dep-ok";\n',
            'node_modules/dep/package.json': '{ "name": "dep", "main": "index.js" }\n',
            'assets.mjs':
              'import p from "./node_modules/dep/package.json" with { type: "file" };\nexport default p;\n',
          },
          'src',
        );
        const built = box.compile(
          'src',
          '{ entrypoints: ["./main.cjs", "./chunks/c.cjs", "./node_modules/dep/index.js", "./assets.mjs"], root: ".", target: "bun", format: "cjs", naming: { entry: "[dir]/[name].[ext]", asset: "[dir]/[name].[ext]" }, compile: { outfile: "../bin/app", autoloadPackageJson: true } }',
        );
        if (built.status !== 'built') inconclusive('embedded-bare-specifier', built.detail);
        box.remove('src');
        box.write({ '.keep': '' }, 'empty');
        const raw = box.run([join(box.dir, 'bin/app')], join(box.dir, 'empty')).result;
        const { rel, bare } = JSON.parse(raw) as { rel: string; bare: string };
        // Control: the package IS embedded — a relative computed require from
        // the same chunk reaches it — so a bare miss is resolution alone.
        if (rel !== 'dep-ok') inconclusive('embedded-bare-specifier', `relative require: ${raw}`);
        if (bare !== 'dep-ok' && !/^fail Cannot find (?:module|package)/.test(bare))
          inconclusive('embedded-bare-specifier', `bare require failed oddly: ${raw}`);
        return {
          stillBroken: bare !== 'dep-ok',
          evidence: `relative require of the embedded package → ${rel}; require("dep") from the embedded chunk → ${bare}`,
        };
      } finally {
        box.dispose();
      }
    },
  },
  {
    id: 'bunfs-static-disk-alias',
    upstream: 'oven-sh/bun#22223',
    upstreamTitle: '`readdir` and `createReadStream` support inside `$bunfs`',
    issue: '#1456',
    kind: 'shim',
    shape: 'next',
    against: 'bun',
    // Next serves `.next/static` through `send` (fs.stat + createReadStream)
    // and derives it from `distDir`, which the self-contained build points into
    // the executable. createReadStream of an embedded file fails, so static
    // files stay on disk and the entry aliases `<embedded distDir>/static` (and
    // `/cache`, which Next writes) to the disk beside the binary
    // (standalone-embed.mjs installDistDirAlias). The Next half — a supported
    // way to put the static and cache roots somewhere other than `distDir` —
    // is drafted in .claude/research/n1-nextjs-distdir-ask-DRAFT.md.
    //
    // The shim covers THREE distinct `$bunfs` gaps, not one, so the probe
    // covers all three — a partial upstream fix (e.g. #22223 alone) must still
    // report `stillBroken`, since the shim would still be load-bearing for the
    // other two:
    //   1. createReadStream of an embedded file (oven-sh/bun#22223 itself);
    //   2. a WRITE under an embedded path (`.next/cache`, which Next writes at
    //      runtime) — `$bunfs` is a baked-in virtual filesystem and can never
    //      accept a write, upstream or not; this half of the shim is permanent;
    //   3. an embedded EXTENSIONLESS file (`BUILD_ID`): Bun's own asset naming
    //      appends a trailing dot to a name with no extension, so the runtime
    //      must ask for `BUILD_ID.`, not `BUILD_ID` — a naming quirk, not a
    //      missing capability, and independent of (1).
    repro: async () => {
      const box = sandbox('22223');
      try {
        box.write(
          {
            'main.cjs':
              'const fs = require("node:fs"), { dirname, join } = require("node:path");\n' +
              'const dir = dirname(process.argv[1]);\n' +
              'const f = join(dir, "static", "a.txt");\n' +
              'let read; try { read = fs.readFileSync(f, "utf8").trim(); } catch (e) { read = "fail " + e.code; }\n' +
              'let chunks = ""; fs.createReadStream(f).on("data", (c) => { chunks += c; })\n' +
              '  .on("end", () => afterStream(chunks.trim()))\n' +
              '  .on("error", (e) => afterStream("fail " + e.code));\n' +
              'function afterStream(stream) {\n' +
              '  const cacheFile = join(dir, "cache", "x.bin");\n' +
              '  let write; try { fs.writeFileSync(cacheFile, "w"); write = "wrote"; } catch (e) { write = "fail " + e.code; }\n' +
              '  const idFile = join(dir, "BUILD_ID");\n' +
              '  let ext; try { ext = fs.readFileSync(idFile, "utf8").trim(); } catch (e) { ext = "fail " + e.code; }\n' +
              '  console.log("RESULT " + JSON.stringify({ read, stream, write, ext }));\n' +
              '}\n',
            'static/a.txt': 'static-ok\n',
            BUILD_ID: 'id-ok\n',
            'assets.mjs':
              'import a from "./static/a.txt" with { type: "file" };\nimport b from "./BUILD_ID" with { type: "file" };\nexport default [a, b];\n',
          },
          'src',
        );
        const built = box.compile(
          'src',
          '{ entrypoints: ["./main.cjs", "./assets.mjs"], root: ".", target: "bun", format: "cjs", naming: { entry: "[dir]/[name].[ext]", asset: "[dir]/[name].[ext]" }, compile: { outfile: "../bin/app" } }',
        );
        if (built.status !== 'built') inconclusive('bunfs-static-disk-alias', built.detail);
        box.remove('src');
        box.write({ '.keep': '' }, 'empty');
        const raw = box.run([join(box.dir, 'bin/app')], join(box.dir, 'empty')).result;
        const { read, stream, write, ext } = JSON.parse(raw) as {
          read: string;
          stream: string;
          write: string;
          ext: string;
        };
        // Control: the files ARE embedded and readable with readFileSync.
        if (read !== 'static-ok') inconclusive('bunfs-static-disk-alias', `readFileSync: ${raw}`);
        const streamBroken = stream !== 'static-ok';
        const extensionlessBroken = ext !== 'id-ok';
        // The write leg (`write`) is deliberately excluded from `stillBroken`:
        // gap (2), a write under an embedded `$bunfs` path, is permanent by
        // design (a
        // baked-in virtual filesystem can never accept a write, upstream or
        // not) — there is no upstream fix that could ever retire it. ORing it
        // in would make this probe report `stillBroken: true` forever even
        // after (1) and (3) are both fixed, permanently masking a real
        // retirement of the read-side shim. It stays in `evidence` so a
        // regression in the disk-write fallback is still visible.
        return {
          stillBroken: streamBroken || extensionlessBroken,
          evidence: `createReadStream → ${stream}; write under an embedded path (permanent, not gating) → ${write}; extensionless read (no trailing-dot alias) → ${ext}`,
        };
      } finally {
        box.dispose();
      }
    },
  },
  {
    id: 'bun-json-asset-require',
    upstream: 'oven-sh/bun#44095',
    upstreamTitle: 'require() of an embedded JSON file asset evaluates it as JavaScript',
    issue: '#1456',
    kind: 'shim',
    shape: 'next',
    against: 'bun',
    // `require()` of an embedded JSON `type: "file"` asset evaluates its bytes as a
    // JavaScript module body (a SyntaxError on the first `:`) instead of going
    // through the `.json` loader a disk `require()` uses. Next `require`s some
    // manifests by absolute path, so the self-contained entry installs a
    // `Module.prototype.require` hook that answers `.json` paths under the
    // embedded root from the file's bytes, parsed and cached like a real
    // `require` (standalone-embed.mjs installEmbeddedJsonRequire).
    repro: async () => {
      const box = sandbox('bun-json-asset-require');
      try {
        box.write(
          {
            'main.cjs':
              'const { dirname, join } = require("node:path");\n' +
              'const p = join(dirname(process.argv[1]), "data", "m.json");\n' +
              'const disk = require("node:fs").readFileSync(p, "utf8").trim();\n' +
              'let req; try { req = JSON.stringify(require(p)); } catch (e) { req = "fail " + String(e.message).split("\\n")[0]; }\n' +
              'console.log("RESULT " + JSON.stringify({ disk, req }));\n',
            'assets.mjs':
              'import m from "./data/m.json" with { type: "file" };\nexport default m;\n',
            'data/m.json': '{"a":1}',
          },
          'src',
        );
        const built = box.compile(
          'src',
          '{ entrypoints: ["./main.cjs", "./assets.mjs"], root: ".", target: "bun", format: "cjs", naming: { entry: "[dir]/[name].[ext]", asset: "[dir]/[name].[ext]" }, compile: { outfile: "../bin/app" } }',
        );
        if (built.status !== 'built') inconclusive('bun-json-asset-require', built.detail);
        box.remove('src');
        box.write({ '.keep': '' }, 'empty');
        const raw = box.run([join(box.dir, 'bin/app')], join(box.dir, 'empty')).result;
        const { disk, req } = JSON.parse(raw) as { disk: string; req: string };
        // Control: the file IS embedded and readable byte-for-byte with fs.
        if (disk !== '{"a":1}') inconclusive('bun-json-asset-require', `readFileSync: ${raw}`);
        return {
          stillBroken: req !== '{"a":1}',
          evidence: `readFileSync of the embedded JSON asset → ${disk}; require() of the same path → ${req}`,
        };
      } finally {
        box.dispose();
      }
    },
  },
  {
    id: 'bun-asset-extensionless-dot',
    upstream: 'oven-sh/bun#44096',
    upstreamTitle: 'embeds an extensionless file with a trailing dot',
    issue: '#1456',
    kind: 'shim',
    shape: 'next',
    against: 'bun',
    // With `naming.asset: "[dir]/[name].[ext]"`, an embedded file with no
    // extension is emitted with a trailing dot (`BUILD_ID` → `BUILD_ID.`) instead
    // of its own name — `[ext]` always expands with its leading `.` even when
    // empty. Next reads `.next/BUILD_ID` with `fs`, so the self-contained entry
    // aliases the app's extensionless embedded paths to the dotted name Bun
    // actually gives them (standalone-exec-entry.mjs selfContainedPrologue,
    // installed by standalone-embed.mjs installDistDirAlias).
    repro: async () => {
      const box = sandbox('bun-asset-extensionless-dot');
      try {
        box.write(
          {
            'main.cjs':
              'const fs = require("node:fs");\n' +
              'const { dirname } = require("node:path");\n' +
              // `root` is joined with a literal "./" (not `path.join`, which would
              // normalize the "." away): with `naming.asset: "[dir]/[name].[ext]"`
              // and `root: "."`, Bun embeds these assets one level down, under an
              // actual directory named ".", so the check must reach past it.
              'const root = dirname(process.argv[1]) + "/./";\n' +
              'const e1 = fs.existsSync(root + "BUILD_ID");\n' +
              'const e2 = fs.existsSync(root + "BUILD_ID.");\n' +
              'const j1 = fs.existsSync(root + "x.json");\n' +
              'console.log("RESULT " + JSON.stringify({ e1, e2, j1 }));\n',
            'assets.mjs':
              'import a from "./BUILD_ID" with { type: "file" };\nimport b from "./x.json" with { type: "file" };\nexport default [a, b];\n',
            BUILD_ID: 'buildid-content',
            'x.json': '{"a":1}',
          },
          'src',
        );
        const built = box.compile(
          'src',
          '{ entrypoints: ["./main.cjs", "./assets.mjs"], root: ".", target: "bun", naming: { entry: "[dir]/[name].[ext]", asset: "[dir]/[name].[ext]" }, compile: { outfile: "../bin/app" } }',
        );
        if (built.status !== 'built') inconclusive('bun-asset-extensionless-dot', built.detail);
        box.remove('src');
        box.write({ '.keep': '' }, 'empty');
        const raw = box.run([join(box.dir, 'bin/app')], join(box.dir, 'empty')).result;
        const { e1, e2, j1 } = JSON.parse(raw) as { e1: boolean; e2: boolean; j1: boolean };
        // Control: the extensioned asset embeds under its own correct name.
        if (!j1)
          inconclusive('bun-asset-extensionless-dot', `x.json missing at its own name: ${raw}`);
        return {
          stillBroken: !e1 && e2,
          evidence: `BUILD_ID present under its own name → ${e1}; BUILD_ID. (trailing dot) present → ${e2}; x.json present under its own name → ${j1}`,
        };
      } finally {
        box.dispose();
      }
    },
  },
];
