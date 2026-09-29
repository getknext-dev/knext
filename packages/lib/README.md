# @getknext/lib

Runtime helpers and clients for Next.js apps deployed with knext on Knative. Provides pooled Postgres (writer and read-only), Redis, and object-storage clients optimized for scale-to-zero, plus structured logging and health checks.

## Install

```bash
npm install @getknext/lib
```

## Usage

Import the clients you need:

```typescript
import { getDbPool, getDbPoolRO, getMinioClient } from '@getknext/lib/clients';
import { logger } from '@getknext/lib/logger';
import { checkDeepHealth } from '@getknext/lib/health';
```

- **`getDbPool()`** — writer pool for writes and read-your-write queries over `DATABASE_URL`.
- **`getDbPoolRO()`** — read-only pool over `DATABASE_URL_RO` for analytics and fan-out reads.
- **`getMinioClient()`** — S3-compatible object storage client.
- **`logger`** — structured logging with pino.

For typed database queries, see [`@getknext/db`](../db).

## Supported platforms

| Runtime | Turbopack | Webpack |
|---------|-----------|---------|
| Node.js | ✓ | ✓ |
| Bun     | ✓ | ✓ |

Tested against Next.js 16.2.12. See the [compatibility page](https://knext.dev/docs/compatibility) for complete version coverage.

## Learn more

- [Documentation](https://knext.dev) — guides and configuration reference
- [Compatibility](https://knext.dev/docs/compatibility) — supported runtimes and Next.js versions
- [Security](https://knext.dev/docs/security) — threat model and hardening
- [Contributing](https://github.com/getknext-dev/knext/blob/main/CONTRIBUTING.md) — report issues and contribute

## License

[Apache-2.0](./LICENSE)
