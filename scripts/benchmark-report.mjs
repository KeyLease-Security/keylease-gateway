import { readFile, writeFile } from 'node:fs/promises';

const [resultsPath = 'packages/proxy/benchmark-results.json', baselinePath = 'packages/proxy/benchmark-baseline.json'] =
  process.argv.slice(2);
const outputPath = process.env.BENCHMARK_MARKDOWN ?? 'benchmark-trend.md';

function collect(value, output = {}) {
  if (!value || typeof value !== 'object') return output;
  if (typeof value.name === 'string' && typeof value.hz === 'number') {
    output[value.name] = value.hz;
  }
  for (const child of Object.values(value)) collect(child, output);
  return output;
}

const results = JSON.parse(await readFile(resultsPath, 'utf8'));
const current = collect(results);
let baseline = {};
try {
  baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
} catch {
  baseline = {};
}
if (process.env.UPDATE_BENCHMARK_BASELINE === '1') {
  await writeFile(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  baseline = current;
}

const names = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
const rows = names.map((name) => {
  const before = baseline[name];
  const after = current[name];
  if (before === undefined) return `| ${name} | ${after?.toFixed(2) ?? 'n/a'} | baseline pending |`;
  if (after === undefined) return `| ${name} | n/a | deleted benchmark |`;
  const delta = ((after - before) / before) * 100;
  const sign = delta >= 0 ? '+' : '';
  return `| ${name} | ${after.toFixed(2)} | ${sign}${delta.toFixed(2)}% |`;
});

const markdown = [
  '## Proxy benchmark trend',
  '',
  '| Benchmark | ops/sec | vs baseline |',
  '|---|---:|---:|',
  ...rows,
  '',
  '_Run locally with `pnpm --filter @keylease/proxy bench`._',
].join('\n');

await writeFile(outputPath, `${markdown}\n`);
await writeFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/stdout', `${markdown}\n`, { flag: 'a' });
