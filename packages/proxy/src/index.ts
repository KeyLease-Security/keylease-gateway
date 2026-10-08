#!/usr/bin/env node
/**
 * `@keylease/proxy` entrypoint.
 *
 * Reads configuration from the environment, wires the Soroban-backed lease
 * verifier to the reverse proxy and starts listening.
 *
 * Environment:
 *   KEYLEASE_UPSTREAM_URL   (required) protected upstream API base URL
 *   KEYLEASE_NETWORK        testnet | mainnet | local (default: testnet)
 *   KEYLEASE_RPC_URL        Soroban RPC endpoint override
 *   KEYLEASE_CONTRACT_ID    keylease-core contract id (required)
 *   KEYLEASE_CACHE_TTL_MS   lease-state cache TTL (default: 30000)
 *   KEYLEASE_FORWARD_AUTH   "true" to forward the caller's bearer token
 *   PORT / HOST             listen address (default: 8080 / 0.0.0.0)
 */
import { pathToFileURL } from 'node:url';
import { SorobanClient } from '@keylease/cli/soroban';
import { buildProxyServer } from './server.js';
import { LeaseVerifier, type LeaseStateProvider } from './verifier.js';

export * from './cache.js';
export * from './server.js';
export * from './verifier.js';

export interface ProxyEnv {
  KEYLEASE_UPSTREAM_URL?: string | undefined;
  KEYLEASE_NETWORK?: string | undefined;
  KEYLEASE_RPC_URL?: string | undefined;
  KEYLEASE_CONTRACT_ID?: string | undefined;
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

  const cacheTtlMs = env.KEYLEASE_CACHE_TTL_MS === undefined ? 30_000 : Number(env.KEYLEASE_CACHE_TTL_MS);
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
  };
}

export function providerFromClient(client: Pick<SorobanClient, 'getLeaseState'>): LeaseStateProvider {
  return {
    getLeaseState: (leaseId: string) => client.getLeaseState(leaseId),
  };
}

/** Starts the proxy; resolves once the socket is listening. */
export async function startProxy(env: ProxyEnv = process.env): Promise<{
  close: () => Promise<void>;
  url: string;
  verifier: LeaseVerifier;
}> {
  const config = resolveConfig(env);
  const client = SorobanClient.fromEnv(env);
  const verifier = new LeaseVerifier({
    provider: providerFromClient(client),
    cacheTtlMs: config.cacheTtlMs,
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
    close: () => app.close(),
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
