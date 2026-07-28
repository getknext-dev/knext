<!-- GENERATED FILE — do not edit by hand.
     Source of truth: packages/kn-next/src/cli/cr-builder.ts (scanned).
     Regenerate: bun scripts/gen-cr-fields.ts -->

# NextApp CR fields the `kn-next` CLI emits

This table is **derived by scanning `cr-builder.ts`**, not maintained by hand —
a field added to the builder shows up here on the next generation, and CI reds
if the committed copy is stale.

Read it alongside the machine-readable `cr-fields.json` (schema version
1), which is the artifact other tools should consume.

**What "in bundled CRD" means:** the field is defined by the NextApp CRD in
*this repository* (`packages/kn-next-operator/config/crd/bases`). It says
nothing about the CRD installed on *your* cluster — that is what `kn-next
deploy`'s preflight and `kn-next doctor`'s schema-coverage check answer, live.
Upgrade order matters: **operator/CRD first, then CLI.**

`*` in a path is a dynamic map key or an array index.

Every field the CLI can emit is defined by the bundled CRD.

| field | in bundled CRD |
|---|---|
| `apiVersion` | yes |
| `kind` | yes |
| `metadata` | yes |
| `metadata.name` | yes |
| `metadata.namespace` | yes |
| `spec` | yes |
| `spec.buildId` | yes |
| `spec.cache` | yes |
| `spec.cache.bytecodeCacheSize` | yes |
| `spec.cache.enableBytecodeCache` | yes |
| `spec.cache.keyPrefix` | yes |
| `spec.cache.provider` | yes |
| `spec.cache.url` | yes |
| `spec.database` | yes |
| `spec.database.roSecretRef` | yes |
| `spec.database.roSecretRef.key` | yes |
| `spec.database.roSecretRef.name` | yes |
| `spec.database.secretRef` | yes |
| `spec.database.secretRef.key` | yes |
| `spec.database.secretRef.name` | yes |
| `spec.env` | yes |
| `spec.healthCheckPath` | yes |
| `spec.image` | yes |
| `spec.observability` | yes |
| `spec.observability.enabled` | yes |
| `spec.observability.rum` | yes |
| `spec.observability.rum.enabled` | yes |
| `spec.observability.rum.sampleRate` | yes |
| `spec.observability.tracing` | yes |
| `spec.observability.tracing.enabled` | yes |
| `spec.observability.tracing.endpoint` | yes |
| `spec.observability.tracing.sampleRate` | yes |
| `spec.preview` | yes |
| `spec.preview.branch` | yes |
| `spec.preview.enabled` | yes |
| `spec.preview.prId` | yes |
| `spec.resources` | yes |
| `spec.resources.cpuLimit` | yes |
| `spec.resources.cpuRequest` | yes |
| `spec.resources.memoryLimit` | yes |
| `spec.resources.memoryRequest` | yes |
| `spec.revalidation` | yes |
| `spec.revalidation.kafkaBrokerUrl` | yes |
| `spec.revalidation.queue` | yes |
| `spec.runtime` | yes |
| `spec.scaling` | yes |
| `spec.scaling.containerConcurrency` | yes |
| `spec.scaling.imagePrewarm` | yes |
| `spec.scaling.maxScale` | yes |
| `spec.scaling.minScale` | yes |
| `spec.scaling.panicThresholdPercentage` | yes |
| `spec.scaling.panicWindowPercentage` | yes |
| `spec.scaling.poolMax` | yes |
| `spec.scaling.targetBurstCapacity` | yes |
| `spec.scaling.warmSchedule` | yes |
| `spec.scaling.warmSchedule.*.end` | yes |
| `spec.scaling.warmSchedule.*.replicas` | yes |
| `spec.scaling.warmSchedule.*.start` | yes |
| `spec.scaling.warmSchedule.*.timezone` | yes |
| `spec.secrets` | yes |
| `spec.secrets.envFrom` | yes |
| `spec.secrets.envMap` | yes |
| `spec.secrets.envMap.*.secretKey` | yes |
| `spec.secrets.envMap.*.secretName` | yes |
| `spec.storage` | yes |
| `spec.storage.bucket` | yes |
| `spec.storage.endpoint` | yes |
| `spec.storage.provider` | yes |
| `spec.storage.region` | yes |
