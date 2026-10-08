import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
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
