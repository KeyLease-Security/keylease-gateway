import { Keypair, nativeToScVal } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  ContractCallError,
  LeaseNotFoundError,
  SorobanClient,
  mapContractError,
  parseLeaseId,
  parseLeaseState,
  encodeLeaseState,
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
  it('accepts decimal u64 ids', () => {
    expect(parseLeaseId('1')).toBe(1n);
    expect(parseLeaseId('18446744073709551615')).toBe(0xffff_ffff_ffff_ffffn);
  });

  it('rejects anything else', () => {
    expect(() => parseLeaseId('lease-1')).toThrow(/decimal u64/);
    expect(() => parseLeaseId('0')).toThrow(/out of the u64 range/);
    expect(() => parseLeaseId('18446744073709551616')).toThrow(/out of the u64 range/);
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
});

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
