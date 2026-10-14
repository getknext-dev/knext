# ELF fixtures for the libc check

Three tiny real shared libraries, built from `f.c`, used by `elf.test.ts` and
`ffi-build.test.ts` to prove the `DT_NEEDED` check reads what a real linker
writes. Each links libc explicitly (`--no-as-needed -lc`), so libc is in its
`DT_NEEDED` list.

| File | Built in | `DT_NEEDED` |
|---|---|---|
| `libmusl_x64.so` | `alpine:3.20`, linux/amd64 | `libc.musl-x86_64.so.1` |
| `libmusl_arm64.so` | `alpine:3.20`, linux/arm64 | `libc.musl-aarch64.so.1` |
| `libglibc_x64.so` | `debian:bookworm-slim`, linux/amd64 | `libc.so.6` |

Rebuild (from this directory):

```sh
# Alpine (musl): apk add gcc musl-dev
gcc -shared -fPIC -Os -s -Wl,--build-id=none -Wl,-z,max-page-size=4096 \
    -Wl,--no-as-needed -lc f.c -o libmusl_<arch>.so
# Debian (glibc): apt-get install gcc libc6-dev
gcc -shared -fPIC -Os -s -Wl,--build-id=none -Wl,--no-as-needed -lc f.c -o libglibc_x64.so
```
