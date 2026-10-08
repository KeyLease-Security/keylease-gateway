import { Keypair, StrKey } from '@stellar/stellar-sdk';

/**
 * Session bearer token format.
 *
 *   kls1.<base64url(payload JSON)>.<base64url(ed25519 signature)>
 *
 * The payload carries `(lease_id, consumer, iat, exp)` and is signed by the
 * consumer's ed25519 key (the Stellar account that created the lease on chain).
 * The signature covers the *transmitted* payload segment verbatim, so decoding
 * is canonical by construction: no JSON key-order or float round-tripping.
 *
 * A proxy only needs the token to verify the signature; the on-chain lease is
 * then checked separately over Soroban RPC to bind `consumer` to `lease_id`.
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
}

export type TokenErrorCode =
  | 'malformed_token'
  | 'unsupported_version'
  | 'invalid_consumer'
  | 'bad_signature'
  | 'consumer_mismatch'
  | 'lease_mismatch'
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

function encodeSegment(value: string | Buffer): string {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
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

  const payload: SessionTokenPayload = {
    v: SESSION_TOKEN_VERSION,
    lease_id: input.leaseId,
    consumer: keypair.publicKey(),
    iat: issuedAt,
    exp: input.expiresAt,
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
  /** Allowed future drift for `iat`, in seconds. Defaults to 60. */
  maxClockSkewSeconds?: number;
}

/**
 * Fully authenticates a bearer token: structure, version, ed25519 signature,
 * binding to the expected lease/consumer, and validity window.
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

  if (options.expectedLeaseId !== undefined && payload.lease_id !== options.expectedLeaseId) {
    throw new TokenVerificationError('lease_mismatch', 'token is not scoped to the requested lease');
  }
  if (options.expectedConsumer !== undefined && payload.consumer !== options.expectedConsumer) {
    throw new TokenVerificationError('consumer_mismatch', 'token consumer does not match the lease consumer');
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
