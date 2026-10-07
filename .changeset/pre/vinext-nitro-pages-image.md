---
"@getknext/core": patch
---

On the vinext target, a Pages Router app now serves `/_next/image` instead of answering 404, so images left on the built-in optimizer load — including ones an `images.loaderFile` loader sends to `/_next/image/`. A `url` that points back at `/_next/image` is rejected with a 400, as in Next.js. Delivered as a bundled vinext fix on top of the earlier `/_next/image` one, so apps that already carry that fix pick it up without reinstalling.
