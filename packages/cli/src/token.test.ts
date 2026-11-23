import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { acquireCommand, type LeaseSession, type SessionStore } from './commands/lease.js';
import type { CliIo } from './index.js';
import {
  SESSION_TOKEN_PREFIX,
  TokenVerificationError,
  mintSessionToken,
  parseSessionToken,
  verifySessionToken,
} from './token.js';

const consumer = Keypair.random();
const OTHER = Keypair.random();
const NOW = 1_700_000_000;

function mint(overrides: Partial<Parameters<typeof mintSessionToken>[0]> = {}): string {
  return mintSessionToken({
    leaseId: 'lease-abc',
    consumerSecret: consumer.secret(),
    issuedAt: NOW,
    expiresAt: NOW + 300,
    ...overrides,
  });
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TokenVerificationError);
    expect((error as TokenVerificationError).code).toBe(code);
    return;
  }
  throw new Error(`expected TokenVerificationError ${code}, but nothing was thrown`);
}

describe('mintSessionToken', () => {
  it('produces a three-segment kls1 token', () => {
    const token = mint();
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(SESSION_TOKEN_PREFIX);
  });

  it('rejects an invalid consumer secret', () => {
    expect(() =>
      mintSessionToken({
        leaseId: 'lease-abc',
        consumerSecret: 'not-a-secret',
        expiresAt: NOW + 60,
      }),
    ).toThrow(TokenVerificationError);
  });

  it('rejects an expiry that is not after issue time', () => {
    expect(() => mint({ issuedAt: NOW, expiresAt: NOW })).toThrow(TokenVerificationError);
  });
});

describe('parseSessionToken', () => {
  it('decodes the payload without verifying the signature', () => {
    const decoded = parseSessionToken(mint());
    expect(decoded.payload.v).toBe(1);
    expect(decoded.payload.lease_id).toBe('lease-abc');
    expect(decoded.payload.consumer).toBe(consumer.publicKey());
    expect(decoded.payload.iat).toBe(NOW);
    expect(decoded.payload.exp).toBe(NOW + 300);
    expect(decoded.signature).toHaveLength(64);
  });

  it.each([
    ['', 'malformed_token'],
    ['nonsense', 'malformed_token'],
    ['kls1.only-one-segment', 'malformed_token'],
    ['wrong.prefix.payload.signature', 'malformed_token'],
    ['kls1.@@@not-base64@@@.sig', 'malformed_token'],
  ])('rejects malformed token %j', (token, code) => {
    expectCode(() => parseSessionToken(token), code);
  });

  it('rejects an unsupported token version', () => {
    const payload = Buffer.from(
      JSON.stringify({
        v: 99,
        lease_id: 'lease-abc',
        consumer: consumer.publicKey(),
        iat: NOW,
        exp: NOW + 60,
      }),
      'utf8',
    ).toString('base64url');
    const fakeSignature = Buffer.alloc(64).toString('base64url');
    expectCode(() => parseSessionToken(`kls1.${payload}.${fakeSignature}`), 'unsupported_version');
  });

  it('rejects a payload whose consumer is not a stellar public key', () => {
    const payload = Buffer.from(
      JSON.stringify({ v: 1, lease_id: 'x', consumer: 'nope', iat: NOW, exp: NOW + 60 }),
      'utf8',
    ).toString('base64url');
    const fakeSignature = Buffer.alloc(64).toString('base64url');
    expectCode(() => parseSessionToken(`kls1.${payload}.${fakeSignature}`), 'invalid_consumer');
  });

  it('rejects a signature that is not 64 bytes long', () => {
    const payload = Buffer.from(
      JSON.stringify({ v: 1, lease_id: 'x', consumer: consumer.publicKey(), iat: NOW, exp: NOW + 60 }),
      'utf8',
    ).toString('base64url');
    expectCode(() => parseSessionToken(`kls1.${payload}.AAAA`), 'malformed_token');
  });
});

describe('verifySessionToken', () => {
  it('accepts a freshly minted token', () => {
    const payload = verifySessionToken(mint(), { now: NOW + 10 });
    expect(payload.lease_id).toBe('lease-abc');
    expect(payload.consumer).toBe(consumer.publicKey());
  });

  it('rejects a tampered payload', () => {
    const [, , signature] = mint().split('.') as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({
        v: 1,
        lease_id: 'lease-abc',
        consumer: consumer.publicKey(),
        iat: NOW,
        exp: NOW + 99_999,
      }),
      'utf8',
    ).toString('base64url');
    expectCode(() => verifySessionToken(`kls1.${forged}.${signature}`, { now: NOW }), 'bad_signature');
  });

  it('rejects a token signed by another key', () => {
    const foreign = mintSessionToken({
      leaseId: 'lease-abc',
      consumerSecret: OTHER.secret(),
      issuedAt: NOW,
      expiresAt: NOW + 300,
    });
    // Signature verifies for its own (different) consumer...
    expect(verifySessionToken(foreign, { now: NOW }).consumer).toBe(OTHER.publicKey());
    // ...but not when bound to the expected consumer.
    expectCode(
      () => verifySessionToken(foreign, { now: NOW, expectedConsumer: consumer.publicKey() }),
      'consumer_mismatch',
    );
  });

  it('rejects an expired token', () => {
    expectCode(() => verifySessionToken(mint(), { now: NOW + 301 }), 'token_expired');
  });

  it('rejects a token issued too far in the future', () => {
    expectCode(
      () => verifySessionToken(mint(), { now: NOW - 3_600, maxClockSkewSeconds: 60 }),
      'token_not_yet_valid',
    );
  });

  it('rejects a lease binding mismatch', () => {
    expectCode(
      () => verifySessionToken(mint(), { now: NOW, expectedLeaseId: 'lease-other' }),
      'lease_mismatch',
    );
  });

  it('rejects a consumer binding mismatch', () => {
    expectCode(
      () => verifySessionToken(mint(), { now: NOW, expectedConsumer: OTHER.publicKey() }),
      'consumer_mismatch',
    );
  });
});

/** Signs an arbitrary payload exactly like `mintSessionToken` does. */
function signRaw(payload: Record<string, unknown>, signer: Keypair = consumer): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = Buffer.from(signer.sign(Buffer.from(encoded, 'utf8'))).toString('base64url');
  return `${SESSION_TOKEN_PREFIX}.${encoded}.${signature}`;
}

/** A v1 token as minted before the `service` claim existed. */
function legacyToken(): string {
  return signRaw({
    v: 1,
    lease_id: 'lease-abc',
    consumer: consumer.publicKey(),
    iat: NOW,
    exp: NOW + 300,
  });
}

describe('service binding', () => {
  it('mints the service claim when a service is given', () => {
    const { payload } = parseSessionToken(mint({ service: 'weather-api' }));
    expect(payload.service).toBe('weather-api');
    expect(payload.v).toBe(1);
  });

  it('omits the claim entirely when no service is given (legacy payload shape)', () => {
    const { payload } = parseSessionToken(mint());
    expect('service' in payload).toBe(false);
    expect(Object.keys(payload).sort()).toEqual(['consumer', 'exp', 'iat', 'lease_id', 'v']);
  });

  it('rejects an empty service when minting', () => {
    expectCode(() => mint({ service: '' }), 'malformed_token');
  });

  it('verifies a legacy v1 token without the claim, with or without an expected service', () => {
    const token = legacyToken();
    expect(verifySessionToken(token, { now: NOW }).service).toBeUndefined();
    const payload = verifySessionToken(token, { now: NOW, expectedService: 'weather-api' });
    expect(payload.lease_id).toBe('lease-abc');
    expect(payload.service).toBeUndefined();
  });

  it('accepts a token whose service matches the expected service', () => {
    const payload = verifySessionToken(mint({ service: 'weather-api' }), {
      now: NOW,
      expectedService: 'weather-api',
    });
    expect(payload.service).toBe('weather-api');
  });

  it('accepts a service-bound token when no expected service is given', () => {
    expect(verifySessionToken(mint({ service: 'weather-api' }), { now: NOW }).service).toBe(
      'weather-api',
    );
  });

  it('rejects a cross-service token with service_mismatch', () => {
    const token = mint({ service: 'weather-api' });
    expectCode(
      () => verifySessionToken(token, { now: NOW, expectedService: 'maps-api' }),
      'service_mismatch',
    );
    try {
      verifySessionToken(token, { now: NOW, expectedService: 'maps-api' });
    } catch (error) {
      expect(error).toBeInstanceOf(TokenVerificationError);
      expect((error as TokenVerificationError).message).toMatch(/service/);
    }
  });

  it('checks the signature before the service binding', () => {
    // A forged claim signed by the wrong key is a bad signature, not a mismatch.
    const forged = signRaw(
      {
        v: 1,
        lease_id: 'lease-abc',
        consumer: consumer.publicKey(),
        iat: NOW,
        exp: NOW + 300,
        service: 'maps-api',
      },
      OTHER,
    );
    expectCode(
      () => verifySessionToken(forged, { now: NOW, expectedService: 'weather-api' }),
      'bad_signature',
    );
  });

  it('cannot be rebound to another service without breaking the signature', () => {
    const [prefix, encoded, signature] = mint({ service: 'weather-api' }).split('.') as [
      string,
      string,
      string,
    ];
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    payload['service'] = 'maps-api';
    const tampered = `${prefix}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
    expectCode(
      () => verifySessionToken(tampered, { now: NOW, expectedService: 'maps-api' }),
      'bad_signature',
    );
  });

  it('rejects a non-string or empty service claim as malformed', () => {
    for (const service of [42, '', null]) {
      const token = signRaw({
        v: 1,
        lease_id: 'lease-abc',
        consumer: consumer.publicKey(),
        iat: NOW,
        exp: NOW + 300,
        service,
      });
      expectCode(() => parseSessionToken(token), 'malformed_token');
    }
  });

  it('keeps the existing lease and consumer checks alongside the service check', () => {
    const token = mint({ service: 'weather-api' });
    expectCode(
      () =>
        verifySessionToken(token, {
          now: NOW,
          expectedLeaseId: 'lease-other',
          expectedService: 'weather-api',
        }),
      'lease_mismatch',
    );
    expectCode(() => verifySessionToken(token, { now: NOW + 301, expectedService: 'weather-api' }), 'token_expired');
  });
});

describe('acquire populates the service claim', () => {
  function memoryStore(): SessionStore & { saved: LeaseSession[] } {
    const saved: LeaseSession[] = [];
    return {
      saved,
      async load() {
        return {};
      },
      async save(session) {
        saved.push(session);
      },
      async saveAll() {},
    };
  }

  it('binds the minted token to the --service the lease was created for', async () => {
    const store = memoryStore();
    const created: string[] = [];
    const out: string[] = [];
    const io: CliIo = { out: (line) => out.push(line), err: () => undefined };

    const code = await acquireCommand(
      {
        service: 'weather-api',
        calls: 10,
        duration: 300,
        secret: consumer.secret(),
        dryRun: false,
        json: true,
      },
      io,
      {
        store,
        now: () => NOW * 1000,
        createClient: () => ({
          async createLease(input) {
            created.push(input.service);
            return { leaseId: '42', txHash: 'tx-hash' };
          },
          async quote() {
            return 0;
          },
        }),
      },
    );

    expect(code).toBe(0);
    expect(created).toEqual(['weather-api']);
    expect(store.saved).toHaveLength(1);
    const session = store.saved[0] as LeaseSession;
    expect(session.service).toBe('weather-api');

    const payload = verifySessionToken(session.token, {
      now: NOW,
      expectedLeaseId: '42',
      expectedConsumer: consumer.publicKey(),
      expectedService: 'weather-api',
    });
    expect(payload.service).toBe('weather-api');
    expectCode(
      () => verifySessionToken(session.token, { now: NOW, expectedService: 'maps-api' }),
      'service_mismatch',
    );
    expect(JSON.parse(out.join('\n')).session_token).toBe(session.token);
  });
});
