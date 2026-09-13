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
    // The service worker runs in its own global scope -- no `window`, no
    // Node globals, and (since it's plain .js, not .ts) none of the
    // TypeScript-lib-driven global resolution that lets the block above turn
    // `no-undef` off. js.configs.recommended has no browser/worker globals
    // declared for .js files, so it flags every runtime-provided identifier
    // this file uses. Scoped narrowly to sw.js rather than a blanket
    // browser/worker env, since it's the only non-TS, non-Node source file
    // in the repo -- if that changes, switch to the `globals` package's
    // `globals.serviceworker` instead of growing this object by hand.
    files: ['apps/web/public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        // Added after CI run #107 failed on `'Response' is not defined` at
        // sw.js:69. That line is the `?? new Response(LAST_RESORT_HTML, ...)`
        // fallback added in the repo-hygiene sweep -- so the reference
        // arrived with a change made while `pnpm lint` still ran nowhere,
        // and stayed invisible until the step that runs it landed.
        //
        // A CONFIG GAP, NOT A CODE BUG. `Response` is a real
        // ServiceWorkerGlobalScope global; the offline fallback works (see
        // src/sw.test.ts, which drives that exact branch). What was wrong is
        // that this hand-maintained list did not name it.
        //
        // Which is the argument for the `globals` package that the comment
        // above has now predicted twice: this list needed extending the
        // first time anything checked it. `pnpm add -D -w globals`, then
        // `globals.serviceworker` here and `globals.node` on the .mjs block,
        // replaces both hand-written sets with ones that cannot fall behind.
        // Left as one line rather than a dependency + lockfile change in a
        // patch whose job was to make CI green.
        Response: 'readonly',
      },
    },
  },
  {
    /**
     * Node-run .mjs scripts. `no-undef` is turned off for .ts/.tsx above
     * because TypeScript resolves globals itself, but these files get no
     * such treatment: flat config declares only ES built-ins by default, so
     * `process` (15 uses in check-migrations-current.mjs) and `URL` are
     * flagged as undefined and `eslint .` fails at error level.
     *
     * That is why this block exists now rather than earlier: `pnpm lint` was
     * defined but never wired into CI, so nothing ever ran it to find out.
     * It is a prerequisite for the lint step this change adds to the
     * workflow, not a cleanup.
     *
     * Hand-declared, following the precedent sw.js's block below sets -- and
     * this is the second hand-declared block, which is the point that block's
     * own comment names as the moment to switch to the `globals` package
     * (globals.node / globals.serviceworker) instead. Not done here because
     * it is a new dependency and a pnpm-lock.yaml change, which deserves to
     * be its own decision rather than a side effect of a CI patch.
     */
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
      },
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
