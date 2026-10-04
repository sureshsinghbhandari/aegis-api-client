import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve the `@aegis/*` workspace aliases from tsconfig.json `paths`.
  resolve: { tsconfigPaths: true },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/security/**/*.test.ts', 'packages/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
