---
"@getknext/core": patch
"@getknext/lib": patch
---

Stop a webpack build from baking the build machine's absolute path into the server chunk. The lib loaded ioredis (and the pino-pretty probe, and the optional MinIO and Cerbos SDKs) through `createRequire(import.meta.url)`, and webpack turns `import.meta.url` into a literal path of the machine that ran `next build`. That leaked the directory layout and made the output differ between two machines building the same commit, and the path does not exist in the deployed image anyway. The lib now asks the engine where it is running from at call time, so an unbundled install still resolves its own dependencies and a bundled chunk resolves from where it is deployed. Falls back to the working directory when the engine reports nothing usable.

The compile report keeps naming the deliberate ioredis load for the new shape, so it is still never silent.

Under `next dev --webpack` these optional SDKs now resolve from the app's working directory, so an app on a strict install needs them as its own dependencies.
