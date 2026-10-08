/**
 * Lease verification for incoming requests.
 *
 * Two independent checks are combined:
 *   1. the bearer token's ed25519 signature and validity window (offline), and
 *   2. the lease's current on-chain state over Soroban RPC, cached for a short
 *      TTL so a busy proxy does not issue one RPC call per request.
 *
 * On top of that this verifier keeps the *local* call counter: each allowed
 * request increments it, and a lease is refused once its quota is spent.
 */
import { TokenVerificationError, verifySessionToken, type SessionTokenPayload } from '@keylease/cli/token';
import type { LeaseState } from '@keylease/cli/soroban';
import { DEFAULT_TTL_MS, TtlCache } from './cache.js';

export interface LeaseStateProvider {
  getLeaseState(leaseId: string): Promise<LeaseState>;
}

export type FailureReason =
  | 'missing_token'
  | 'invalid_token'
  | 'token_expired'
  | 'lease_not_found'
  | 'verification_unavailable'
  | 'lease_inactive'
  | 'lease_expired'
  | 'consumer_mismatch'
  | 'quota_exhausted';

export type VerificationResult =
  | {
      ok: true;
      lease: LeaseState;
      payload: SessionTokenPayload;
      /** Calls still available on this lease after the current one. */
      remainingCalls: number;
    }
  | {
      ok: false;
      status: 401 | 403 | 503;
      reason: FailureReason;
      message: string;
    };

export interface VerifierOptions {
  provider: LeaseStateProvider;
  /** How long a fetched lease state stays fresh. Defaults to 30s. */
  cacheTtlMs?: number;
  /** Share a pre-built cache (e.g. to reuse metrics) instead. */
  cache?: TtlCache<LeaseState>;
  maxCacheEntries?: number;
  /** Clock in milliseconds. Defaults to `Date.now`. */
  clock?: () => number;
  /** Cap on tracked local counters. Defaults to 10 000. */
  maxCounters?: number;
}

export interface VerifierStats {
  cache: ReturnType<TtlCache<LeaseState>['stats']>;
  rpcCalls: number;
  counters: number;
}

const BEARER_PATTERN = /^Bearer[ \t]+(.+)$/i;

/** Extracts the raw token from an `Authorization` header value. */
export function extractBearerToken(header: string | undefined | null): string | null {
  if (typeof header !== 'string') return null;
  const match = BEARER_PATTERN.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function nowSeconds(clock: () => number): number {
  return Math.floor(clock() / 1000);
}

export class LeaseVerifier {
  private readonly provider: LeaseStateProvider;
  private readonly cache: TtlCache<LeaseState>;
  private readonly clock: () => number;
  private readonly maxCounters: number;
  private readonly calls = new Map<string, number>();
  private rpcCalls = 0;

  constructor(options: VerifierOptions) {
    this.provider = options.provider;
    this.cache =
      options.cache ??
      new TtlCache<LeaseState>({
        ttlMs: options.cacheTtlMs ?? DEFAULT_TTL_MS,
        maxEntries: options.maxCacheEntries ?? 1_000,
        clock: options.clock ?? Date.now,
      });
    this.clock = options.clock ?? Date.now;
    this.maxCounters = options.maxCounters ?? 10_000;
  }

  /**
   * Verifies an `Authorization: Bearer <lease_token>` header and, when allowed,
   * consumes one call from the lease's local quota.
   */
  async verifyAuthorization(header: string | undefined | null): Promise<VerificationResult> {
    const token = extractBearerToken(header);
    if (token === null) {
      const hasHeader = typeof header === 'string' && header.trim().length > 0;
      return {
        ok: false,
        status: 401,
        reason: hasHeader ? 'invalid_token' : 'missing_token',
        message: hasHeader
          ? 'authorization header must use the Bearer scheme'
          : 'missing Authorization: Bearer <lease_token> header',
      };
    }
    return this.verify(token);
  }

  /** Verifies a raw session token and consumes a call when allowed. */
  async verify(token: string): Promise<VerificationResult> {
    let payload: SessionTokenPayload;
    try {
      payload = verifySessionToken(token, { now: nowSeconds(this.clock) });
    } catch (error) {
      if (error instanceof TokenVerificationError) {
        const expired = error.code === 'token_expired' || error.code === 'token_not_yet_valid';
        return {
          ok: false,
          status: 401,
          reason: expired ? 'token_expired' : 'invalid_token',
          message: error.message,
        };
      }
      throw error;
    }

    let lease: LeaseState;
    try {
      lease = await this.resolveLease(payload.lease_id);
    } catch (error) {
      if (isLeaseNotFound(error)) {
        return {
          ok: false,
          status: 403,
          reason: 'lease_not_found',
          message: `lease ${payload.lease_id} does not exist on chain`,
        };
      }
      return {
        ok: false,
        status: 503,
        reason: 'verification_unavailable',
        message: `unable to verify lease ${payload.lease_id} over Soroban RPC`,
      };
    }

    if (payload.consumer !== lease.consumer) {
      return {
        ok: false,
        status: 403,
        reason: 'consumer_mismatch',
        message: 'token consumer does not own this lease',
      };
    }
    if (!lease.active) {
      return {
        ok: false,
        status: 403,
        reason: 'lease_inactive',
        message: 'lease has been revoked',
      };
    }
    if (lease.expiresAt <= nowSeconds(this.clock)) {
      return {
        ok: false,
        status: 403,
        reason: 'lease_expired',
        message: 'lease has expired',
      };
    }

    const limit = lease.callsLimit;
    const used = Math.max(lease.callsUsed, this.localCalls(lease.leaseId));
    if (used >= limit) {
      return {
        ok: false,
        status: 403,
        reason: 'quota_exhausted',
        message: `lease quota exhausted (${limit} calls spent)`,
      };
    }

    this.consume(lease.leaseId, used + 1);
    return { ok: true, lease, payload, remainingCalls: limit - used - 1 };
  }

  /** Local calls consumed for a lease in this process. */
  localCalls(leaseId: string): number {
    return this.calls.get(leaseId) ?? 0;
  }

  /** Drops the local counter for a lease (admin/testing hook). */
  resetCalls(leaseId?: string): void {
    if (leaseId === undefined) this.calls.clear();
    else this.calls.delete(leaseId);
  }

  stats(): VerifierStats {
    return { cache: this.cache.stats(), rpcCalls: this.rpcCalls, counters: this.calls.size };
  }

  private async resolveLease(leaseId: string): Promise<LeaseState> {
    const cached = this.cache.get(leaseId);
    if (cached !== undefined) return cached;

    this.rpcCalls += 1;
    const lease = await this.provider.getLeaseState(leaseId);
    this.cache.set(leaseId, lease);
    return lease;
  }

  private consume(leaseId: string, used: number): void {
    if (!this.calls.has(leaseId) && this.calls.size >= this.maxCounters) {
      const oldest = this.calls.keys().next();
      if (!oldest.done) this.calls.delete(oldest.value);
    }
    this.calls.set(leaseId, used);
  }
}

function isLeaseNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'LeaseNotFoundError';
}
