# @getknext/core

The `kn-next` CLI and the official Next.js deployment adapter for running
Next.js on **Knative** with **scale-to-zero**.

`@getknext/core` gives you two things:

- **`kn-next` CLI** — build your Next.js app, publish the container image, and
  deploy it to a Knative cluster.
- **The Next.js adapter** — wires your app into Knative's scale-to-zero runtime
  using the official Next.js Deployment Adapter API (`output: 'standalone'`).

## Install

```bash
npm i @getknext/core
# or run the CLI directly
npx @getknext/core --help
```

## Usage

Deploy your Next.js app:

```bash
npx @getknext/core deploy
```

Reference the adapter and config types from your `next.config` / `kn-next.config`:

```ts
import type { KnativeNextConfig } from '@getknext/core';
```

## Documentation

Full guides and configuration reference: <https://knext.dev>

## License

[Apache-2.0](./LICENSE)
