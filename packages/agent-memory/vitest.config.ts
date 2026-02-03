import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'bun:test': 'vitest',
    },
  },
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 30000,
  },
});
