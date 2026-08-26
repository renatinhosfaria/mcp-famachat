import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // As fixtures do gerador imitam código do backend, inclusive um *.test.ts.
    exclude: ['tests/fixtures/**'],
    environment: 'node',
    globals: false,
  },
});
