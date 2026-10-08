import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { mintSessionToken } from '../token.js';
import { SorobanClient, type CreateLeaseResult } from '../client/soroban.js';
import type { CliIo } from '../index.js';

/** Where acquired leases are remembered so `keylease env` can find them. */
export const SESSION_STORE_PATH = '.keylease/sessions.json';

export interface NetworkArgs {
  network?: string | undefined;
  rpc?: string | undefined;
  contract?: string | undefined;
}

export interface AcquireArgs extends NetworkArgs {
  service: string;
  calls: number;
  duration: number;
  secret: string;
  json: boolean;
}

export interface EnvArgs {
  service: string;
  file: string;
  json: boolean;
}

/** A locally stored lease session produced by `keylease acquire`. */
export interface LeaseSession {
  service: string;
  leaseId: string;
  consumer: string;
  token: string;
  callsLimit: number;
  issuedAt: number;
  expiresAt: number;
  txHash: string | null;
  network: string;
}

export interface SessionStore {
  load(): Promise<Record<string, LeaseSession>>;
  save(session: LeaseSession): Promise<void>;
}

export interface AcquireDeps {
  createClient?: (args: AcquireArgs) => Pick<SorobanClient, 'createLease'>;
  store?: SessionStore;
  now?: () => number;
}

export interface EnvDeps {
  store?: SessionStore;
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, contents: string) => Promise<void>;
}

/** File-backed store, one JSON document keyed by service id. */
export function fileSessionStore(cwd: string = process.cwd()): SessionStore {
  const path = isAbsolute(SESSION_STORE_PATH)
    ? SESSION_STORE_PATH
    : join(cwd, SESSION_STORE_PATH);

  return {
    async load(): Promise<Record<string, LeaseSession>> {
      try {
        const raw = await readFile(path, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, LeaseSession>;
        }
      } catch {
        // Missing or corrupt store: treat as empty.
      }
      return {};
    },
    async save(session: LeaseSession): Promise<void> {
      const sessions = await this.load();
      sessions[session.service] = session;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(sessions, null, 2)}\n`, { mode: 0o600 });
    },
  };
}

export function parseConsumerSecret(secret: string): Keypair {
  try {
    return Keypair.fromSecret(secret);
  } catch {
    throw new Error('--secret must be a valid Stellar secret seed (starts with "S")');
  }
}

function defaultCreateClient(args: AcquireArgs): Pick<SorobanClient, 'createLease'> {
  return SorobanClient.fromEnv({
    KEYLEASE_NETWORK: args.network,
    KEYLEASE_RPC_URL: args.rpc,
    KEYLEASE_CONTRACT_ID: args.contract,
  });
}

function renderAcquireOutput(session: LeaseSession, io: CliIo, json: boolean): void {
  if (json) {
    io.out(
      JSON.stringify(
        {
          service: session.service,
          lease_id: session.leaseId,
          consumer: session.consumer,
          calls: session.callsLimit,
          issued_at: session.issuedAt,
          expires_at: session.expiresAt,
          tx_hash: session.txHash,
          session_token: session.token,
        },
        null,
        2,
      ),
    );
    return;
  }

  io.out(`Lease acquired for service "${session.service}"`);
  io.out(`  lease id   : ${session.leaseId}`);
  io.out(`  consumer   : ${session.consumer}`);
  io.out(`  calls      : ${session.callsLimit}`);
  io.out(`  expires at : ${new Date(session.expiresAt * 1000).toISOString()}`);
  if (session.txHash) io.out(`  tx hash    : ${session.txHash}`);
  io.out('');
  io.out(`  Authorization: Bearer ${session.token}`);
}

/**
 * `keylease acquire --service <id> --calls <count> --duration <secs> --secret <key>`
 *
 * Invokes `create_lease` on `keylease-core`, then mints an ed25519-signed
 * session bearer token bound to `(lease_id, consumer)`.
 */
export async function acquireCommand(
  args: AcquireArgs,
  io: CliIo,
  deps: AcquireDeps = {},
): Promise<number> {
  const consumer = parseConsumerSecret(args.secret);
  const createClient = deps.createClient ?? defaultCreateClient;
  const store = deps.store ?? fileSessionStore();
  const now = deps.now ?? (() => Date.now());

  const result: CreateLeaseResult = await createClient(args).createLease({
    service: args.service,
    calls: args.calls,
    duration: args.duration,
    consumer,
  });

  const issuedAt = Math.floor(now() / 1000);
  const expiresAt = issuedAt + args.duration;
  const token = mintSessionToken({
    leaseId: result.leaseId,
    consumerSecret: args.secret,
    issuedAt,
    expiresAt,
  });

  const session: LeaseSession = {
    service: args.service,
    leaseId: result.leaseId,
    consumer: consumer.publicKey(),
    token,
    callsLimit: args.calls,
    issuedAt,
    expiresAt,
    txHash: result.txHash,
    network: args.network ?? 'testnet',
  };

  await store.save(session);
  renderAcquireOutput(session, io, args.json);
  return 0;
}

/** The keys `keylease env` drops into the local `.env`. */
export function envEntriesFor(session: LeaseSession): Record<string, string> {
  return {
    KEYLEASE_SERVICE: session.service,
    KEYLEASE_LEASE_ID: session.leaseId,
    KEYLEASE_CONSUMER: session.consumer,
    KEYLEASE_SESSION_TOKEN: session.token,
    KEYLEASE_CALLS_LIMIT: String(session.callsLimit),
    KEYLEASE_ISSUED_AT: String(session.issuedAt),
    KEYLEASE_EXPIRES_AT: String(session.expiresAt),
  };
}

/**
 * Merges key/value pairs into existing `.env` text: unknown lines are kept
 * verbatim, previously set `KEY` are replaced in place, new keys appended.
 */
export function mergeEnv(existing: string, entries: Record<string, string>): string {
  const lines = existing.length > 0 ? existing.split('\n') : [];
  const emitted = new Set<string>();
  const out = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trimEnd());
    if (!match) return line;
    const key = match[1] as string;
    if (key in entries && !emitted.has(key)) {
      emitted.add(key);
      return `${key}=${entries[key]}`;
    }
    if (key in entries) return null; // drop duplicates
    return line;
  });

  // Drop the trailing blank line(s) of the original file before appending.
  while (out.length > 0 && out[out.length - 1] === '') {
    out.pop();
  }

  for (const [key, value] of Object.entries(entries)) {
    if (!emitted.has(key)) {
      emitted.add(key);
      out.push(`${key}=${value}`);
    }
  }

  const text = out.filter((line) => line !== null).join('\n').replace(/\n*$/, '\n');
  return text;
}

/**
 * `keylease env --service <id> [--file .env]`
 *
 * Writes the temporary session keys of a previously acquired lease into a local
 * `.env` file so shell tooling can pick them up.
 */
export async function envCommand(
  args: EnvArgs,
  io: CliIo,
  deps: EnvDeps = {},
): Promise<number> {
  const store = deps.store ?? fileSessionStore();
  const read = deps.readFile ?? ((path: string) => readFile(path, 'utf8'));
  const write =
    deps.writeFile ?? ((path: string, contents: string) => writeFile(path, contents, { mode: 0o600 }));

  const sessions = await store.load();
  const session = sessions[args.service];
  if (!session) {
    io.err(`no lease found for service "${args.service}"`);
    io.err('run: keylease acquire --service <id> --calls <n> --duration <secs> --secret <key>');
    return 1;
  }

  const entries = envEntriesFor(session);
  const existing = await read(args.file).catch(() => '');
  const merged = mergeEnv(existing, entries);
  await write(args.file, merged);

  const keys = Object.keys(entries);
  if (args.json) {
    io.out(JSON.stringify({ file: args.file, keys }, null, 2));
  } else {
    io.out(`Wrote ${keys.length} keys to ${args.file}`);
    io.out(`  ${keys.join(', ')}`);
  }
  return 0;
}
