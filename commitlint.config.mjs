/**
 * Conventional Commits rules for pull request titles.
 *
 * CI pipes the pull request title into commitlint with this config:
 *
 *   printf '%s\n' "$PR_TITLE" | pnpm exec commitlint --config commitlint.config.mjs
 *
 * The accepted types and the length limit come from
 * `scripts/conventional-commits.mjs` so the CI check and the suggested title
 * can never disagree. Scopes stay free-form (lower-case only) on purpose:
 * see CONTRIBUTING.md for the recommended ones.
 */
import { MAX_HEADER_LENGTH, TYPES } from './scripts/conventional-commits.mjs';

export default {
  // commitlint parses a full commit message; these are the parser options
  // Conventional Commits needs, including the breaking-change `!` marker.
  parserPreset: {
    parserOpts: {
      headerPattern: /^(\w*)(?:\((.*)\))?!?: (.*)$/,
      breakingHeaderPattern: /^(\w*)(?:\((.*)\))?!: (.*)$/,
      headerCorrespondence: ['type', 'scope', 'subject'],
      noteKeywords: ['BREAKING CHANGE', 'BREAKING-CHANGE'],
    },
  },
  rules: {
    'type-empty': [2, 'never'],
    'type-case': [2, 'always', 'lower-case'],
    'type-enum': [2, 'always', TYPES],
    'scope-case': [2, 'always', 'lower-case'],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', MAX_HEADER_LENGTH],
  },
};
