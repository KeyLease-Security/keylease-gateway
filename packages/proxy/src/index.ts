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
 *   KEYLEASE_FORWARD_AUTH    "true" to forward the caller's bearer token
 *   PORT / HOST              listen address (default: 8080 / 0.0.0.0)
 */
import { pathToFileURL } from 'node:url';
import { Keypair } from '@stellar/stellar-sdk';
import { SorobanClient } from '@keylease/cli/soroban';
import { buildProxyServer } from './server.js';
import { LeaseVerifier, type LeaseStateProvider } from './verifier.js';
import { OnChainQuota, type QuotaSink } from './quota.js';

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
  KEYLEASE_FORWARD_AUTH?: string | undefined;
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
  gatewaySecret: string | null;
  quotaBatch: number;
  quotaFlushMs: number;
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ProxyConfigError(`${name} "${raw}" must be a positive integer`);
  }
  return value;
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

  return {
    upstream,
    host: env.HOST ?? '0.0.0.0',
    port,
    cacheTtlMs,
    forwardAuthorization: env.KEYLEASE_FORWARD_AUTH === 'true',
    gatewaySecret: env.KEYLEASE_GATEWAY_SECRET ?? null,
    quotaBatch: positiveInt(env.KEYLEASE_QUOTA_BATCH, 50, 'KEYLEASE_QUOTA_BATCH'),
    quotaFlushMs: positiveInt(env.KEYLEASE_QUOTA_FLUSH_MS, 10_000, 'KEYLEASE_QUOTA_FLUSH_MS'),
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
        'on-chain quota commit failed; calls requeued',
      );
    },
  });
}

/** Starts the proxy; resolves once the socket is listening. */
export async function startProxy(env: ProxyEnv = process.env): Promise<{
  close: () => Promise<void>;
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
    logger: true,
  });

  const address = await app.listen({ host: config.host, port: config.port });
  return {
    url: address,
    verifier,
    close: async () => {
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
