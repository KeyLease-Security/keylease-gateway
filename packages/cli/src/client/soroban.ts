import type { Keypair } from '@stellar/stellar-sdk';
import {
  Account,
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
 * Client for the `keylease-core` Soroban contract that lives in
 * [`contracts/keylease-core`](../../../contracts/keylease-core/src/lib.rs).
 *
 * The interface is deliberately narrow ({@link SorobanRpc}) so unit tests can
 * substitute a fake RPC layer without touching the network.
 *
 * ## Contract schema
 *
 * ```text
 * init(admin, token, gateway)
 * register_service(provider, service, price_per_call) -> Service
 * quote(service, calls)                              -> i128
 * create_lease(consumer, service, calls, duration)   -> u64   (pulls escrow)
 * use_call(lease_id, count)                          -> Lease (gateway only)
 * revoke(lease_id)                                   -> Lease (consumer only)
 * settle(lease_id)                                   -> Lease (permissionless)
 * get_lease(lease_id) -> Lease
 * get_service(service) -> Service
 * remaining_calls(lease_id) -> u32
 * ```
 *
 * Leases are prepaid: `create_lease` transfers `calls * price_per_call` of the
 * configured SAC token from the consumer into contract escrow. Settlement pays
 * the provider for consumed calls and refunds the remainder.
 */
export const KEYLEASE_CORE_CONTRACT = 'keylease-core';

/** Transaction polling defaults for contract invocations. */
const DEFAULT_TX_POLL_ATTEMPTS = 30;
const DEFAULT_TX_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TX_TIMEOUT_SECONDS = 60;

/**
 * Simulation-only source account. Read calls do not require a funded account,
 * and reusing a constant keeps `get_lease` free of `getAccount` round trips.
 */
const SIMULATION_SOURCE = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));

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
  /** Decimal string of the contract's `u64` lease id. */
  leaseId: string;
  service: string;
  provider: string;
  consumer: string;
  callsLimit: number;
  callsUsed: number;
  /** Lease expiry in unix seconds. */
  expiresAt: number;
  active: boolean;
  /** True once the escrow was paid out (settled or revoked). */
  settled: boolean;
  /** Escrowed amount in token smallest units (stroops for the native SAC). */
  pricePaid: number;
}

/** On-chain view of a registered service. */
export interface ServiceState {
  service: string;
  provider: string;
  pricePerCall: number;
  active: boolean;
}

export interface CreateLeaseParams {
  service: string;
  calls: number;
  duration: number;
  /** Keypair that pays for and owns the lease; also signs the session token. */
  consumer: Keypair;
}

export interface CreateLeaseResult {
  /** Decimal string of the on-chain lease id. */
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
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
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

/** Raised when the contract itself traps with one of its `Error` variants. */
export class ContractCallError extends SorobanError {
  readonly code: number | null;
  readonly method: string;

  constructor(method: string, code: number | null, detail: string) {
    super(`keylease-core.${method} failed${code === null ? '' : ` with Error(${code})`}: ${detail}`);
    this.name = 'ContractCallError';
    this.method = method;
    this.code = code;
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

function requireAddress(value: unknown, field: string): string {
  if (typeof value !== 'string' || !StrKey.isValidEd25519PublicKey(value)) {
    throw new SorobanError(`lease field ${field} must be a Stellar account address`);
  }
  return value;
}

/** Parses the contract's `Lease` struct into a {@link LeaseState}. */
export function parseLeaseState(value: xdr.ScVal, leaseId: string): LeaseState {
  if (value.type !== 'scvMap') {
    throw new SorobanError(`lease ${leaseId}: expected scvMap, got ${value.type}`);
  }
  const raw = scValToNative(value) as Record<string, unknown>;
  const service = raw['service'];
  if (typeof service !== 'string') {
    throw new SorobanError(`lease ${leaseId}: field "service" must be a string`);
  }

  return {
    leaseId,
    service,
    provider: requireAddress(raw['provider'], 'provider'),
    consumer: requireAddress(raw['consumer'], 'consumer'),
    callsLimit: requireFiniteNumber(raw['calls_limit'], 'calls_limit'),
    callsUsed: requireFiniteNumber(raw['calls_used'], 'calls_used'),
    expiresAt: requireFiniteNumber(raw['expires_at'], 'expires_at'),
    active: Boolean(raw['active']),
    settled: raw['settled'] === undefined ? false : Boolean(raw['settled']),
    pricePaid: raw['price_paid'] === undefined ? 0 : requireFiniteNumber(raw['price_paid'], 'price_paid'),
  };
}

/** Parses the contract's `Service` struct into a {@link ServiceState}. */
export function parseServiceState(value: xdr.ScVal): ServiceState {
  const raw = scValToNative(value) as Record<string, unknown>;
  const service = raw['service'];
  if (typeof service !== 'string') {
    throw new SorobanError('service field "service" must be a string');
  }
  return {
    service,
    provider: requireAddress(raw['provider'], 'provider'),
    pricePerCall: requireFiniteNumber(raw['price_per_call'], 'price_per_call'),
    active: Boolean(raw['active']),
  };
}

/** Serialises a {@link LeaseState} back into the contract's struct layout. */
export function encodeLeaseState(state: LeaseState): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('id'),
      val: nativeToScVal(BigInt(state.leaseId), { type: 'u64' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('service'),
      val: nativeToScVal(state.service, { type: 'string' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('provider'),
      val: nativeToScVal(Address.fromString(state.provider), { type: 'address' }),
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
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('settled'),
      val: nativeToScVal(state.settled, { type: 'bool' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('price_paid'),
      val: nativeToScVal(BigInt(state.pricePaid), { type: 'i128' }),
    }),
  ]);
}

/** Validates the decimal `u64` lease id used on chain and in bearer tokens. */
export function parseLeaseId(leaseId: string): bigint {
  if (!/^[0-9]+$/.test(leaseId)) {
    throw new SorobanError(`lease id "${leaseId}" must be a decimal u64`);
  }
  const value = BigInt(leaseId);
  if (value <= 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new SorobanError(`lease id "${leaseId}" is out of the u64 range`);
  }
  return value;
}

function contractErrorCode(detail: string): number | null {
  const match = /Error\(Contract, #(\d+)\)/.exec(detail);
  return match?.[1] === undefined ? null : Number(match[1]);
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
  static fromEnv(
    env: ClientEnv = process.env,
    serverFactory: (url: string) => SorobanRpc = createRpcServer,
  ): SorobanClient {
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

  /**
   * Prepays a lease: transfers `calls * price_per_call` from the consumer into
   * contract escrow and waits for the transaction to be included.
   */
  async createLease(params: CreateLeaseParams): Promise<CreateLeaseResult> {
    validateLeaseParams(params);

    const { txHash, returnValue } = await this.invoke({
      signer: params.consumer,
      method: 'create_lease',
      args: [
        nativeToScVal(Address.fromString(params.consumer.publicKey()), { type: 'address' }),
        nativeToScVal(params.service, { type: 'string' }),
        nativeToScVal(params.calls, { type: 'u32' }),
        nativeToScVal(BigInt(params.duration), { type: 'u64' }),
      ],
    });

    if (returnValue === undefined || returnValue.type !== 'scvU64') {
      throw new SorobanError('create_lease succeeded but returned no lease id');
    }
    return { leaseId: String(scValToNative(returnValue)), txHash };
  }

  /** Commits served calls on chain. Only the registered gateway can do this. */
  async useCalls(leaseId: string, count: number, gateway: Keypair): Promise<LeaseState> {
    if (!Number.isInteger(count) || count <= 0) {
      throw new SorobanError(`call count must be a positive integer, got ${count}`);
    }
    const id = parseLeaseId(leaseId);
    const { returnValue } = await this.invoke({
      signer: gateway,
      method: 'use_call',
      args: [nativeToScVal(id, { type: 'u64' }), nativeToScVal(count, { type: 'u32' })],
    });
    if (!returnValue) throw new SorobanError('use_call returned no lease');
    return parseLeaseState(returnValue, leaseId);
  }

  /**
   * Settles an expired or exhausted lease: the provider is paid for consumed
   * calls and the consumer is refunded the rest. Permissionless on chain, so
   * any funded account can submit it.
   */
  async settle(leaseId: string, signer: Keypair): Promise<LeaseState> {
    const id = parseLeaseId(leaseId);
    const { returnValue } = await this.invoke({
      signer,
      method: 'settle',
      args: [nativeToScVal(id, { type: 'u64' })],
    });
    if (!returnValue) throw new SorobanError('settle returned no lease');
    return parseLeaseState(returnValue, leaseId);
  }

  /** Consumer exit: refunds unused calls immediately and closes the lease. */
  async revoke(leaseId: string, consumer: Keypair): Promise<LeaseState> {
    const id = parseLeaseId(leaseId);
    const { returnValue } = await this.invoke({
      signer: consumer,
      method: 'revoke',
      args: [nativeToScVal(id, { type: 'u64' })],
    });
    if (!returnValue) throw new SorobanError('revoke returned no lease');
    return parseLeaseState(returnValue, leaseId);
  }

  /** Provider-side service registration / price update. */
  async registerService(
    provider: Keypair,
    service: string,
    pricePerCall: number,
  ): Promise<ServiceState> {
    if (!Number.isSafeInteger(pricePerCall) || pricePerCall <= 0) {
      throw new SorobanError(`price per call must be a positive integer, got ${pricePerCall}`);
    }
    const { returnValue } = await this.invoke({
      signer: provider,
      method: 'register_service',
      args: [
        nativeToScVal(Address.fromString(provider.publicKey()), { type: 'address' }),
        nativeToScVal(service, { type: 'string' }),
        nativeToScVal(BigInt(pricePerCall), { type: 'i128' }),
      ],
    });
    if (!returnValue) throw new SorobanError('register_service returned no service');
    return parseServiceState(returnValue);
  }

  /** Reads a lease's current state by simulating `get_lease`. */
  async getLeaseState(leaseId: string): Promise<LeaseState> {
    const id = parseLeaseId(leaseId);
    try {
      const retval = await this.simulate('get_lease', [nativeToScVal(id, { type: 'u64' })]);
      return parseLeaseState(retval, leaseId);
    } catch (error) {
      if (error instanceof ContractCallError && error.code === 5) {
        throw new LeaseNotFoundError(leaseId);
      }
      throw error;
    }
  }

  /** Reads a registered service by simulating `get_service`. */
  async getService(service: string): Promise<ServiceState> {
    const retval = await this.simulate('get_service', [
      nativeToScVal(service, { type: 'string' }),
    ]);
    return parseServiceState(retval);
  }

  /** Price of `calls` calls on `service`, in token smallest units. */
  async quote(service: string, calls: number): Promise<number> {
    if (!Number.isInteger(calls) || calls <= 0) {
      throw new SorobanError(`calls must be a positive integer, got ${calls}`);
    }
    const retval = await this.simulate('quote', [
      nativeToScVal(service, { type: 'string' }),
      nativeToScVal(calls, { type: 'u32' }),
    ]);
    return requireFiniteNumber(scValToNative(retval), 'quote');
  }

  /** Runs a read-only contract method through `simulateTransaction`. */
  private async simulate(method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
    const transaction = this.build(method, args, SIMULATION_SOURCE, '0');
    const simulation = await this.server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulation)) {
      const code = contractErrorCode(simulation.error);
      throw new ContractCallError(method, code, simulation.error);
    }
    const retval = simulation.result?.retval;
    if (retval === undefined) {
      throw new SorobanError(`${method} simulation returned no value`);
    }
    return retval;
  }

  /** Submits a signed contract invocation and waits for it to be included. */
  private async invoke(params: {
    signer: Keypair;
    method: string;
    args: xdr.ScVal[];
  }): Promise<{ txHash: string; returnValue: xdr.ScVal | undefined }> {
    const account = await this.server.getAccount(params.signer.publicKey());
    const transaction = this.build(params.method, params.args, account.accountId(), account.sequenceNumber());

    const prepared = await this.server.prepareTransaction(transaction);
    prepared.sign(params.signer);

    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === 'ERROR') {
      const detail = transactionResultName(sent.errorResult?.result);
      throw new SorobanError(`${params.method} was rejected by the RPC (${sent.hash}): ${detail}`);
    }

    const confirmed = await this.awaitTransaction(sent.hash);
    if (confirmed.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new ContractCallError(
        params.method,
        contractErrorCode(JSON.stringify(confirmed)),
        `${params.method} transaction ${sent.hash} failed (${confirmed.status})`,
      );
    }
    return { txHash: sent.hash, returnValue: confirmed.returnValue };
  }

  private build(
    method: string,
    args: xdr.ScVal[],
    source: string,
    sequence: string,
  ): Transaction {
    const operation = new Contract(this.contractId).call(method, ...args);
    const account = new Account(source, sequence);
    return new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS)
      .build();
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

/** Best-effort human name for a rejected transaction's result code. */
function transactionResultName(result: unknown): string {
  if (typeof result === 'object' && result !== null) {
    const type = (result as { type?: unknown }).type;
    if (typeof type === 'string') return type;
    const name = (result as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return 'unknown error';
}

function createRpcServer(url: string): SorobanRpc {
  return new rpc.Server(url, { allowHttp: url.startsWith('http://') }) as unknown as SorobanRpc;
}
