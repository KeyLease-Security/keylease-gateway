import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { acquireCommand, envCommand, type LeaseSession } from './lease.js';
import { revokeCommand, settleCommand } from './lifecycle.js';
import { statusCommand } from './status.js';
import type { LeaseState } from '../client/soroban.js';
import type { CliIo } from '../index.js';

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

function lease(overrides: Partial<LeaseState> = {}): LeaseState {
  return {
    leaseId: '17',
    service: 'weather-api',
    provider: Keypair.random().publicKey(),
    consumer: consumer.publicKey(),
    callsLimit: 10,
    callsUsed: 4,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    active: true,
    settled: false,
    pricePaid: 10_000,
    ...overrides,
  };
}

function normalize(output: string[]): string {
  return `${output
    .join('\n')
    .replace(/kls1\.[^\s]+/g, '<SESSION_TOKEN>')
    .replace(/[GC][A-Z2-7]{55}/g, '<ADDRESS>')
    .replace(/\b[0-9a-f]{64}\b/gi, '<HASH>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<TIMESTAMP>')}\n`;
}

async function expectGolden(name: string, output: string[]): Promise<void> {
  const fixture = new URL(`../../test/golden/${name}.txt`, import.meta.url);
  const actual = normalize(output);
  if (process.env['UPDATE_GOLDEN'] === '1') await writeFile(fixture, actual);
  await expect(readFile(fixture, 'utf8')).resolves.toBe(actual);
}

describe('human-readable command output', () => {
  it('matches acquire output', async () => {
    const { io, out, err } = captureIo();
    const code = await acquireCommand(
      {
        service: 'weather-api',
        calls: 3,
        duration: 600,
        secret: consumer.secret(),
        json: false,
      },
      io,
      {
        now: () => 1_700_000_000_000,
        store: {
          load: async () => ({}),
          save: async () => {},
          saveAll: async () => {},
        },
        createClient: () => ({
          quote: async () => 15_000,
          createLease: async () => ({
            leaseId: '17',
            txHash: randomBytes(32).toString('hex'),
          }),
          getLeaseState: async () =>
            lease({
              callsLimit: 3,
              callsUsed: 0,
              expiresAt: 1_700_000_600,
              pricePaid: 15_000,
            }),
        }),
      },
    );

    expect(code).toBe(0);
    expect(err).toEqual([]);
    await expectGolden('acquire', out);
  });

  it('matches status output', async () => {
    const { io, out } = captureIo();
    expect(
      await statusCommand(
        { lease: '17', json: false },
        io,
        { createClient: () => ({ getLeaseState: async () => lease() }) },
      ),
    ).toBe(0);
    await expectGolden('status', out);
  });

  it('matches env output', async () => {
    const session: LeaseSession = {
      service: 'weather-api',
      leaseId: '17',
      consumer: consumer.publicKey(),
      token: 'kls1.payload.signature',
      callsLimit: 3,
      issuedAt: 1_700_000_000,
      expiresAt: 1_700_000_600,
      txHash: null,
      network: 'testnet',
    };
    const { io, out } = captureIo();
    expect(
      await envCommand(
        { service: session.service, file: '.env', json: false },
        io,
        {
          store: {
            load: async () => ({ [session.service]: session }),
            save: async () => {},
            saveAll: async () => {},
          },
          readFile: async () => '',
          writeFile: async () => {},
        },
      ),
    ).toBe(0);
    await expectGolden('env', out);
  });

  it('matches settle output', async () => {
    const { io, out } = captureIo();
    expect(
      await settleCommand(
        { lease: ['17'], secret: consumer.secret(), json: false },
        io,
        { createClient: () => ({ settle: async () => lease({ settled: true }) }) },
      ),
    ).toBe(0);
    await expectGolden('settle', out);
  });

  it('matches revoke output', async () => {
    const { io, out } = captureIo();
    expect(
      await revokeCommand(
        { lease: ['17'], secret: consumer.secret(), json: false },
        io,
        { createClient: () => ({ revoke: async () => lease({ callsUsed: 1, settled: true }) }) },
      ),
    ).toBe(0);
    await expectGolden('revoke', out);
  });
});
