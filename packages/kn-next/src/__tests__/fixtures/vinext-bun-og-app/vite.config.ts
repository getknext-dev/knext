import { nitro } from "nitro/vite";
import vinext from "vinext";
import { defineConfig } from "vite";

// The plain nitro bun preset, no custom entry: this fixture only needs a
// compilable `.output/server/index.mjs` to exercise cluster C4 (next/og's
// ImageResponse inside a `bun build --compile --bytecode` single executable);
// it does not need knext's own runtime-contract entry.
export default defineConfig({
    plugins: [vinext(), nitro({ preset: "bun" })],
});
