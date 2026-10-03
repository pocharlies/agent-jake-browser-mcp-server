/**
 * Vitest configuration for unit tests.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/core/tests/**/*.test.ts', 'packages/protocol/tests/**/*.test.ts', 'tests/entrypoints.test.ts'],
    exclude: ['tests/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/core/src/**/*.ts'],
      exclude: ['packages/core/src/cli/*.ts'],
    },
  },
});
