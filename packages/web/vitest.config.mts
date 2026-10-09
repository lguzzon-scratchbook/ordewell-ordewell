import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['server/**/*.ts'],
      exclude: ['**/*.test.ts', '**/__tests__/**', '**/fixtures/**', '**/*.d.ts', 'dist/**'],
    },
  },
});
