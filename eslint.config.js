// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // ── Global ignores ──
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '.lab/**',
      'tests/**',
      'scripts/**',
      'packages/apps/**',
      'packages/plugins/**',
      'packages/external/**',
      'adapters/**',
      'lab-cli/**',
      'config/**',
      'docs/**',
      '**/*.test.ts',
      '**/*.spec.ts',
    ],
  },

  // ── Base recommended ──
  eslint.configs.recommended,

  // ── Strict type-checked presets ──
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // ── Parser / project service ──
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ── Strict rules for core & infra ──
  {
    files: [
      'packages/core/*/src/**/*.ts',
      'packages/infra/*/src/**/*.ts',
    ],
    rules: {
      // ────────────────────────────────────
      // Type Safety — zero tolerance for any
      // ────────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // ─────────────────────────
      // Promise discipline
      // ─────────────────────────
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],

      // ─────────────────────────
      // Strictness
      // ─────────────────────────
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unnecessary-type-parameters': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', {
        allowNumber: true,
        allowBoolean: true,
      }],

      // ─────────────────────────
      // Consistency
      // ─────────────────────────
      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports',
        fixStyle: 'separate-type-imports',
      }],
      '@typescript-eslint/consistent-type-exports': ['error', {
        fixMixedExportsWithInlineTypeSpecifier: true,
      }],
      '@typescript-eslint/no-import-type-side-effects': 'error',

      // ─────────────────────────
      // Code quality
      // ─────────────────────────
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/no-confusing-void-expression': ['error', {
        ignoreArrowShorthand: true,
      }],
      '@typescript-eslint/no-meaningless-void-operator': 'error',

      // ─────────────────────────
      // Base ESLint overrides
      // ─────────────────────────
      'eqeqeq': ['error', 'always'],
      'no-eval': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-return-await': 'off', // handled by @typescript-eslint/return-await
    },
  },
);
