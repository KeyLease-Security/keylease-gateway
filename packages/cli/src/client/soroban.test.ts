import { BASE_FEE, Keypair, nativeToScVal } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  ContractCallError,
  LeaseNotFoundError,
  SorobanClient,
  mapContractError,
  parseLeaseId,
  parseLeaseState,
  encodeLeaseState,
  type Transaction,
  validateRpcUrl,
  type LeaseState,
  type SorobanRpc,
} from './soroban.js';

const consumer = Keypair.random();
const provider = Keypair.random();

const LEASE: LeaseState = {
  leaseId: '7',
  service: 'weather-api',
  provider: provider.publicKey(),
  consumer: consumer.publicKey(),
  callsLimit: 12,
  callsUsed: 3,
  expiresAt: 1_800_000_000,
  active: true,
  settled: false,
  pricePaid: 12_000,
};

describe('parseLeaseId', () => {
  it('accepts canonical decimal form', () => {
    expect(parseLeaseId('0')).toBe(0n);
    expect(parseLeaseId('1')).toBe(1n);
    expect(parseLeaseId('7')).toBe(7n);
    expect(parseLeaseId('42')).toBe(42n);
    expect(parseLeaseId('18446744073709551615')).toBe(0xffff_ffff_ffff_ffffn);
  });

  it('rejects leading zeros', () => {
    expect(() => parseLeaseId('00')).toThrow(/canonical decimal form/);
    expect(() => parseLeaseId('007')).toThrow(/canonical decimal form/);
    expect(() => parseLeaseId('01')).toThrow(/canonical decimal form/);
  });

  it('rejects out-of-range u64 values', () => {
    expect(() => parseLeaseId('18446744073709551616')).toThrow(/out of the u64 range/);
    expect(() => parseLeaseId('99999999999999999999')).toThrow(/out of the u64 range/);
  });

  it('rejects non-decimal formats', () => {
    expect(() => parseLeaseId('lease-1')).toThrow(/canonical decimal form/);
    expect(() => parseLeaseId('0x7')).toThrow(/canonical decimal form/);
    expect(() => parseLeaseId('1.5')).toThrow(/canonical decimal form/);
    expect(() => parseLeaseId('1e5')).toThrow(/canonical decimal form/);
  });
});

describe('validateRpcUrl', () => {
  it('accepts valid https URLs', () => {
    expect(() => validateRpcUrl('https://soroban-testnet.stellar.org')).not.toThrow();
    expect(() => validateRpcUrl('https://mainnet.sorobanrpc.com')).not.toThrow();
    expect(() =>
      validateRpcUrl('https://soroban-testnet.stellar.org:443/soroban/rpc'),
    ).not.toThrow();
  });

  it('accepts http URLs for localhost', () => {
    expect(() => validateRpcUrl('http://localhost:8000')).not.toThrow();
    expect(() => validateRpcUrl('http://localhost:8000/soroban/rpc')).not.toThrow();
    expect(() => validateRpcUrl('http://127.0.0.1:8000')).not.toThrow();
    expect(() => validateRpcUrl('http://[::1]:8000')).not.toThrow();
  });

  it('rejects invalid URLs', () => {
    expect(() => validateRpcUrl('not-a-url')).toThrow('must be a valid URL');
    expect(() => validateRpcUrl('localhost:8000')).toThrow('must be a valid URL');
    expect(() => validateRpcUrl('192.168.1.1:8000')).toThrow('must be a valid URL');
  });

  it('rejects wrong schemes', () => {
    expect(() => validateRpcUrl('ftp://example.com')).toThrow('scheme must be http: or https:');
    expect(() => validateRpcUrl('file:///path/to/file')).toThrow('scheme must be http: or https:');
    expect(() => validateRpcUrl('gopher://example.com')).toThrow('scheme must be http: or https:');
  });

  it('rejects http URLs that are not localhost', () => {
    expect(() => validateRpcUrl('http://example.com')).toThrow('localhost');
    expect(() => validateRpcUrl('http://192.168.1.1')).toThrow('localhost');
    expect(() => validateRpcUrl('http://staging.example.com:8000')).toThrow('localhost');
    expect(() => validateRpcUrl('http://example.com:8000/soroban/rpc')).toThrow('localhost');
  });

  it('catches typos like htps:// or htp://', () => {
    expect(() => validateRpcUrl('htps://example.com')).toThrow('scheme');
    expect(() => validateRpcUrl('htp://example.com')).toThrow('scheme');
  });
});

describe('parseLeaseState', () => {
  it('round-trips the contract struct layout', () => {
    const parsed = parseLeaseState(encodeLeaseState(LEASE), LEASE.leaseId);
    expect(parsed).toEqual(LEASE);
  });

  it('rejects a value that is not a map', () => {
    expect(() => parseLeaseState(nativeToScVal(1, { type: 'u32' }), '7')).toThrow(/scvMap/);
  });
});

describe('getLeaseState', () => {
  function clientWithSimulation(response: unknown): SorobanClient {
    const server = {
      simulateTransaction: async () => response,
    } as unknown as SorobanRpc;
    return new SorobanClient({
      server,
      contractId: 'CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
  }

  it('maps contract Error(Contract, #5) to LeaseNotFoundError', async () => {
    const client = clientWithSimulation({
      _parsed: true,
      id: '1',
      latestLedger: 1,
      error: 'HostError: Error(Contract, #5)',
      events: [],
    });

    await expect(client.getLeaseState('9')).rejects.toBeInstanceOf(LeaseNotFoundError);
  });

  it('surfaces other simulation failures as contract errors', async () => {
    const client = clientWithSimulation({
      _parsed: true,
      id: '1',
      latestLedger: 1,
      error: 'HostError: Error(Contract, #6)',
      events: [],
    });

    await expect(client.getLeaseState('9')).rejects.toThrow(/Error\(6\)/);
  });

  describe('retry behavior', () => {
    it('retries on 429 and returns successful result', async () => {
      let attempts = 0;
      const server = {
        simulateTransaction: async () => {
          attempts += 1;
          if (attempts < 3) {
            const error = new Error('429 Too Many Requests');
            (error as any).status = 429;
            throw error;
          }
          return {
            _parsed: true,
            id: '1',
            latestLedger: 1,
            result: {
              retval: encodeLeaseState(LEASE),
            },
            events: [],
          };
        },
      } as unknown as SorobanRpc;

      const client = new SorobanClient({
        server,
        contractId: 'CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC',
        networkPassphrase: 'Test SDF Network ; September 2015',
        sleep: () => Promise.resolve(),
      });

      const result = await client.getLeaseState('7');
      expect(result.leaseId).toBe('7');
      expect(attempts).toBe(3);
    });

    it('retries on 5xx and returns successful result', async () => {
      let attempts = 0;
      const server = {
        simulateTransaction: async () => {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error('500 Internal Server Error');
            (error as any).status = 500;
            throw error;
          }
          if (attempts === 2) {
            const error = new Error('503 Service Unavailable');
            (error as any).status = 503;
            throw error;
          }
          return {
            _parsed: true,
            id: '1',
            latestLedger: 1,
            result: {
              retval: encodeLeaseState(LEASE),
            },
            events: [],
          };
        },
      } as unknown as SorobanRpc;

      const client = new SorobanClient({
        server,
        contractId: 'CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC',
        networkPassphrase: 'Test SDF Network ; September 2015',
        sleep: () => Promise.resolve(),
      });

      const result = await client.getLeaseState('7');
      expect(result.leaseId).toBe('7');
      expect(attempts).toBe(3);
    });

    it('retries on timeout error', async () => {
      let attempts = 0;
      const server = {
        simulateTransaction: async () => {
          attempts += 1;
          if (attempts < 2) {
            throw new Error('timeout exceeded');
          }
          return {
            _parsed: true,
            id: '1',
            latestLedger: 1,
            result: {
              retval: encodeLeaseState(LEASE),
            },
            events: [],
          };
        },
      } as unknown as SorobanRpc;

      const client = new SorobanClient({
        server,
        contractId: 'CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC',
        networkPassphrase: 'Test SDF Network ; September 2015',
        sleep: () => Promise.resolve(),
      });

      const result = await client.getLeaseState('7');
      expect(result.leaseId).toBe('7');
      expect(attempts).toBe(2);
    });

    it('does not retry on contract errors', async () => {
      let attempts = 0;
      const server = {
        simulateTransaction: async () => {
          attempts += 1;
          return {
            _parsed: true,
            id: '1',
            latestLedger: 1,
            error: 'HostError: Error(Contract, #6)',
            events: [],
          };
        },
      } as unknown as SorobanRpc;

      const client = new SorobanClient({
        server,
        contractId: 'CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC',
        networkPassphrase: 'Test SDF Network ; September 2015',
        sleep: () => Promise.resolve(),
      });

      await expect(client.getLeaseState('9')).rejects.toThrow(/Error\(6\)/);
      expect(attempts).toBe(1);
    });

    it('does not retry on client errors (4xx)', async () => {
      let attempts = 0;
      const server = {
        simulateTransaction: async () => {
          attempts += 1;
          const error = new Error('400 Bad Request');
          (error as any).status = 400;
          throw error;
        },
      } as unknown as SorobanRpc;

      const client = new SorobanClient({
        server,
        contractId: 'CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC',
        networkPassphrase: 'Test SDF Network ; September 2015',
        sleep: () => Promise.resolve(),
      });

      await expect(client.getLeaseState('9')).rejects.toThrow('400 Bad Request');
      expect(attempts).toBe(1);
    });

    it('respects Retry-After header (numeric seconds)', async () => {
      let attempts = 0;
      const sleepMs: number[] = [];
      const server = {
        simulateTransaction: async () => {
          attempts += 1;
          if (attempts < 2) {
            const error = new Error('429 Too Many Requests');
            (error as any).status = 429;
            (error as any).retryAfter = 2;
            throw error;
          }
          return {
            _parsed: true,
            id: '1',
            latestLedger: 1,
            result: {
              retval: encodeLeaseState(LEASE),
            },
            events: [],
          };
        },
      } as unknown as SorobanRpc;

      const client = new SorobanClient({
        server,
        contractId: 'CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC',
        networkPassphrase: 'Test SDF Network ; September 2015',
        sleep: (ms: number) => {
          sleepMs.push(ms);
          return Promise.resolve();
        },
      });

      const result = await client.getLeaseState('7');
      expect(result.leaseId).toBe('7');
      expect(sleepMs).toHaveLength(1);
      expect(sleepMs[0]).toBe(2000); // 2 seconds converted to ms
    });

    it('exponential backoff caps at maxDelayMs', async () => {
      let attempts = 0;
      const sleepMs: number[] = [];
      const server = {
        simulateTransaction: async () => {
          attempts += 1;
          if (attempts < 8) {
            const error = new Error('503 Service Unavailable');
            (error as any).status = 503;
            throw error;
          }
          return {
            _parsed: true,
            id: '1',
            latestLedger: 1,
            result: {
              retval: encodeLeaseState(LEASE),
            },
            events: [],
          };
        },
      } as unknown as SorobanRpc;

      const client = new SorobanClient({
        server,
        contractId: 'CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC',
        networkPassphrase: 'Test SDF Network ; September 2015',
        sleep: (ms: number) => {
          sleepMs.push(ms);
          return Promise.resolve();
        },
      });

      await expect(client.getLeaseState('7')).rejects.toThrow();
      // We should have made 5 attempts (max attempts), so 4 sleep calls
      expect(sleepMs).toHaveLength(4);
      // Check exponential backoff: 100ms, 200ms, 400ms, 800ms
      expect(sleepMs[0]).toBe(100);
      expect(sleepMs[1]).toBe(200);
      expect(sleepMs[2]).toBe(400);
      expect(sleepMs[3]).toBe(800);
    });

    it('exhausts retries and throws last error', async () => {
      const server = {
        simulateTransaction: async () => {
          const error = new Error('503 Service Unavailable');
          (error as any).status = 503;
          throw error;
        },
      } as unknown as SorobanRpc;

      const client = new SorobanClient({
        server,
        contractId: 'CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC',
        networkPassphrase: 'Test SDF Network ; September 2015',
        sleep: () => Promise.resolve(),
      });

      await expect(client.getLeaseState('7')).rejects.toThrow('503 Service Unavailable');
    });
  });
});

describe('transaction envelope options', () => {
  it('uses the supplied fee and timeout and preserves defaults when omitted', async () => {
    const transactions: Transaction[] = [];
    const server = {
      simulateTransaction: async (transaction: Transaction) => {
        transactions.push(transaction);
        return {
          _parsed: true,
          id: '1',
          latestLedger: 1,
          events: [],
          result: { retval: nativeToScVal(1_000, { type: 'i128' }) },
        };
      },
    } as unknown as SorobanRpc;

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    try {
      const custom = new SorobanClient({
        server,
        contractId: 'CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC',
        networkPassphrase: 'Test SDF Network ; September 2015',
        fee: 2_500,
        timeout: 90,
      });
      await custom.quote('weather-api', 1);
      expect(transactions[0]?.fee).toBe('2500');
      expect(transactions[0]?.timeBounds?.maxTime).toBe('1704067290');

      const defaults = new SorobanClient({
        server,
        contractId: 'CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC',
        networkPassphrase: 'Test SDF Network ; September 2015',
      });
      await defaults.quote('weather-api', 1);
      expect(transactions[1]?.fee).toBe(String(BASE_FEE));
      expect(transactions[1]?.timeBounds?.maxTime).toBe('1704067260');
    } finally {
      vi.useRealTimers();
    }
describe('mapContractError', () => {
  it('maps error code 1 (AlreadyInitialized)', () => {
    const msg = mapContractError(1);
    expect(msg.message).toContain('already been performed');
    expect(msg.nextStep).toContain('deployment');
  });

  it('maps error code 2 (NotInitialized)', () => {
    const msg = mapContractError(2);
    expect(msg.message).toContain('not been initialized');
    expect(msg.nextStep).toContain('KEYLEASE_CONTRACT_ID');
  });

  it('maps error code 3 (UnknownService)', () => {
    const msg = mapContractError(3);
    expect(msg.message).toContain('never registered');
    expect(msg.nextStep).toContain('--service');
  });

  it('maps error code 4 (ServiceInactive)', () => {
    const msg = mapContractError(4);
    expect(msg.message).toContain('paused');
    expect(msg.nextStep).toContain('provider');
  });

  it('maps error code 5 (LeaseNotFound)', () => {
    const msg = mapContractError(5);
    expect(msg.message).toContain('does not exist');
    expect(msg.nextStep).toContain('--lease');
  });

  it('maps error code 6 (LeaseInactive)', () => {
    const msg = mapContractError(6);
    expect(msg.message).toContain('inactive');
    expect(msg.nextStep).toContain('new lease');
  });

  it('maps error code 7 (LeaseExpired)', () => {
    const msg = mapContractError(7);
    expect(msg.message).toContain('expired');
    expect(msg.nextStep).toContain('settle');
  });

  it('maps error code 8 (LeaseNotSettleable)', () => {
    const msg = mapContractError(8);
    expect(msg.message).toContain('cannot be settled yet');
    expect(msg.nextStep).toContain('expiry');
  });

  it('maps error code 9 (AlreadySettled)', () => {
    const msg = mapContractError(9);
    expect(msg.message).toContain('already been paid out');
    expect(msg.nextStep).toContain('twice');
  });

  it('maps error code 10 (InvalidCalls)', () => {
    const msg = mapContractError(10);
    expect(msg.message).toContain('invalid');
    expect(msg.nextStep).toContain('--calls');
  });

  it('maps error code 11 (InvalidDuration)', () => {
    const msg = mapContractError(11);
    expect(msg.message).toContain('invalid');
    expect(msg.nextStep).toContain('--duration');
  });

  it('maps error code 12 (InvalidPrice)', () => {
    const msg = mapContractError(12);
    expect(msg.message).toContain('invalid');
    expect(msg.nextStep).toContain('operator');
  });

  it('maps error code 13 (InvalidAmount)', () => {
    const msg = mapContractError(13);
    expect(msg.message).toContain('invalid');
    expect(msg.nextStep).toContain('funds');
  });

  it('maps error code 14 (Unauthorized)', () => {
    const msg = mapContractError(14);
    expect(msg.message).toContain('not authorized');
    expect(msg.nextStep).toContain('permission');
  });

  it('maps unknown error codes gracefully', () => {
    const msg = mapContractError(999);
    expect(msg.message).toContain('unknown');
    expect(msg.nextStep).toContain('support');
  });

  it('maps null code (not found in error detail)', () => {
    const msg = mapContractError(null);
    expect(msg.message).toContain('unknown');
    expect(msg.nextStep).toContain('support');
  });
});

describe('ContractCallError', () => {
  it('includes error code and mapped message for known codes', () => {
    const error = new ContractCallError('settle', 8, 'Error(Contract, #8)');
    expect(error.message).toContain('Error(8)');
    expect(error.message).toContain('cannot be settled yet');
    expect(error.message).toContain('Next step:');
    expect(error.detail).toBe('Error(Contract, #8)');
  });

  it('includes unknown code and generic message for null code', () => {
    const error = new ContractCallError('settle', null, 'Error(Contract, UNKNOWN)');
    expect(error.message).toContain('Error(unknown)');
    expect(error.message).toContain('unknown contract error');
    expect(error.detail).toBe('Error(Contract, UNKNOWN)');
  });

  it('preserves raw detail for --json output', () => {
    const rawDetail = 'HostError: Error(Contract, #5)';
    const error = new ContractCallError('get_lease', 5, rawDetail);
    expect(error.detail).toBe(rawDetail);
    expect(error.code).toBe(5);
    expect(error.method).toBe('get_lease');
  });
});

describe('SorobanClient.listServices', () => {
  it('unwraps returned array of service strings', async () => {
    const fakeServer = {
      simulateTransaction: async () => ({
        result: {
          retval: nativeToScVal(['service-a', 'service-b']),
        },
      }),
    } as unknown as SorobanRpc;
    const client = new SorobanClient({
      server: fakeServer,
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    const services = await client.listServices(0, 10);
    expect(services).toEqual(['service-a', 'service-b']);
  });
});
