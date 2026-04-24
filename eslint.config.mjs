import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.next/**',
      '**/.expo/**',
      '**/cdk.out/**',
      '**/.husky/_/**',
      '**/*.d.ts',
      'docs/design/*.jsx',
      'pnpm-lock.yaml',
      'packages/**/prisma/generated/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  prettier,
);
