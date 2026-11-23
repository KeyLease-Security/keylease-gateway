/**
 * `keylease settle` and `keylease revoke` — the consumer side of the lease
 * lifecycle on `keylease-core`.
 *
 * Both entrypoints move real value out of the contract's escrow:
 *
 * * `settle` is permissionless and only succeeds once the lease expired or ran
 *   out of calls. The provider is paid for consumed calls, the consumer is
 *   refunded the remainder.
 * * `revoke` is consumer-authorised and returns the unused calls immediately.
 */
import type { Keypair } from '@stellar/stellar-sdk';
import { ContractCallError, SorobanClient, type LeaseState } from '../client/soroban.js';
import { parseConsumerSecret, type TransactionArgs } from './lease.js';
import type { CliIo } from '../index.js';
import { CliError } from '../errors.js';

export interface SettleArgs extends TransactionArgs {
  lease: string | string[];
  secret: string;
  json: boolean;
}

export interface RevokeArgs extends TransactionArgs {
  lease: string | string[];
  secret: string;
  json: boolean;
}

export interface UseCallArgs extends NetworkArgs {
  lease: string;
  count: number;
  secret: string;
  json: boolean;
}

export interface ReleaseArgs extends NetworkArgs {
  lease: string;
  secret: string;
  json: boolean;
}

export interface SettleDeps {
  createClient?: (args: SettleArgs) => Pick<SorobanClient, 'settle'>;
  readSecretFromStdin?: () => Promise<string>;
}

export interface RevokeDeps {
  createClient?: (args: RevokeArgs) => Pick<SorobanClient, 'revoke'>;
  readSecretFromStdin?: () => Promise<string>;
}

function defaultClient(args: TransactionArgs): SorobanClient {
  return SorobanClient.fromEnv({
    KEYLEASE_NETWORK: args.network,
    KEYLEASE_RPC_URL: args.rpc,
    KEYLEASE_CONTRACT_ID: args.contract,
  }, undefined, { fee: args.fee, timeout: args.timeout });
}

export function renderLeaseOutcome(
  action: 'settled' | 'revoked',
  lease: LeaseState,
  io: CliIo,
  json: boolean,
): void {
  if (json) {
    io.out(JSON.stringify({ action, ...lease }, null, 2));
    return;
  }
  const paidOut =
    lease.callsLimit === 0
      ? 0
      : Math.floor((lease.pricePaid * lease.callsUsed) / lease.callsLimit);
  const refunded = lease.pricePaid - paidOut;
  io.out(`Lease ${lease.leaseId} ${action}`);
  io.out(`  service     : ${lease.service}`);
  io.out(`  consumer    : ${lease.consumer}`);
  io.out(`  provider    : ${lease.provider}`);
  io.out(`  calls used  : ${lease.callsUsed}/${lease.callsLimit}`);
  io.out(`  paid out    : ${paidOut} (to provider)`);
  io.out(`  refunded    : ${refunded} (to consumer)`);
}

type LeaseResult =
  | { leaseId: string; status: 'settled'; lease: LeaseState }
  | { leaseId: string; status: 'revoked'; lease: LeaseState }
  | { leaseId: string; status: 'already_settled'; message: string }
  | { leaseId: string; status: 'failed'; error: string };

function normalizeLeaseIds(leases: string | string[]): string[] {
  const values = Array.isArray(leases) ? leases : [leases];
  const ids = values.flatMap((value) => value.split(',').map((id) => id.trim()));
  if (ids.length === 0 || ids.some((id) => id.length === 0)) {
    throw new Error('--lease must contain at least one non-empty lease ID');
  }
  return [...new Set(ids)];
}

function payoutSplit(lease: LeaseState): { paidOut: number; refunded: number } {
  const paidOut =
    lease.callsLimit === 0
      ? 0
      : Math.floor((lease.pricePaid * lease.callsUsed) / lease.callsLimit);
  return { paidOut, refunded: lease.pricePaid - paidOut };
}

function renderBatchResults(results: LeaseResult[], io: CliIo, json: boolean): void {
  if (json) {
    io.out(JSON.stringify(results, null, 2));
    return;
  }

  const headers = ['LEASE ID', 'STATUS', 'PAID OUT', 'REFUNDED', 'DETAIL'];
  const rows = results.map((result) => {
    if (result.status === 'settled' || result.status === 'revoked') {
      const { paidOut, refunded } = payoutSplit(result.lease);
      return [result.leaseId, result.status, String(paidOut), String(refunded), result.lease.service];
    }
    if (result.status === 'already_settled') {
      return [result.leaseId, result.status, '-', '-', result.message];
    }
    return [result.leaseId, result.status, '-', '-', result.error];
  });
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const render = (cells: string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd();

  io.out(render(headers));
  for (const row of rows) io.out(render(row));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runLifecycleBatch(
  action: 'settled' | 'revoked',
  args: SettleArgs | RevokeArgs,
  leaseIds: string[],
  signer: Keypair,
  io: CliIo,
  invoke: (leaseId: string, signer: Keypair) => Promise<LeaseState>,
): Promise<number> {
  const results: LeaseResult[] = [];

  for (const leaseId of leaseIds) {
    try {
      const lease = await invoke(leaseId, signer);
      results.push({ leaseId, status: action, lease });
    } catch (error) {
      if (error instanceof ContractCallError && error.code === 9) {
        results.push({
          leaseId,
          status: 'already_settled',
          message: error.message,
        });
      } else {
        results.push({ leaseId, status: 'failed', error: errorText(error) });
      }
    }
  }

  renderBatchResults(results, io, args.json);
  return results.some((result) => result.status === 'failed') ? 1 : 0;
}

/** `keylease settle --lease <id>[,<id>...] --secret <key>` */
export async function settleCommand(
  args: SettleArgs,
  io: CliIo,
  deps: SettleDeps = {},
): Promise<number> {
  const leaseIds = normalizeLeaseIds(args.lease);
  const signer = parseConsumerSecret(args.secret);
  const client = deps.createClient ? deps.createClient(args) : defaultClient(args);
  return runLifecycleBatch('settled', args, leaseIds, signer, io, (leaseId, signer) =>
    client.settle(leaseId, signer),
  );
}

/** `keylease revoke --lease <id>[,<id>...] --secret <key>` */
export async function revokeCommand(
  args: RevokeArgs,
  io: CliIo,
  deps: RevokeDeps = {},
): Promise<number> {
  const leaseIds = normalizeLeaseIds(args.lease);
  const signer = parseConsumerSecret(args.secret);
  const client = deps.createClient ? deps.createClient(args) : defaultClient(args);
  return runLifecycleBatch('revoked', args, leaseIds, signer, io, (leaseId, signer) =>
    client.revoke(leaseId, signer),
  );
}

/** `keylease release --lease <id> --secret <key>` */
export async function releaseCommand(
  args: ReleaseArgs,
  io: CliIo,
  deps: ReleaseDeps = {},
): Promise<number> {
  let signer: Keypair;
  try {
    signer = parseConsumerSecret(args.secret);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('auth failure: invalid consumer secret', 'auth_failure');
  }
  const client = deps.createClient ? deps.createClient(args) : defaultClient(args);
  try {
    const result = await client.release(args.lease, signer);
    if (args.json) {
      io.out(
        JSON.stringify(
          { leaseId: result.leaseId, refunded: result.refunded, txHash: result.txHash },
          null,
          2,
        ),
      );
      return 0;
    }
    io.out(`Lease ${result.leaseId} released`);
    io.out(`  refunded : ${result.refunded}`);
    io.out(`  txHash   : ${result.txHash}`);
    return 0;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (
      error instanceof LeaseNotFoundError ||
      (error instanceof ContractCallError && error.code === 5)
    ) {
      throw new CliError(`lease ${args.lease} was not found on chain`, 'lease_not_found');
    }
    if (error instanceof ContractCallError) {
      if (error.code === 8) {
        throw new CliError(`lease ${args.lease} has not expired yet`, 'lease_not_expired');
      }
      if (error.code === 14) {
        throw new CliError(
          'auth failure: consumer signature did not match lease consumer',
          'auth_failure',
        );
      }
    }
    const msg = error instanceof Error ? error.message : String(error);
    if (
      msg.includes('not expired') ||
      msg.includes('LeaseNotSettleable') ||
      msg.includes('Error(8)')
    ) {
      throw new CliError(`lease ${args.lease} has not expired yet`, 'lease_not_expired');
    }
    if (msg.includes('not found') || msg.includes('Error(5)')) {
      throw new CliError(`lease ${args.lease} was not found on chain`, 'lease_not_found');
    }
    if (msg.includes('auth') || msg.includes('unauthorized') || msg.includes('Error(14)')) {
      throw new CliError('auth failure: consumer authorization failed', 'auth_failure');
    }
    throw error;
  }
}
