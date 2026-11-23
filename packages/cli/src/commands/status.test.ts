import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { mintSessionToken } from '../token.js';
import type { LeaseState } from '../client/soroban.js';
import type { CliIo } from '../index.js';
import { statusCommand, type LeaseStateProvider, type StatusArgs } from './status.js';

const NOW = 1_700_000_000;
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

function makeLease(overrides: Partial<LeaseState> = {}): LeaseState {
  return {
    leaseId: '42',
    service: 'weather-api',
    provider: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    consumer: consumer.publicKey(),
    callsLimit: 10,
    callsUsed: 4,
    expiresAt: NOW + 600,
    active: true,
    settled: false,
    pricePaid: 10_000,
    ...overrides,
  };
}

function token(): string {
  return mintSessionToken({
    leaseId: '42',
    consumerSecret: consumer.secret(),
    issuedAt: NOW - 10,
    expiresAt: NOW + 300,
  });
}

function args(value: string, json = false): StatusArgs {
  return { token: value, checkChain: true, json };
}

describe('statusCommand --check-chain', () => {
  it('shows on-chain spend and per-call cost for --lease in text and JSON', async () => {
    const state = makeLease();
    const provider = { getLeaseState: vi.fn(async () => state) };
    const text = captureIo();

    expect(
      await statusCommand(
        { lease: '42', json: false },
        text.io,
        { createClient: () => provider },
      ),
    ).toBe(0);
    expect(text.out.join('\n')).toContain('escrow     : 10000');
    expect(text.out.join('\n')).toContain('price/call : 1000');

    const json = captureIo();
    await statusCommand(
      { lease: '42', json: true },
      json.io,
      { createClient: () => provider },
    );
    expect(JSON.parse(json.out.join('\n'))).toMatchObject({
      pricePaid: 10_000,
      pricePerCall: 1_000,
    });
  });

  it('passes token and on-chain checks for a valid lease', async () => {
    const bearer = token();
    const { io, out } = captureIo();
    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async () => makeLease()),
    };

    expect(
      await statusCommand(args(bearer, true), io, {
        leaseStateProvider: provider,
        now: () => NOW * 1000,
      }),
    ).toBe(0);

    const result = JSON.parse(out.join('\n')) as {
      token: { lease_id: string };
      checks: Record<string, { passed: boolean }>;
      lease: LeaseState;
    };
    expect(result.token.lease_id).toBe('42');
    expect(result.lease.service).toBe('weather-api');
    expect(Object.values(result.checks).every((check) => check.passed)).toBe(true);
    expect(provider.getLeaseState).toHaveBeenCalledWith('42');
    expect(out.join('\n')).not.toContain(bearer);
  });

  it('fails the lease-active check for a revoked lease', async () => {
    const { io, out } = captureIo();
    const provider: LeaseStateProvider = {
      getLeaseState: async () => makeLease({ active: false, settled: true }),
    };

    expect(
      await statusCommand(args(token()), io, {
        leaseStateProvider: provider,
        now: () => NOW * 1000,
      }),
    ).toBe(1);
    expect(out.join('\n')).toContain('lease active   : FAIL');
    expect(out.join('\n')).toContain('consumer match : PASS');
    expect(out.join('\n')).toContain('quota          : PASS');
  });

  it('keeps token checks visible and reports chain checks failed on RPC errors', async () => {
    const bearer = token();
    const { io, out } = captureIo();
    const provider: LeaseStateProvider = {
      getLeaseState: async () => {
        throw new Error('RPC unavailable');
      },
    };

    expect(
      await statusCommand(args(bearer), io, {
        leaseStateProvider: provider,
        now: () => NOW * 1000,
      }),
    ).toBe(1);
    expect(out.join('\n')).toContain('signature      : PASS');
    expect(out.join('\n')).toContain('expiry         : PASS');
    expect(out.join('\n')).toContain('lease active   : FAIL (chain lookup failed: RPC unavailable)');
    expect(out.join('\n')).not.toContain(bearer);
  });

  it('never echoes a deliberately malformed token in stderr', async () => {
    const malformed = 'kls1.invalid.token.with.too.many.parts';
    const { io, err } = captureIo();

    expect(
      await statusCommand(args(malformed), io, {
        now: () => NOW * 1000,
      }),
    ).toBe(1);

    const stderr = err.join('\n');
    expect(stderr).not.toContain('invalid');
    expect(stderr).not.toContain('kls1.invalid');
    expect(stderr).toContain('kls1.<redacted>');
  });

  it('redacts tokens in verification error messages', async () => {
    const malformed = 'kls1.notbase64url!!!.sig';
    const { io, err } = captureIo();

    await statusCommand(args(malformed, false), io, {
      now: () => NOW * 1000,
    });

    const stderr = err.join('\n');
    expect(stderr).not.toContain('kls1.notbase64url');
    expect(stderr).toContain('kls1.<redacted>');
  });
});

describe('statusCommand --lease', () => {
  it('includes network and truncated contract id in human output', async () => {
    const { io, out } = captureIo();
    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async () => makeLease()),
    };

    await statusCommand(
      { lease: '42', json: false },
      io,
      {
        leaseStateProvider: provider,
        networkName: 'testnet',
        contractId: 'CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC',
      },
    );

    const output = out.join('\n');
    expect(output).toContain('network    : testnet');
    expect(output).toContain('contract   : CC2YHTV3...UOXDA3KRC');
  });

  it('includes network and truncated contract id in JSON output', async () => {
    const { io, out } = captureIo();
    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async () => makeLease()),
    };

    await statusCommand(
      { lease: '42', json: true },
      io,
      {
        leaseStateProvider: provider,
        networkName: 'mainnet',
        contractId: 'CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC',
      },
    );

    const result = JSON.parse(out.join('\n')) as Record<string, unknown>;
    expect(result.network).toBe('mainnet');
    expect(result.contract_id).toBe('CC2YHTV3...UOXDA3KRC');
  });

  it('resolves network from args when not provided in deps', async () => {
    const { io, out } = captureIo();
    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async () => makeLease()),
    };

    await statusCommand(
      { lease: '42', network: 'local', json: false },
      io,
      {
        leaseStateProvider: provider,
      },
    );

    expect(out.join('\n')).toContain('network    : local');
  });

  it('defaults to testnet when network is not specified', async () => {
    const { io, out } = captureIo();
    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async () => makeLease()),
    };

    await statusCommand(
      { lease: '42', json: false },
      io,
      {
        leaseStateProvider: provider,
      },
    );

    expect(out.join('\n')).toContain('network    : testnet');
  });

  it('omits network and contract when not provided', async () => {
    const { io, out } = captureIo();
    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async () => makeLease()),
    };

    await statusCommand(
      { lease: '42', json: false },
      io,
      {
        leaseStateProvider: provider,
        networkName: undefined,
        contractId: undefined,
      },
    );

    const output = out.join('\n');
    expect(output).toContain('Lease 42');
    expect(output).not.toContain('network');
    expect(output).not.toContain('contract');
  });
});

describe('statusCommand --lease', () => {
  it('prints remaining calls for an active lease', async () => {
    const { io, out } = captureIo();
    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async () => makeLease({ callsUsed: 4, callsLimit: 10 })),
    };

    expect(
      await statusCommand({ lease: '42', checkChain: true, json: false }, io, {
        leaseStateProvider: provider,
        now: () => NOW * 1000,
      }),
    ).toBe(0);

    expect(out.join('\n')).toContain('remaining  : 6');
  });

  it('includes remainingCalls in JSON output', async () => {
    const { io, out } = captureIo();
    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async () => makeLease({ callsUsed: 2, callsLimit: 10 })),
    };

    expect(
      await statusCommand({ lease: '42', checkChain: true, json: true }, io, {
        leaseStateProvider: provider,
        now: () => NOW * 1000,
      }),
    ).toBe(0);

    const result = JSON.parse(out.join('\n')) as LeaseState & { remainingCalls: number };
    expect(result.remainingCalls).toBe(8);
  });

  it('returns zero remaining for a settled lease', async () => {
    const { io, out } = captureIo();
    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async () => makeLease({ callsUsed: 1, callsLimit: 500, settled: true })),
    };

    expect(
      await statusCommand({ lease: '42', checkChain: true, json: false }, io, {
        leaseStateProvider: provider,
        now: () => NOW * 1000,
      }),
    ).toBe(0);

    expect(out.join('\n')).toContain('remaining  : 0');
  });

  it('returns zero remaining for an inactive lease', async () => {
    const { io, out } = captureIo();
    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async () => makeLease({ callsUsed: 1, callsLimit: 500, active: false })),
    };

    expect(
      await statusCommand({ lease: '42', checkChain: true, json: false }, io, {
        leaseStateProvider: provider,
        now: () => NOW * 1000,
      }),
    ).toBe(0);

    expect(out.join('\n')).toContain('remaining  : 0');
  });

  it('returns zero remaining for an expired lease', async () => {
    const { io, out } = captureIo();
    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async () => makeLease({ callsUsed: 1, callsLimit: 500, expiresAt: NOW - 10 })),
    };

    expect(
      await statusCommand({ lease: '42', checkChain: true, json: false }, io, {
        leaseStateProvider: provider,
        now: () => NOW * 1000,
      }),
    ).toBe(0);

    expect(out.join('\n')).toContain('remaining  : 0');
  });

  it('returns zero remaining when all calls are used', async () => {
    const { io, out } = captureIo();
    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async () => makeLease({ callsUsed: 10, callsLimit: 10 })),
    };

    expect(
      await statusCommand({ lease: '42', checkChain: true, json: false }, io, {
        leaseStateProvider: provider,
        now: () => NOW * 1000,
      }),
    ).toBe(0);

    expect(out.join('\n')).toContain('remaining  : 0');
  });
});
