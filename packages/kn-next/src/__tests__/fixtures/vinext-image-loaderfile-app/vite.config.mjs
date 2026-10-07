import { nitro } from 'nitro/vite';
import vinext from 'vinext';
import { defineConfig } from 'vite';

// Plain vinext + Nitro node build; the bundled vinext fix under test is what wires images.loaderFile.
export default defineConfig({
  plugins: [
    vinext(),
    nitro({
      preset: 'node',
      rollupConfig: { output: { inlineDynamicImports: true } },
    }),
  ],
});
