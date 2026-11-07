// @ts-check
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const skipReason = require('./scripts/eslint-skip-reason.cjs');
const portability = require('./scripts/eslint-portability.cjs');
const mentions = require('./scripts/eslint-mention-pills.cjs');

// One plugin object: flat config refuses a name bound to two different ones.
const squadron = { rules: { 'skip-reason': skipReason, ...portability.rules, ...mentions.rules } };

// A found Program comes from resolution; fixtures alone may name one.
const namedProgram = {
  object: 'executables',
  property: 'named',
  message: 'Programs come from executables.find; `named` is for test fixtures.'
};
// Owner checks are private_files' rules; a missing uid must never pass one.
const ownerCheck = {
  object: 'process',
  property: 'getuid',
  message: 'Check owners through platform.privateFiles, with an explicit purpose.'
};

/**
 * Type-aware linting, because the rules worth having here need types: this
 * extension is a pile of fire-and-forget async work over files that may not
 * exist, and a dropped promise or a silently-`any` CLI record is exactly the
 * bug class that survives `tsc`.
 */
module.exports = tseslint.config(
  // `.claude/**` holds worktree checkouts of this same repo. Linting one is
  // both pointless and wrong: the per-directory overrides below key off
  // `src/webview/**`, which a second checkout's copy does not match, so it gets
  // reported under rules that were never meant for it.
  //
  // `*.tmp.mjs` is a scratch script — a screenshot rig beside a mockup, thrown
  // away when the mockup is done. It belongs to no tsconfig, so the typed
  // parser fails on it and the whole gate goes red over a file nobody ships.
  //
  // `.*.mjs` is the same file under the other name sessions actually give it:
  // hidden rather than suffixed. `docs/mockups/.shot-hh.mjs` reddened one
  // session's commit while another was still writing it — and eslint 9 lints
  // dotfiles, where eslint 8 skipped them, so the older habit stopped being
  // safe without anyone changing it. Both spellings ignored, since the point is
  // the file being scratch rather than which convention its author reached for.
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      '.claude/**',
      // Linked worktrees, `.gitignore` says why they are here and dot-prefixed.
      '.worktrees/**',
      '**/*.tmp.mjs',
      '**/*.tmp/**',
      '**/.*.mjs'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: __dirname
      }
    },
    rules: {
      // Every background refresh is deliberately not awaited. `void` marks the
      // ones that are meant; anything else is a promise nobody is watching.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': 'error',
      // External JSON and untyped host APIs still use unchecked reads at some
      // boundaries. Enabling these checks needs a separate validation migration.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // Naming a field in a rest destructure purely to drop it is how a
      // projection at a seam is written, and the binding is meant to be unused.
      // typescript-eslint defaults this to `false`, which cost `stateKey` a
      // workaround and `modelViews` a disable comment before it was turned on.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true }
      ],
      // A swallowed error is how this degrades gracefully; an empty block with
      // no comment saying so is not.
      'no-empty': ['error', { allowEmptyCatch: false }]
    }
  },
  {
    files: ['src/webview/**/*.ts'],
    plugins: { squadron },
    processor: mentions.processor,
    rules: { 'squadron/mention-exception-reason': 'error' }
  },
  {
    files: ['src/webview/**/*.ts'],
    ignores: ['src/webview/prose.ts', 'src/webview/mention_pill.ts'],
    plugins: { squadron },
    rules: { 'squadron/mention-pills': 'error' }
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/core/platform/host.ts', 'src/test/home.ts'],
    plugins: { squadron },
    rules: { 'squadron/os-read': 'error' }
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/core/platform/**', 'src/test/**'],
    rules: { 'no-restricted-properties': ['error', namedProgram, ownerCheck] }
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/core/platform/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/executables/internal'],
              message: 'Program execution cooperation is internal to core/platform.'
            }
          ]
        }
      ]
    }
  },
  {
    // `describe` and `it` return promises that the runner owns, not the test.
    // A wrong `!` in a test throws and reds it, which is the assertion anyway;
    // 151 of the 158 sites flagged on 2026-10-02 were here.
    files: ['src/test/**'],
    plugins: { squadron },
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'squadron/skip-reason': 'error',
      'squadron/home-write': 'error',
      'squadron/temp-root': 'error'
    }
  },
  {
    // The build and deploy scripts are plain ESM run by node; nothing
    // type-aware to say. `docs/diagrams/embed.mjs` is the same kind of thing,
    // one directory down.
    files: [
      'scripts/**/*.mjs',
      'docs/diagrams/embed.mjs',
      'docs/QA/**/build-*.mjs',
      'docs/reference/cli_state/claude/probe*.mjs',
      'docs/reference/cli_state/codex/probe*.mjs',
      'docs/reference/cli_state/grok/probe*.mjs',
      'docs/mockups/build-*.mjs',
      'docs/mockups/shoot-*.mjs',
      'docs/mockups/coffee-cup/shoot-pour.mjs',
      'docs/design_tokens/lib/*.mjs',
      'docs/mockups/lib/*.mjs',
      'docs/design_tokens/build-*.mjs'
    ],
    ...tseslint.configs.disableTypeChecked,
    // A fresh `languageOptions` replaces the spread's, so name its
    // parserOptions again or these scripts rejoin the project service.
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        MessageEvent: 'readonly'
      }
    }
  },
  {
    // These functions execute in the page through Playwright or serialization.
    files: [
      'docs/mockups/build-at-mention.mjs',
      'docs/mockups/coffee-cup/shoot-pour.mjs',
      'docs/design_tokens/build-color-balance.mjs',
      'docs/design_tokens/build-bottom-drawer.mjs'
    ],
    languageOptions: {
      globals: {
        dispatchEvent: 'readonly',
        document: 'readonly',
        Image: 'readonly',
        getComputedStyle: 'readonly'
      }
    }
  },
  {
    files: ['docs/QA/kit/assets/report.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        document: 'readonly',
        addEventListener: 'readonly',
        requestAnimationFrame: 'readonly'
      }
    }
  },
  {
    files: ['scripts/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'readonly' }
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    files: ['docs/reference/windows/probe*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __filename: 'readonly'
      }
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { require: 'readonly', module: 'readonly', __dirname: 'readonly' }
    },
    // CommonJS, because that is what eslint loads a `.js` config as.
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  }
);
