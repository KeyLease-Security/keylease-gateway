#!/usr/bin/env node
/**
 * Prints a copy-pasteable Conventional Commit title for a rejected PR title.
 *
 * Usage:
 *   node scripts/pr-title-suggestion.mjs "Add proxy runbook"
 *   PR_TITLE="Add proxy runbook" node scripts/pr-title-suggestion.mjs
 *
 * The corrected title goes to stdout (CI captures it into the job summary and
 * an `::error::` annotation); explanations go to stderr.
 */
import { buildSuggestion, isExemptTitle } from './conventional-commits.mjs';

const fromArgs = process.argv.slice(2).join(' ').trim();
const title = fromArgs.length > 0 ? fromArgs : (process.env.PR_TITLE ?? '').trim();

if (title.length === 0) {
  process.stderr.write('usage: node scripts/pr-title-suggestion.mjs "<pull request title>"\n');
  process.exit(2);
}

if (isExemptTitle(title)) {
  process.stdout.write(`${title}\n`);
  process.exit(0);
}

const suggestion = buildSuggestion(title);
process.stdout.write(`${suggestion.title}\n`);
for (const note of suggestion.notes) {
  process.stderr.write(`note: ${note}\n`);
}
