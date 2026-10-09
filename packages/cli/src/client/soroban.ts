import type { Keypair } from '@stellar/stellar-sdk';
import {
  type Account,
  type Transaction,
  Address,
  BASE_FEE,
  Contract,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

/**
 * Thin wrapper around the `keylease-core` Soroban contract.
 *
 * The interface is deliberately narrow ({@link SorobanRpc}) so that unit tests
 * can substitute a fake RPC layer without touching the network.
 *
 * ## Contract schema
 *
 * `create_lease(service: string, calls: u32, duration: u32, consumer: Address) -> string`
 *
 * The returned lease is stored under the persistent storage key
 * `Vec[Symbol("lease"), String(lease_id)]` as a map:
 *
 * ```
 * {
 *   service:     String,
 *   consumer:    Address,
 *   calls_limit: U32,
 *   calls_used:  U32,
 *   expires_at:  U64,   // unix seconds
 *   active:      Bool,
 * }
 * ```
 */
export const KEYLEASE_CORE_CONTRACT = 'keylease-core';

/** Transaction polling defaults for `create_lease` confirmation. */
const DEFAULT_TX_POLL_ATTEMPTS = 30;
const DEFAULT_TX_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TX_TIMEOUT_SECONDS = 60;

export interface NetworkConfig {
  name: string;
  rpcUrl: string;
  networkPassphrase: string;
}

export const NETWORKS: Record<string, NetworkConfig> = {
  testnet: {
    name: 'testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
  mainnet: {
    name: 'mainnet',
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
  },
  local: {
    name: 'local',
    rpcUrl: 'http://localhost:8000/soroban/rpc',
    networkPassphrase: 'Standalone Network ; February 2017',
  },
};

/** On-chain view of a lease, as returned by `keylease-core`. */
export interface LeaseState {
  leaseId: string;
  service: string;
  consumer: string;
  callsLimit: number;
  callsUsed: number;
  /** Lease expiry in unix seconds. */
  expiresAt: number;
  active: boolean;
}

export interface CreateLeaseParams {
  service: string;
  calls: number;
  duration: number;
  /** Keypair that owns the lease; also signs the session bearer token. */
  consumer: Keypair;
}

export interface CreateLeaseResult {
  leaseId: string;
  txHash: string;
}

/**
 * The subset of `rpc.Server` this client relies on. `rpc.Server` satisfies it
 * structurally, and tests can supply any object with the same shape.
 */
export interface SorobanRpc {
  getAccount(address: string): Promise<Account>;
  prepareTransaction(tx: Transaction): Promise<Transaction>;
  sendTransaction(tx: Transaction): Promise<rpc.Api.SendTransactionResponse>;
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
  getContractData(
    contract: string,
    key: xdr.ScVal,
    durability?: rpc.Durability,
  ): Promise<rpc.Api.LedgerEntryResult>;
}

export class SorobanError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SorobanError';
    this.cause = cause;
  }
}

export class LeaseNotFoundError extends SorobanError {
  readonly leaseId: string;

  constructor(leaseId: string) {
    super(`lease ${leaseId} was not found on chain`);
    this.name = 'LeaseNotFoundError';
    this.leaseId = leaseId;
  }
}

export interface SorobanClientOptions {
  server: SorobanRpc;
  contractId: string;
  networkPassphrase: string;
  txPollAttempts?: number;
  txPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ClientEnv {
  KEYLEASE_NETWORK?: string | undefined;
  KEYLEASE_RPC_URL?: string | undefined;
  KEYLEASE_CONTRACT_ID?: string | undefined;
  KEYLEASE_CONTRACT?: string | undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds the persistent storage key under which a lease entry lives. */
export function leaseStorageKey(leaseId: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('lease'), xdr.ScVal.scvString(leaseId)]);
}

function requireFiniteNumber(value: unknown, field: string): number {
  let result: number;
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new SorobanError(`lease field ${field} overflows a safe integer: ${value.toString()}`);
    }
    result = Number(value);
  } else if (typeof value === 'number') {
    result = value;
  } else {
    throw new SorobanError(`lease field ${field} has unexpected type ${typeof value}`);
  }
  if (!Number.isFinite(result)) {
    throw new SorobanError(`lease field ${field} is not finite`);
  }
  return result;
}

/** Parses the contract's lease map into a {@link LeaseState}. */
export function parseLeaseState(value: xdr.ScVal, leaseId: string): LeaseState {
  if (value.switch().name !== 'scvMap') {
    throw new SorobanError(
      `lease ${leaseId}: expected scvMap, got ${value.switch().name}`,
    );
  }
  const raw = scValToNative(value) as Record<string, unknown>;

  const service = raw['service'];
  const consumer = raw['consumer'];
  const active = raw['active'];

  if (typeof service !== 'string') {
    throw new SorobanError(`lease ${leaseId}: field "service" must be a string`);
  }
  if (typeof consumer !== 'string' || !StrKey.isValidEd25519PublicKey(consumer)) {
    throw new SorobanError(`lease ${leaseId}: field "consumer" must be a Stellar public key`);
  }

  return {
    leaseId,
    service,
    consumer,
    callsLimit: requireFiniteNumber(raw['calls_limit'], 'calls_limit'),
    callsUsed: raw['calls_used'] === undefined ? 0 : requireFiniteNumber(raw['calls_used'], 'calls_used'),
    expiresAt: requireFiniteNumber(raw['expires_at'], 'expires_at'),
    active: active === undefined ? true : Boolean(active),
  };
}

/** Serialises a {@link LeaseState} into the contract's storage representation. */
export function encodeLeaseState(state: LeaseState): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('service'),
      val: nativeToScVal(state.service, { type: 'string' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('consumer'),
      val: nativeToScVal(Address.fromString(state.consumer), { type: 'address' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('calls_limit'),
      val: nativeToScVal(state.callsLimit, { type: 'u32' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('calls_used'),
      val: nativeToScVal(state.callsUsed, { type: 'u32' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('expires_at'),
      val: nativeToScVal(BigInt(state.expiresAt), { type: 'u64' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('active'),
      val: nativeToScVal(state.active, { type: 'bool' }),
    }),
  ]);
}

export class SorobanClient {
  private readonly server: SorobanRpc;
  private readonly contractId: string;
  private readonly networkPassphrase: string;
  private readonly txPollAttempts: number;
  private readonly txPollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: SorobanClientOptions) {
    this.server = options.server;
    this.contractId = options.contractId;
    this.networkPassphrase = options.networkPassphrase;
    this.txPollAttempts = options.txPollAttempts ?? DEFAULT_TX_POLL_ATTEMPTS;
    this.txPollIntervalMs = options.txPollIntervalMs ?? DEFAULT_TX_POLL_INTERVAL_MS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Builds a client from environment configuration:
   * `KEYLEASE_NETWORK` (testnet|mainnet|local), `KEYLEASE_RPC_URL`,
   * `KEYLEASE_CONTRACT_ID`.
   */
  static fromEnv(env: ClientEnv = process.env, serverFactory: (url: string) => SorobanRpc = createRpcServer): SorobanClient {
    const networkName = env.KEYLEASE_NETWORK ?? 'testnet';
    const network = NETWORKS[networkName];
    if (!network) {
      throw new SorobanError(
        `unknown KEYLEASE_NETWORK "${networkName}" (expected one of: ${Object.keys(NETWORKS).join(', ')})`,
      );
    }
    const rpcUrl = env.KEYLEASE_RPC_URL ?? network.rpcUrl;
    const contractId = env.KEYLEASE_CONTRACT_ID ?? env.KEYLEASE_CONTRACT;
    if (!contractId) {
      throw new SorobanError(
        'KEYLEASE_CONTRACT_ID is not set: deploy keylease-core and point this variable at its contract id',
      );
    }
    if (!StrKey.isValidContract(contractId)) {
      throw new SorobanError(`KEYLEASE_CONTRACT_ID "${contractId}" is not a valid contract address`);
    }

    return new SorobanClient({
      server: serverFactory(rpcUrl),
      contractId,
      networkPassphrase: network.networkPassphrase,
    });
  }

  /** Invokes `create_lease` and waits for the transaction to be included. */
  async createLease(params: CreateLeaseParams): Promise<CreateLeaseResult> {
    validateLeaseParams(params);

    const contract = new Contract(this.contractId);
    const operation = contract.call(
      'create_lease',
      nativeToScVal(params.service, { type: 'string' }),
      nativeToScVal(params.calls, { type: 'u32' }),
      nativeToScVal(params.duration, { type: 'u32' }),
      nativeToScVal(Address.fromString(params.consumer.publicKey()), { type: 'address' }),
    );

    const account = await this.server.getAccount(params.consumer.publicKey());
    const builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    });
    const transaction = builder
      .addOperation(operation)
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS)
      .build();

    const prepared = await this.server.prepareTransaction(transaction);
    prepared.sign(params.consumer);

    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === 'ERROR') {
      throw new SorobanError(
        `create_lease was rejected by the RPC (${sent.hash}): ${sent.errorResult?.result().switch().name ?? 'unknown error'}`,
      );
    }

    const confirmed = await this.awaitTransaction(sent.hash);
    if (confirmed.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new SorobanError(`create_lease transaction ${sent.hash} failed with status ${confirmed.status}`);
    }

    const leaseId = extractLeaseId(confirmed.returnValue, sent.hash);
    return { leaseId, txHash: sent.hash };
  }

  /** Reads a lease's current state from contract storage. */
  async getLeaseState(leaseId: string): Promise<LeaseState> {
    let entry: rpc.Api.LedgerEntryResult;
    try {
      entry = await this.server.getContractData(
        this.contractId,
        leaseStorageKey(leaseId),
        rpc.Durability.Persistent,
      );
    } catch (error) {
      if (isNotFoundResponse(error)) {
        throw new LeaseNotFoundError(leaseId);
      }
      throw new SorobanError(`failed to read lease ${leaseId} from Soroban RPC`, error);
    }

    return parseLeaseState(entry.val.contractData().val(), leaseId);
  }

  private async awaitTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    let lastStatus: string = 'NOT_FOUND';
    for (let attempt = 0; attempt < this.txPollAttempts; attempt += 1) {
      const result = await this.server.getTransaction(hash);
      lastStatus = result.status;
      if (
        result.status === rpc.Api.GetTransactionStatus.SUCCESS ||
        result.status === rpc.Api.GetTransactionStatus.FAILED
      ) {
        return result;
      }
      if (attempt < this.txPollAttempts - 1) {
        await this.sleep(this.txPollIntervalMs);
      }
    }
    throw new SorobanError(`timed out waiting for transaction ${hash} (last status: ${lastStatus})`);
  }
}

function validateLeaseParams(params: CreateLeaseParams): void {
  if (!params.service || params.service.trim().length === 0) {
    throw new SorobanError('service id must not be empty');
  }
  if (!Number.isInteger(params.calls) || params.calls <= 0) {
    throw new SorobanError(`calls must be a positive integer, got ${params.calls}`);
  }
  if (!Number.isInteger(params.duration) || params.duration <= 0) {
    throw new SorobanError(`duration must be a positive integer, got ${params.duration}`);
  }
}

function extractLeaseId(returnValue: xdr.ScVal | undefined, txHash: string): string {
  if (returnValue && returnValue.switch().name === 'scvString') {
    const leaseId = scValToNative(returnValue) as string;
    if (leaseId.length > 0) {
      return leaseId;
    }
  }
  throw new SorobanError(
    `create_lease transaction ${txHash} succeeded but returned no lease id`,
  );
}

function isNotFoundResponse(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 404;
}

function createRpcServer(url: string): SorobanRpc {
  return new rpc.Server(url, { allowHttp: url.startsWith('http://') }) as unknown as SorobanRpc;
}
