# The bimodal @getknext/core packed digest: named, reproduced, mechanism identified

**Task:** sprint-3 decision-free measurement feeding the ADR-0007 amendment (issue #850; follows
the A3 ledger measurement on PR #941, `docs/benchmarks/compat-window-ledger-measurement.md`).

**Verdict up front:** the flipping file is **`package.json`** — not anything tsup/esbuild emits.
`dist/` is byte-for-byte deterministic (10/10 clean rebuilds identical). The flip happens at
**`pnpm pack` time**: pnpm 10.4.1 rewrites the two `workspace:^` dependencies
(`@getknext/db`, `@getknext/lib`) concurrently and re-inserts them into the `dependencies`
object in **promise-completion order**, so the packed manifest serializes them in one of exactly
two orders. Two workspace deps → two orderings → a bimodal digest, ~50/50. The ledger's
"the flip is inside @getknext/core's built output" hypothesis is **corrected** by this
measurement: the built output is stable; the pack step is not.

## Environment

- Commit: `ddadaff5` (detached — the exact frozen commit the 9-night ledger measured).
- macOS (darwin 25.5.0), Node v24.14.0, pnpm 10.4.1 (the repo's `packageManager`, via corepack).
- Install: `pnpm install --frozen-lockfile` — the same toolchain the nightly uses
  (`test-e2e-deploy.yml` builds with `pnpm --filter @getknext/core build` and packs with
  `pnpm pack`; the CI `bun install` jobs are separate lanes). Note: `bun install
  --frozen-lockfile` (bun 1.4.0) **fails** on this commit ("lockfile had changes"), so bun could
  not have been the nightly's install path anyway.
- `@getknext/lib` and `@getknext/db` built once up front (the ledger already showed them
  byte-stable; re-confirmed below by mechanism).

## Step 1 — is the build nondeterministic? No.

10 clean rebuilds (`rm -r packages/kn-next/dist` between runs; build = `pnpm --filter
@getknext/core build`, which runs `tsup` directly — turbo is not in this path, so no cache could
mask nondeterminism):

```
run 1..10  sha256(per-file manifest of dist/) =
           70b84b8f83fa870a9c806e0eced4a69fdfef8a68083f0ee204f13839ff254951   (all 10 identical)
```

Every file in `dist/` — hash-named chunks, sourcemaps, `.d.ts` — is byte-identical across all 10
runs. **tsup/esbuild/rollup-dts are ruled out.** The ADR-0035 compile-cache nondeterminism is
also ruled out for this artifact: that layer is baked into container images, never into the npm
tarball closure.

## Step 2 — build + pack loop: the flip reproduces

6 cycles of clean build → `pnpm pack` → extract → per-file manifest (path + mode + sha256,
the same shape `scripts/compat-window-fingerprint.mjs` `collectPacked` hashes; 134 files, matching
the ledger):

```
pack 1  fb73b6ca…   pack 2  fb73b6ca…   pack 3  fb73b6ca…
pack 4  1b164bdd…   pack 5  fb73b6ca…   pack 6  fb73b6ca…
```

Exactly two distinct manifests. Their diff is **one line**:

```
< package.json 644 45c866e72343a4c721f3d16a9d5658c3c54349cf9cdbdba14eda052a995b4f8a
> package.json 644 4cd456a4016e193de80df71d5b188dac8d2ec2e6df42decbec1f25abccaf9be3
```

All 133 other files (entire `dist/`, `templates/`, LICENSE, README) are identical across every run.

## Step 3 — isolate from the build entirely: pack alone is bimodal

20 consecutive `pnpm pack` runs **on the same unchanged `dist/`** produced the same two
`package.json` hashes, interleaved 13/7:

```
45c866e7… ×13    4cd456a4… ×7
```

So the build is irrelevant; `pnpm pack` alone flips.

## Step 4 — the bytes

First divergence at byte offset 5057 (line 164). The two variants differ only in the order of the
last two entries of `dependencies`:

```
variant A (45c866e7…)                     variant B (4cd456a4…)
  "yaml": "^2.7.1",                         "yaml": "^2.7.1",
  "@getknext/db": "^0.3.1",                 "@getknext/lib": "^0.3.1",
  "@getknext/lib": "^0.3.1"                 "@getknext/db": "^0.3.1"
```

Hexdump at the divergence (0x13C1): `64 62` ("db") vs `6c 69` ("li").

Two tells in that snippet:

1. In the **source** `package.json` the `@getknext/*` deps sort *first* (lines 167–168,
   alphabetical). In the **packed** manifest they have moved to the *end* of `dependencies`.
2. Only those two entries ever move; the other seven keep source order.

## Step 5 — mechanism, in pnpm's own code

`pnpm pack` builds the publish manifest via `createExportableManifest` →
`makePublishDependencies`, which maps the `dependencies` object through **`p-map-values@1.0.0`**
(pnpm 10.4.1 bundle, `dist/pnpm.cjs:209811` and `:133977`):

```js
async function pMapValue(mapper, obj) {
  const result2 = {};
  await Promise.all(Object.entries(obj).map(async ([key, value]) => {
    result2[key] = await mapper(value, key, obj);   // ← insertion order = COMPLETION order
  }));
  return result2;
}
```

Key insertion into `result2` happens when each mapper **completes**, not in source order.
Non-`workspace:` deps return after pure-microtask awaits, so they complete in a deterministic
first wave and keep their relative order. The two `workspace:^` deps each do filesystem I/O
(`replaceWorkspaceProtocol` → `tryReadProjectManifest` of `packages/db` and `packages/lib` to
read the real version), so they complete **last** (why they sink to the end of the object) and
**in racy order relative to each other** (why there are exactly two outcomes, roughly 50/50).

This also explains the ledger's sibling observations for free:

- `@getknext/lib`: **zero** workspace deps → nothing races → byte-stable.
- `@getknext/db`: **one** workspace dep (`@getknext/lib`) → it sinks to the end alone, no peer to
  race against → byte-stable.
- `@getknext/core`: **two** workspace deps → 2! = 2 orderings → bimodal. (A third workspace dep
  would make it 6-modal.)

## What this means for the ADR-0007 amendment (stated, not decided)

- The instability is **semantically empty**: JSON object key order in `dependencies` has no
  meaning to npm or any resolver. The shipped code is identical every night.
- `collectPacked` already normalizes away tarball *bytes* (gzip mtime) by hashing contents — it
  just doesn't normalize *this*. A canonicalization of `package.json` (e.g. sorted dependency
  keys, or key-order-insensitive JSON hashing) at the fingerprint boundary would make the
  14-night window reachable without touching what is actually attested. Alternatively pnpm ≥
  a version that serializes publish deps deterministically, or an upstream fix to
  `p-map-values`, removes it at the source. Choosing between these is the amendment's call.
- The prior note on #941 that "the flip is inside @getknext/core's built output" should be read
  as superseded by this measurement.

## Reproduction (all runnable from a checkout of ddadaff5)

```sh
pnpm install --frozen-lockfile
pnpm --filter @getknext/lib build && pnpm --filter @getknext/db build
# build determinism (expect: one distinct manifest across N runs)
for i in 1 2 3; do
  rm -r packages/kn-next/dist; pnpm --filter @getknext/core build >/dev/null
  (cd packages/kn-next/dist && find . -type f | sort | xargs shasum -a 256) > /tmp/m$i
done; shasum -a 256 /tmp/m1 /tmp/m2 /tmp/m3
# pack bimodality (expect: two distinct hashes, interleaved)
cd packages/kn-next
for i in $(seq 1 20); do
  d=$(mktemp -d); pnpm pack --pack-destination "$d" >/dev/null 2>&1
  tar xzf "$d"/*.tgz -C "$d" package/package.json
  shasum -a 256 "$d/package/package.json"; rm -r "$d"
done
```
