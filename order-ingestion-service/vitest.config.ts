import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    exclude: ['test/integration/**'],
    root: './',
    // class-validator/class-transformer decorators read design-time metadata via
    // Reflect. Nest pulls this polyfill in at runtime; vitest does not, so the
    // DTOs would throw "Reflect.getMetadata is not a function" under test.
    setupFiles: ['reflect-metadata'],
    coverage: {
      provider: 'v8',
      exclude: ['src/main.ts', 'src/app.module.ts'],
    },
  },
  plugins: [swc.vite()],
});
