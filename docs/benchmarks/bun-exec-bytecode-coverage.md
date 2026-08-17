# bun-exec bytecode coverage and image floor (ADR-0042 Phase 3(d))

**Run date:** 2026-08-17. **Host:** darwin/arm64, OrbStack docker 29.4.0 (aarch64 Linux VM).
**Toolchain:** bun 1.3.5, `vinext@1.0.0-beta.4`, `nitro@3.0.260610-beta`, vite 8.
**Artifact:** `examples/bun-exec`, built by `./build.sh linux-arm64` — the shipped recipe, unmodified.

This record closes ADR-0042 **Phase 3(d)** items 1–3 and supplies the evidence for
**Escalation 2′ / A12** ("does the flip stand if the application is not bytecode-compiled?").
It does **not** close Phase 1 — see *What this is not* at the bottom.

## Headline

| Question | Answer | Evidence |
|---|---|---|
| Is the application embedded in the binary? | **Yes** | container e2e, `.output/server` absent from the image, dynamic SSR 200 |
| Is the application bytecode-compiled (not just the shell)? | **Yes** | +6.06 MB payload, and the boot win lands in app-module evaluation |
| Cold time-to-first-dynamic-SSR | **70 ms** (vs 169 ms without `--bytecode`) | in-container, 5 samples each |
| Can the image be ~5 MB? | **No — floor is 92 MB** | an *empty* `--compile` binary is 92,025,917 B |

## 1. The application IS in the binary

`bun run test:image` (`examples/bun-exec/test/alpine-image.docker-e2e.test.ts`) — **10/10 passed**,
184 s. The suite builds the binary unconditionally, builds the image, and probes it in a container.
Two of its assertions together are the embedding proof:

- `.output/server` is asserted **absent** from the image (`Dockerfile` copies only the binary and
  `.output/public`), and
- `/item/42` — a **dynamic** SSR route — returns 200 with the rendered body, `/api/echo/hello`
  returns its JSON, and the page's own `/_next/static/…js` chunk is served.

There is no `_ssr/`, `_chunks/` or `_libs/` directory anywhere in the image, so the modules serving
those responses can only have come from the binary. Independently reproduced on a `FROM scratch`
image containing **only** three shared libraries, `/app/server` and `/app/.output/public`:

```
/api/health      -> 200 {"status":"ok","target":"bun-exec"}
/                -> 200 (SSR HTML)
/item/42         -> 200 (contains item:<!-- -->42)
/api/echo/hello  -> 200 {"echoed":"hello"}
/_next/static/chunks/index-79w3gekz.js -> 200 text/javascript 184281 bytes
```

### Why this does not contradict #658 — it is a different entry

ADR-0042 Consequence 11 ("the application is not in the binary") was measured against beta.4's
**`prod-server.js`** path, which computes `rscEntryPath = <outDir>/server/index.js` and `import()`s
it — a dynamic import of a *computed* path, unbundleable by construction. That finding stands **for
that entry**.

knext does not ship that entry. `build.sh` compiles nitro's `.output/server/index.mjs`, and there the
app is reached through a **literal** specifier:

```js
ie = n(() => import(`./_chunks/ssr-renderer.mjs`))   // .output/server/index.mjs
```

A literal dynamic import **is** followed by bun's bundler and embedded. The mechanism is nitro's, not
vinext's: nitro pre-bundles the app into `_ssr/`+`_chunks/` and references them literally.
So Consequence 11 was scoped to the wrong artifact, not wrong — corrected in the ADR rather than
deleted, because the `prod-server` result is still true of `prod-server`.

## 2. The bytecode covers the APPLICATION, not just the shell

Three builds of the same `.output/server/index.mjs`, differing only in flags
(`--target=bun-linux-arm64-musl`):

| Build | Binary bytes | App payload over the runtime floor |
|---|---|---|
| empty entry (`export{}`) — the Bun runtime floor | 92,025,917 | — |
| `--compile --minify` (no bytecode) | 92,733,544 | 707,627 B |
| `--compile --minify --bytecode` (**shipped**) | 98,789,510 | 6,763,593 B |
| `--compile --bytecode` (no minify) | 99,493,437 | 7,467,520 B |

**`--bytecode` adds 6,055,966 B on 707,627 B of embedded source — 8.6×.** Shell-only bytecode on a
3-line entry could not produce a 6 MB delta; this is bytecode across the embedded module graph.

The timing separates shell from application, which is the part that answers A12. Both measured
in-container from `/proc/uptime` before `exec` to the observed event, 5 samples, median:

| | boot → `LISTENING` | boot → first **dynamic-SSR** 200 |
|---|---|---|
| `--bytecode` (shipped) | **39 ms** | **70 ms** |
| no bytecode | 59 ms | 169 ms |
| delta | 20 ms | **99 ms** |

The SSR renderer is loaded by the lazy `import()` above — i.e. **on first request, not at boot**.
Only 20 ms of the 99 ms saving is available before `LISTENING`; the remaining **79 ms is app-module
evaluation**. Bytecode that covered only the shell could not move that number.

Raw samples (ms): bytecode `70 70 70 139 180`; no bytecode `100 139 169 180 329`.

### What is NOT evidence, recorded so it is not reused

`strings -a <binary> | grep -c 'bytecode\|CodeBlock\|UnlinkedProgramCodeBlock'` gives **231** for the
bytecode build and **227** for the no-bytecode build. It does not discriminate — Bun's own embedded
runtime carries JSC symbols either way. The claim rests on the two deltas above, not on this grep.

## 3. Image floor — the "5 MB alpine" premise, quantified

| Image shape | on-disk | gzipped (what an image pull costs) |
|---|---|---|
| `alpine:3.22` + `libstdc++`/`libgcc` (**shipped**) | 111 MB | 46,279,692 B |
| same, no `--bytecode` | 105 MB | 44,312,436 B |
| `FROM scratch` + 3 `.so` files | **103 MB** | **42,491,491 B** |

**92,025,917 B of every one of those is the Bun runtime**, embedded by `--compile` — 89% of the
`scratch` image. The application contributes ~6.8 MB and the static assets 396 KB. No base-image
choice can reach 5 MB; the only lever that would is not using `--compile`, which is the feature.

`scratch` is viable and was **proved serving** (§1). It saves 8 MB on-disk / 3.8 MB per pull (8.2%)
and costs the in-container shell, so `docker exec ls` / `ldd` assertions in the e2e must be rewritten
against layer contents. Recorded as a measured option, **not adopted here** — see the follow-up issue.

The three libraries are exactly `ldd` output, so the list is derived, not guessed:
`/lib/ld-musl-aarch64.so.1` (also answers `libc.musl-aarch64.so.1`), `/usr/lib/libstdc++.so.6`,
`/usr/lib/libgcc_s.so.1`.

## What this is not

- **Not an A/B against the node path, and not a Phase 1 result.** No `node+turbopack` arm was run
  here; the 169 ms column is the *same* vinext artifact minus one flag, which is what isolates
  bytecode and nothing else. ADR-0036's five re-open conditions are not claimed.
- **Not an OKE number.** This is a local ARM VM with a warm page cache and no image pull. The most
  recent OKE data has cold start **scheduling-bound on a 2-node cluster, not boot-bound**, so a 70 ms
  runtime boot does not predict an end-to-end cold start there — and a 42–46 MB pull is a cost this
  measurement does not include. The honest reading: the *runtime-boot component* collapses from the
  ~1957 ms Next-standalone floor that motivated ADR-0036 to ~70 ms; whether that is visible
  end-to-end on Knative is a separate measurement that must happen on OKE.
- **Not a compat result.** Five routes on one sample app. Phase 2's `KNEXT_BUILD=vinext` lane and the
  `compat-smoke` build-axis parameterisation remain unbuilt, and no ✅ row in
  `docs/compat-matrix.md` is backed on this target.
- **Not a generalisation to large apps.** The embedding mechanism (nitro literal-specifier chunks)
  should hold at any size, but it was verified on a 5-route app; bytecode size grows with the module
  graph and 6 MB is this app's figure, not a constant.

## Reproducing

```bash
cd examples/bun-exec
bun run test:image                       # §1, builds + probes in a container
./build.sh linux-arm64                   # the shipped binary
bun build --compile --minify --target=bun-linux-arm64-musl \
  .output/server/index.mjs --outfile /tmp/nobc     # the no-bytecode control
echo 'export{}' > /tmp/empty.mjs && bun build --compile --minify --bytecode \
  --target=bun-linux-arm64-musl /tmp/empty.mjs --outfile /tmp/empty   # the runtime floor
```

Timing script (run as the container's entrypoint, `sh -s <`), polling with busybox `nc` so the
measurement needs nothing added to the image:

```sh
read A _ < /proc/uptime
/app/server > /tmp/l 2>&1 & P=$!
while :; do
  case "$(printf 'GET /item/42 HTTP/1.0\r\nHost: x\r\n\r\n' | nc 127.0.0.1 3000 | head -1)" in
    *200*) read B _ < /proc/uptime
           awk -v a="$A" -v b="$B" 'BEGIN{printf "%d\n",(b-a)*1000}'; kill -9 $P; exit 0;;
  esac
done
```

`/proc/uptime` is not namespaced, so it is a usable monotonic clock inside the container at 10 ms
resolution; busybox `date` has no `%N`, which is why it is not used.
