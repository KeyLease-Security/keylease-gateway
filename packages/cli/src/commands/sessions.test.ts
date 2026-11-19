import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileSessionStore, type LeaseSession } from './lease.js';
import { sessionsCommand } from './sessions.js';
import { run, type CliIo } from '../index.js';

const NOW = 1_700_000_000;

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (line = '') => out.push(line),
      err: (line = '') => err.push(line),
    },
  };
}

function session(service: string, leaseId: string, expiresAt: number): LeaseSession {
  return {
    service,
    leaseId,
    consumer: 'GCONSUMER',
    token: 'kls1.payload.signature',
    callsLimit: 10,
    issuedAt: NOW - 10,
    expiresAt,
    txHash: null,
    network: 'testnet',
  };
}

describe('sessionsCommand', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'keylease-sessions-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists stored sessions in a table and supports JSON output', async () => {
    const store = fileSessionStore(dir);
    await store.saveAll({
      'weather-api': session('weather-api', 'lease-1', NOW + 60),
      'maps-api': session('maps-api', 'lease-2', NOW - 1),
    });

    const table = captureIo();
    expect(
      await sessionsCommand({ prune: false, json: false }, table.io, {
        store,
        now: () => NOW * 1000,
      }),
    ).toBe(0);
    expect(table.out.join('\n')).toContain('SERVICE');
    expect(table.out.join('\n')).toContain('weather-api');
    expect(table.out.join('\n')).toContain('lease-1');
    expect(table.out.join('\n')).toContain('active');
    expect(table.out.join('\n')).toContain('expired');

    const json = captureIo();
    await sessionsCommand({ prune: false, json: true }, json.io, {
      store,
      now: () => NOW * 1000,
    });
    expect(JSON.parse(json.out.join('\n'))).toEqual([
      { service: 'maps-api', lease_id: 'lease-2', expires_at: NOW - 1, status: 'expired' },
      { service: 'weather-api', lease_id: 'lease-1', expires_at: NOW + 60, status: 'active' },
    ]);
  });

  it('prunes expired sessions and reports the removed count', async () => {
    const store = fileSessionStore(dir);
    await store.saveAll({
      'expired-api': [session('expired-api', 'lease-old', NOW)],
      'active-api': [session('active-api', 'lease-current', NOW + 60)],
    });
    const { io, out } = captureIo();

    expect(
      await sessionsCommand({ prune: true, json: false }, io, {
        store,
        now: () => NOW * 1000,
      }),
    ).toBe(0);

    expect(out).toEqual(['Pruned 1 expired session.']);
    await expect(store.load()).resolves.toEqual({
      'active-api': [session('active-api', 'lease-current', NOW + 60)],
    });
  });

  it('reports corrupt and missing stores without exposing a stack trace', async () => {
    const corruptDir = join(dir, 'corrupt');
    await mkdir(join(corruptDir, '.keylease'), { recursive: true });
    await writeFile(join(corruptDir, '.keylease', 'sessions.json'), '{broken');

    for (const [cwd, expected, guidance] of [
      [corruptDir, 'corrupt', 'Back up or repair'],
      [join(dir, 'missing'), 'missing', 'keylease acquire'],
    ]) {
      const { io, err } = captureIo();
      expect(
        await run(['sessions'], io, { sessions: { store: fileSessionStore(cwd) } }),
      ).toBe(1);
      expect(err.join('\n')).toContain(expected);
      expect(err.join('\n')).toContain(guidance);
      expect(err.join('\n')).not.toMatch(/\n\s+at\s/);
    }
  });
});
