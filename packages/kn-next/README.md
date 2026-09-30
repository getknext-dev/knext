# @getknext/core

The official Next.js Deployment Adapter and CLI for deploying Next.js apps on Knative with scale-to-zero Kubernetes. Build your app, push the container image, and deploy it to a Knative cluster—it automatically scales down to zero when idle and back up on traffic.

## Install

```bash
npm install @getknext/core
```

Or use the CLI directly without installing:

```bash
npx @getknext/core --help
```

## Quickstart

Create and deploy a new Next.js app:

```bash
npx @getknext/core create my-app
cd my-app
npx knext deploy
```

Configure knext in your app's `knext.config.ts`:

```typescript
import type { KnextConfig } from '@getknext/core';

export default {
  // Your configuration
} satisfies KnextConfig;
```

## Supported platforms

| Runtime | Turbopack | Webpack |
|---------|-----------|---------|
| Node.js | ✓ | ✓ |
| Bun     | ✓ | ✓ |

See the [compatibility page](https://knext.dev/docs/compat-matrix) for supported Next.js versions and runtime/builder coverage.

## Learn more

- [Documentation](https://knext.dev) — guides and configuration reference
- [Compatibility](https://knext.dev/docs/compat-matrix) — supported runtimes and Next.js versions
- [Security](https://knext.dev/docs/security) — threat model and hardening
- [Contributing](https://github.com/getknext-dev/knext/blob/main/CONTRIBUTING.md) — report issues and contribute

## License

[Apache-2.0](./LICENSE)
