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
import { SorobanClient, type LeaseState } from '../client/soroban.js';
import { parseConsumerSecret, type NetworkArgs } from './lease.js';
import type { CliIo } from '../index.js';

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

export interface SettleDeps {
  createClient?: (args: SettleArgs) => Pick<SorobanClient, 'settle'>;
}

export interface RevokeDeps {
  createClient?: (args: RevokeArgs) => Pick<SorobanClient, 'revoke'>;
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
