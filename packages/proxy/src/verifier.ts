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
 *
 * LRU counter eviction invariant: Local counters must never drop uncommitted
 * quota. When maxCounters is reached, pending quota is flushed through the
 * quotaSink and the evicted lease's cached state is invalidated before
 * removing the local counter, ensuring on-chain calls_used reflects all
 * served traffic and prevents double-spending quota.
 */
import { TokenVerificationError, verifySessionToken, type SessionTokenPayload } from '@keylease/cli/token';
import { LeaseNotFoundError, type LeaseState } from '@keylease/cli/soroban';
import { DEFAULT_TTL_MS, TtlCache } from './cache.js';
import type { QuotaSink } from './quota.js';

export interface LeaseStateProvider {
  getLeaseState(leaseId: string): Promise<LeaseState>;
  /** Optional health/readiness probe. */
  isReady?: () => boolean | Promise<boolean>;
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
  | 'quota_exhausted'
  | 'lease_service_mismatch'
  | 'rate_limited';

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
      status: 401 | 403 | 429 | 503;
      reason: FailureReason;
      message: string;
      retryAfter?: number;
    };

export interface VerifierOptions {
  provider: LeaseStateProvider;
  /** How long a fetched lease state stays fresh. Defaults to 30s. */
  cacheTtlMs?: number;
  /** Share a pre-built cache (e.g. to reuse metrics) instead. */
  cache?: TtlCache<LeaseState>;
  /** Share a pre-built denial cache instead. */
  denialCache?: TtlCache<true>;
  maxCacheEntries?: number;
  /** Clock in milliseconds. Defaults to `Date.now`. */
  clock?: () => number;
  /** Cap on tracked local counters. Defaults to 10 000. */
  maxCounters?: number;
  /**
   * Optional on-chain quota sink. When present, every served call is queued
   * for a `use_call` commit so `calls_used` on chain tracks real traffic.
   */
  quotaSink?: QuotaSink;
  /**
   * Optional service binding: when set, incoming leases must match this service ID.
   */
  serviceId?: string;
  /**
   * Optional per-lease rate limit in requests per minute (0 = disabled).
   */
  rateLimitPerMinute?: number;
}

export interface VerifierStats {
  cache: ReturnType<TtlCache<LeaseState>['stats']>;
  /** Stats for the terminal lease denial cache (cached LeaseNotFoundError outcomes). */
  denials: ReturnType<TtlCache<true>['stats']>;
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

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
  lastAccessMs: number;
}

export class LeaseVerifier {
  private readonly provider: LeaseStateProvider;
  private readonly cache: TtlCache<LeaseState>;
  /**
   * Denials for missing leases (LeaseNotFoundError) are cached for a short TTL
   * capped at min(cacheTtlMs, 5000) so unknown leases do not burn RPC quota.
   */
  private readonly denialCache: TtlCache<true>;
  readonly cacheTtlMs: number;
  readonly serviceId?: string | undefined;
  readonly rateLimitPerMinute: number;
  private readonly clock: () => number;
  private readonly maxCounters: number;
  private readonly quotaSink: QuotaSink | undefined;
  private readonly calls = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<LeaseState>>();
  private readonly rateLimitBuckets = new Map<string, TokenBucket>();
  private rpcCalls = 0;
  private rpcDown = false;

  constructor(options: VerifierOptions) {
    this.provider = options.provider;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_TTL_MS;
    this.serviceId = options.serviceId;
    this.rateLimitPerMinute = Math.max(0, options.rateLimitPerMinute ?? 0);
    this.cache =
      options.cache ??
      new TtlCache<LeaseState>({
        ttlMs: this.cacheTtlMs,
        maxEntries: options.maxCacheEntries ?? 1_000,
        clock: options.clock ?? Date.now,
      });
    this.denialCache =
      options.denialCache ??
      new TtlCache<true>({
        ttlMs: Math.min(this.cacheTtlMs, 5_000),
        maxEntries: options.maxCacheEntries ?? 1_000,
        clock: options.clock ?? Date.now,
      });
    this.clock = options.clock ?? Date.now;
    this.maxCounters = options.maxCounters ?? 10_000;
    this.quotaSink = options.quotaSink;
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

    if (this.serviceId !== undefined && lease.service !== this.serviceId) {
      return {
        ok: false,
        status: 403,
        reason: 'lease_service_mismatch',
        message: `lease is for service "${lease.service}", expected "${this.serviceId}"`,
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

    if (this.rateLimitPerMinute > 0) {
      const rateCheck = this.checkRateLimit(lease.leaseId);
      if (!rateCheck.allowed) {
        return {
          ok: false,
          status: 429,
          reason: 'rate_limited',
          message: `rate limit of ${this.rateLimitPerMinute} req/min exceeded for lease ${lease.leaseId}`,
          retryAfter: rateCheck.retryAfter,
        };
      }
    }

    await this.consume(lease.leaseId, used + 1);
    this.quotaSink?.record(lease.leaseId);
    return { ok: true, lease, payload, remainingCalls: limit - used - 1 };
  }

  /** Local calls consumed for a lease in this process. */
  localCalls(leaseId: string): number {
    return this.calls.get(leaseId) ?? 0;
  }

  /** Drops the local counter for a lease (admin/testing hook). */
  resetCalls(leaseId?: string): void {
    if (leaseId === undefined) {
      this.calls.clear();
      this.inFlight.clear();
      this.rateLimitBuckets.clear();
    } else {
      this.calls.delete(leaseId);
      this.inFlight.delete(this.cacheKey(leaseId));
      this.rateLimitBuckets.delete(leaseId);
    }
  }

  stats(): VerifierStats {
    return {
      cache: this.cache.stats(),
      denials: this.denialCache.stats(),
      rpcCalls: this.rpcCalls,
      counters: this.calls.size,
    };
  }

  /**
   * Reports whether the lease verifier has a cached, reachable state.
   */
  async isReady(): Promise<boolean> {
    if (typeof this.provider.isReady === 'function') {
      return this.provider.isReady();
    }
    return this.cache.size > 0 && !this.rpcDown;
  }

  private cacheKey(leaseId: string): string {
    return this.serviceId !== undefined ? `${this.serviceId}:${leaseId}` : leaseId;
  }

  private checkRateLimit(leaseId: string): { allowed: true } | { allowed: false; retryAfter: number } {
    const now = this.clock();
    let bucket = this.rateLimitBuckets.get(leaseId);
    if (!bucket) {
      bucket = {
        tokens: this.rateLimitPerMinute,
        lastRefillMs: now,
        lastAccessMs: now,
      };
      this.rateLimitBuckets.set(leaseId, bucket);
    } else {
      const elapsedMs = Math.max(0, now - bucket.lastRefillMs);
      const addedTokens = (elapsedMs * this.rateLimitPerMinute) / 60_000;
      bucket.tokens = Math.min(this.rateLimitPerMinute, bucket.tokens + addedTokens);
      bucket.lastRefillMs = now;
      bucket.lastAccessMs = now;
    }

    this.pruneIdleBuckets(now);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    const needed = 1 - bucket.tokens;
    const msUntilRefill = (needed * 60_000) / this.rateLimitPerMinute;
    const retryAfter = Math.max(1, Math.ceil(msUntilRefill / 1_000));
    return { allowed: false, retryAfter };
  }

  private pruneIdleBuckets(now: number): void {
    if (this.rateLimitBuckets.size < 10) return;
    for (const [id, b] of this.rateLimitBuckets.entries()) {
      if (now - b.lastAccessMs >= 60_000) {
        this.rateLimitBuckets.delete(id);
      }
    }
  }

  private async resolveLease(leaseId: string): Promise<LeaseState> {
    const key = this.cacheKey(leaseId);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    if (this.denialCache.get(key) !== undefined) {
      throw new LeaseNotFoundError(leaseId);
    }

    const inFlightPromise = this.inFlight.get(key);
    if (inFlightPromise !== undefined) {
      return inFlightPromise;
    }

    const flight = (async () => {
      this.rpcCalls += 1;
      try {
        const lease = await this.provider.getLeaseState(leaseId);
        this.rpcDown = false;
        // Never cache past the lease's own expiry; non-positive TTLs are not cached.
        const untilExpiryMs = lease.expiresAt * 1000 - this.clock();
        this.cache.set(key, lease, Math.min(this.cacheTtlMs, untilExpiryMs));
        return lease;
      } catch (error) {
        if (isLeaseNotFound(error)) {
          this.denialCache.set(key, true, Math.min(this.cacheTtlMs, 5_000));
        } else {
          this.rpcDown = true;
        }
        throw error;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, flight);
    return flight;
  }

  private async consume(leaseId: string, used: number): Promise<void> {
    if (!this.calls.has(leaseId) && this.calls.size >= this.maxCounters) {
      const oldestEntry = this.calls.keys().next();
      if (!oldestEntry.done) {
        const oldestId = oldestEntry.value;
        if (this.quotaSink) {
          await this.quotaSink.flush();
          this.cache.delete(this.cacheKey(oldestId));
          this.calls.delete(oldestId);
        }
      }
    }
    this.calls.set(leaseId, used);
  }
}

function isLeaseNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'LeaseNotFoundError';
}
