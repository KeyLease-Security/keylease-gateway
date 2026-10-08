import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireCommand,
  envCommand,
  envEntriesFor,
  fileSessionStore,
  mergeEnv,
  parseConsumerSecret,
  type LeaseSession,
} from './lease.js';
import { verifySessionToken } from '../token.js';
import type { CliIo } from '../index.js';

const NOW_MS = 1_700_000_000_000;
const NOW = NOW_MS / 1000;
const consumer = Keypair.random();

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

function memoryStore(initial: Record<string, LeaseSession> = {}) {
  const sessions: Record<string, LeaseSession> = { ...initial };
  return {
    sessions,
    load: async () => sessions,
    save: async (session: LeaseSession) => {
      sessions[session.service] = session;
    },
  };
}

describe('parseConsumerSecret', () => {
  it('accepts a valid stellar secret seed', () => {
    expect(parseConsumerSecret(consumer.secret()).publicKey()).toBe(consumer.publicKey());
  });

  it('rejects anything else', () => {
    expect(() => parseConsumerSecret('password')).toThrow(/Stellar secret seed/);
  });
});

describe('acquireCommand', () => {
  it('invokes create_lease and mints a verifiable session token', async () => {
    const store = memoryStore();
    const { io, out } = captureIo();
    const calls: Array<Record<string, unknown>> = [];

    const code = await acquireCommand(
      {
        service: 'weather-api',
        calls: 7,
        duration: 600,
        secret: consumer.secret(),
        json: false,
      },
      io,
      {
        now: () => NOW_MS,
        store,
        createClient: () => ({
          createLease: async (params) => {
            calls.push({
              service: params.service,
              calls: params.calls,
              duration: params.duration,
              consumer: params.consumer.publicKey(),
            });
            return { leaseId: 'lease-xyz', txHash: 'aaaa1111' };
          },
        }),
      },
    );

    expect(code).toBe(0);
    expect(calls).toEqual([
      { service: 'weather-api', calls: 7, duration: 600, consumer: consumer.publicKey() },
    ]);

    const session = store.sessions['weather-api'] as LeaseSession;
    expect(session.leaseId).toBe('lease-xyz');
    expect(session.consumer).toBe(consumer.publicKey());
    expect(session.expiresAt).toBe(NOW + 600);

    const payload = verifySessionToken(session.token, { now: NOW + 1 });
    expect(payload.lease_id).toBe('lease-xyz');
    expect(payload.consumer).toBe(consumer.publicKey());
    expect(out.join('\n')).toContain('Bearer kls1.');
  });

  it('supports JSON output', async () => {
    const { io, out } = captureIo();
    const code = await acquireCommand(
      { service: 'weather-api', calls: 1, duration: 60, secret: consumer.secret(), json: true },
      io,
      {
        now: () => NOW_MS,
        store: memoryStore(),
        createClient: () => ({
          createLease: async () => ({ leaseId: 'lease-json', txHash: 'beef' }),
        }),
      },
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(out.join('\n')) as Record<string, unknown>;
    expect(parsed['lease_id']).toBe('lease-json');
    expect(String(parsed['session_token'])).toContain('kls1.');
  });

  it('rejects an invalid secret before touching the chain', async () => {
    const { io, err } = captureIo();
    await expect(
      acquireCommand(
        { service: 'weather-api', calls: 1, duration: 60, secret: 'nope', json: false },
        io,
        { createClient: () => ({ createLease: async () => ({ leaseId: 'x', txHash: 'y' }) }) },
      ),
    ).rejects.toThrow(/Stellar secret seed/);
    expect(err).toEqual([]);
  });
});

describe('envEntriesFor', () => {
  const session: LeaseSession = {
    service: 'weather-api',
    leaseId: 'lease-xyz',
    consumer: 'GCC...',
    token: 'kls1.abc.def',
    callsLimit: 12,
    issuedAt: 100,
    expiresAt: 200,
    txHash: null,
    network: 'testnet',
  };

  it('exposes the temporary keys under KEYLEASE_* names', () => {
    expect(envEntriesFor(session)).toEqual({
      KEYLEASE_SERVICE: 'weather-api',
      KEYLEASE_LEASE_ID: 'lease-xyz',
      KEYLEASE_CONSUMER: 'GCC...',
      KEYLEASE_SESSION_TOKEN: 'kls1.abc.def',
      KEYLEASE_CALLS_LIMIT: '12',
      KEYLEASE_ISSUED_AT: '100',
      KEYLEASE_EXPIRES_AT: '200',
    });
  });
});

describe('mergeEnv', () => {
  it('appends keys to an empty file', () => {
    expect(mergeEnv('', { A: '1', B: '2' })).toBe('A=1\nB=2\n');
  });

  it('replaces known keys in place and preserves everything else', () => {
    const existing = ['FOO=bar', 'A=old', '# comment', 'A=duplicate', ''].join('\n');
    const merged = mergeEnv(existing, { A: 'new', B: 'added' });
    expect(merged).toBe('FOO=bar\nA=new\n# comment\nB=added\n');
  });

  it('keeps unrelated lines untouched on repeated writes', () => {
    const once = mergeEnv('', { KEYLEASE_SERVICE: 'x' });
    const twice = mergeEnv(once, { KEYLEASE_SERVICE: 'x' });
    expect(twice).toBe(once);
  });
});

describe('envCommand', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'keylease-env-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes session keys into the target .env', async () => {
    const target = join(dir, '.env');
    const { io, out } = captureIo();
    const store = memoryStore({
      'weather-api': {
        service: 'weather-api',
        leaseId: 'lease-xyz',
        consumer: consumer.publicKey(),
        token: 'kls1.abc.def',
        callsLimit: 3,
        issuedAt: NOW,
        expiresAt: NOW + 600,
        txHash: null,
        network: 'testnet',
      },
    });

    const code = await envCommand({ service: 'weather-api', file: target, json: false }, io, {
      store,
    });

    expect(code).toBe(0);
    const written = await readFile(target, 'utf8');
    expect(written).toContain('KEYLEASE_LEASE_ID=lease-xyz');
    expect(written).toContain('KEYLEASE_SESSION_TOKEN=kls1.abc.def');
    expect(out.join('\n')).toContain(target);
  });

  it('preserves existing variables in the .env', async () => {
    const target = join(dir, '.env');
    const { io } = captureIo();
    const store = memoryStore({
      'weather-api': {
        service: 'weather-api',
        leaseId: 'lease-xyz',
        consumer: consumer.publicKey(),
        token: 'kls1.abc.def',
        callsLimit: 3,
        issuedAt: NOW,
        expiresAt: NOW + 600,
        txHash: null,
        network: 'testnet',
      },
    });

    const { writeFile } = await import('node:fs/promises');
    await writeFile(target, 'EXISTING=value\n');

    expect(await envCommand({ service: 'weather-api', file: target, json: false }, io, { store })).toBe(0);
    const written = await readFile(target, 'utf8');
    expect(written).toContain('EXISTING=value');
    expect(written).toContain('KEYLEASE_SERVICE=weather-api');
  });

  it('fails when no lease exists for the service', async () => {
    const { io, err } = captureIo();
    const code = await envCommand(
      { service: 'unknown', file: join(dir, '.env'), json: false },
      io,
      { store: memoryStore() },
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('no lease found');
  });
});

describe('fileSessionStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'keylease-store-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips sessions through disk', async () => {
    const store = fileSessionStore(dir);
    expect(await store.load()).toEqual({});

    await store.save({
      service: 'weather-api',
      leaseId: 'lease-1',
      consumer: consumer.publicKey(),
      token: 'kls1.x.y',
      callsLimit: 1,
      issuedAt: NOW,
      expiresAt: NOW + 60,
      txHash: null,
      network: 'testnet',
    });

    const reloaded = await fileSessionStore(dir).load();
    expect(reloaded['weather-api']?.leaseId).toBe('lease-1');
  });

  it('treats a corrupt store as empty', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(dir, '.keylease'), { recursive: true });
    await writeFile(join(dir, '.keylease', 'sessions.json'), 'not json');
    const store = fileSessionStore(dir);
    await expect(store.load()).resolves.toEqual({});
  });
});
