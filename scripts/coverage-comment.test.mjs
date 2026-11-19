import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  COVERAGE_MARKER,
  aggregateByPackage,
  findStickyComment,
  generateCoverageComment,
  parseVitestCoverageSummary,
  readCoverageSummaries,
} from './coverage-comment.mjs';

function writeSummary(directory, summary) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'coverage-summary.json');
  writeFileSync(file, JSON.stringify(summary));
  return file;
}

test('parses Vitest summaries and aggregates multiple packages', () => {
  const root = mkdtempSync(join(tmpdir(), 'keylease-coverage-'));
  try {
    const cli = writeSummary(join(root, 'packages/cli/coverage'), {
      'packages/cli/src/a.ts': { lines: { covered: 8, total: 10 }, branches: { covered: 3, total: 4 } },
      'packages/cli/src/b.ts': { lines: { covered: 7, total: 10 }, branches: { covered: 1, total: 4 } },
    });
    const parsed = parseVitestCoverageSummary(cli);
    assert.equal(parsed.length, 2);
    assert.deepEqual(aggregateByPackage(parsed), [{
      name: '@keylease/cli',
      lines: 75,
      branches: 50,
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('calculates positive, negative, and unchanged deltas', () => {
  const pr = [{ key: 'packages/proxy/src/a.ts', lines: { covered: 9, total: 10, pct: 90 }, branches: { covered: 4, total: 5, pct: 80 } }];
  const base = [{ key: 'packages/proxy/src/a.ts', lines: { covered: 8, total: 10, pct: 80 }, branches: { covered: 4, total: 5, pct: 80 } }];
  const comment = generateCoverageComment(pr, base);
  assert.match(comment, /\+10\.00%/);
  assert.match(comment, /0\.00% \(unchanged\)/);

  const negative = generateCoverageComment(
    [{ key: 'packages/proxy/src/a.ts', lines: { covered: 7, total: 10, pct: 70 }, branches: { covered: 2, total: 5, pct: 40 } }],
    base,
  );
  assert.match(negative, /-10\.00%/);
});

test('handles missing and malformed coverage data', () => {
  const root = mkdtempSync(join(tmpdir(), 'keylease-coverage-'));
  try {
    const malformed = join(root, 'malformed.json');
    writeFileSync(malformed, '{bad json');
    assert.equal(parseVitestCoverageSummary(malformed), null);
    assert.equal(readCoverageSummaries(join(root, 'missing')).length, 0);
    const comment = generateCoverageComment([], []);
    assert.match(comment, /Base coverage is unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uses a stable sticky marker and selects only the existing matching comment', () => {
  const comments = [
    { id: 1, body: 'unrelated' },
    { id: 2, body: `${COVERAGE_MARKER}\n## Package coverage` },
  ];
  assert.equal(findStickyComment(comments)?.id, 2);
  assert.equal(findStickyComment([{ id: 1, body: 'unrelated' }]), null);
  assert.match(generateCoverageComment([], []), new RegExp(COVERAGE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
