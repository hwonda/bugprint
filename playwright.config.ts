import { defineConfig } from '@playwright/test';

// Runs generated reproduction tests against the demo shop.
// DEMO_FIXED=1 serves the patched app so you can watch the repro turn green.
export default defineConfig({
  testDir: 'tests/repro',
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: `node demo/serve.mjs 4173${process.env.DEMO_FIXED === '1' ? ' --fixed' : ''}`,
    url: 'http://localhost:4173',
    reuseExistingServer: false,
  },
});
