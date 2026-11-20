#!/usr/bin/env node
/**
 * `@keylease/proxy` entrypoint.
 *
 * Reads configuration from the environment, wires the Soroban-backed lease
 * verifier to the reverse proxy and starts listening.
 *
 * Environment:
 *   KEYLEASE_UPSTREAM_URL    (required) protected upstream API base URL
 *   KEYLEASE_NETWORK         testnet | mainnet | local (default: testnet)
 *   KEYLEASE_RPC_URL         Soroban RPC endpoint override
 *   KEYLEASE_CONTRACT_ID     keylease-core contract id (required)
 *   KEYLEASE_GATEWAY_SECRET  Stellar seed of the registered gateway account;
 *                            enables on-chain `use_call` quota commits
 *   KEYLEASE_QUOTA_BATCH     calls buffered before a commit (default: 50)
 *   KEYLEASE_QUOTA_FLUSH_MS  periodic commit interval (default: 10000)
 *   KEYLEASE_CACHE_TTL_MS    lease-state cache TTL (default: 30000)
 *   KEYLEASE_MAX_BODY_BYTES  maximum request body size in bytes (default: 33554432)
 *   KEYLEASE_TRUST_PROXY     trusted edge proxies for x-forwarded-*: "true", a hop count or
 *                            a comma-separated IP/CIDR list (default: false)
 *   KEYLEASE_MAX_INFLIGHT    max concurrent proxied requests; excess get 503 + Retry-After
 *                            (default: 1024, 0 disables)
 *   KEYLEASE_FORWARD_AUTH    "true" to forward the caller's bearer token
 *   KEYLEASE_FORWARD_HEADERS comma-separated additional request header names to forward
 *   KEYLEASE_METRICS_ENABLED "true" to expose Prometheus metrics on /metrics (default: false)
 *   KEYLEASE_SHUTDOWN_TIMEOUT_MS shutdown drain timeout in ms (default: 10000)
 *   PORT / HOST              listen address (default: 8080 / 0.0.0.0)
 */
import { pathToFileURL } from 'node:url';
import { Keypair } from '@stellar/stellar-sdk';
import { SorobanClient } from '@keylease/cli/soroban';
import { buildProxyServer, DEFAULT_MAX_IN_FLIGHT, drainProxyServer } from './server.js';
import { LeaseVerifier, type LeaseStateProvider } from './verifier.js';
import { OnChainQuota, QuotaCapacityWarning, type QuotaSink } from './quota.js';

export * from './cache.js';
export * from './quota.js';
export * from './server.js';
export * from './verifier.js';

export interface ProxyEnv {
  KEYLEASE_UPSTREAM_URL?: string | undefined;
  KEYLEASE_NETWORK?: string | undefined;
  KEYLEASE_RPC_URL?: string | undefined;
  KEYLEASE_CONTRACT_ID?: string | undefined;
  KEYLEASE_GATEWAY_SECRET?: string | undefined;
  KEYLEASE_QUOTA_BATCH?: string | undefined;
  KEYLEASE_QUOTA_FLUSH_MS?: string | undefined;
  KEYLEASE_CACHE_TTL_MS?: string | undefined;
  KEYLEASE_TRUST_PROXY?: string | undefined;
  KEYLEASE_FORWARD_AUTH?: string | undefined;
  KEYLEASE_FORWARD_HEADERS?: string | undefined;
  KEYLEASE_METRICS_ENABLED?: string | undefined;
  KEYLEASE_SHUTDOWN_TIMEOUT_MS?: string | undefined;
  KEYLEASE_MAX_BODY_BYTES?: string | undefined;
  KEYLEASE_MAX_INFLIGHT?: string | undefined;
  PORT?: string | undefined;
  HOST?: string | undefined;
}

export class ProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyConfigError';
  }
}

export interface ResolvedConfig {
  upstream: string;
  host: string;
  port: number;
  cacheTtlMs: number;
  forwardAuthorization: boolean;
  forwardHeaders: string[];
  trustProxy: boolean | number | string[];
  metricsEnabled: boolean;
  shutdownTimeoutMs: number;
  gatewaySecret: string | null;
  quotaBatch: number;
  quotaFlushMs: number;
  maxBodyBytes: number;
  maxInFlight: number;
}

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024; // 32 MiB
export const MAX_BODY_BYTES_LIMIT = 1024 * 1024 * 1024; // 1 GiB

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ProxyConfigError(`${name} "${raw}" must be a positive integer`);
  }
  return value;
}

function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  const value = raw?.trim();
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return hops === 0 ? false : hops;
  }
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => !/^[0-9a-fA-F.:]+(\/\d{1,3})?$/.test(entry))) {
    throw new ProxyConfigError(
      `KEYLEASE_TRUST_PROXY "${raw ?? ''}" must be "true", "false", a hop count or a comma-separated IP/CIDR list`,
    );
  }
  return entries;
}

function parseForwardHeaders(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
}

export function resolveConfig(env: ProxyEnv): ResolvedConfig {
  const upstream = env.KEYLEASE_UPSTREAM_URL;
  if (!upstream) {
    throw new ProxyConfigError('KEYLEASE_UPSTREAM_URL is required (protected API base URL)');
  }
  try {
    new URL(upstream);
  } catch {
    throw new ProxyConfigError(`KEYLEASE_UPSTREAM_URL "${upstream}" is not a valid URL`);
  }

  const port = env.PORT === undefined ? 8080 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ProxyConfigError(`PORT "${env.PORT ?? ''}" is not a valid port number`);
  }

  const cacheTtlMs =
    env.KEYLEASE_CACHE_TTL_MS === undefined ? 30_000 : Number(env.KEYLEASE_CACHE_TTL_MS);
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs <= 0) {
    throw new ProxyConfigError(
      `KEYLEASE_CACHE_TTL_MS "${env.KEYLEASE_CACHE_TTL_MS ?? ''}" must be a positive number of milliseconds`,
    );
  }

  const maxBodyBytes = positiveInt(
    env.KEYLEASE_MAX_BODY_BYTES,
    DEFAULT_MAX_BODY_BYTES,
    'KEYLEASE_MAX_BODY_BYTES',
  );
  if (maxBodyBytes > MAX_BODY_BYTES_LIMIT) {
    throw new ProxyConfigError(
      `KEYLEASE_MAX_BODY_BYTES "${env.KEYLEASE_MAX_BODY_BYTES}" exceeds maximum allowed limit of 1 GiB (${MAX_BODY_BYTES_LIMIT} bytes)`,
    );
  }

  const maxInFlight =
    env.KEYLEASE_MAX_INFLIGHT === undefined
      ? DEFAULT_MAX_IN_FLIGHT
      : Number(env.KEYLEASE_MAX_INFLIGHT);
  if (!Number.isInteger(maxInFlight) || maxInFlight < 0) {
    throw new ProxyConfigError(
      `KEYLEASE_MAX_INFLIGHT "${env.KEYLEASE_MAX_INFLIGHT ?? ''}" must be a non-negative integer (0 disables the cap)`,
    );
  }

  return {
    upstream,
    host: env.HOST ?? '0.0.0.0',
    port,
    cacheTtlMs,
    forwardAuthorization: env.KEYLEASE_FORWARD_AUTH === 'true',
    forwardHeaders: parseForwardHeaders(env.KEYLEASE_FORWARD_HEADERS),
    trustProxy: parseTrustProxy(env.KEYLEASE_TRUST_PROXY),
    metricsEnabled: env.KEYLEASE_METRICS_ENABLED === 'true',
    shutdownTimeoutMs: positiveInt(
      env.KEYLEASE_SHUTDOWN_TIMEOUT_MS,
      10_000,
      'KEYLEASE_SHUTDOWN_TIMEOUT_MS',
    ),
    gatewaySecret: env.KEYLEASE_GATEWAY_SECRET ?? null,
    quotaBatch: positiveInt(env.KEYLEASE_QUOTA_BATCH, 50, 'KEYLEASE_QUOTA_BATCH'),
    quotaFlushMs: positiveInt(env.KEYLEASE_QUOTA_FLUSH_MS, 10_000, 'KEYLEASE_QUOTA_FLUSH_MS'),
    maxBodyBytes,
    maxInFlight,
  };
}

/**
 * Secret-free view of the resolved configuration, safe to log at startup.
 * The gateway secret is reduced to a boolean and the upstream URL is stripped
 * of credentials, query and fragment.
 */
export function describeConfig(config: ResolvedConfig): Record<string, unknown> {
  const url = new URL(config.upstream);
  return {
    upstream: `${url.protocol}//${url.host}${url.pathname}`,
    host: config.host,
    port: config.port,
    cacheTtlMs: config.cacheTtlMs,
    forwardAuthorization: config.forwardAuthorization,
    forwardHeaders: config.forwardHeaders,
    trustProxy: config.trustProxy,
    metricsEnabled: config.metricsEnabled,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    onChainQuotaCommits: config.gatewaySecret !== null,
    quotaBatch: config.quotaBatch,
    quotaFlushMs: config.quotaFlushMs,
    maxBodyBytes: config.maxBodyBytes,
    maxInFlight: config.maxInFlight,
  };
}

export function providerFromClient(
  client: Pick<SorobanClient, 'getLeaseState'>,
): LeaseStateProvider {
  return {
    getLeaseState: (leaseId: string) => client.getLeaseState(leaseId),
  };
}

/**
 * Builds the on-chain quota sink. Without a gateway secret the proxy still
 * enforces quota locally, but `calls_used` on chain only moves at settlement.
 */
export function quotaSinkFrom(
  client: Pick<SorobanClient, 'useCalls'>,
  config: Pick<ResolvedConfig, 'gatewaySecret' | 'quotaBatch' | 'quotaFlushMs'>,
  logger: { warn: (obj: unknown, msg?: string) => void } = { warn: () => {} },
): QuotaSink | undefined {
  if (config.gatewaySecret === null) return undefined;

  let gateway: Keypair;
  try {
    gateway = Keypair.fromSecret(config.gatewaySecret);
  } catch {
    throw new ProxyConfigError(
      'KEYLEASE_GATEWAY_SECRET is not a valid Stellar secret seed (starts with "S")',
    );
  }

  return new OnChainQuota({
    batchSize: config.quotaBatch,
    flushIntervalMs: config.quotaFlushMs,
    committer: {
      useCalls: (leaseId: string, count: number) => client.useCalls(leaseId, count, gateway),
    },
    onError: (error, leaseId, count) => {
      logger.warn(
        { err: error, leaseId, count },
        error instanceof QuotaCapacityWarning
          ? 'on-chain quota lease limit reached; flushing pending calls early'
          : 'on-chain quota commit failed; calls requeued',
      );
    },
  });
}

export function attachSignalHandlers(
  drain: () => Promise<'drained' | 'timed_out'>,
  options: {
    logger?: { info: (msg: string) => void };
    exit?: (code: number) => void;
    processObj?: Pick<NodeJS.Process, 'on' | 'removeListener'>;
  } = {},
): () => void {
  const proc = options.processObj ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  const onSignal = async (signal: string) => {
    if (shuttingDown) {
      options.logger?.info(`received second ${signal}; forcing immediate exit`);
      exit(1);
      return;
    }
    shuttingDown = true;
    options.logger?.info(`received ${signal}; draining in-flight requests...`);
    try {
      const outcome = await drain();
      options.logger?.info(`shutdown complete: ${outcome}`);
      exit(outcome === 'drained' ? 0 : 1);
    } catch {
      options.logger?.info('shutdown failed with error');
      exit(1);
    }
  };

  const onSigterm = () => void onSignal('SIGTERM');
  const onSigint = () => void onSignal('SIGINT');

  proc.on('SIGTERM', onSigterm);
  proc.on('SIGINT', onSigint);

  return () => {
    proc.removeListener('SIGTERM', onSigterm);
    proc.removeListener('SIGINT', onSigint);
  };
}

/** Starts the proxy; resolves once the socket is listening. */
export async function startProxy(env: ProxyEnv = process.env): Promise<{
  close: () => Promise<void>;
  drain: (timeoutMs?: number) => Promise<'drained' | 'timed_out'>;
  url: string;
  verifier: LeaseVerifier;
}> {
  const config = resolveConfig(env);
  const client = SorobanClient.fromEnv(env);
  const quotaSink = quotaSinkFrom(client, config);
  const verifier = new LeaseVerifier({
    provider: providerFromClient(client),
    cacheTtlMs: config.cacheTtlMs,
    ...(quotaSink === undefined ? {} : { quotaSink }),
  });
  const app = buildProxyServer({
    upstream: config.upstream,
    verifier,
    forwardAuthorization: config.forwardAuthorization,
    forwardHeaders: config.forwardHeaders,
    trustProxy: config.trustProxy,
    metricsEnabled: config.metricsEnabled,
    maxBodyBytes: config.maxBodyBytes,
    maxInFlight: config.maxInFlight,
    logger: true,
  });
  app.log.info({ config: describeConfig(config) }, 'configuration');

  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info(`listening on ${address}`);

  const drain = async (timeoutMs = config.shutdownTimeoutMs): Promise<'drained' | 'timed_out'> => {
    const outcome = await drainProxyServer(app, timeoutMs);
    await quotaSink?.close();
    return outcome;
  };

  const removeSignalHandlers = attachSignalHandlers(drain, {
    logger: {
      info: (msg) => app.log.info(msg),
    },
  });

  return {
    url: address,
    verifier,
    drain,
    close: async () => {
      removeSignalHandlers();
      await quotaSink?.close();
      await app.close();
    },
  };
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  startProxy().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`keylease-proxy: ${message}\n`);
    process.exitCode = 1;
  });
}
