import { SorobanClient, type LeaseState } from '../client/soroban.js';
import {
  parseSessionToken,
  verifySessionToken,
  TokenVerificationError,
  type SessionTokenPayload,
} from '../token.js';
import { renderError } from '../error-renderer.js';
import type { CliIo } from '../index.js';
import { redactToken } from '../errors.js';
import type { NetworkArgs } from './lease.js';

export interface StatusArgs extends NetworkArgs {
  lease?: string | undefined;
  token?: string | undefined;
  checkChain?: boolean | undefined;
  json: boolean;
}

export interface LeaseStateProvider {
  getLeaseState(leaseId: string): Promise<LeaseState>;
}

export interface StatusDeps {
  createClient?: (args: StatusArgs) => Pick<SorobanClient, 'getLeaseState'>;
  leaseStateProvider?: LeaseStateProvider;
  now?: () => number;
  networkName?: string | undefined;
  contractId?: string | undefined;
}

interface CheckResult {
  passed: boolean;
  detail: string;
}

interface TokenChainChecks {
  signature: CheckResult;
  expiry: CheckResult;
  lease_active: CheckResult;
  consumer_match: CheckResult;
  quota: CheckResult;
  lease_id_match?: CheckResult;
}

function defaultCreateClient(args: StatusArgs): Pick<SorobanClient, 'getLeaseState'> {
  return SorobanClient.fromEnv({
    KEYLEASE_NETWORK: args.network,
    KEYLEASE_RPC_URL: args.rpc,
    KEYLEASE_CONTRACT_ID: args.contract,
  });
}

function renderTokenChecks(
  payload: SessionTokenPayload | null,
  checks: TokenChainChecks,
  lease: LeaseState | null,
  io: CliIo,
  json: boolean,
): void {
  if (json) {
    io.out(JSON.stringify({ token: payload, checks, lease }, null, 2));
    return;
  }

  io.out('Session token chain check');
  io.out(`  signature      : ${checks.signature.passed ? 'PASS' : 'FAIL'} (${checks.signature.detail})`);
  io.out(`  expiry         : ${checks.expiry.passed ? 'PASS' : 'FAIL'} (${checks.expiry.detail})`);
  if (checks.lease_id_match) {
    io.out(
      `  lease id match : ${checks.lease_id_match.passed ? 'PASS' : 'FAIL'} (${checks.lease_id_match.detail})`,
    );
  }
  io.out(`  lease active   : ${checks.lease_active.passed ? 'PASS' : 'FAIL'} (${checks.lease_active.detail})`);
  io.out(`  consumer match : ${checks.consumer_match.passed ? 'PASS' : 'FAIL'} (${checks.consumer_match.detail})`);
  io.out(`  quota          : ${checks.quota.passed ? 'PASS' : 'FAIL'} (${checks.quota.detail})`);
  if (lease !== null) io.out(`  service        : ${lease.service}`);
}

function failedChainChecks(detail: string): Pick<
  TokenChainChecks,
  'lease_active' | 'consumer_match' | 'quota'
> {
  return {
    lease_active: { passed: false, detail },
    consumer_match: { passed: false, detail },
    quota: { passed: false, detail },
  };
}

async function checkTokenOnChain(
  args: StatusArgs,
  io: CliIo,
  deps: StatusDeps,
): Promise<number> {
  const now = Math.floor((deps.now ?? Date.now)() / 1000);
  let payload: SessionTokenPayload;
  try {
    payload = parseSessionToken(args.token ?? '').payload;
  } catch (error) {
    if (args.json) {
      renderError(error, io, true);
      return 1;
    }
    const detail =
      error instanceof TokenVerificationError ? error.message : String(error);
    const checks: TokenChainChecks = {
      signature: { passed: false, detail: redactToken(detail) },
      expiry: { passed: false, detail: 'cannot evaluate an invalid token' },
      ...failedChainChecks('not checked because the token could not be parsed'),
    };
    renderTokenChecks(null, checks, null, io, args.json);
    return 1;
  }

  let tokenError: TokenVerificationError | null = null;
  try {
    verifySessionToken(args.token ?? '', { now });
  } catch (error) {
    if (!(error instanceof TokenVerificationError)) throw error;
    tokenError = error;
  }

  const signaturePassed =
    tokenError === null ||
    tokenError.code === 'token_expired' ||
    tokenError.code === 'token_not_yet_valid';
  const expiryPassed =
    payload.exp > now && tokenError?.code !== 'token_not_yet_valid';
  const checks: TokenChainChecks = {
    signature: {
      passed: signaturePassed,
      detail: signaturePassed
        ? 'token signature is valid'
        : (tokenError?.message ?? 'token signature is invalid'),
    },
    expiry: {
      passed: expiryPassed,
      detail: expiryPassed
        ? `expires at ${new Date(payload.exp * 1000).toISOString()}`
        : (tokenError?.message ?? 'token has expired'),
    },
    lease_active: { passed: false, detail: 'not checked' },
    consumer_match: { passed: false, detail: 'not checked' },
    quota: { passed: false, detail: 'not checked' },
  };
  if (args.lease !== undefined) {
    checks.lease_id_match = {
      passed: args.lease === payload.lease_id,
      detail: args.lease === payload.lease_id ? 'matches token lease id' : 'does not match token lease id',
    };
  }

  let lease: LeaseState | null = null;
  if (!signaturePassed) {
    Object.assign(
      checks,
      failedChainChecks('not checked because the token signature is invalid'),
    );
  } else {
    try {
      const provider =
        deps.leaseStateProvider ?? deps.createClient?.(args) ?? defaultCreateClient(args);
      lease = await provider.getLeaseState(payload.lease_id);
      const active =
        lease.leaseId === payload.lease_id &&
        lease.active &&
        !lease.settled &&
        lease.expiresAt > now;
      const consumerMatches = lease.consumer === payload.consumer;
      const remaining = lease.callsLimit - lease.callsUsed;
      const quotaAvailable = remaining > 0;
      checks.lease_active = {
        passed: active,
        detail: active
          ? 'lease is active and unexpired'
          : lease.leaseId !== payload.lease_id
            ? `chain returned lease ${lease.leaseId} instead of ${payload.lease_id}`
            : 'lease is inactive, settled, or expired',
      };
      checks.consumer_match = {
        passed: consumerMatches,
        detail: consumerMatches ? 'on-chain consumer matches token' : 'on-chain consumer differs from token',
      };
      checks.quota = {
        passed: quotaAvailable,
        detail: `${Math.max(0, remaining)} calls remaining (${lease.callsUsed}/${lease.callsLimit} used)`,
      };
    } catch (error) {
      const detail = `chain lookup failed: ${error instanceof Error ? error.message : String(error)}`;
      Object.assign(checks, failedChainChecks(detail));
    }
  }

  renderTokenChecks(payload, checks, lease, io, args.json);
  return Object.values(checks).every((check) => check.passed) ? 0 : 1;
}

function renderState(state: LeaseState, io: CliIo, json: boolean): void {
  const pricePerCall = state.pricePaid / state.callsLimit;
  if (json) {
    io.out(JSON.stringify({ ...state, pricePerCall }, null, 2));
    return;
  }
  io.out(`Lease ${state.leaseId}`);
  if (networkName !== undefined) io.out(`  network    : ${networkName}`);
  if (contractId !== undefined) io.out(`  contract   : ${contractId}`);
  io.out(`  service    : ${state.service}`);
  io.out(`  provider   : ${state.provider}`);
  io.out(`  consumer   : ${state.consumer}`);
  io.out(`  calls      : ${state.callsUsed}/${state.callsLimit}`);
  io.out(`  remaining  : ${remainingCalls}`);
  io.out(`  escrow     : ${state.pricePaid} (paid into keylease-core)`);
  io.out(`  price/call : ${pricePerCall}`);
  io.out(`  expires at : ${new Date(state.expiresAt * 1000).toISOString()}${expired ? ' (expired)' : ''}`);
  io.out(`  active     : ${state.active ? 'yes' : 'no'}`);
  io.out(`  settled    : ${state.settled ? 'yes' : 'no'}`);
}

/**
 * `keylease status --lease <id>`        → reads live state from Soroban RPC
 * `keylease status --token <token>`     → verifies a session token offline
 * `keylease status --token <token> --check-chain` → also checks current lease state
 */
export async function statusCommand(
  args: StatusArgs,
  io: CliIo,
  deps: StatusDeps = {},
): Promise<number> {
  const now = deps.now ?? (() => Date.now());

  if (args.token) {
    if (args.checkChain) return checkTokenOnChain(args, io, deps);
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
        if (payload.service !== undefined) io.out(`  service    : ${payload.service}`);
        io.out(`  expires at : ${new Date(payload.exp * 1000).toISOString()} (${expiresIn}s left)`);
      }
      return 0;
    } catch (error) {
      if (error instanceof TokenVerificationError) {
        renderError(error, io, args.json);
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
  
  // Resolve network name and truncated contract id
  const networkName = deps.networkName ?? args.network ?? 'testnet';
  const contractId = deps.contractId ?? args.contract;
  const contractIdTruncated = contractId ? `${contractId.slice(0, 8)}...${contractId.slice(-8)}` : undefined;
  
  renderState(state, io, args.json, networkName, contractIdTruncated);
  return 0;
}
