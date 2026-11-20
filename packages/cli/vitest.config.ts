import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      // Explicitly exclude test files and operational deployment scripts
      exclude: [
        'src/**/*.test.ts',
        'dist/**',
        // deploy-testnet.mjs is an interactive operator script that executes
        // manual deployment workflows against Soroban testnet, not imported by CLI runtime.
        'scripts/**',
      ],
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 75,
        statements: 80,
      },
    },
  },
});
