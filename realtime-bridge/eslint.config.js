// ESLint v9+ flat config.
// Keep this intentionally minimal so `npm run lint` works and we can tighten later.

export default [
  {
    ignores: ['node_modules/**', 'dist/**', '.fly/**'],
  },
  {
    // Standard Node ESM/CJS files in this repo.
    files: ['src/**/*.{js,mjs,cjs}', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // Node globals
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        AbortController: 'readonly',

        // Timers
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      // Basic hygiene
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-unreachable': 'error',

      // Style (leave formatting to Prettier)
      semi: ['error', 'always'],
      quotes: ['error', 'single', { avoidEscape: true }],
    },
  },
];
