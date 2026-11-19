import { Keypair } from '@stellar/stellar-sdk';
import { mintSessionToken } from '@keylease/cli/token';
import type { LeaseState } from '@keylease/cli/soroban';
import { describe, expect, it, vi } from 'vitest';
import { LeaseVerifier, extractBearerToken, type LeaseStateProvider } from './verifier.js';
import { TtlCache } from './cache.js';
import { OnChainQuota } from './quota.js';

const START = 1_700_000_000;
const consumer = Keypair.random();
const IMPERSONATOR = Keypair.random();

function leaseState(overrides: Partial<LeaseState> = {}): LeaseState {
  return {
    leaseId: 'lease-1',
    service: 'weather-api',
    provider: 'GCCJ6YI4KDNQJWVXQY2QZ6XKQ2J6QJ6YI4KDNQJWVXQY2QZ6XKQ2J6Q',
    consumer: consumer.publicKey(),
    callsLimit: 5,
    callsUsed: 0,
    expiresAt: START + 3_600,
    active: true,
    settled: false,
    pricePaid: 5_000,
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

describe('LeaseVerifier cache TTL near expiry', () => {
  it('re-fetches a lease expiring in 2s after 2s, not after the full TTL', async () => {
    const { verifier, provider, nowMs } = makeVerifier({
      lease: leaseState({ expiresAt: START + 2 }),
    });
    const header = `Bearer ${tokenFor('lease-1')}`;
    expect((await verifier.verifyAuthorization(header)).ok).toBe(true);
    nowMs.value += 1_000;
    expect((await verifier.verifyAuthorization(header)).ok).toBe(true);
    expect(provider.getLeaseState).toHaveBeenCalledTimes(1);
    nowMs.value += 1_000;
    const result = await verifier.verifyAuthorization(header);
    expect(provider.getLeaseState).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: false, reason: 'lease_expired' });
  });

  it('keeps the full TTL for long-lived leases', async () => {
    const { verifier, provider, nowMs } = makeVerifier({
      lease: leaseState({ expiresAt: START + 3_600 }),
    });
    const header = `Bearer ${tokenFor('lease-1')}`;
    await verifier.verifyAuthorization(header);
    nowMs.value += 29_000;
    await verifier.verifyAuthorization(header);
    expect(provider.getLeaseState).toHaveBeenCalledTimes(1);
    nowMs.value += 2_000;
    await verifier.verifyAuthorization(header);
    expect(provider.getLeaseState).toHaveBeenCalledTimes(2);
  });

  it('denies an already-expired lease without leaving a cache entry', async () => {
    const { verifier } = makeVerifier({ lease: leaseState({ expiresAt: START - 1 }) });
    const result = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(result).toMatchObject({ ok: false, status: 403, reason: 'lease_expired' });
    expect(await verifier.isReady()).toBe(false); // isReady requires a cached lease
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

describe('LeaseVerifier on-chain quota sink', () => {
  it('records each served call so it can be committed on chain', async () => {
    const recorded: string[] = [];
    const provider: LeaseStateProvider = { getLeaseState: vi.fn(async () => leaseState()) };
    const verifier = new LeaseVerifier({
      provider,
      clock: () => START * 1_000,
      quotaSink: {
        record: (leaseId: string) => recorded.push(leaseId),
        flush: async () => {},
        close: async () => {},
        pendingFor: () => 0,
      },
    });

    await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);

    expect(recorded).toEqual(['lease-1', 'lease-1']);
  });

  it('does not record denied requests', async () => {
    const record = vi.fn();
    const verifier = new LeaseVerifier({
      provider: {
        getLeaseState: async () => {
          throw new Error('rpc down');
        },
      },
      clock: () => START * 1_000,
      quotaSink: { record, flush: async () => {}, close: async () => {}, pendingFor: () => 0 },
    });

    const result = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(result.ok).toBe(false);
    expect(record).not.toHaveBeenCalled();
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

  it('caches LeaseNotFoundError outcomes for a short window', async () => {
    const error = new Error('not found');
    error.name = 'LeaseNotFoundError';
    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async () => {
        throw error;
      }),
    };
    const { verifier, nowMs } = makeVerifier({ provider, cacheTtlMs: 30_000 });

    for (let i = 0; i < 5; i += 1) {
      const res = await verifier.verifyAuthorization(`Bearer ${tokenFor('missing-lease')}`);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('lease_not_found');
    }

    // Provider called only once across 5 repeated requests
    expect(provider.getLeaseState).toHaveBeenCalledTimes(1);
    expect(verifier.stats().rpcCalls).toBe(1);
    expect(verifier.stats().denials.hits).toBe(4);

    // After 5s (the capped denial TTL), the next request retries the provider
    nowMs.value = (START + 6) * 1_000;
    const retry = await verifier.verifyAuthorization(`Bearer ${tokenFor('missing-lease')}`);
    expect(retry.ok).toBe(false);
    expect(retry.reason).toBe('lease_not_found');
    expect(provider.getLeaseState).toHaveBeenCalledTimes(2);
  });

  it('caps denial TTL at min(cacheTtlMs, 5000) when cacheTtlMs is small', async () => {
    const error = new Error('not found');
    error.name = 'LeaseNotFoundError';
    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async () => {
        throw error;
      }),
    };
    const { verifier, nowMs } = makeVerifier({ provider, cacheTtlMs: 2_000 });

    await verifier.verifyAuthorization(`Bearer ${tokenFor('missing-lease')}`);
    expect(provider.getLeaseState).toHaveBeenCalledTimes(1);

    // After 3s (exceeding 2s cacheTtlMs, which is smaller than 5s)
    nowMs.value = (START + 3) * 1_000;
    await verifier.verifyAuthorization(`Bearer ${tokenFor('missing-lease')}`);
    expect(provider.getLeaseState).toHaveBeenCalledTimes(2);
  });

  it('never caches transport or timeout errors', async () => {
    let callCount = 0;
    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error('ETIMEDOUT');
        }
        return leaseState();
      }),
    };
    const { verifier } = makeVerifier({ provider });

    const first = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(first.ok).toBe(false);
    expect(first.reason).toBe('verification_unavailable');

    const second = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(second.ok).toBe(true);
    expect(provider.getLeaseState).toHaveBeenCalledTimes(2);
    expect(verifier.stats().denials.hits).toBe(0);
  });

  it('collapses 25 concurrent verifications into one provider call with single-flight', async () => {
    let resolveProvider!: (lease: LeaseState) => void;
    const deferredPromise = new Promise<LeaseState>((resolve) => {
      resolveProvider = resolve;
    });

    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(() => deferredPromise),
    };
    const { verifier } = makeVerifier({ provider });

    const token = tokenFor('lease-1');
    const promises = Array.from({ length: 25 }, () =>
      verifier.verifyAuthorization(`Bearer ${token}`),
    );

    resolveProvider(leaseState({ leaseId: 'lease-1', callsLimit: 100 }));

    const results = await Promise.all(promises);
    expect(results).toHaveLength(25);
    for (const res of results) {
      expect(res.ok).toBe(true);
    }
    expect(provider.getLeaseState).toHaveBeenCalledTimes(1);
    expect(verifier.stats().rpcCalls).toBe(1);
  });

  it('retries a rejected lookup on the next request and clears in-flight state', async () => {
    let callCount = 0;
    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error('transient RPC network error');
        }
        return leaseState({ leaseId: 'lease-1' });
      }),
    };
    const { verifier } = makeVerifier({ provider });

    const token = tokenFor('lease-1');
    const first = await verifier.verifyAuthorization(`Bearer ${token}`);
    expect(first.ok).toBe(false);
    expect(first.reason).toBe('verification_unavailable');
    expect(provider.getLeaseState).toHaveBeenCalledTimes(1);

    const second = await verifier.verifyAuthorization(`Bearer ${token}`);
    expect(second.ok).toBe(true);
    expect(provider.getLeaseState).toHaveBeenCalledTimes(2);
  });
});

describe('deterministic quota-exhaustion race tests', () => {
  it('fires N concurrent requests against a lease with calls_limit = M < N and asserts exactly M succeed', async () => {
    const M = 5;
    const N = 20;
    const lease = leaseState({ callsLimit: M, callsUsed: 0 });
    const { verifier } = makeVerifier({ lease });

    const token = tokenFor('lease-1');
    const results = await Promise.all(
      Array.from({ length: N }, () => verifier.verifyAuthorization(`Bearer ${token}`)),
    );

    const allowed = results.filter((r) => r.ok);
    const denied = results.filter((r) => !r.ok);

    expect(allowed).toHaveLength(M);
    expect(denied).toHaveLength(N - M);
    for (const d of denied) {
      expect(d).toMatchObject({ ok: false, status: 403, reason: 'quota_exhausted' });
    }
    expect(verifier.localCalls('lease-1')).toBe(M);
  });

  it('denies requests when on-chain calls_used exceeds or equals limit even if local counter is lower (max rule)', async () => {
    const lease = leaseState({ callsLimit: 10, callsUsed: 10 });
    const { verifier } = makeVerifier({ lease });
    expect(verifier.localCalls('lease-1')).toBe(0);

    const result = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('quota_exhausted');
  });

  it('is stable across 20 repeated runs of concurrent dispatch', async () => {
    const M = 4;
    const N = 15;

    for (let run = 0; run < 20; run += 1) {
      const lease = leaseState({ callsLimit: M, callsUsed: 0 });
      const { verifier } = makeVerifier({ lease });

      const token = tokenFor('lease-1');
      const results = await Promise.all(
        Array.from({ length: N }, () => verifier.verifyAuthorization(`Bearer ${token}`)),
      );

      const allowed = results.filter((r) => r.ok);
      const denied = results.filter((r) => !r.ok);

      expect(allowed).toHaveLength(M);
      expect(denied).toHaveLength(N - M);
      for (const d of denied) {
        expect(d).toMatchObject({ ok: false, status: 403, reason: 'quota_exhausted' });
      }
      expect(verifier.localCalls('lease-1')).toBe(M);
    }
  });
});

describe('LeaseVerifier service binding', () => {
  it('admits requests when lease service matches configured serviceId', async () => {
    const lease = leaseState({ service: 'weather-api' });
    const verifier = new LeaseVerifier({
      provider: { getLeaseState: async () => lease },
      serviceId: 'weather-api',
      clock: () => START * 1000,
    });

    const result = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(result.ok).toBe(true);
  });

  it('denies requests with 429/403 lease_service_mismatch when lease service differs', async () => {
    const lease = leaseState({ service: 'cheap-api' });
    const verifier = new LeaseVerifier({
      provider: { getLeaseState: async () => lease },
      serviceId: 'expensive-api',
      clock: () => START * 1000,
    });

    const result = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      reason: 'lease_service_mismatch',
    });
  });

  it('permits any service when serviceId is unset', async () => {
    const lease = leaseState({ service: 'any-service' });
    const verifier = new LeaseVerifier({
      provider: { getLeaseState: async () => lease },
      clock: () => START * 1000,
    });

    const result = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(result.ok).toBe(true);
  });

  it('does not reuse a cached state under a different service binding', async () => {
    const cache = new TtlCache<LeaseState>({ ttlMs: 30_000 });
    const leaseA = leaseState({ leaseId: 'lease-1', service: 'service-a' });
    const leaseB = leaseState({ leaseId: 'lease-1', service: 'service-b' });

    let activeService = 'service-a';
    const provider: LeaseStateProvider = {
      getLeaseState: async () => (activeService === 'service-a' ? leaseA : leaseB),
    };

    const verifierA = new LeaseVerifier({
      provider,
      cache,
      serviceId: 'service-a',
      clock: () => START * 1000,
    });

    const resA = await verifierA.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(resA.ok).toBe(true);

    activeService = 'service-b';
    const verifierB = new LeaseVerifier({
      provider,
      cache,
      serviceId: 'service-b',
      clock: () => START * 1000,
    });

    // Verifier B with serviceId 'service-b' must not reuse the cache entry from verifier A
    const resB = await verifierB.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(resB.ok).toBe(true);
    if (resB.ok) {
      expect(resB.lease.service).toBe('service-b');
    }
  });
});

describe('LeaseVerifier per-lease token bucket rate limit', () => {
  it('allows burst up to rateLimitPerMinute then returns 429 rate_limited with Retry-After', async () => {
    let now = START * 1000;
    const lease = leaseState({ callsLimit: 100 });
    const verifier = new LeaseVerifier({
      provider: { getLeaseState: async () => lease },
      rateLimitPerMinute: 2, // 2 requests per minute
      clock: () => now,
    });

    const header = `Bearer ${tokenFor('lease-1')}`;

    // First request: consumes 1 token (1 remaining)
    const r1 = await verifier.verifyAuthorization(header);
    expect(r1.ok).toBe(true);
    expect(verifier.localCalls('lease-1')).toBe(1);

    // Second request: consumes 1 token (0 remaining)
    const r2 = await verifier.verifyAuthorization(header);
    expect(r2.ok).toBe(true);
    expect(verifier.localCalls('lease-1')).toBe(2);

    // Third request: burst exhausted -> 429
    const r3 = await verifier.verifyAuthorization(header);
    expect(r3).toMatchObject({
      ok: false,
      status: 429,
      reason: 'rate_limited',
    });
    if (!r3.ok) {
      expect(r3.retryAfter).toBeGreaterThanOrEqual(1);
    }
    // Quota was NOT consumed for denied request
    expect(verifier.localCalls('lease-1')).toBe(2);

    // Advance clock by 30 seconds (1 token refilled)
    now += 30_000;
    const r4 = await verifier.verifyAuthorization(header);
    expect(r4.ok).toBe(true);
    expect(verifier.localCalls('lease-1')).toBe(3);
  });
});

describe('LeaseVerifier LRU counter eviction invariant', () => {
  it('eviction with maxCounters: 2 flushes through quota sink and prevents double spending', async () => {
    let onChainCallsUsed = 0;
    const committer = {
      useCalls: vi.fn(async (leaseId: string, count: number) => {
        if (leaseId === 'lease-1') {
          onChainCallsUsed += count;
        }
      }),
    };
    const quotaSink = new OnChainQuota({
      committer,
      batchSize: 100, // manual flushes
    });

    const provider: LeaseStateProvider = {
      getLeaseState: vi.fn(async (leaseId: string) => {
        return leaseState({
          leaseId,
          callsLimit: 5,
          callsUsed: leaseId === 'lease-1' ? onChainCallsUsed : 0,
        });
      }),
    };

    const verifier = new LeaseVerifier({
      provider,
      maxCounters: 2,
      quotaSink,
      clock: () => START * 1000,
    });

    // 1. Lease 1 uses 2 calls
    await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(verifier.localCalls('lease-1')).toBe(2);

    // 2. Lease 2 uses 1 call
    await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-2')}`);
    expect(verifier.localCalls('lease-2')).toBe(1);

    // Currently tracking 2 counters: lease-1 and lease-2.
    // 3. Lease 3 makes a call -> triggers eviction of oldest (lease-1).
    // Eviction must flush quotaSink before deleting lease-1 from calls and cache.
    await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-3')}`);
    expect(committer.useCalls).toHaveBeenCalled();
    expect(onChainCallsUsed).toBe(2); // lease-1's 2 calls committed to chain!

    // Lease 1 was evicted from local calls:
    expect(verifier.localCalls('lease-1')).toBe(0);

    // 4. Lease 1 comes back!
    // Since cache was invalidated, it fetches from provider which reports callsUsed: 2.
    const res = await verifier.verifyAuthorization(`Bearer ${tokenFor('lease-1')}`);
    expect(res.ok).toBe(true);
    if (res.ok) {
      // 5 total limit - 2 previously used - 1 currently served = 2 remaining
      expect(res.remainingCalls).toBe(2);
    }
  });
});
