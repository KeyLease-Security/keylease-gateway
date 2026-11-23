import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

export const COVERAGE_MARKER = '<!-- keylease-coverage-comment -->';

function metric(value) {
  if (!value || !Number.isFinite(value.covered) || !Number.isFinite(value.total)) {
    return null;
  }
  const pct = value.total === 0 ? 100 : (value.covered / value.total) * 100;
  return { covered: value.covered, total: value.total, pct };
}

export function parseVitestCoverageSummary(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const entries = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'total') continue;
    if (!value || typeof value !== 'object') continue;
    const lines = metric(value.lines);
    const branches = metric(value.branches);
    if (lines || branches) entries.push({ key, lines, branches });
  }
  return entries.length > 0 ? entries : null;
}

function findFiles(path, name = 'coverage-summary.json') {
  const absolute = resolve(path);
  try {
    if (statSync(absolute).isFile()) return basename(absolute) === name ? [absolute] : [];
  } catch {
    return [];
  }
  const found = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(child, name));
    else if (entry.name === name) found.push(child);
  }
  return found;
}

export function readCoverageSummaries(path) {
  const entries = [];
  for (const file of findFiles(path)) {
    const normalized = file.replaceAll('\\', '/');
    const match = normalized.match(/(?:^|\/)(packages\/[^/]+)(?:\/|$)/);
    const packageName = match ? `@keylease/${match[1].split('/').pop()}` : null;
    const parsed = parseVitestCoverageSummary(file) ?? [];
    entries.push(...parsed.map((entry) => ({ ...entry, packageName })));
  }
  return entries;
}

function packageName(entryKey) {
  const normalized = entryKey.replaceAll('\\', '/');
  const match = normalized.match(/(?:^|\/)(packages\/[^/]+)(?:\/|$)/);
  return match ? match[1].replace('packages/', '@keylease/') : 'other';
}

export function aggregateByPackage(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const name = entry.packageName ?? packageName(entry.key);
    const group = grouped.get(name) ?? { lines: { covered: 0, total: 0 }, branches: { covered: 0, total: 0 } };
    if (entry.lines) {
      group.lines.covered += entry.lines.covered;
      group.lines.total += entry.lines.total;
    }
    if (entry.branches) {
      group.branches.covered += entry.branches.covered;
      group.branches.total += entry.branches.total;
    }
    grouped.set(name, group);
  }
  return [...grouped].map(([name, counts]) => ({
    name,
    lines: counts.lines.total === 0 ? null : (counts.lines.covered / counts.lines.total) * 100,
    branches: counts.branches.total === 0 ? null : (counts.branches.covered / counts.branches.total) * 100,
  }));
}

function percentage(value) {
  return value === null ? 'Unavailable' : `${value.toFixed(2)}%`;
}

function delta(pr, base) {
  if (pr === null || base === null) return 'Unavailable';
  const difference = pr - base;
  if (Math.abs(difference) < 0.005) return '0.00% (unchanged)';
  const sign = difference > 0 ? '+' : '';
  return `${sign}${difference.toFixed(2)}%`;
}

export function generateCoverageComment(prEntries, baseEntries) {
  const pr = aggregateByPackage(prEntries);
  const base = aggregateByPackage(baseEntries);
  const baseByName = new Map(base.map((item) => [item.name, item]));
  const names = [...new Set([...pr.map((item) => item.name), ...base.map((item) => item.name)])].sort();
  const rows = [];

  for (const name of names) {
    const prCoverage = pr.find((item) => item.name === name) ?? { lines: null, branches: null };
    const baseCoverage = baseByName.get(name) ?? { lines: null, branches: null };
    rows.push(
      `| ${name} | ${percentage(prCoverage.lines)} | ${percentage(baseCoverage.lines)} | ${delta(prCoverage.lines, baseCoverage.lines)} | ${percentage(prCoverage.branches)} | ${percentage(baseCoverage.branches)} | ${delta(prCoverage.branches, baseCoverage.branches)} |`,
    );
  }

  const unavailable = rows.length === 0 || names.some((name) => {
    const baseCoverage = baseByName.get(name);
    return !baseCoverage;
  });

  return [
    COVERAGE_MARKER,
    '## Package coverage',
    '',
    '| Package | PR lines | Base lines | Line delta | PR branches | Base branches | Branch delta |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...(rows.length > 0 ? rows : ['| Unavailable | Unavailable | Unavailable | Unavailable | Unavailable | Unavailable | Unavailable |']),
    '',
    unavailable
      ? '> Base coverage is unavailable or could not be matched for some packages. Deltas are omitted rather than estimated.'
      : '> Coverage values are calculated from Vitest JSON summary data.',
  ].join('\n');
}

export function findStickyComment(comments, marker = COVERAGE_MARKER) {
  if (!Array.isArray(comments)) return null;
  return comments.find((comment) =>
    typeof comment.body === 'string' && comment.body.includes(marker),
  ) ?? null;
}

function parseArgs(argv) {
  const args = { prCoverage: null, baseCoverage: null, comment: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--pr-coverage') args.prCoverage = argv[++index];
    else if (argv[index] === '--base-coverage') args.baseCoverage = argv[++index];
    else if (argv[index] === '--comment') args.comment = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prCoverage || !args.baseCoverage) {
    throw new Error('Usage: coverage-comment.mjs --pr-coverage <path> --base-coverage <path> [--comment]');
  }
  const prEntries = readCoverageSummaries(args.prCoverage);
  const baseEntries = readCoverageSummaries(args.baseCoverage);
  const body = generateCoverageComment(prEntries, baseEntries);

  if (!args.comment) {
    process.stdout.write(`${body}\n`);
    return;
  }

  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = process.env.PR_NUMBER;
  if (!repo || !prNumber) {
    process.stdout.write(`${body}\n`);
    process.stdout.write('Coverage comment skipped: PR metadata is unavailable.\n');
    return;
  }

  try {
    const output = execFileSync(
      'gh',
      ['api', '--paginate', `repos/${repo}/issues/${prNumber}/comments`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const comments = JSON.parse(output);
    const existing = findStickyComment(comments);
    if (existing) {
      execFileSync(
        'gh',
        ['api', '--method', 'PATCH', `repos/${repo}/issues/comments/${existing.id}`, '-f', `body=${body}`],
        { stdio: 'ignore' },
      );
    } else {
      execFileSync(
        'gh',
        ['api', '--method', 'POST', `repos/${repo}/issues/${prNumber}/comments`, '-f', `body=${body}`],
        { stdio: 'ignore' },
      );
    }
  } catch {
    process.stdout.write('Coverage comment skipped: GitHub comment permissions are unavailable.\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main();
}
