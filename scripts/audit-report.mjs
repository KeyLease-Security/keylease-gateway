import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const [reportPath, exitStatus = '0'] = process.argv.slice(2);
if (!reportPath) {
  console.error('usage: node scripts/audit-report.mjs <pnpm-audit.json> <exit-status>');
  process.exit(1);
}

const statusCode = Number(exitStatus);
if (!Number.isFinite(statusCode) || statusCode > 1) {
  console.error(`pnpm audit command failed (exit ${exitStatus})`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(await readFile(reportPath, 'utf8'));
} catch (error) {
  if (Number(exitStatus) !== 0) {
    console.error(`pnpm audit command failed (exit ${exitStatus}); no usable JSON report`);
    process.exit(1);
  }
  throw error;
}

const advisories = report.advisories ?? {};
const rows = Object.entries(advisories)
  .map(([id, advisory]) => {
    const severity = String(advisory.severity ?? 'unknown');
    if (!['high', 'critical'].includes(severity.toLowerCase())) return null;
    const pkg = advisory.module_name ??
      advisory.name ??
      advisory.findings?.[0]?.paths?.[0]?.split?.('@')?.slice(0, -1)?.join('@') ??
      'unknown';
    const fixed = advisory.patched_versions ??
      advisory.fixAvailable?.version ??
      advisory.recommendation ??
      'not specified';
    return { id, severity: severity.toLowerCase(), pkg, fixed };
  })
  .filter(Boolean)
  .sort((a, b) => a.id.localeCompare(b.id));

if (rows.length === 0) {
  console.log('No high or critical workspace advisories found.');
  process.exit(0);
}

const lines = [
  '# pnpm dependency advisory tracking',
  '',
  '> This issue is maintained automatically by the weekly workspace audit.',
  '',
  '| Advisory | Severity | Package | Fixed version |',
  '|---|---|---|---|',
  ...rows.map((row) =>
    `| ${row.id} | ${row.severity} | ${row.pkg} | ${String(row.fixed).replaceAll('|', '\\|')} |`,
  ),
];

const bodyPath = '/tmp/keylease-pnpm-audit-issue.md';
await writeFile(bodyPath, `${lines.join('\n')}\n`);

const title = 'security: pnpm audit high and critical advisories';
const search = spawnSync(
  'gh',
  ['issue', 'list', '--state', 'open', '--search', `${title} in:title`, '--json', 'number,title', '--limit', '20'],
  { encoding: 'utf8' },
);
if (search.status !== 0) {
  console.error(search.stderr || 'unable to search GitHub issues');
  process.exit(1);
}

const issues = JSON.parse(search.stdout || '[]');
const existing = issues.find((issue) => issue.title === title);
if (existing) {
  const update = spawnSync(
    'gh',
    ['issue', 'edit', String(existing.number), '--body-file', bodyPath],
    { encoding: 'utf8' },
  );
  if (update.status !== 0) {
    console.error(update.stderr || `unable to update issue #${existing.number}`);
    process.exit(1);
  }
  console.log(`Updated tracking issue #${existing.number}`);
} else {
  const create = spawnSync(
    'gh',
    ['issue', 'create', '--title', title, '--body-file', bodyPath],
    { encoding: 'utf8' },
  );
  if (create.status !== 0) {
    console.error(create.stderr || 'unable to create tracking issue');
    process.exit(1);
  }
  console.log(create.stdout.trim());
}
