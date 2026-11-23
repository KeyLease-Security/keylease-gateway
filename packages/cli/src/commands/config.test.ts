import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { resolveWhoamiConfig, whoamiCommand } from './config.js';
import type { LeaseSession, SessionStore } from './lease.js';
import type { CliIo } from '../index.js';

const consumer = Keypair.random();
const CONTRACT = 'CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC';

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (line = '') => out.push(line), err: (line = '') => err.push(line) } };
}

function memoryStore(sessions: Record<string, LeaseSession> = {}): SessionStore {
  return {
    load: async () => sessions,
    save: async () => {},
    saveAll: async () => {},
  };
}

function session(overrides: Partial<LeaseSession> = {}): LeaseSession {
  return {
    service: 'weather-api',
    leaseId: '42',
    consumer: consumer.publicKey(),
    token: 'kls1.x.y',
    callsLimit: 10,
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_003_600,
    txHash: null,
    network: 'testnet',
    ...overrides,
  };
}

describe('resolveWhoamiConfig', () => {
  it('resolves the defaults and environment overrides like the chain commands', () => {
    expect(resolveWhoamiConfig({}, {})).toEqual({
      network: 'testnet',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      contractId: null,
    });

    expect(
      resolveWhoamiConfig(
        { network: 'mainnet' },
        { KEYLEASE_RPC_URL: 'https://rpc.example', KEYLEASE_CONTRACT_ID: CONTRACT },
      ),
    ).toMatchObject({
      network: 'mainnet',
      rpcUrl: 'https://rpc.example',
      contractId: CONTRACT,
    });
  });

  it('lets flags override the environment', () => {
    expect(
      resolveWhoamiConfig(
        { network: 'local', rpc: 'http://localhost:9000', contract: CONTRACT },
        { KEYLEASE_NETWORK: 'mainnet', KEYLEASE_RPC_URL: 'https://rpc.example' },
      ),
    ).toMatchObject({ network: 'local', rpcUrl: 'http://localhost:9000', contractId: CONTRACT });
  });

  it('rejects unknown networks and malformed contract ids', () => {
    expect(() => resolveWhoamiConfig({ network: 'devnet' }, {})).toThrow(/unknown network/);
    expect(() => resolveWhoamiConfig({ contract: 'not-a-contract' }, {})).toThrow(
      /valid contract/,
    );
  });
});

describe('whoamiCommand', () => {
  it('reports an unconfigured terminal without failing', async () => {
    const { io, out } = captureIo();
    const code = await whoamiCommand({ json: false }, io, {
      env: {},
      store: memoryStore(),
    });

    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('network   : testnet');
    expect(text).toContain('(unset: set KEYLEASE_CONTRACT_ID)');
    expect(text).toContain('(not supplied: pass --secret)');
    expect(text).toContain('(none stored)');
  });

  it('prints the resolved contract, consumer key and stored sessions', async () => {
    const { io, out } = captureIo();
    const code = await whoamiCommand(
      { secret: consumer.secret(), json: false },
      io,
      {
        env: { KEYLEASE_NETWORK: 'mainnet', KEYLEASE_CONTRACT_ID: CONTRACT },
        store: memoryStore({ 'weather-api': session() }),
      },
    );

    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('network   : mainnet');
    expect(text).toContain(`contract  : ${CONTRACT}`);
    expect(text).toContain(`consumer  : ${consumer.publicKey()}`);
    expect(text).toContain('weather-api  lease 42');
    expect(text).not.toContain(consumer.secret());
  });

  it('emits machine-readable JSON including sessions', async () => {
    const { io, out } = captureIo();
    await whoamiCommand({ secret: consumer.secret(), json: true }, io, {
      env: { KEYLEASE_CONTRACT_ID: CONTRACT },
      store: memoryStore({ 'weather-api': session() }),
    });

    expect(JSON.parse(out.join('\n'))).toMatchObject({
      network: 'testnet',
      contract_id: CONTRACT,
      consumer: consumer.publicKey(),
      sessions: [{ service: 'weather-api', lease_id: '42', expires_at: 1_700_003_600 }],
    });
  });

  it('rejects an invalid secret without printing it', async () => {
    const { io } = captureIo();
    await expect(
      whoamiCommand({ secret: 'S-not-a-seed', json: false }, io, {
        env: {},
        store: memoryStore(),
      }),
    ).rejects.toThrow(/Stellar secret seed/);
  });
});
