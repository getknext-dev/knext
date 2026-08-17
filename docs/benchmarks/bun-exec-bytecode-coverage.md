# bun-exec bytecode coverage and image floor (ADR-0042 Phase 3(d))

**Run date:** 2026-08-17. **Host:** darwin/arm64, OrbStack docker 29.4.0 (aarch64 Linux VM).
**Toolchain:** bun 1.3.5, `vinext@1.0.0-beta.4`, `nitro@3.0.260610-beta`, vite 8.
**Artifact:** `examples/bun-exec`, built by `./build.sh linux-arm64` — the shipped recipe, unmodified.

## Read this first — most of Phase 3(d) was ALREADY measured

**This is a replication and an extension, not a first measurement.** Phase 3(d) was measured on
**2026-08-08/09** and recorded in `docs/adr/gates/adr-0042-gates.json` (phase `3d`), by a better
method than the one used here:

| Criterion | Measured then | By |
|---|---|---|
| P3d-1 `--bytecode` verified | **true** | payload isolated after the shared ~92 MB runtime prefix, then characterised: control 100% printable / 0% nulls, bytecode 9.46× larger / 30.1% printable / 33.3% nulls |
| P3d-2 coverage on cold first request | **34/34 = 100% from the binary** | `strace -ff -e trace=file` on the as-shipped image, **with a non-vacuity control** |
| P3d-2b is bytecode most of the win? | **~33% of cold boot** | ABBA interleaved, 15 blocks → **30 paired comparisons, 30 faster / 0 slower**, paired median −29 ms |
| P3d-3 standalone shape | **still unmeasured** | beta.4 emits no `dist/standalone` on this config — #658 measured a shape `build.sh` does not build |

It was re-run on 2026-08-17 because the ADR **prose** said 3(d) was "NEW, and it gates Phase 1" and
the phase's `status` field read `NOT_STARTED`, while its criteria carried measured values. The prose
was read and the gate file was not. The status is now corrected; this section stays as the reason it
was wrong to trust the prose.

**What 2026-08-17 actually adds**, and it is narrower than this document's first draft claimed:

1. **Closes P3d-1's own stated caveat** — "extracted from a LOCALLY BUILT image … closing that link
   needs a published image." Now done against the **registry-pulled deployed digest**, on the **x64
   ship target** rather than arm64.
2. **Independent replication by a different instrument** (size subtraction, no `strace`): +6,056,134 B
   on x64 vs +6,055,969 B on arm64 — agreement within 168 bytes.
3. **The embedding mechanism**, which explains why the two shapes disagree (literal vs computed
   dynamic-import specifier) — the gate file recorded the *contradiction*, not the *cause*.
4. **The image floor**, attributed: 92 MB of the image is the Bun runtime.
5. **The A/B's same-app precondition**, read from both deployed digests.
6. **Guards** — nothing asserted the build flags before.

It does **not** close Phase 1 — see *What this is not* at the bottom.

## Headline

| Question | Answer | Strongest evidence (and when) |
|---|---|---|
| Is the application embedded in the binary? | **Yes** | **34/34 modules from the binary, 0 from disk** — `strace`, 2026-08-08. Corroborated 2026-08-17 by a container e2e and a `FROM scratch` image with no `_ssr/`/`_chunks/` present at all |
| Is the application bytecode-compiled (not just the shell)? | **Yes** | payload characterisation 2026-08-08 (9.46×, 30.1% printable, 33.3% nulls vs a 100%-printable control); size delta **+6.06 MB on 707,627 B of source**, reproduced 2026-08-17 on the x64 ship target from the **deployed digest** |
| Is bytecode most of the win, or none of it? | **~33% of cold boot** | ABBA-paired, **30 faster / 0 slower**, paired median −29 ms — 2026-08-09. *Does not* clear ADR-0036's separation bar (ranges overlap) |
| Does the 2026-08-17 replication agree? | **On direction, yes** | shell effect 19 ms to listening (95% CI 10–29, p=5.7e-6); application-side **magnitude CI crosses zero** — unpaired n=40, a weaker design than the ABBA run |
| Can the image be ~5 MB? | **No — floor is 92 MB** | an *empty* `--compile` binary is 92,025,917 B (89% of the image) |

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

**Already established on 2026-08-08** by payload characterisation and a 34/34 module census; what
follows is an independent size-based replication, and the x64/deployed-digest extension.

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

#### Reconciled against the 2026-08-08 payload-isolation figures — the two methods cross-validate

The prior run reports the same quantities with a **different floor**, and the ~8 KB gap is not noise;
it is fully explained, which makes the agreement a real cross-check rather than a coincidence:

| Quantity | 2026-08-08 (payload isolation) | Here (empty-entry subtraction) | Gap |
|---|---|---|---|
| control payload | 715,697 B | 707,627 B | 8,070 B |
| bytecode payload | 6,771,666 B | 6,763,593 B | 8,073 B |
| **bytecode − control (the load-bearing delta)** | **6,055,969 B** | **6,055,966 B** | **3 B** |

The prior floor is the **shared prefix** between the two real binaries (92,017,848 B). Mine is a
compiled **empty-entry** binary (92,025,917 B) — which still contains the scaffolding bun emits for a
module, so it is **8,069 B larger**. That offset explains the 8,070 and 8,073 gaps, and because it is
present in both of my terms it **cancels in the difference** — which is why two independent
instruments, on two different runs, agree to **3 bytes** on the number the argument actually rests on.

Practical consequence: quote the **delta**, not the payload. The payload figure depends on which floor
you subtract; the delta does not.

### The same result on the SHIPPED x64 target, extracted from the DEPLOYED digest

The table above is `arm64-musl`, built locally. Phase 3(d) item 1 asked specifically for the
**cross-compiled musl target, extracted from the deployed digest** — so that was done too, and it is
the artifact currently serving on OKE (`ksvc/p1b-bunexec`, `default`):

| `bun-linux-x64-musl` build | Binary bytes | Payload over the floor |
|---|---|---|
| empty entry — runtime floor | 96,948,627 | — |
| `--compile --minify` (no bytecode) | 97,656,254 | 707,627 B |
| `--compile --minify --bytecode` | **103,712,388** | 6,763,761 B |

**Bytecode delta 6,056,134 B on the identical 707,627 B of source** — the same result on a different
architecture, and the source payload is byte-for-byte identical across the two targets.

Extracted from the running digest
(`p1b-bunexec@sha256:16c4b79fd7d4dc30143eec2ae34db82ba1fe9b9fe088ed76b252de48ea4c1e14`):

```
crane export <digest> - | tar -xO app/server | wc -c   ->  103712388
```

**Byte-identical to the local build**, so these measurements describe the artifact that is actually
deployed, not a local rebuild of it. The digest's own OCI labels state the flags, which is the
one-line provenance lookup `build.sh`'s header was written to enable:

```
dev.knext.build.command = bun build --compile --minify --bytecode --target=bun-linux-x64-musl \
                          .output/server/index.mjs --outfile knext-bun-exec-linux-x64
dev.knext.build.target  = bun-linux-x64-musl
dev.knext.app.id        = app-159989384ca3275f
```

**And the A/B's admissibility precondition is satisfied on the deployed arms.** ADR-0042 records the
Run 25/26 defect — `p1b-node` and `p1b-bunexec` served *different applications and nothing noticed*.
Read from the two deployed digests, not from source: **both carry
`dev.knext.app.id = app-159989384ca3275f`**, while their build labels differ as they should
(`npx next build --turbopack`, next 16.3.0 / node v24.14.0 vs the bun command above). The arms agree
on the application and differ only on the build. That does **not** make Phase 1 done — no timing run
was taken here — but it removes the reason the previous attempt was withdrawn.

### Timing — and a correction to this document's own first draft

**The size delta above is what refutes A12's premise. The timing below supports it and does not carry
it**, which is the opposite of how this document read when first written. Recording why, because the
mistake is instructive: the first draft ran **n=5 per arm** and reported "70 ms vs 169 ms, of which
79 ms is app-module evaluation". At **n=40** the medians move (129.5 ms, not 70 ms) and the
app-evaluation magnitude does not survive a confidence interval. **The n=5 attribution is withdrawn.**
It was also computed across *separate* runs of the two events; the n=40 design records both
timestamps **within one process lifetime**, so the app term is a real within-run subtraction.

n=40 per arm, in-container, `/proc/uptime` before `exec`, both events per run. Mann-Whitney U
(two-sided, rank test — the distributions have heavy right tails, so no t-test), plus a
Hodges-Lehmann shift and a 20,000-resample bootstrap CI on the **median difference**:

| Metric | `--bytecode` median | no-bytecode median | HL shift | bootstrap 95% CI | p |
|---|---|---|---|---|---|
| boot → `LISTENING` (shell) | **39 ms** | 50 ms | **19 ms** | **[10, 29]** | **5.7e-6** |
| boot → first dynamic-SSR 200 | 129.5 ms | 169.5 ms | 40 ms | [−11, 100] | 0.023 |
| SSR − `LISTENING`, within-run (app) | 70.5 ms | 111 ms | 30 ms | [−11, 70.5] | 0.033 |

**What is established:** bytecode reduces time-to-listening by **19 ms (CI 10–29 ms, p = 5.7e-6)**.
That interval excludes zero and the effect is not in doubt.

**What is NOT established:** the *magnitude* of the application-side saving. The rank test separates
the two distributions (p = 0.033) and the direction is consistent (median 111 → 70.5 ms), but the
bootstrap CI on the median difference **includes zero** — heavy right tails from container-start noise
dominate. So: direction supported, magnitude not pinned down. Anyone needing the magnitude must
control the noise (pinned CPUs, pre-pulled image, a warm-up discard, n in the hundreds), not just add
samples.

A useful property of the design, stated because it cuts the safe way: the bytecode binary is **6 MB
larger**, so it has more to read and map at start. That biases the comparison **against** bytecode,
which means these are conservative figures rather than flattering ones.

The poll loop's own latency and the 10 ms `/proc/uptime` quantisation are **common-mode** — identical
in both arms — so they inflate both columns equally and cannot manufacture a between-arm difference.
They do set a floor on resolution, which is why the 19 ms shell result (CI 10–29) is reported as an
interval and not as a point.

Raw within-run samples are in the reproduction section below.

### A bad instrument, and the good one that already existed

`strings -a <binary> | grep -c 'bytecode\|CodeBlock\|UnlinkedProgramCodeBlock'` gives **231** for the
bytecode build and **227** for the no-bytecode build — it does not discriminate, because Bun's own
embedded runtime carries JSC symbols either way.

**That is a fault in the instrument, not in ADR-0042's prescribed method, and an earlier draft of this
document wrongly declared the method "withdrawn as unsound".** The prescribed method works, and had
already been run: **isolate the payload after the ~92 MB runtime prefix the two arms share**, then
characterise it — control 100% printable with zero nulls (minified JS), bytecode payload 9.46× larger,
30.1% printable, 33.3% nulls (a binary blob), with source surviving in both, so `--bytecode` *adds*
bytecode rather than replacing source. Grep the whole binary and you learn nothing; isolate the
payload first and it is unambiguous.

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
  here; the no-bytecode column is the *same* vinext artifact minus one flag, which is what isolates
  bytecode and nothing else. ADR-0036's five re-open conditions are not claimed.
- **Not an OKE number.** This is a local ARM VM with a warm page cache and no image pull. The most
  recent OKE data has cold start **scheduling-bound on a 2-node cluster, not boot-bound**, so a
  sub-200 ms runtime boot does not predict an end-to-end cold start there — and a 42–46 MB pull is a cost this
  measurement does not include. The honest reading: the *runtime-boot component* collapses from the
  ~1957 ms Next-standalone floor that motivated ADR-0036 to a 39 ms listen / 129.5 ms
  first-SSR median on this artifact — a figure measured on a different machine, in a different
  container, on a 5-route app, and therefore NOT a like-for-like replacement for the 1957 ms; whether that is visible
  end-to-end on Knative is a separate measurement that must happen on OKE.
- **Not a compat result.** Five routes on one sample app. Phase 2's `KNEXT_BUILD=vinext` lane and the
  `compat-smoke` build-axis parameterisation remain unbuilt, and no ✅ row in
  `docs/compat-matrix.md` is backed on this target.
- **Not a generalisation to large apps.** The embedding mechanism (nitro literal-specifier chunks)
  should hold at any size, but it was verified on a 5-route app; bytecode size grows with the module
  graph and 6 MB is this app's figure, not a constant.

## Raw within-run samples (n=40 per arm)

Each line is one container lifetime: `boot->LISTENING_ms boot->SSR200_ms`.

<details><summary>`--compile --minify --bytecode`</summary>

```
340 410
40 300
50 150
39 99
110 230
39 79
30 70
30 79
39 400
30 70
39 79
19 90
29 199
19 69
50 350
19 769
39 150
19 59
39 99
20 140
50 120
29 79
19 59
39 69
39 70
30 309
29 79
30 140
50 139
39 79
49 109
70 199
49 89
30 450
59 349
90 1150
49 139
29 79
30 289
59 2050
```

</details>

<details><summary>`--compile --minify` (no bytecode)</summary>

```
1080 2030
50 329
59 239
39 150
39 99
49 169
49 119
49 320
59 170
50 130
39 119
59 130
59 250
59 159
59 210
59 269
49 109
50 150
70 179
59 480
39 250
250 879
2819 3039
90 519
130 260
59 480
59 130
79 159
49 210
50 140
50 119
49 119
49 109
49 170
49 119
39 89
50 180
49 129
60 180
50 110
```

</details>

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
