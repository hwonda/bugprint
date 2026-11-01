import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The real-browser suites each start the demo server on a fixed port; run files one at a time.
    fileParallelism: false,
  },
});
