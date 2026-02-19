import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    // Provide required env vars so lib/env.ts passes boot validation in tests.
    // These values are for testing only and must never reach production.
    env: {
      DB_HOST: 'localhost',
      DB_PORT: '5432',
      DB_NAME: 'prospeccao_test',
      DB_USER: 'test_user',
      DB_PASSWORD: 'testpassword',
      OPENROUTER_API_KEY: 'sk-or-test-placeholder-for-unit-tests-only',
      OPENROUTER_MODEL: 'anthropic/claude-3.5-sonnet',
      NODE_ENV: 'test',
      // 64 hex chars = 32 bytes — safe placeholder for tests only
      CREDENTIALS_ENCRYPTION_KEY: 'a'.repeat(64),
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['lib/**', 'app/api/**'],
      exclude: ['**/*.d.ts', '**/node_modules/**'],
    },
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
