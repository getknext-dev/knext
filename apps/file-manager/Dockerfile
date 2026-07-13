# Stage 1: Build Next.js app with standalone output
#
# Base image is DIGEST-PINNED (not the floating node:22-alpine tag) so the CVE
# surface of the image we sign cannot change under us via an unreviewed upstream
# push. The human-readable tag is kept in this comment block (Docker rejects
# trailing/inline comments on a FROM line); refresh both the digest and this
# comment together when bumping. Resolve a new digest with:
#   docker buildx imagetools inspect node:22-alpine
# Enforced by scripts/check-base-images-pinned.sh (CI: base-image-pin-guard).
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS builder
# Reproducible-build input (best effort): the CI supply-chain workflow passes the
# commit time here. Declared so build-push-action doesn't warn on an unknown ARG.
# NOT yet a full reproducibility guarantee — see docs/security/threat-model.md.
ARG SOURCE_DATE_EPOCH
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# Build the workspace lib (@knext/lib ships only dist/) BEFORE the app, in a
# SEPARATE step so its dist/ is fully emitted before `next build` resolves it.
# (A combined recursive build can race the app's build ahead of the lib's emit.)
RUN pnpm --filter "@knext/lib" build
# @knext/db ships only dist/ and depends on @knext/lib; @knext/core type-imports it
# (the `kn-next db migrate` runner lives in @knext/db/migrate, #242), so db must be
# built after lib and before core or core's dts build hard-fails (TS2307).
RUN pnpm --filter "@knext/db" build
# @knext/core also ships only dist/ and its exports resolve to ./dist/* (#114);
# file-manager imports @knext/core (adapter + KnativeNextConfig), so core must be
# built (after lib + db, whose types core's build needs) BEFORE `next build`
# resolves it from dist. Order: lib → db → core → file-manager.
RUN pnpm --filter "@knext/core" build
RUN pnpm --filter file-manager build

# Produce a SELF-CONTAINED @knext/core for the runner. The container CMD boots the
# knext runtime entry (`@knext/core/internal/node-server`), but Next's standalone
# output is import-graph driven and NOTHING in app code imports node-server.js — so
# neither node-server.js, its build chunks, NOR its hard runtime deps (prom-client,
# pino) land in `.next/standalone`. Without this the image's CMD resolves
# `@knext/core/internal/node-server` → MODULE_NOT_FOUND and crash-loops at boot.
#
# `pnpm deploy --prod` emits a flat, self-contained package dir (dist + a real
# node_modules with prom-client/pino resolved) that we drop into the runner at
# node_modules/@knext/core, so the package specifier resolves with its deps.
RUN pnpm --filter "@knext/core" --prod deploy --legacy /knext-core-runtime

# Prune BUILD TOOLING that `pnpm deploy --prod` wrongly carries into the runtime
# package. @knext/db declares drizzle-kit as an OPTIONAL peerDependency and pnpm
# resolves it from the workspace (it is db's devDependency), so the deployed
# "prod" tree ships drizzle-kit's dependency graph: @esbuild-kit/esm-loader →
# esbuild@0.18.20 (a Go 1.20.7-built binary — 20 HIGH/CRITICAL Go-stdlib
# findings, 2 CRITICAL), drizzle-kit's own esbuild@0.25.12 (Go 1.23.12 — 15
# findings), tsx → esbuild@0.28.0, and @drizzle-team/brocli. None of it is
# runtime code: this image's CMD only boots @knext/core/internal/node-server
# (prom-client + pino); `kn-next db migrate` runs CLI-side in the app's own
# tree, never inside this image. Same discipline as the npm/corepack strip in
# the runner stage below (#199): remove what we don't run, don't suppress the
# scanner. Guarded by tests/supply-chain-workflow.test.ts. The trailing
# `! find …` is a self-check: fail the build if any esbuild binary survives.
RUN rm -rf /knext-core-runtime/node_modules/.pnpm/esbuild@* \
    /knext-core-runtime/node_modules/.pnpm/@esbuild+* \
    /knext-core-runtime/node_modules/.pnpm/@esbuild-kit+* \
    /knext-core-runtime/node_modules/.pnpm/tsx@* \
    /knext-core-runtime/node_modules/.pnpm/drizzle-kit@* \
    /knext-core-runtime/node_modules/.pnpm/@drizzle-team+* \
    /knext-core-runtime/node_modules/.bin/tsx \
    /knext-core-runtime/node_modules/.bin/esbuild \
    /knext-core-runtime/node_modules/.bin/drizzle-kit \
    && ! find /knext-core-runtime -type f -name esbuild -path '*bin*' | grep -q .

# Build a clean, flat, production-only sharp install for THIS platform (musl) that
# the runner stage can copy verbatim into the app's node_modules. We do NOT rely on
# Next's standalone trace to carry sharp: Next's image optimizer require()s sharp
# lazily at runtime, and with pnpm's symlinked store the node-file-trace step does
# not reliably include sharp + its @img/sharp-* native platform packages — that is
# exactly why `require('sharp')` failed in the runner before (#66). The builder is
# already node:22-alpine (linux/musl), so `npm install` here resolves the correct
# @img/sharp-linuxmusl-* prebuilt + bundled libvips for the runner's musl arch.
# Pin to the same major as apps/file-manager/package.json ("sharp": "^0.35.2").
RUN mkdir -p /sharp-runtime \
    && cd /sharp-runtime \
    && npm init -y >/dev/null 2>&1 \
    && npm install --no-audit --no-fund --omit=dev sharp@^0.35.2 \
    && node -e "const s=require('/sharp-runtime/node_modules/sharp');console.log('builder sharp ok: libvips '+s.versions.vips)"

# Stage 2: Lean production image using Node.js standalone output.
# Digest-pinned (same digest as the builder stage); see the builder FROM above.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install curl for healthcheck. sharp 0.35's musl prebuilt (@img/sharp-linuxmusl-*)
# bundles its own libvips, so the `vips` apk package is NOT strictly required; we keep
# it as a defensive fallback for any code path that prefers a global libvips. (#66 AC#3.)
#
# `apk upgrade --no-cache` first: the digest-pinned base freezes the provenance of
# the base bytes, but apk security fixes published AFTER that digest (e.g. c-ares
# 1.34.8-r0 for CVE-2026-33630, pulled in via libcurl) would otherwise trip the
# Trivy HIGH/CRITICAL gate until the next digest bump. The upgrade only pulls
# published fixes from the SAME pinned alpine stable branch — it cannot float
# the base to a different alpine release. Policy: docs/security/threat-model.md
# §4 "Patching policy" (#267).
RUN apk upgrade --no-cache && apk add --no-cache curl vips

# Strip the package managers from the RUNTIME image (#199). The standalone server
# never runs npm/corepack/yarn (the CMD is a bare `node`), and node:alpine's BUNDLED
# npm ships dependencies Trivy rightly flags in the image we sign — sigstore 3.1.0
# (CVE-2026-48815, HIGH) and picomatch 4.0.3 (CVE-2026-33671, HIGH) under
# /usr/local/lib/node_modules/npm. Removing them clears those findings and shrinks
# the runtime surface without touching the app dependency tree. (The builder stage
# keeps its npm/pnpm — it never ships.) Guarded by tests/supply-chain-workflow.test.ts.
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# node:22-alpine already ships a non-root `node` user/group at uid/gid 1000;
# recreating it fails ("group 'node' in use"). Reuse the existing user.

# Copy standalone server bundle (includes node_modules trace)
COPY --from=builder /app/apps/file-manager/.next/standalone ./
# Copy static assets served locally (non-CDN fallback)
COPY --from=builder /app/apps/file-manager/.next/static ./apps/file-manager/.next/static
# Copy public assets
COPY --from=builder /app/apps/file-manager/public ./apps/file-manager/public
# Copy the self-contained knext runtime package (node-server entry + its prod deps:
# prom-client, pino). Placed at node_modules/@knext/core so the CMD's
# `@knext/core/internal/node-server` specifier resolves from /app with its own
# nested node_modules — the standalone trace omits it (see builder stage).
COPY --from=builder /knext-core-runtime ./node_modules/@knext/core

# Place the flat musl sharp install — sharp itself, its @img native platform
# packages, AND sharp's own runtime deps (detect-libc, semver, color, …) — into the
# app's node_modules so `require('sharp')` (resolved from server.js) finds it. This is
# the fix for #66: the standalone trace alone does not carry sharp's native runtime.
# We copy the WHOLE flat tree (not just sharp + @img) because sharp require()s
# detect-libc at load time, which is a sibling in the flat install; copying only
# sharp/@img leaves it with "Cannot find module 'detect-libc'". COPY merges into the
# existing traced node_modules without clobbering the app's own modules.
COPY --from=builder /sharp-runtime/node_modules/ ./apps/file-manager/node_modules/

# Verify sharp's native (musl) runtime actually loads in THIS image — fail the
# build now rather than 500ing at request time on /_next/image. The standalone
# trace places sharp under the app's node_modules; resolve from there. (#66 AC#3.)
RUN node -e "const{createRequire}=require('module');const r=createRequire('/app/apps/file-manager/server.js');const s=r('sharp');console.log('sharp ok: libvips '+s.versions.vips)" \
    || (echo 'FATAL: sharp failed to load — next/image optimization is broken in this image (missing libvips/musl runtime?)' && exit 1)

# Pre-create the compile-cache directory
RUN mkdir -p apps/file-manager/.next/compile-cache && chown -R node:node apps/file-manager/.next

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

# Drop privileges
USER node

# Runtime entry: boot the knext runtime (@knext/core node-server), NOT bare
# `node server.js`. The runtime entry is the ONLY thing that (1) installs the
# SIGTERM handler that forwards the signal so Next drains in-flight requests +
# runs `after()` callbacks on scale-down (security.md graceful shutdown), and
# (2) serves the Prometheus metrics sidecar on :9091. Bare-exec'ing server.js
# bypasses both, so a real knext deploy must run the runtime entry — matching
# how the operator-managed image runs. The entry then SPAWNS server.js itself.
#
# @knext/core is COPY'd into node_modules/@knext/core as a self-contained package
# (the runner stage above — Next's standalone trace omits node-server.js + its
# prom-client/pino deps), so the package specifier resolves via its `exports` map
# (./internal/node-server) with its own nested node_modules.
# The container layout puts server.js at apps/file-manager/server.js, so we tell
# the runtime entry where it is via STANDALONE_SERVER_PATH (its default,
# .next/standalone/server.js, is the single-app layout).
#
# NODE_COMPILE_CACHE: V8 bytecode cache for faster subsequent cold starts.
# EXPORT so the value reaches the exec'd node process (a bare `${VAR:=default}` only sets a shell
# variable, not an env var). The operator's externally-injected value (PVC path) still wins via
# `:-`; the Dockerfile only supplies the fallback when the env var is unset at runtime.
CMD ["sh", "-c", "export NODE_COMPILE_CACHE=\"${NODE_COMPILE_CACHE:-apps/file-manager/.next/compile-cache}\"; export STANDALONE_SERVER_PATH=\"${STANDALONE_SERVER_PATH:-apps/file-manager/server.js}\"; exec node -e \"import('@knext/core/internal/node-server')\""]
