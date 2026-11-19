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
import {
  SorobanClient,
  type LeaseState,
  LeaseNotFoundError,
  ContractCallError,
} from '../client/soroban.js';
import { parseConsumerSecret, type NetworkArgs } from './lease.js';
import type { CliIo } from '../index.js';
import { CliError } from '../errors.js';

export interface SettleArgs extends NetworkArgs {
  lease: string;
  secret: string;
  json: boolean;
}

export interface RevokeArgs extends NetworkArgs {
  lease: string;
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
}

export interface RevokeDeps {
  createClient?: (args: RevokeArgs) => Pick<SorobanClient, 'revoke'>;
}

export interface ReleaseDeps {
  createClient?: (args: ReleaseArgs) => Pick<SorobanClient, 'release'>;
}

function defaultClient(args: NetworkArgs): SorobanClient {
  return SorobanClient.fromEnv({
    KEYLEASE_NETWORK: args.network,
    KEYLEASE_RPC_URL: args.rpc,
    KEYLEASE_CONTRACT_ID: args.contract,
  });
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

/** `keylease settle --lease <id> --secret <key>` */
export async function settleCommand(
  args: SettleArgs,
  io: CliIo,
  deps: SettleDeps = {},
): Promise<number> {
  const signer: Keypair = parseConsumerSecret(args.secret);
  const client = deps.createClient ? deps.createClient(args) : defaultClient(args);
  const lease = await client.settle(args.lease, signer);
  renderLeaseOutcome('settled', lease, io, args.json);
  return 0;
}

/** `keylease revoke --lease <id> --secret <key>` */
export async function revokeCommand(
  args: RevokeArgs,
  io: CliIo,
  deps: RevokeDeps = {},
): Promise<number> {
  const signer: Keypair = parseConsumerSecret(args.secret);
  const client = deps.createClient ? deps.createClient(args) : defaultClient(args);
  const lease = await client.revoke(args.lease, signer);
  renderLeaseOutcome('revoked', lease, io, args.json);
  return 0;
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
