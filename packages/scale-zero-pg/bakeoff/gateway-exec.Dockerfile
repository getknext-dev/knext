# Bake-off exec-mode gateway image.
#
# This does NOT rebuild the gateway. It copies the BYTE-IDENTICAL /gateway binary
# out of the production image (scale-zero-pg/gateway:dev) and re-bases it onto a
# runtime that has the two things exec-mode needs at runtime and that the
# production distroless image deliberately omits: a POSIX shell (execDriver runs
# `/bin/sh -c $GW_WAKE_CMD`) and `kubectl` (to toggle the CNPG hibernation
# annotation). The Go code is unchanged — this is the honest proof that the same
# gateway fronts a completely different foundation (CNPG) via a different driver
# mode, with zero source changes.
FROM scale-zero-pg/gateway:dev AS gw

FROM alpine:3.20
RUN apk add --no-cache ca-certificates curl \
 && curl -fsSL -o /usr/local/bin/kubectl \
      https://dl.k8s.io/release/v1.29.2/bin/linux/arm64/kubectl \
 && chmod +x /usr/local/bin/kubectl \
 && apk del curl
COPY --from=gw /gateway /gateway
EXPOSE 55432 9090
ENTRYPOINT ["/gateway"]
