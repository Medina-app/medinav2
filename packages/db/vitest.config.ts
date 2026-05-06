import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    sequence: {
      concurrent: false,
    },
    testTimeout: 30000,
    // Bumped for the issue #5 refactor: afterAll now loops through 5–28
    // tracked clinics and runs ~18 child DELETEs per clinic. Parallelization
    // helps but FK ordering inside a clinic must stay serial.
    hookTimeout: 120000,
  },
});
