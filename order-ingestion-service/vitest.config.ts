import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    exclude: ['test/integration/**'],
    root: './',
    coverage: {
      provider: 'v8',
      exclude: ['src/main.ts', 'src/app.module.ts'],
    },
  },
  plugins: [swc.vite()],
});
