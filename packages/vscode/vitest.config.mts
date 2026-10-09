import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import * as path from 'path';
import { fileURLToPath } from 'node:url';

// `.mts` so Vite loads this config as ESM instead of its deprecated CJS
// path (see `vite.config.mts`); `__dirname` is unavailable under ESM.

export default defineConfig({
  plugins: [react()],
  test: {
    // `environmentMatchGlobs` does not exist in vitest 5 and is silently
    // ignored, so per-file environments are separate projects instead:
    // node for adapter tests, jsdom for React component tests.
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['src/test/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/__tests__/**',
        '**/fixtures/**',
        '**/*.d.ts',
        'src/test/**',
        'src/test-integration/**',
        'dist/**',
        'dist-test/**',
      ],
    },
  },
  resolve: {
    alias: {
      vscode: path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src/test/vscode.mock.ts'),
    },
  },
});
