import { nitro } from 'nitro/vite';
import vinext from 'vinext';
import { defineConfig } from 'vite';

// Plain vinext + Nitro node build; no traceDeps here on purpose: the bundled vinext fix is what is under test.
export default defineConfig({
  plugins: [
    vinext(),
    nitro({
      preset: 'node',
      rollupConfig: { output: { inlineDynamicImports: true } },
    }),
  ],
});
