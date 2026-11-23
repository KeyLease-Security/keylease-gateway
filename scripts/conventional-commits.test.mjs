import { describe, expect, it } from 'vitest';
import {
  MAX_HEADER_LENGTH,
  TYPES,
  buildSuggestion,
  isExemptActor,
  isExemptTitle,
  parseTitle,
  validateTitle,
} from './conventional-commits.mjs';

describe('validateTitle', () => {
  it.each([
    'feat(proxy): add request validation',
    'fix(ci): pin actionlint',
    'docs: add proxy runbook',
    'test(contract): cover unauthorised entrypoints',
    'chore: bump tooling',
    'ci: validate the pull request title',
    'feat: add a health endpoint',
    'feat(proxy)!: require the gateway key for on-chain quota',
    'fix!: drop Node 20 support',
  ])('accepts %s', (title) => {
    expect(validateTitle(title)).toMatchObject({ ok: true, reasons: [] });
  });

  it.each([
    ['Add proxy runbook', 'missing type'],
    ['feature(proxy): add x', 'synonym is not an accepted type'],
    ['feat(Proxy): add x', 'scope must be lower-case'],
    ['docs: add proxy runbook.', 'subject must not end with a period'],
    ['feat: ', 'subject is empty'],
    ['feat(proxy) add x', 'missing colon'],
  ])('rejects %s (%s)', (title) => {
    expect(validateTitle(title).ok).toBe(false);
  });

  it('rejects a header longer than the limit', () => {
    const title = `feat(proxy): ${'x'.repeat(MAX_HEADER_LENGTH)}`;
    const result = validateTitle(title);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain(String(MAX_HEADER_LENGTH));
  });

  it('keeps the breaking-change marker when parsing', () => {
    expect(parseTitle('feat(proxy)!: drop legacy quota')).toMatchObject({
      type: 'feat',
      scope: 'proxy',
      breaking: true,
      subject: 'drop legacy quota',
    });
  });
});

describe('buildSuggestion', () => {
  it('adds a type inferred from the subject', () => {
    expect(buildSuggestion('Add proxy runbook').title).toBe('docs: add proxy runbook');
  });

  it('normalises type and scope casing and drops a trailing period', () => {
    expect(buildSuggestion('Feat(Proxy): Add request validation.').title).toBe(
      'feat(proxy): add request validation',
    );
  });

  it('keeps a valid title unchanged', () => {
    for (const title of [
      'feat(proxy): add request validation',
      'docs: add mainnet readiness checklist',
      'fix!: drop the deprecated parser',
    ]) {
      expect(buildSuggestion(title).title).toBe(title);
    }
  });

  it('maps a rejected type to an accepted one', () => {
    expect(buildSuggestion('security: harden header handling').title).toBe(
      'fix: harden header handling',
    );
    expect(buildSuggestion('feature(proxy): add retries').title).toBe(
      'feat(proxy): add retries',
    );
  });

  it('turns every rejected title into one the rules accept', () => {
    const rejected = [
      'Add proxy runbook',
      'feature(proxy): add x',
      'feat(Proxy): add x',
      'docs: add proxy runbook.',
      'Fix broken quota retry',
      '[ci] Add a title check',
      'Update the README',
      'release 0.2.0',
    ];
    for (const title of rejected) {
      const suggestion = buildSuggestion(title).title;
      expect(validateTitle(suggestion).ok, `${title} -> ${suggestion}`).toBe(true);
    }
  });

  it('does not claim a type that was present in the title', () => {
    expect(buildSuggestion('feat(proxy): add request validation').notes).toEqual([]);
  });
});

describe('exemptions', () => {
  it('exempts merge-commit titles only', () => {
    expect(isExemptTitle('Merge pull request #150 from KeyLease-Security/main')).toBe(true);
    expect(isExemptTitle('Merge branch "feat/x" into main')).toBe(true);
    expect(isExemptTitle('feat: add proxy runbook')).toBe(false);
    expect(isExemptTitle('Merge quota fix')).toBe(false);
  });

  it('exempts dependabot only', () => {
    expect(isExemptActor('dependabot[bot]')).toBe(true);
    expect(isExemptActor('renovate[bot]')).toBe(false);
    expect(isExemptActor('octocat')).toBe(false);
  });
});

describe('rule table', () => {
  it('lists each type once, in lower case', () => {
    expect(new Set(TYPES).size).toBe(TYPES.length);
    for (const type of TYPES) expect(type).toBe(type.toLowerCase());
  });
});
