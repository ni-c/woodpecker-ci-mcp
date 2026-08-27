import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Entry point: only wires config and server to the stdio transport and exits
      // the process; not reachable from unit tests.
      exclude: ['src/index.ts'],
      // Measured 2026-08-27 at 97.87 / 90.61 / 99.62 / 98.49. These sit below
      // that with room for an honest refactor — they are a floor to defend with
      // new tests, never a number to lower when a run goes red.
      //
      // Branches has the least headroom because the tool bodies are mostly
      // `if (value !== undefined)` over optional arguments; test/tools-optional.ts
      // is what keeps that half honest, and a new optional argument belongs in it.
      thresholds: {
        statements: 95,
        branches: 87,
        functions: 95,
        lines: 95,
      },
    },
  },
});
