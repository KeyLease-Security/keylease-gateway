import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { revokeCommand, settleCommand } from './lifecycle.js';
import type { LeaseState } from '../client/soroban.js';
import type { CliIo } from '../index.js';

const consumer = Keypair.random();

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (line = '') => out.push(line), err: (line = '') => err.push(line) } };
}

function lease(overrides: Partial<LeaseState> = {}): LeaseState {
  return {
    leaseId: '42',
    service: 'weather-api',
    provider: 'GB6NFD3JZ2ZQY5Q7JQZ3QZ3QZ3QZ3QZ3QZ3QZ3QZ3QZ3QZ3QZ3QZ3QZ',
    consumer: consumer.publicKey(),
    callsLimit: 10,
    callsUsed: 4,
    expiresAt: 1_700_000_000,
    active: false,
    settled: true,
    pricePaid: 10_000,
    ...overrides,
  };
}

describe('settleCommand', () => {
  it('submits settle with the consumer key and reports the payout split', async () => {
    const { io, out } = captureIo();
    const seen: Array<{ leaseId: string; signer: string }> = [];

    const code = await settleCommand(
      { lease: '42', secret: consumer.secret(), json: false },
      io,
      {
        createClient: () => ({
          settle: async (leaseId: string, signer: Keypair) => {
            seen.push({ leaseId, signer: signer.publicKey() });
            return lease({ leaseId });
          },
        }),
      },
    );

    expect(code).toBe(0);
    expect(seen).toEqual([{ leaseId: '42', signer: consumer.publicKey() }]);
    const text = out.join('\n');
    expect(text).toContain('Lease 42 settled');
    expect(text).toContain('paid out    : 4000');
    expect(text).toContain('refunded    : 6000');
  });

  it('supports --json', async () => {
    const { io, out } = captureIo();
    await settleCommand({ lease: '42', secret: consumer.secret(), json: true }, io, {
      createClient: () => ({ settle: async () => lease() }),
    });
    const parsed = JSON.parse(out.join('\n')) as Record<string, unknown>;
    expect(parsed['action']).toBe('settled');
    expect(parsed['leaseId']).toBe('42');
  });

  it('rejects an invalid secret before touching the chain', async () => {
    const { io } = captureIo();
    await expect(
      settleCommand({ lease: '42', secret: 'nope', json: false }, io, {
        createClient: () => ({ settle: async () => lease() }),
      }),
    ).rejects.toThrow(/Stellar secret seed/);
  });
});

describe('revokeCommand', () => {
  it('submits revoke and renders the refund', async () => {
    const { io, out } = captureIo();
    const code = await revokeCommand(
      { lease: '42', secret: consumer.secret(), json: false },
      io,
      { createClient: () => ({ revoke: async () => lease({ callsUsed: 1 }) }) },
    );

    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Lease 42 revoked');
    expect(out.join('\n')).toContain('refunded    : 9000');
  });
});
