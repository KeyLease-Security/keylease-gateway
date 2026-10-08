import { SorobanClient, type LeaseState } from '../client/soroban.js';
import { verifySessionToken, TokenVerificationError } from '../token.js';
import type { CliIo } from '../index.js';
import type { NetworkArgs } from './lease.js';

export interface StatusArgs extends NetworkArgs {
  lease?: string | undefined;
  token?: string | undefined;
  json: boolean;
}

export interface StatusDeps {
  createClient?: (args: StatusArgs) => Pick<SorobanClient, 'getLeaseState'>;
  now?: () => number;
}

function defaultCreateClient(args: StatusArgs): Pick<SorobanClient, 'getLeaseState'> {
  return SorobanClient.fromEnv({
    KEYLEASE_NETWORK: args.network,
    KEYLEASE_RPC_URL: args.rpc,
    KEYLEASE_CONTRACT_ID: args.contract,
  });
}

function renderState(state: LeaseState, io: CliIo, json: boolean): void {
  if (json) {
    io.out(JSON.stringify(state, null, 2));
    return;
  }
  const expired = state.expiresAt <= Math.floor(Date.now() / 1000);
  io.out(`Lease ${state.leaseId}`);
  io.out(`  service    : ${state.service}`);
  io.out(`  consumer   : ${state.consumer}`);
  io.out(`  calls      : ${state.callsUsed}/${state.callsLimit}`);
  io.out(`  expires at : ${new Date(state.expiresAt * 1000).toISOString()}${expired ? ' (expired)' : ''}`);
  io.out(`  active     : ${state.active ? 'yes' : 'no'}`);
}

/**
 * `keylease status --lease <id>`        → reads live state over Soroban RPC
 * `keylease status --token <token>`     → verifies a session token offline
 */
export async function statusCommand(
  args: StatusArgs,
  io: CliIo,
  deps: StatusDeps = {},
): Promise<number> {
  const now = deps.now ?? (() => Date.now());

  if (args.token) {
    try {
      const payload = verifySessionToken(args.token, {
        now: Math.floor(now() / 1000),
        expectedLeaseId: args.lease,
      });
      const expiresIn = payload.exp - Math.floor(now() / 1000);
      if (args.json) {
        io.out(JSON.stringify(payload, null, 2));
      } else {
        io.out('Session token is valid');
        io.out(`  lease id   : ${payload.lease_id}`);
        io.out(`  consumer   : ${payload.consumer}`);
        io.out(`  expires at : ${new Date(payload.exp * 1000).toISOString()} (${expiresIn}s left)`);
      }
      return 0;
    } catch (error) {
      if (error instanceof TokenVerificationError) {
        io.err(`token verification failed (${error.code}): ${error.message}`);
        return 1;
      }
      throw error;
    }
  }

  if (!args.lease) {
    io.err('status requires either --lease <id> or --token <session-token>');
    return 2;
  }

  const createClient = deps.createClient ?? defaultCreateClient;
  const state = await createClient(args).getLeaseState(args.lease);
  renderState(state, io, args.json);
  return 0;
}
