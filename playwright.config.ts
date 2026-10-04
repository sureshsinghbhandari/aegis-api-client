import { defineConfig } from '@playwright/test';

// End-to-end tests launch the BUILT Electron app (run `npm run build` first; `npm run test:e2e` does that).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
