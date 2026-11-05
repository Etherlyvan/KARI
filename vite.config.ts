import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist/widget', emptyOutDir: true,
    lib: { entry: 'apps/widget/src/index.ts', formats: ['es'], fileName: () => 'embed.js' },
    target: 'es2022',
  },
});
