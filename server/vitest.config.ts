import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests share one Postgres database — run files serially.
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
    env: {
      DATABASE_URL: 'postgres://localhost:5432/khata_test',
      JWT_SECRET: 'test-secret',
    },
  },
});
