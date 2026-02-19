import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
import securityPlugin from 'eslint-plugin-security'

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  securityPlugin.configs.recommended,
  {
    rules: {
      // Ignore intentionally-unused variables/params that start with _ (TypeScript convention)
      '@typescript-eslint/no-unused-vars': ['warn', {
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // Prevent dynamic property access with user-controlled keys (e.g., obj[userInput])
      'security/detect-object-injection': 'error',
      // Prevent RegExp constructed from non-literal strings (ReDoS risk)
      'security/detect-non-literal-regexp': 'error',
      // Prevent fs calls with non-literal filenames (path traversal risk)
      'security/detect-non-literal-fs-filename': 'error',
      // Warn on potential timing attacks (string comparison)
      'security/detect-possible-timing-attacks': 'warn',
      // Warn on potentially catastrophic backtracking regex
      'security/detect-unsafe-regex': 'error',
      // Note: security/detect-sql-injection does not exist in eslint-plugin-security v3+
      // SQL injection is prevented by parameterized queries in lib/query-builder.ts
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    '__tests__/**', // test files use msw patterns that trigger some rules
  ]),
])

export default eslintConfig
