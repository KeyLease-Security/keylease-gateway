import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { mintSessionToken } from '../token.js';
import { SorobanClient, type CreateLeaseResult } from '../client/soroban.js';
import { CliError } from '../errors.js';
import type { CliIo } from '../index.js';

/**
 * Where acquired leases are remembered so `keylease env` can find them.
 *
 * Storage format (v2):
 *   {
 *     "[service-id]": [
 *       { leaseId, consumer, token, callsLimit, issuedAt, expiresAt, ... },
 *       { ... }
 *     ]
 *   }
 *
 * Multiple leases per service support parallel acquisitions and renewals.
 * This file is git-ignored and should not be committed to version control.
 * The store is read-only from the CLI's perspective (no mutations via env command).
 *
 * Backward compatibility:
 *   Old v1 format { "[service]": LeaseSession } is automatically migrated
 *   to v2 format on first load, converting single sessions to arrays.
 */
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
  /** Consumer secret seed; required unless `dryRun` is set. */
  secret?: string | undefined;
  dryRun: boolean;
  json: boolean;
}

export interface EnvArgs {
  service: string;
  file: string;
  json: boolean;
  lease?: string;
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
  load(): Promise<Record<string, LeaseSession[]>>;
  save(session: LeaseSession): Promise<void>;
  saveAll(sessions: Record<string, LeaseSession[]>): Promise<void>;
}

export class SessionStoreError extends Error {
  constructor(
    readonly code: 'missing' | 'corrupt' | 'unreadable' | 'locked',
    path: string,
  ) {
    if (code === 'locked') {
      super(
        `Cannot write session store at ${path}: locked. Another keylease process holds ` +
          `${path}.lock; wait for it to finish, or delete the lock file if no keylease ` +
          'command is running.',
      );
    } else {
      const guidance =
        code === 'missing'
          ? 'Run `keylease acquire` to create a stored lease.'
          : code === 'corrupt'
            ? 'Back up or repair the file, then run this command again.'
            : 'Check file permissions and try again.';
      super(`Cannot read session store at ${path}: ${code}. ${guidance}`);
    }
    this.name = 'SessionStoreError';
  }
}

export interface FileSessionStoreOptions {
  /** How long to wait for another process's lock before giving up. */
  lockTimeoutMs?: number;
  /** A lock file older than this is considered abandoned and removed once. */
  staleLockMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 10_000;
const LOCK_POLL_MS = 25;

/** Per-path tail of the in-process write queue. */
const pendingWrites = new Map<string, Promise<unknown>>();

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Takes an exclusive `<path>.lock` (O_CREAT | O_EXCL) for cross-process
 * safety. A lock older than `staleLockMs` is removed and retried once; if the
 * lock is still held after `timeoutMs`, fails with a `locked` error.
 */
async function acquireLock(
  path: string,
  timeoutMs: number,
  staleLockMs: number,
): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + timeoutMs;
  let removedStale = false;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return async () => {
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }

    if (!removedStale) {
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > staleLockMs) {
        removedStale = true;
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
    }
    if (Date.now() >= deadline) throw new SessionStoreError('locked', path);
    await delay(LOCK_POLL_MS);
  }
}

/** Writes `contents` to a sibling temp file, then renames it over `path`. */
async function writeAtomic(path: string, contents: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, contents, { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

export interface AcquireDeps {
  createClient?: (args: AcquireArgs) => Pick<SorobanClient, 'createLease' | 'quote'>;
  store?: SessionStore;
  now?: () => number;
}

export interface EnvDeps {
  store?: SessionStore;
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, contents: string) => Promise<void>;
  now?: () => number;
}

function isLeaseSession(value: unknown): value is LeaseSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session['service'] === 'string' &&
    typeof session['leaseId'] === 'string' &&
    typeof session['consumer'] === 'string' &&
    typeof session['token'] === 'string' &&
    typeof session['callsLimit'] === 'number' &&
    Number.isFinite(session['callsLimit']) &&
    typeof session['issuedAt'] === 'number' &&
    Number.isFinite(session['issuedAt']) &&
    typeof session['expiresAt'] === 'number' &&
    Number.isFinite(session['expiresAt']) &&
    (typeof session['txHash'] === 'string' || session['txHash'] === null) &&
    typeof session['network'] === 'string'
  );
}

/** Migrates v1 format { [service]: LeaseSession } to v2 format { [service]: LeaseSession[] } */
function migrateSessionsV1ToV2(
  parsed: unknown,
): Record<string, LeaseSession[]> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const result: Record<string, LeaseSession[]> = {};
  for (const [service, value] of Object.entries(parsed)) {
    // Check if this is a v1 single session or already v2 array format
    if (Array.isArray(value)) {
      // v2 format: validate each item
      const sessions: LeaseSession[] = [];
      for (const item of value) {
        if (isLeaseSession(item)) {
          sessions.push(item);
        }
      }
      if (sessions.length > 0) {
        result[service] = sessions;
      }
    } else if (isLeaseSession(value)) {
      // v1 format: wrap single session in array
      result[service] = [value];
    }
  }
  return result;
}

/**
 * Selects the best lease for a service: newest unexpired, or explicit by ID.
 *
 * Selection logic:
 *   - If leaseId is provided: returns that lease (even if expired), or undefined if not found
 *   - Otherwise: returns the newest unexpired lease by issuedAt, or undefined if all expired
 *
 * This enables:
 *   - Default behavior: env picks the most recent valid lease automatically
 *   - Explicit override: --lease <id> forces a specific lease
 *   - Renewal support: multiple concurrent leases are tracked, with newer ones preferred
 *
 * @param sessions - All leases for a service
 * @param now - Current time in seconds (Unix epoch)
 * @param leaseId - Optional explicit lease ID to select
 * @returns The selected lease or undefined if selection fails
 */
export function selectLease(
  sessions: LeaseSession[],
  now: number,
  leaseId?: string,
): LeaseSession | undefined {
  if (leaseId) {
    // Explicit lease selection
    return sessions.find((s) => s.leaseId === leaseId);
  }

  // Find newest unexpired lease
  const unexpired = sessions.filter((s) => s.expiresAt > now);
  if (unexpired.length === 0) return undefined;

  // Sort by issuedAt descending (most recent first)
  return unexpired.sort((a, b) => b.issuedAt - a.issuedAt)[0];
}

/**
 * File-backed store for lease sessions, one JSON document keyed by service id.
 *
 * Storage schema (v2):
 *   {
 *     "[service-id]": [LeaseSession, LeaseSession, ...],
 *     ...
 *   }
 *
 * Migration from v1:
 *   The store automatically detects and migrates the old single-session format
 *   { "[service]": LeaseSession } to the new array format on load. This is
 *   transparent to callers; save() always writes v2 format.
 *
 * Idempotent saves:
 *   save() replaces any lease with the same leaseId (keeping array size constant
 *   for a given lease), ensuring multiple saves of the same acquisition are safe.
 *
 * File permissions:
 *   Created with mode 0o600 (owner read/write only) to protect sensitive tokens.
 */
/**
 * File-backed store, one JSON document keyed by service id.
 *
 * This is a local cache, not a database. Writes are serialized per path within
 * the process, guarded across processes by a best-effort `<path>.lock` file,
 * and land via an atomic temp-file rename so readers never see a torn file.
 */
export function fileSessionStore(
  cwd: string = process.cwd(),
  options: FileSessionStoreOptions = {},
): SessionStore {
  const path = isAbsolute(SESSION_STORE_PATH)
    ? SESSION_STORE_PATH
    : join(cwd, SESSION_STORE_PATH);
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;

  /** Runs `task` after every earlier write to `path` in this process, under the file lock. */
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = pendingWrites.get(path) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        const release = await acquireLock(path, lockTimeoutMs, staleLockMs);
        try {
          return await task();
        } finally {
          await release();
        }
      });
    pendingWrites.set(path, run);
    void run
      .finally(() => {
        if (pendingWrites.get(path) === run) pendingWrites.delete(path);
      })
      .catch(() => undefined);
    return run;
  }

  const writeSessions = (sessions: Record<string, LeaseSession[]>): Promise<void> =>
    writeAtomic(path, `${JSON.stringify(sessions, null, 2)}\n`);

  return {
    async load(): Promise<Record<string, LeaseSession[]>> {
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (error) {
        throw new SessionStoreError(errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable', path);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new SessionStoreError('corrupt', path);
      }

      const sessions = migrateSessionsV1ToV2(parsed);
      if (Object.keys(sessions).length === 0 && raw.trim().length > 0) {
        // Had content but no valid sessions were migrated
        throw new SessionStoreError('corrupt', path);
      }
      return sessions;
    },
    async save(session: LeaseSession): Promise<void> {
      await exclusive(async () => {
        let sessions: Record<string, LeaseSession[]>;
        try {
          sessions = await this.load();
        } catch (error) {
          if (!(error instanceof SessionStoreError) || error.code !== 'missing') throw error;
          sessions = {};
        }

        // Add or update lease in array (idempotent: replace if same leaseId exists)
        if (!sessions[session.service]) {
          sessions[session.service] = [];
        }
        const list = sessions[session.service]!;
        const idx = list.findIndex((s) => s.leaseId === session.leaseId);
        if (idx >= 0) {
          list[idx] = session;
        } else {
          list.push(session);
        }

        await writeSessions(sessions);
      });
    },
    async saveAll(sessions: Record<string, LeaseSession[]>): Promise<void> {
      await exclusive(() => writeSessions(sessions));
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

function defaultCreateClient(args: AcquireArgs): Pick<SorobanClient, 'createLease' | 'quote'> {
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

  io.out(`Lease ${session.leaseId} acquired for service "${session.service}"`);
  io.out(`  consumer   : ${session.consumer}`);
  io.out(`  calls      : ${session.callsLimit} (prepaid into contract escrow)`);
  io.out(`  expires at : ${new Date(session.expiresAt * 1000).toISOString()}`);
  if (session.txHash) io.out(`  tx hash    : ${session.txHash}`);
  io.out('');
  io.out(`  Authorization: Bearer ${session.token}`);
}

interface DryRunSummary {
  service: string;
  calls: number;
  duration: number;
  price: number;
  expiresAt: number;
  consumer: string | undefined;
}

function renderDryRunOutput(summary: DryRunSummary, io: CliIo, json: boolean): void {
  if (json) {
    io.out(
      JSON.stringify(
        {
          dry_run: true,
          service: summary.service,
          calls: summary.calls,
          duration: summary.duration,
          price: summary.price,
          expires_at: summary.expiresAt,
          consumer: summary.consumer ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  io.out(`Dry run: quote for ${summary.calls} calls on "${summary.service}" (nothing signed or submitted)`);
  io.out(`  service    : ${summary.service}`);
  io.out(`  calls      : ${summary.calls}`);
  io.out(`  duration   : ${summary.duration}s`);
  io.out(`  price      : ${summary.price} (token smallest units, quoted from keylease-core)`);
  if (summary.consumer !== undefined) io.out(`  consumer   : ${summary.consumer}`);
  io.out(`  expires at : ${new Date(summary.expiresAt * 1000).toISOString()} (if acquired now)`);
}

/**
 * `keylease acquire --service <id> --calls <count> --duration <secs> --secret <key>`
 *
 * Invokes `create_lease` on the keylease-core contract, then mints an ed25519-signed
 * session bearer token bound to `(lease_id, consumer)`. Appends the lease to the
 * service's lease list in the session store.
 *
 * Multiple acquisitions for the same service are supported and idempotent:
 *   - New lease: appended to the service's array
 *   - Same leaseId: replaced in-place (e.g., on retry or renewal with tx hash update)
 *   - env command: automatically selects newest unexpired lease
 * Invokes `create_lease` on `keylease-core`, then mints an ed25519-signed
 * session bearer token bound to `(lease_id, consumer)`.
 *
 * With `--dry-run` the price is read through `quote` instead: nothing is signed,
 * no lease is created, and no session is written to the local store.
 */
export async function acquireCommand(
  args: AcquireArgs,
  io: CliIo,
  deps: AcquireDeps = {},
): Promise<number> {
  const createClient = deps.createClient ?? defaultCreateClient;
  const store = deps.store ?? fileSessionStore();
  const now = deps.now ?? (() => Date.now());
  const consumer = args.secret === undefined ? undefined : parseConsumerSecret(args.secret);

  if (args.dryRun) {
    const client = createClient(args);
    const price = await client.quote(args.service, args.calls);
    const expiresAt = Math.floor(now() / 1000) + args.duration;
    renderDryRunOutput(
      {
        service: args.service,
        calls: args.calls,
        duration: args.duration,
        price,
        expiresAt,
        consumer: consumer?.publicKey(),
      },
      io,
      args.json,
    );
    return 0;
  }

  if (consumer === undefined || args.secret === undefined) {
    throw new CliError('--secret is required unless --dry-run is set', 'missing_option');
  }

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

/** Values made only of shell-safe characters are written without quotes. */
const ENV_BARE_VALUE = /^[A-Za-z0-9_.:@/-]+$/;

/**
 * Renders a value for a `.env` file meant to be sourced by a POSIX shell.
 *
 * Plain values stay bare for readability; anything that could be split, quoted
 * or expanded (`space`, `#`, `$`, `"`, `\\`, empty) is double-quoted with `\\`,
 * `"` and `$` escaped, so the shell reads back exactly the original value.
 */
export function quoteEnvValue(value: string): string {
  if (ENV_BARE_VALUE.test(value)) return value;
  return `"${value.replace(/[\\"$]/g, (char) => `\\${char}`)}"`;
}

/**
 * Merges key/value pairs into existing `.env` text: unknown lines are kept
 * verbatim, previously set `KEY` are replaced in place, new keys appended.
 */
export function mergeEnv(existing: string, entries: Record<string, string>): string {
  const lines = existing.length > 0 ? existing.split('\n') : [];
  const emitted = new Set<string>();
  const out = lines.map((line) => {
    const match = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trimEnd());
    if (!match) return line;
    const exportPrefix = match[1] ?? '';
    const key = match[2] as string;
    const rawVal = match[3] ?? '';
    if (key in entries && !emitted.has(key)) {
      emitted.add(key);
      const commentMatch = /\s+(#.*)$/.exec(rawVal);
      const comment = commentMatch ? ` ${commentMatch[1]}` : '';
      return `${exportPrefix}${key}=${quoteEnvValue(entries[key] as string)}${comment}`;
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
      out.push(`${key}=${quoteEnvValue(value)}`);
    }
  }

  const text = out.filter((line) => line !== null).join('\n').replace(/\n*$/, '\n');
  return text;
}

/**
 * `keylease env --service <id> [--file .env] [--lease <id>]`
 *
 * Writes the temporary session keys of a previously acquired lease into a local
 * `.env` file so shell tooling can pick them up. Selects the newest unexpired lease
 * by default, or explicit lease via --lease.
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
  const now = deps.now ?? (() => Date.now());
  const currentSeconds = Math.floor(now() > 1e11 ? now() / 1000 : now());

  const rawSessions = await store.load();
  const allSessions = migrateSessionsV1ToV2(rawSessions);
  const sessions = allSessions[args.service];
  if (!sessions || sessions.length === 0) {
    io.err(`no lease found for service "${args.service}"`);
    io.err('run: keylease acquire --service <id> --calls <n> --duration <secs> --secret <key>');
    return 1;
  }

  const session = selectLease(sessions, currentSeconds, args.lease);
  if (!session) {
    io.err(`no valid lease found for service "${args.service}"`);
    if (args.lease) {
      io.err(`  (requested lease ${args.lease} not found or expired)`);
    } else {
      io.err(`  (all ${sessions.length} leases expired)`);
    }
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
