import { Keypair } from '@stellar/stellar-sdk';
import { bench, describe } from 'vitest';
import { mintSessionToken } from '@keylease/cli/token';
import type { LeaseState } from '@keylease/cli/soroban';
import { TtlCache } from '../cache.js';
import { OnChainQuota } from '../quota.js';
import { buildUpstreamHeaders } from '../server.js';
import { LeaseVerifier } from '../verifier.js';

const now = 1_700_000_000;
const consumer = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(7));
const lease: LeaseState = {
  leaseId: 'lease-bench',
  service: 'weather-api',
  provider: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  consumer: consumer.publicKey(),
  callsLimit: 1_000_000,
  callsUsed: 0,
  expiresAt: now + 3_600,
  active: true,
  settled: false,
  pricePaid: 1_000_000,
};
const token = mintSessionToken({
  leaseId: lease.leaseId,
  consumerSecret: consumer.secret(),
  issuedAt: now,
  expiresAt: now + 3_600,
  service: lease.service,
});
const cache = new TtlCache<LeaseState>({
  ttlMs: 30_000,
  clock: () => now * 1_000,
});
const hitVerifier = new LeaseVerifier({
  provider: { getLeaseState: async () => lease },
  cache,
  clock: () => now * 1_000,
  serviceId: 'weather-api',
});
const missCache = new TtlCache<LeaseState>({
  ttlMs: 30_000,
  clock: () => now * 1_000,
});
const missVerifier = new LeaseVerifier({
  provider: { getLeaseState: async () => lease },
  cache: missCache,
  clock: () => now * 1_000,
  serviceId: 'weather-api',
});
const quota = new OnChainQuota({
  committer: { useCalls: async () => undefined },
  batchSize: 1_000_000,
  flushIntervalMs: 0,
});

describe('LeaseVerifier hot paths', () => {
  bench('cache hit: verify', async () => {
    await hitVerifier.verify(token);
  });

  bench('cache miss: verify', async () => {
    missCache.clear();
    await missVerifier.verify(token);
  });
});

describe('Quota and forwarding hot paths', () => {
  bench('quota record', () => {
    quota.record('lease-bench');
  });

  bench('build upstream headers', () => {
    buildUpstreamHeaders(
      {
        accept: 'application/json',
        'user-agent': 'keylease-bench/1',
        'if-none-match': '"bench"',
        'x-keylease-secret': 'drop-me',
        authorization: 'Bearer should-not-forward',
        cookie: 'a=1',
      },
      { forwardHeaders: ['x-trace-id'] },
    );
  });
});
