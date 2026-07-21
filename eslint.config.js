// Flat ESLint config (ESLint 9+). Shared across every app/package in the monorepo.
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

export default [
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 'latest',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // TypeScript's own checker resolves identifiers (including DOM/Worker/Node
      // globals via `lib`), and core `no-undef` false-positives on global types
      // -- typescript-eslint recommends turning it off for TS files.
      'no-undef': 'off',
      // Allow the idiomatic `interface FooProps extends React.X {}` pattern used
      // by the UI primitives -- a named, extensible props type is intentional,
      // not an accidental empty object type.
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.open-next/**',
      '**/.wrangler/**',
      '**/node_modules/**',
      '**/coverage/**',
    ],
  },
  prettier,
];
