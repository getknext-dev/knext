# @knext/lib

Shared runtime helpers for Next.js apps deployed with **knext** on Knative.

Provides small, focused clients and utilities the knext runtime uses:

- **Clients** — pooled Postgres, Redis, and object-storage (MinIO/S3) clients.
- **Logger** — a structured (pino) logger.
- **Health** — readiness/liveness health checks.

## Install

```bash
npm i @knext/lib
```

## Usage

```ts
import { getDbPool, getDbPoolRO, getMinioClient } from '@knext/lib/clients';
import { logger } from '@knext/lib/logger';
import { checkDeepHealth } from '@knext/lib/health';
```

### Postgres pools (writer + read-only)

- `getDbPool()` — the writer pool over `DATABASE_URL` (read-your-writes,
  single-writer). Small bounded defaults tuned for scale-to-zero (`max 5`,
  idle `10s` < the gateway's 60s idle, connect `15s` ≥ the ~2.5s cold-wake).
  Override with `DB_POOL_MAX` / `DB_POOL_IDLE_TIMEOUT_MS` /
  `DB_POOL_CONNECT_TIMEOUT_MS`.
- `getDbPoolRO()` — the read-only pool over `DATABASE_URL_RO` (the scale-zero-pg
  RO gateway, **bounded-staleness ~9s, no read-your-writes**). Returns `null`
  when `DATABASE_URL_RO` is unset. Mirrors the writer defaults; override with
  `DB_POOL_RO_MAX` / `DB_POOL_RO_IDLE_TIMEOUT_MS` / `DB_POOL_RO_CONNECT_TIMEOUT_MS`.

Reads are an **explicit opt-in** — nothing is auto-routed. Both pools drain on
SIGTERM via `closeDbPool()` / `closeDbPoolRO()`. For typed schema, migrations,
and drizzle queries over these pools, use [`@knext/db`](../db).

## Documentation

Full guides and configuration reference: <https://knext.dev>

## License

[Apache-2.0](./LICENSE)
