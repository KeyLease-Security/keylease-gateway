/**
 * `keylease whoami` — a one-shot report of the configuration a terminal is
 * using: resolved network, RPC URL, contract id, the consumer public key when
 * a secret is supplied, and the locally stored lease sessions.
 *
 * The network configuration is resolved exactly like the chain commands do
 * (`KEYLEASE_NETWORK`, `KEYLEASE_RPC_URL`, `KEYLEASE_CONTRACT_ID`, with flags
 * taking precedence), but a missing contract id is reported instead of
 * throwing, because diagnosing an unconfigured terminal is the point.
 */
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { NETWORKS } from '../client/soroban.js';
import {
  fileSessionStore,
  SessionStoreError,
  type LeaseSession,
  type NetworkArgs,
  type SessionStore,
} from './lease.js';
import type { CliIo } from '../index.js';

export interface WhoamiArgs extends NetworkArgs {
  secret?: string | undefined;
  json: boolean;
}

export interface WhoamiEnv {
  KEYLEASE_NETWORK?: string | undefined;
  KEYLEASE_RPC_URL?: string | undefined;
  KEYLEASE_CONTRACT_ID?: string | undefined;
  KEYLEASE_CONTRACT?: string | undefined;
}

export interface WhoamiDeps {
  store?: SessionStore;
  env?: WhoamiEnv;
  now?: () => number;
}

export interface ResolvedWhoamiConfig {
  network: string;
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string | null;
}

export class WhoamiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhoamiConfigError';
  }
}

/** Resolves the network view without requiring a contract id. */
export function resolveWhoamiConfig(
  args: Pick<WhoamiArgs, 'network' | 'rpc' | 'contract'>,
  env: WhoamiEnv = process.env,
): ResolvedWhoamiConfig {
  const networkName = args.network ?? env.KEYLEASE_NETWORK ?? 'testnet';
  const network = NETWORKS[networkName];
  if (!network) {
    throw new WhoamiConfigError(
      `unknown network "${networkName}" (expected one of: ${Object.keys(NETWORKS).join(', ')})`,
    );
  }

  const contractId = args.contract ?? env.KEYLEASE_CONTRACT_ID ?? env.KEYLEASE_CONTRACT ?? null;
  if (contractId !== null && !StrKey.isValidContract(contractId)) {
    throw new WhoamiConfigError(`contract id "${contractId}" is not a valid contract address`);
  }

  return {
    network: network.name,
    rpcUrl: args.rpc ?? env.KEYLEASE_RPC_URL ?? network.rpcUrl,
    networkPassphrase: network.networkPassphrase,
    contractId,
  };
}

/** Derives the public key of `--secret` without ever exposing the seed. */
export function deriveConsumerPublicKey(secret: string): string {
  try {
    return Keypair.fromSecret(secret).publicKey();
  } catch {
    throw new WhoamiConfigError('--secret must be a valid Stellar secret seed (starts with "S")');
  }
}

interface SessionSummary {
  service: string;
  lease_id: string;
  expires_at: number;
}

function sessionSummaries(
  sessions: Record<string, LeaseSession>,
): SessionSummary[] {
  return Object.values(sessions)
    .map((session) => ({
      service: session.service,
      lease_id: session.leaseId,
      expires_at: session.expiresAt,
    }))
    .sort((left, right) => left.service.localeCompare(right.service));
}

function formatExpiry(expiresAt: number): string {
  const date = new Date(expiresAt * 1000);
  return Number.isNaN(date.getTime()) ? String(expiresAt) : date.toISOString();
}

async function loadSessions(store: SessionStore): Promise<Record<string, LeaseSession> | null> {
  try {
    return await store.load();
  } catch (error) {
    // A missing store simply means nothing has been acquired in this directory.
    if (error instanceof SessionStoreError && error.code === 'missing') return null;
    throw error;
  }
}

/** `keylease whoami [--secret <key>] [--network <name>] [--rpc <url>] [--contract <id>]` */
export async function whoamiCommand(
  args: WhoamiArgs,
  io: CliIo,
  deps: WhoamiDeps = {},
): Promise<number> {
  const config = resolveWhoamiConfig(args, deps.env ?? process.env);
  const consumer = args.secret === undefined ? null : deriveConsumerPublicKey(args.secret);
  const store = deps.store ?? fileSessionStore();
  const sessions = await loadSessions(store);

  if (args.json) {
    io.out(
      JSON.stringify(
        {
          network: config.network,
          rpc_url: config.rpcUrl,
          contract_id: config.contractId,
          consumer,
          sessions: sessions === null ? [] : sessionSummaries(sessions),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  io.out('KeyLease configuration');
  io.out(`  network   : ${config.network}`);
  io.out(`  rpc       : ${config.rpcUrl}`);
  io.out(`  contract  : ${config.contractId ?? '(unset: set KEYLEASE_CONTRACT_ID)'}`);
  io.out(`  consumer  : ${consumer ?? '(not supplied: pass --secret)'}`);

  const rows = sessions === null ? [] : sessionSummaries(sessions);
  if (rows.length === 0) {
    io.out('  sessions  : (none stored)');
  } else {
    io.out('  sessions  :');
    for (const row of rows) {
      io.out(`    ${row.service}  lease ${row.lease_id}  expires ${formatExpiry(row.expires_at)}`);
    }
  }
  return 0;
}
