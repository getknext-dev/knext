---
"@getknext/core": patch
---

The Bun single-executable build now writes the HarfBuzz and harfbuzzjs licence notice (`knext-third-party-notices.txt`) beside the binary whenever it embeds `hb.wasm` for `next/og`, and the generated Dockerfiles copy it into the image.
