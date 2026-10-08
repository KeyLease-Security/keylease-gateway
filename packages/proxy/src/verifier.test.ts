import { Keypair } from '@stellar/stellar-sdk';
import { mintSessionToken } from '@keylease/cli/token';
import type { LeaseState } from '@keylease/cli/soroban';
import { describe, expect, it, vi } from 'vitest';
import { LeaseVerifier, extractBearerToken, type LeaseStateProvider } from './verifier.js';

const START = 1_700_000_000;
const consumer = Keypair.random();
const IMPERSONATOR = Keypair.random();

function leaseState(overrides: Partial<LeaseState> = {}): LeaseState {
  return {
    leaseId: 'lease-1',
    service: 'weather-api',
    consumer: consumer.publicKey(),
    callsLimit: 5,
    callsUsed: 0,
    expiresAt: START + 3_600,
    active: true,
    ...overrides,
  };
}

function tokenFor(
  leaseId: string,
  signer: Keypair = consumer,
  issuedAt = START,
  expiresAt = START + 3_600,
): string {
  return mintSessionToken({
    leaseId,
    consumerSecret: signer.secret(),
    issuedAt,
    expiresAt,
  });
}

function makeVerifier(options: {
  provider?: LeaseStateProvider;
  lease?: LeaseState | null;
  cacheTtlMs?: number;
  nowMs?: number;
} = {}) {
  const nowMs = { value: options.nowMs ?? START * 1_000 };
  const lease = options.lease === undefined ? leaseState() : options.lease;
  const getLeaseState = vi.fn(async (leaseId: string) => {
    if (lease === null || leaseId !== lease.leaseId) {
      const error = new Error(`lease ${leaseId} was not found on chain`);
      error.name = 'LeaseNotFoundError';
      throw error;
    }
    return lease;
  });
  const provider: LeaseStateProvider = options.provider ?? { getLeaseState };

  const verifier = new LeaseVerifier({
    provider,
    cacheTtlMs: options.cacheTtlMs ?? 30_000,
    clock: () => nowMs.value,
  });

  return { verifier, provider, nowMs };
}

describe('extractBearerToken', () => {
  it('extracts the token from a Bearer header', () => {
    expect(extractBearerToken('Bearer kls1.a.b')).toBe('kls1.a.b');
    expect(extractBearerToken('  bearer   kls1.a.b  ')).toBe('kls1.a.b');
  });

  it('returns null for missing or non-bearer headers', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    expect(extractBearerToken('Bearer   ')).toBeNull();
  });
});

describe('LeaseVerifier token verification', () => {
  it('allows a valid token and consumes one call', async () => {
    const { verifier } = makeVerifier();
    const result = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lease.service).toBe('weather-api');
      expect(result.remainingCalls).toBe(4);
    }
    expect(verifier.localCalls('lease-1')).toBe(1);
    expect(verifier.stats().counters).toBe(1);
  });

  it('rejects a missing Authorization header', async () => {
    const { verifier, provider } = makeVerifier();
    const result = await verifier.verifyAuthorization(undefined);

    expect(result).toMatchObject({ ok: false, status: 401, reason: 'missing_token' });
    expect(provider.getLeaseState).not.toHaveBeenCalled();
  });

  it('rejects a non-bearer Authorization header', async () => {
    const { verifier } = makeVerifier();
    const result = await verifier.verifyAuthorization('Basic dXNlcjpwYXNz');
    expect(result).toMatchObject({ ok: false, status: 401, reason: 'invalid_token' });
  });

  it('rejects a token that fails signature verification', async () => {
    const { verifier, provider } = makeVerifier();
    const forged = tokenFor('lease-1', IMPERSONATOR);
    const result = await verifier.verifyAuthorization(`Bearer ${forged}x`);

    expect(result).toMatchObject({ ok: false, status: 401, reason: 'invalid_token' });
    expect(provider.getLeaseState).not.toHaveBeenCalled();
  });

  it('rejects a token minted by an account that does not own the lease', async () => {
    const { verifier } = makeVerifier();
    const result = await verifier.verifyAuthorization(
      `Bearer ${tokenFor('lease-1', IMPERSONATOR)}`,
    );

    expect(result).toMatchObject({ ok: false, status: 403, reason: 'consumer_mismatch' });
    expect(verifier.localCalls('lease-1')).toBe(0);
  });

  it('rejects an expired token', async () => {
    const { verifier } = makeVerifier();
    const expired = tokenFor('lease-1', consumer, START - 120, START - 60);
    const result = await verifier.verifyAuthorization(`Bearer ${expired}`);

    expect(result).toMatchObject({ ok: false, status: 401, reason: 'token_expired' });
    expect(verifier.stats().rpcCalls).toBe(0);
  });

  it('rejects a malformed token', async () => {
    const { verifier } = makeVerifier();
    const result = await verifier.verifyAuthorization('Bearer garbage');
    expect(result).toMatchObject({ ok: false, status: 401, reason: 'invalid_token' });
  });

  it('rejects a token whose lease does not exist on chain', async () => {
    const { verifier, provider } = makeVerifier();
    const result = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-missing')}`);

    expect(result).toMatchObject({ ok: false, status: 403, reason: 'lease_not_found' });
    expect(provider.getLeaseState).toHaveBeenCalledTimes(1);
  });

  it('answers 503 when the RPC layer is unavailable', async () => {
    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    };
    const { verifier } = makeVerifier({ provider });
    const result = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);

    expect(result).toMatchObject({ ok: false, status: 503, reason: 'verification_unavailable' });
    expect(verifier.stats().rpcCalls).toBe(1);
  });
});

describe('LeaseVerifier on-chain state checks', () => {
  it('rejects revoked leases', async () => {
    const { verifier } = makeVerifier({ lease: leaseState({ active: false }) });
    const result = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(result).toMatchObject({ ok: false, status: 403, reason: 'lease_inactive' });
  });

  it('rejects leases that expired on chain', async () => {
    const { verifier } = makeVerifier({ lease: leaseState({ expiresAt: START - 1 }) });
    const result = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(result).toMatchObject({ ok: false, status: 403, reason: 'lease_expired' });
  });

  it('rejects once the on-chain call counter is spent', async () => {
    const { verifier } = makeVerifier({
      lease: leaseState({ callsLimit: 3, callsUsed: 3 }),
    });
    const result = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(result).toMatchObject({ ok: false, status: 403, reason: 'quota_exhausted' });
    expect(verifier.localCalls('lease-1')).toBe(0);
  });
});

describe('LeaseVerifier local call counter', () => {
  it('allows exactly `callsLimit` requests before refusing', async () => {
    const { verifier } = makeVerifier({ lease: leaseState({ callsLimit: 2 }) });
    const header = `Bearer ${tokenFor('lease-1')}`;

    const first = await verifier.verifyAuthorization(header);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.remainingCalls).toBe(1);

    const second = await verifier.verifyAuthorization(header);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.remainingCalls).toBe(0);

    const third = await verifier.verifyAuthorization(header);
    expect(third).toMatchObject({ ok: false, status: 403, reason: 'quota_exhausted' });
    expect(verifier.localCalls('lease-1')).toBe(2);
  });

  it('takes the larger of the on-chain and local counters', async () => {
    const { verifier } = makeVerifier({ lease: leaseState({ callsLimit: 5, callsUsed: 4 }) });
    const header = `Bearer ${tokenFor('lease-1')}`;

    const result = await verifier.verifyAuthorization(header);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.remainingCalls).toBe(0);

    expect(await verifier.verifyAuthorization(header)).toMatchObject({
      ok: false,
      reason: 'quota_exhausted',
    });
  });

  it('tracks counters per lease and can reset them', async () => {
    const { verifier } = makeVerifier({
      lease: leaseState({ leaseId: 'lease-1', callsLimit: 1 }),
    });
    await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(verifier.localCalls('lease-1')).toBe(1);

    verifier.resetCalls('lease-1');
    expect(verifier.localCalls('lease-1')).toBe(0);

    verifier.resetCalls();
    expect(verifier.stats().counters).toBe(0);
  });
});

describe('LeaseVerifier RPC caching', () => {
  it('hits the RPC only once inside the TTL window', async () => {
    const lease = leaseState({ callsLimit: 100 });
    const provider: LeaseStateProvider = { getLeaseState: vi.fn(async () => lease) };
    const { verifier, nowMs } = makeVerifier({ provider, cacheTtlMs: 30_000 });

    for (let i = 0; i < 5; i += 1) {
      const result = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
      expect(result.ok).toBe(true);
    }

    expect(provider.getLeaseState).toHaveBeenCalledTimes(1);
    expect(verifier.stats().rpcCalls).toBe(1);
    expect(verifier.stats().cache.hits).toBe(4);

    // After the TTL elapses the state is re-read from chain.
    nowMs.value = (START + 31) * 1_000;
    const refreshed = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(refreshed.ok).toBe(true);
    expect(provider.getLeaseState).toHaveBeenCalledTimes(2);
  });

  it('does not cache provider failures', async () => {
    let calls = 0;
    const provider: LeaseStateProvider = {
      getLeaseState: async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error('boom'), { name: 'SorobanError' });
        }
        return leaseState();
      },
    };
    const { verifier } = makeVerifier({ provider });

    const first = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(first).toMatchObject({ ok: false, status: 503 });

    const second = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(second.ok).toBe(true);
    expect(calls).toBe(2);
  });
});
