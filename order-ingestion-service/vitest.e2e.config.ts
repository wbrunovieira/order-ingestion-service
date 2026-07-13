import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * The pollers against the REAL mock customer APIs, which this suite spawns itself.
 *
 * Kept out of CI and out of `pnpm test`: it starts processes, and one case waits out
 * a genuine 60-second rate-limit window. It exists to check the assumptions the unit
 * suite cannot — those are about someone else's implementation, and a fake I wrote
 * can only confirm what I already believed.
 */
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    root: './',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globalSetup: ['./test/e2e/setup/mock-servers.ts'],
    setupFiles: ['reflect-metadata', './test/e2e/setup/env.ts'],
  },
  plugins: [swc.vite()],
});
