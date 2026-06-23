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
import { getDbPool, getMinioClient } from '@knext/lib/clients';
import { logger } from '@knext/lib/logger';
import { checkDeepHealth } from '@knext/lib/health';
```

## Documentation

Full guides and configuration reference: <https://knext.dev>

## License

[Apache-2.0](./LICENSE)
