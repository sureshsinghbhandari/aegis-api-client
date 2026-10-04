import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'release/**', 'node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'database/migrations/**', '**/*.d.ts', 'scripts/**/*.mjs'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // Renderer code must never touch Node or Electron directly.
    files: ['apps/desktop/renderer/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*', 'electron', 'fs', 'path', 'child_process'], message: 'The renderer must not import Node.js or Electron APIs. Use window.api.' },
            { group: ['@aegis/security', '@aegis/storage', '@aegis/app', '@aegis/scripting', '@aegis/http-client'], message: 'The renderer may only import types from @aegis/core.' },
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts', 'packages/**/*.test.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
