import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * `@keylease/cli/*` is a workspace dependency whose published entry points live
 * in `dist/`. Tests and type-checks run straight from source, so alias the two
 * subpaths we consume to the CLI sources.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@keylease/cli/token',
        replacement: fileURLToPath(new URL('../cli/src/token.ts', import.meta.url)),
      },
      {
        find: '@keylease/cli/soroban',
        replacement: fileURLToPath(new URL('../cli/src/client/soroban.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
  },
});
