# The e2e zone's image (see server.ts). TEST HARNESS ONLY: it stands in for a
# built Next.js zone so the Z7 kind e2e can call functions through the real
# generated glue and the real signer. Built by run.sh from the context
# build.ts writes (this file + zone-caller.mjs); never published.
#
# node:24-alpine, digest-pinned to the same index the repo's other images use.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
# NODE_ENV=production: the published cache seams refuse under it, and every app
# runtime image sets it (tests/runtime-image-node-env.test.ts).
ENV NODE_ENV=production
WORKDIR /app
# --chmod: the build context is written by a script that runs under umask 077, and
# the app runs as uid 1000 (`node`), which must be able to read its own bundle.
COPY --chmod=0444 zone-caller.mjs ./
# Numeric, not `node`: the operator renders runAsNonRoot, and the kubelet cannot
# verify a named user is non-root. 1000:1000 is the `node` user of this base image.
USER 1000:1000
EXPOSE 3000
ENTRYPOINT ["node", "/app/zone-caller.mjs"]
