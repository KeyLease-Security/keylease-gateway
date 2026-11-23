import { timingSafeEqual } from 'node:crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

/**
 * Constant-time string equality check to prevent timing side channels.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Session bearer token format.
 *
 *   kls1.<base64url(payload JSON)>.<base64url(ed25519 signature)>
 *
 * The payload carries `(lease_id, consumer, iat, exp)`, plus an optional
 * `service` claim naming the service the lease was bought for, and is signed
 * by the consumer's ed25519 key (the Stellar account that created the lease on chain).
 * The signature covers the *transmitted* payload segment verbatim, so decoding
 * is canonical by construction: no JSON key-order or float round-tripping.
 *
 * A proxy only needs the token to verify the signature; the on-chain lease is
 * then checked separately over Soroban RPC to bind `consumer` to `lease_id`.
 *
 * Service binding and compatibility: `service` was added to the v1 format as
 * an optional claim, so `v` stays `1`. Tokens minted before it existed have no
 * `service` and still verify. When a verifier knows which service it gates it
 * passes `expectedService`; a token that carries a different `service` is then
 * rejected with `service_mismatch`, while a legacy token without the claim is
 * accepted (the on-chain lease remains the authority on its service).
 */
export const SESSION_TOKEN_PREFIX = 'kls1';
export const SESSION_TOKEN_VERSION = 1;

export interface SessionTokenPayload {
  /** Token format version. */
  v: number;
  /** Identifier of the on-chain lease this session rides on. */
  lease_id: string;
  /** Stellar public key (ed25519) that owns the lease. */
  consumer: string;
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expiry, unix seconds. */
  exp: number;
  /**
   * Service id the lease was acquired for. Optional: absent on tokens minted
   * before service binding, which remain valid v1 tokens.
   */
  service?: string;
}

export type TokenErrorCode =
  | 'malformed_token'
  | 'unsupported_version'
  | 'invalid_consumer'
  | 'bad_signature'
  | 'consumer_mismatch'
  | 'lease_mismatch'
  | 'service_mismatch'
  | 'token_expired'
  | 'token_not_yet_valid';

export class TokenVerificationError extends Error {
  readonly code: TokenErrorCode;

  constructor(code: TokenErrorCode, message: string) {
    super(message);
    this.name = 'TokenVerificationError';
    this.code = code;
  }
}

const B64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_CLOCK_SKEW_SECONDS = 60;

function encodeSegment(value: string | Uint8Array): string {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  return buf.toString('base64url');
}

function decodeSegment(segment: string, what: string): Buffer {
  if (segment.length === 0 || !B64URL_PATTERN.test(segment)) {
    throw new TokenVerificationError('malformed_token', `Token ${what} is not valid base64url`);
  }
  return Buffer.from(segment, 'base64url');
}

export interface MintSessionTokenInput {
  leaseId: string;
  /** Stellar secret seed (`S...`) of the consumer account. Never leaves the process. */
  consumerSecret: string;
  /** Issued-at in unix seconds. Defaults to now. */
  issuedAt?: number;
  /** Absolute expiry in unix seconds. */
  expiresAt: number;
  /** Service id the lease was acquired for; becomes the `service` claim. */
  service?: string;
}

/**
 * Mints a signed session bearer token for a freshly acquired lease.
 */
export function mintSessionToken(input: MintSessionTokenInput): string {
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(input.consumerSecret);
  } catch {
    throw new TokenVerificationError('invalid_consumer', 'consumer secret is not a valid Stellar secret seed');
  }

  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(issuedAt) || !Number.isInteger(input.expiresAt)) {
    throw new TokenVerificationError('malformed_token', 'iat/exp must be integer unix seconds');
  }
  if (input.expiresAt <= issuedAt) {
    throw new TokenVerificationError('malformed_token', 'token expiry must be after issue time');
  }
  if (input.service !== undefined && (typeof input.service !== 'string' || input.service.length === 0)) {
    throw new TokenVerificationError('malformed_token', 'service claim must be a non-empty string');
  }

  const payload: SessionTokenPayload = {
    v: SESSION_TOKEN_VERSION,
    lease_id: input.leaseId,
    consumer: keypair.publicKey(),
    iat: issuedAt,
    exp: input.expiresAt,
    // Omitted entirely (not `undefined`) when unknown, so the payload of a
    // token minted without a service is byte-for-byte the legacy shape.
    ...(input.service !== undefined ? { service: input.service } : {}),
  };

  const encodedPayload = encodeSegment(JSON.stringify(payload));
  const signature = keypair.sign(Buffer.from(encodedPayload, 'utf8'));

  return `${SESSION_TOKEN_PREFIX}.${encodedPayload}.${encodeSegment(signature)}`;
}

export interface DecodedSessionToken {
  payload: SessionTokenPayload;
  /** The exact payload segment the signature was produced over. */
  encodedPayload: string;
  signature: Buffer;
}

/**
 * Decodes (but does **not** authenticate) a bearer token. Useful for logging.
 * Throws {@link TokenVerificationError} on structural problems.
 */
export function parseSessionToken(token: string): DecodedSessionToken {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TokenVerificationError('malformed_token', 'token is empty');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new TokenVerificationError('malformed_token', 'expected three dot-separated segments');
  }
  const [prefix, encodedPayload, encodedSignature] = parts as [string, string, string];

  if (prefix !== SESSION_TOKEN_PREFIX) {
    throw new TokenVerificationError('malformed_token', `unknown token prefix "${prefix}"`);
  }

  const payloadBytes = decodeSegment(encodedPayload, 'payload');
  const signature = decodeSegment(encodedSignature, 'signature');
  if (signature.length !== 64) {
    throw new TokenVerificationError('malformed_token', 'ed25519 signature must be 64 bytes');
  }

  let payload: SessionTokenPayload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8')) as SessionTokenPayload;
  } catch {
    throw new TokenVerificationError('malformed_token', 'payload is not valid JSON');
  }

  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof payload.v !== 'number' ||
    typeof payload.lease_id !== 'string' ||
    typeof payload.consumer !== 'string' ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number'
  ) {
    throw new TokenVerificationError('malformed_token', 'payload is missing required fields');
  }
  if (
    payload.service !== undefined &&
    (typeof payload.service !== 'string' || payload.service.length === 0)
  ) {
    throw new TokenVerificationError('malformed_token', 'service claim must be a non-empty string');
  }
  if (payload.v !== SESSION_TOKEN_VERSION) {
    throw new TokenVerificationError('unsupported_version', `unsupported token version ${payload.v}`);
  }
  if (!StrKey.isValidEd25519PublicKey(payload.consumer)) {
    throw new TokenVerificationError('invalid_consumer', 'consumer is not a valid Stellar public key');
  }

  return { payload, encodedPayload, signature };
}

export interface VerifySessionTokenOptions {
  /** Current time in unix seconds. Defaults to `Date.now()`. */
  now?: number;
  /** When set, the token must be minted for exactly this lease. */
  expectedLeaseId?: string;
  /** When set, the token must be signed by exactly this consumer account. */
  expectedConsumer?: string;
  /**
   * When set, a token that carries a `service` claim must name exactly this
   * service (`service_mismatch` otherwise). Legacy tokens without the claim
   * are still accepted.
   */
  expectedService?: string;
  /** Allowed future drift for `iat`, in seconds. Defaults to 60. */
  maxClockSkewSeconds?: number;
}

/**
 * Fully authenticates a bearer token: structure, version, ed25519 signature,
 * binding to the expected lease/consumer/service, and validity window.
 */
export function verifySessionToken(
  token: string,
  options: VerifySessionTokenOptions = {},
): SessionTokenPayload {
  const { payload, encodedPayload, signature } = parseSessionToken(token);

  let consumer: Keypair;
  try {
    consumer = Keypair.fromPublicKey(payload.consumer);
  } catch {
    throw new TokenVerificationError('invalid_consumer', 'consumer is not a valid Stellar public key');
  }

  const message = Buffer.from(encodedPayload, 'utf8');
  if (!consumer.verify(message, signature)) {
    throw new TokenVerificationError('bad_signature', 'session token signature does not verify');
  }

  if (
    options.expectedLeaseId !== undefined &&
    !timingSafeEqualString(payload.lease_id, options.expectedLeaseId)
  ) {
    throw new TokenVerificationError('lease_mismatch', 'token is not scoped to the requested lease');
  }
  if (
    options.expectedConsumer !== undefined &&
    !timingSafeEqualString(payload.consumer, options.expectedConsumer)
  ) {
    throw new TokenVerificationError('consumer_mismatch', 'token consumer does not match the lease consumer');
  }
  if (
    options.expectedService !== undefined &&
    payload.service !== undefined &&
    payload.service !== options.expectedService
  ) {
    throw new TokenVerificationError('service_mismatch', 'token is not scoped to the requested service');
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (now >= payload.exp) {
    throw new TokenVerificationError('token_expired', 'session token has expired');
  }
  const skew = options.maxClockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (payload.iat > now + skew) {
    throw new TokenVerificationError('token_not_yet_valid', 'session token is not valid yet');
  }

  return payload;
}
