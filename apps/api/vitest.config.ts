import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Starts one throwaway PostgreSQL for the run; each test file gets its own database.
    globalSetup: ['./src/testing/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
