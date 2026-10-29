#!/usr/bin/env node
/**
 * Deploys `keylease-core` to Stellar testnet, initialises it, registers a
 * priced service and prepays a demo lease — all through Soroban RPC.
 *
 *   node packages/cli/scripts/deploy-testnet.mjs [--wasm <path>] [--service weather-api]
 *                                   [--price 1000] [--calls 25] [--duration 86400]
 *
 * Outputs:
 *   deployments.json                  public record (committed)
 *   .keylease/testnet-accounts.json   secret seeds for the demo roles (git-ignored)
 *
 * No stellar-cli or Rust is needed at deploy time: the contract is uploaded and
 * created with plain Soroban operations built by @stellar/stellar-sdk.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

/** Repo root: this file lives in packages/cli/scripts/. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const NETWORKS = {
  testnet: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
    friendbot: 'https://friendbot.stellar.org',
  },
};

const args = parseArgs(process.argv.slice(2));
const networkName = args.network ?? 'testnet';
const network = NETWORKS[networkName];
if (!network) throw new Error(`unknown --network "${networkName}"`);

const rpcUrl = args.rpc ?? network.rpcUrl;
const wasmPath = resolve(
  repoRoot,
  args.wasm ?? 'contracts/keylease-core/target/wasm32v1-none/release/keylease_core.wasm',
);
const serviceId = args.service ?? 'weather-api';
const pricePerCall = Number(args.price ?? 1_000);
const demoCalls = Number(args.calls ?? 25);
const demoDuration = Number(args.duration ?? 86_400);
const pollIntervalMs = 1_000;
const pollAttempts = 60;

const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (!key || value === undefined) throw new Error(`bad argument: ${argv[i]}`);
    out[key] = value;
  }
  return out;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest();
}

function log(line = '') {
  process.stdout.write(`${line}\n`);
}

async function fund(publicKey) {
  try {
    const response = await fetch(`${network.friendbot}/?addr=${encodeURIComponent(publicKey)}`);
    if (!response.ok && response.status !== 400) {
      throw new Error(`friendbot responded ${response.status}`);
    }
  } catch (error) {
    log(`  ! friendbot unavailable for ${publicKey}: ${error.message}`);
  }
}

async function submit(signer, operation, label) {
  const account = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') {
    throw new Error(`${label}: RPC rejected the transaction (${JSON.stringify(sent.errorResult)})`);
  }

  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    const info = await server.getTransaction(sent.hash);
    if (info.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      log(`  ✓ ${label} — ${sent.hash}`);
      return { hash: sent.hash, returnValue: info.returnValue };
    }
    if (info.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`${label}: transaction ${sent.hash} failed (${JSON.stringify(info)})`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`${label}: timed out waiting for ${sent.hash}`);
}

function deriveContractId(deployer, salt) {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: sha256(Buffer.from(network.passphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(deployer).toScAddress(),
          salt,
        }),
      ),
    }),
  );
  return StrKey.encodeContract(sha256(preimage.toXDR()));
}

async function readConfig(contractId) {
  const source = Keypair.random().publicKey();
  const tx = new TransactionBuilder(new Account(source, '0'), {
    fee: BASE_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(new Contract(contractId).call('get_config'))
    .setTimeout(60)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`get_config simulation failed: ${simulation.error}`);
  }
  const native = scValToNative(simulation.result.retval);
  return {
    admin: native.admin,
    token: native.token,
    gateway: native.gateway,
    leaseCount: Number(native.lease_count),
  };
}

async function main() {
  log(`KeyLease · deploying keylease-core to ${networkName}`);
  log(`  rpc     : ${rpcUrl}`);
  log(`  wasm    : ${wasmPath}`);

  const wasm = await readFile(wasmPath);
  const wasmHash = sha256(wasm);
  log(`  wasm    : ${wasm.length} bytes, sha256 ${wasmHash.toString('hex')}`);

  const admin = Keypair.random();
  const gateway = Keypair.random();
  const provider = Keypair.random();
  const consumer = Keypair.random();
  const roles = { admin, gateway, provider, consumer };

  log('\n1. funding roles via friendbot');
  for (const [role, keypair] of Object.entries(roles)) {
    await fund(keypair.publicKey());
    log(`  ${role.padEnd(8)}: ${keypair.publicKey()}`);
  }

  log('\n2. uploading wasm');
  const txs = {};
  txs.upload = (
    await submit(admin, Operation.uploadContractWasm({ wasm }), 'uploadContractWasm')
  ).hash;

  log('\n3. creating contract instance');
  const salt = sha256(Buffer.concat([wasmHash, Buffer.from(admin.publicKey())]));
  const expectedContractId = deriveContractId(admin.publicKey(), salt);
  txs.create = (
    await submit(
      admin,
      Operation.createCustomContract({
        address: Address.fromString(admin.publicKey()),
        wasmHash,
        salt,
      }),
      'createCustomContract',
    )
  ).hash;
  log(`  contract: ${expectedContractId}`);

  const nativeSac = Asset.native().contractId(network.passphrase);
  log(`  native SAC escrow token: ${nativeSac}`);

  log('\n4. initialising');
  const contract = new Contract(expectedContractId);
  txs.init = (
    await submit(
      admin,
      contract.call(
        'init',
        nativeToScVal(Address.fromString(admin.publicKey()), { type: 'address' }),
        nativeToScVal(Address.fromString(nativeSac), { type: 'address' }),
        nativeToScVal(Address.fromString(gateway.publicKey()), { type: 'address' }),
      ),
      'init(admin, token, gateway)',
    )
  ).hash;

  log('\n5. registering the service');
  txs.registerService = (
    await submit(
      provider,
      contract.call(
        'register_service',
        nativeToScVal(Address.fromString(provider.publicKey()), { type: 'address' }),
        nativeToScVal(serviceId, { type: 'string' }),
        nativeToScVal(BigInt(pricePerCall), { type: 'i128' }),
      ),
      `register_service(${serviceId} @ ${pricePerCall}/call)`,
    )
  ).hash;

  log('\n6. prepaying a demo lease');
  const lease = await submit(
    consumer,
    contract.call(
      'create_lease',
      nativeToScVal(Address.fromString(consumer.publicKey()), { type: 'address' }),
      nativeToScVal(serviceId, { type: 'string' }),
      nativeToScVal(demoCalls, { type: 'u32' }),
      nativeToScVal(BigInt(demoDuration), { type: 'u64' }),
    ),
    `create_lease(${demoCalls} calls, ${demoDuration}s)`,
  );
  const leaseId = String(scValToNative(lease.returnValue));

  const onChain = await readConfig(expectedContractId);
  if (onChain.admin !== admin.publicKey() || onChain.leaseCount < 1) {
    throw new Error('post-deploy verification failed: config does not match what we deployed');
  }

  const deployment = {
    network: networkName,
    networkPassphrase: network.passphrase,
    rpcUrl,
    contractId: expectedContractId,
    wasmHash: wasmHash.toString('hex'),
    wasmBytes: wasm.length,
    deployedAt: new Date().toISOString(),
    escrowToken: nativeSac,
    accounts: {
      admin: admin.publicKey(),
      gateway: gateway.publicKey(),
      provider: provider.publicKey(),
      consumer: consumer.publicKey(),
    },
    transactions: {
      upload: txs.upload,
      create: txs.create,
      init: txs.init,
      registerService: txs.registerService,
    },
    services: [{ id: serviceId, pricePerCall }],
    demoLease: { leaseId, calls: demoCalls, duration: demoDuration, txHash: lease.hash },
  };

  const outPath = resolve(repoRoot, 'deployments.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(deployment, null, 2)}\n`);

  const secretsPath = resolve(repoRoot, '.keylease/testnet-accounts.json');
  await mkdir(dirname(secretsPath), { recursive: true });
  await writeFile(
    secretsPath,
    `${JSON.stringify(
      Object.fromEntries(
        Object.entries(roles).map(([role, keypair]) => [role, keypair.secret()]),
      ),
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  log('\n7. done');
  log(`  contract id : ${expectedContractId}`);
  log(`  lease id    : ${leaseId}`);
  log(`  wrote       : deployments.json (public)`);
  log(`  secrets     : .keylease/testnet-accounts.json (git-ignored)`);
  log(`\n  export KEYLEASE_CONTRACT_ID=${expectedContractId}`);
}

main().catch((error) => {
  process.stderr.write(`\ndeploy failed: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
