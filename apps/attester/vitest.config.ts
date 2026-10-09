import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One throwaway PostgreSQL for the run, migrated with the API's migrations.
    globalSetup: ['./src/testing/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
