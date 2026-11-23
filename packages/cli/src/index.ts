#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  acquireCommand,
  envCommand,
  resolveConsumerSecret,
  type AcquireArgs,
  type AcquireDeps,
  type EnvArgs,
  type EnvDeps,
  type NetworkArgs,
} from './commands/lease.js';
import { statusCommand, type StatusArgs, type StatusDeps } from './commands/status.js';
import {
  releaseCommand,
  revokeCommand,
  settleCommand,
  useCallCommand,
  type RevokeArgs,
  type RevokeDeps,
  type SettleArgs,
  type SettleDeps,
  type UseCallArgs,
  type UseCallDeps,
} from './commands/lifecycle.js';
import {
  sessionsCommand,
  type SessionsArgs,
  type SessionsDeps,
} from './commands/sessions.js';
import {
  completionsCommand,
  COMPLETION_SHELLS,
  isCompletionShell,
  type CompletionsArgs,
} from './commands/completions.js';
import {
  loadConfigFile,
  resolveConfig,
  type KeyleaseConfigFile,
  type ResolvedConfig,
} from './config.js';
import { CliError, redactToken } from './errors.js';
import { renderError } from './error-renderer.js';

export { CliError, redactToken } from './errors.js';

export const MAX_CALLS = 1_000_000;
export const MAX_DURATION = 31_536_000;

export const CLI_NAME = 'keylease';
export const CLI_VERSION = '0.1.0';

/** Maximum lease duration in seconds (365 days). */
export const MAX_DURATION_SECONDS = 365 * 24 * 60 * 60;

export interface CliIo {
  out(line?: string): void;
  err(line?: string): void;
}

export type CommandName =
  | 'acquire'
  | 'env'
  | 'status'
  | 'settle'
  | 'revoke'
  | 'release'
  | 'sessions'
  | 'completions';

export type Invocation =
  | { command: 'help' }
  | { command: 'version' }
  | { command: 'acquire'; args: AcquireArgs }
  | { command: 'quote'; args: QuoteArgs }
  | { command: 'env'; args: EnvArgs }
  | { command: 'status'; args: StatusArgs }
  | { command: 'settle'; args: SettleArgs }
  | { command: 'revoke'; args: RevokeArgs }
  | { command: 'release'; args: ReleaseArgs }
  | { command: 'sessions'; args: SessionsArgs }
  | { command: 'completions'; args: CompletionsArgs };

export interface RunDeps {
  acquire?: AcquireDeps;
  quote?: QuoteDeps;
  env?: EnvDeps;
  status?: StatusDeps;
  settle?: SettleDeps;
  revoke?: RevokeDeps;
  'use-call'?: UseCallDeps;
  sessions?: SessionsDeps;
  /** Directory holding `.keyleaserc.json` (default: `process.cwd()`). */
  cwd?: string;
  /** Environment consulted for `KEYLEASE_*` config (default: `process.env`). */
  environment?: Record<string, string | undefined>;
  /** Pre-loaded `.keyleaserc.json` contents, skipping disk reads. */
  config?: KeyleaseConfigFile;
}

const OPTION_SPEC = {
  service: { type: 'string' },
  calls: { type: 'string' },
  count: { type: 'string' },
  duration: { type: 'string' },
  secret: { type: 'string' },
  lease: { type: 'string', multiple: true },
  fee: { type: 'string' },
  timeout: { type: 'string' },
  token: { type: 'string' },
  network: { type: 'string' },
  rpc: { type: 'string' },
  contract: { type: 'string' },
  file: { type: 'string' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  'check-chain': { type: 'boolean' },
  prune: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

type ParsedOptions = {
  [K in keyof typeof OPTION_SPEC]?: (typeof OPTION_SPEC)[K] extends {
    type: 'string';
    multiple: true;
  }
    ? string[]
    : (typeof OPTION_SPEC)[K]['type'] extends 'string'
      ? string
      : boolean;
};

function readOptions(args: string[]): { values: ParsedOptions; positionals: string[] } {
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: OPTION_SPEC,
    });
    return { values: parsed.values as ParsedOptions, positionals: parsed.positionals };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(message, 'parse_error');
  }
}

function requireString(values: ParsedOptions, name: keyof ParsedOptions): string {
  const value = values[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliError(`--${name} is required`, 'missing_option');
  }
  return value;
}

function optionalString(values: ParsedOptions, name: keyof ParsedOptions): string | undefined {
  const raw = values[name];
  if (Array.isArray(raw) && raw.length > 1) {
    throw new CliError(`--${name} may only be specified once here`, 'invalid_option');
  }
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliError(`--${name} must be a non-empty value`, 'invalid_option');
  }
  return value;
}

function requireLeaseIds(values: ParsedOptions): string[] {
  const raw = values.lease;
  if (raw === undefined) throw new CliError('--lease is required', 'missing_option');
  const valuesToSplit = Array.isArray(raw) ? raw : [raw];
  const leaseIds = valuesToSplit.flatMap((value) => value.split(',').map((id) => id.trim()));
  if (leaseIds.some((id) => id.length === 0)) {
    throw new CliError('--lease must contain non-empty lease IDs', 'invalid_option');
  }
  return [...new Set(leaseIds)];
}

function requirePositiveInt(values: ParsedOptions, name: keyof ParsedOptions): number {
  const raw = requireString(values, name);
  return parsePositiveInt(raw, name);
}

function optionalPositiveInt(values: ParsedOptions, name: keyof ParsedOptions): number | undefined {
  const raw = optionalString(values, name);
  return raw === undefined ? undefined : parsePositiveInt(raw, name);
}

function parsePositiveInt(raw: string, name: keyof ParsedOptions): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new CliError(`--${name} must be a positive integer, got "${raw}"`, 'invalid_option');
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(`--${name} must be a positive integer, got "${raw}"`, 'invalid_option');
  }
  return parsed;
}

function requireDuration(values: ParsedOptions): number {
  const duration = requirePositiveInt(values, 'duration');
  if (duration > MAX_DURATION_SECONDS) {
    throw new CliError(
      `--duration must not exceed ${MAX_DURATION_SECONDS} seconds (365 days), got ${duration}`,
      'invalid_option',
    );
  }
  return duration;
function validateRpcUrl(url: string): void {
  // Validate RPC URL at parse time to catch typos early
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(`invalid --rpc URL "${url}": must be a valid URL`, 'invalid_option');
  }

  const scheme = parsed.protocol;
  if (scheme !== 'http:' && scheme !== 'https:') {
    throw new CliError(
      `invalid --rpc URL "${url}": scheme must be http: or https:, got ${scheme}`,
      'invalid_option',
    );
  }

  // Allow http: only for localhost/127.0.0.1
  if (scheme === 'http:') {
    const hostname = parsed.hostname;
    if (
      hostname !== 'localhost' &&
      hostname !== '127.0.0.1' &&
      hostname !== '::1' &&
      hostname !== '[::1]'
    ) {
      throw new CliError(
        `invalid --rpc URL "${url}": http: is only allowed for localhost, not ${hostname}`,
        'invalid_option',
      );
    }
  }
}

function networkArgs(values: ParsedOptions): {
  network?: string | undefined;
  rpc?: string | undefined;
  contract?: string | undefined;
} {
  const rpc = optionalString(values, 'rpc');
  if (rpc !== undefined) {
    validateRpcUrl(rpc);
  }
  
  return {
    network: optionalString(values, 'network'),
    rpc,
    contract: optionalString(values, 'contract'),
  };
}

function transactionArgs(values: ParsedOptions): {
  network?: string | undefined;
  rpc?: string | undefined;
  contract?: string | undefined;
  fee?: number | undefined;
  timeout?: number | undefined;
} {
  return {
    ...networkArgs(values),
    fee: optionalPositiveInt(values, 'fee'),
    timeout: optionalPositiveInt(values, 'timeout'),
  };
}

function ensureNoPositionals(positionals: string[]): void {
  const first = positionals[0];
  if (first !== undefined) {
    throw new CliError(`unexpected argument "${first}"`, 'unexpected_argument');
  }
}

export interface ParseOptions {
  /** Service id from `.keyleaserc.json` or `KEYLEASE_SERVICE` when `--service` is absent. */
  defaultService?: string | undefined;
}

/** Resolves `--service`, falling back to the configured default service. */
function serviceFrom(values: ParsedOptions, options: ParseOptions): string {
  const flag = optionalString(values, 'service');
  if (flag !== undefined) return flag;
  const fallback = options.defaultService;
  if (fallback !== undefined && fallback.length > 0) return fallback;
  throw new CliError(
    '--service is required (or set "defaultService" in .keyleaserc.json)',
    'missing_option',
  );
}

/**
 * Turns a raw argv slice into a typed invocation. Pure and side-effect free so
 * CLI parameter parsing can be unit tested directly.
 */
export function parseArgv(argv: string[], options: ParseOptions = {}): Invocation {
  const [rawCommand, ...rest] = argv;

  if (rawCommand === undefined || rawCommand === 'help' || rawCommand === '--help' || rawCommand === '-h') {
    return { command: 'help' };
  }
  if (rawCommand === 'version' || rawCommand === '--version' || rawCommand === '-V') {
    return { command: 'version' };
  }

  const { values, positionals } = readOptions(rest);
  if (values.help === true) {
    return { command: 'help' };
  }

  switch (rawCommand) {
    case 'acquire': {
      ensureNoPositionals(positionals);
      const dryRun = values['dry-run'] === true;
      const secret = optionalString(values, 'secret');
      if (!dryRun && secret === undefined) {
        throw new CliError('--secret is required unless --dry-run is set', 'missing_option');
      }
      const calls = requirePositiveInt(values, 'calls');
      if (calls > MAX_CALLS) {
        throw new CliError(`--calls cannot exceed ${MAX_CALLS}, got ${calls}`, 'invalid_option');
      }
      const duration = requirePositiveInt(values, 'duration');
      if (duration > MAX_DURATION) {
        throw new CliError(
          `--duration cannot exceed ${MAX_DURATION} seconds (365 days), got ${duration}`,
          'invalid_option',
        );
      }
      const args: AcquireArgs = {
        ...transactionArgs(values),
        service: requireString(values, 'service'),
        ...networkArgs(values),
        service: serviceFrom(values, options),
        calls: requirePositiveInt(values, 'calls'),
        duration: requireDuration(values),
        secret,
        dryRun,
        json: values.json === true,
      };
      return { command: 'acquire', args };
    }
    case 'quote': {
      ensureNoPositionals(positionals);
      return {
        command: 'quote',
        args: {
          ...networkArgs(values),
          service: requireString(values, 'service'),
          calls: requirePositiveInt(values, 'calls'),
          json: values.json === true,
        },
      };
    }
    case 'env': {
      ensureNoPositionals(positionals);
      const args: EnvArgs = {
        service: serviceFrom(values, options),
        file: optionalString(values, 'file') ?? '.env',
        json: values.json === true,
      };
      return { command: 'env', args };
    }
    case 'status': {
      ensureNoPositionals(positionals);
      const args: StatusArgs = {
        ...networkArgs(values),
        lease: optionalString(values, 'lease'),
        token: optionalString(values, 'token'),
        checkChain: values['check-chain'] === true,
        json: values.json === true,
      };
      if (!args.lease && !args.token) {
        throw new CliError('status requires either --lease <id> or --token <session-token>', 'missing_option');
      }
      if (args.checkChain && !args.token) {
        throw new CliError('--check-chain requires --token <session-token>', 'invalid_option');
      }
      return { command: 'status', args };
    }
    case 'settle': {
      ensureNoPositionals(positionals);
      return {
        command: 'settle',
        args: {
          ...transactionArgs(values),
          lease: requireLeaseIds(values),
          secret: requireString(values, 'secret'),
          json: values.json === true,
        },
      };
    }
    case 'revoke': {
      ensureNoPositionals(positionals);
      return {
        command: 'revoke',
        args: {
          ...transactionArgs(values),
          lease: requireLeaseIds(values),
          secret: requireString(values, 'secret'),
          json: values.json === true,
        },
      };
    }
    case 'use-call': {
      ensureNoPositionals(positionals);
      return {
        command: 'use-call',
        args: {
          ...networkArgs(values),
          lease: requireString(values, 'lease'),
          count: requirePositiveInt(values, 'count'),
          secret: requireString(values, 'secret'),
          json: values.json === true,
        },
      };
    }
    case 'release': {
      ensureNoPositionals(positionals);
      return {
        command: 'release',
        args: {
          ...networkArgs(values),
          lease: requireString(values, 'lease'),
          secret: requireString(values, 'secret'),
          json: values.json === true,
        },
      };
    }
    case 'sessions': {
      ensureNoPositionals(positionals);
      return {
        command: 'sessions',
        args: { prune: values.prune === true, json: values.json === true },
      };
    }
    case 'completions': {
      const shell = positionals[0];
      if (shell === undefined) {
        throw new CliError(
          'completions requires a shell (supported: bash, zsh, fish)',
          'missing_option',
        );
      }
      if (positionals.length > 1) {
        throw new CliError(`unexpected argument "${positionals[1]}"`, 'unexpected_argument');
      }
      if (!isCompletionShell(shell)) {
        throw new CliError(
          `unsupported shell "${shell}" (supported: ${COMPLETION_SHELLS.join(', ')})`,
        );
      }
      return { command: 'completions', args: { shell } };
    }
    default:
      throw new CliError(
        `unknown command "${rawCommand}" (expected acquire, env, status, settle, revoke, release, sessions or completions)`,
        'unknown_command',
      );
  }
}

export function renderHelp(): string {
  return `${CLI_NAME} ${CLI_VERSION} - Soroban lease manager for KeyLease gateways

Usage:
  ${CLI_NAME} acquire --service <id> --calls <count> --duration <secs> --secret <key> [--fee <stroops>] [--timeout <seconds>]
  ${CLI_NAME} env     --service <id> [--file <path>]
  ${CLI_NAME} status  --lease <id> | --token <session-token> [--check-chain]
  ${CLI_NAME} settle  --lease <id>[,<id>...] [--lease <id> ...] --secret <key> [--fee <stroops>] [--timeout <seconds>]
  ${CLI_NAME} revoke  --lease <id>[,<id>...] [--lease <id> ...] --secret <key> [--fee <stroops>] [--timeout <seconds>]
  ${CLI_NAME} sessions [--prune] [--json]
  ${CLI_NAME} completions <shell>
  ${CLI_NAME} help | --version

Commands:
  acquire     Prepay a lease in keylease-core escrow and mint a session bearer token
  env         Write the temporary session keys of an acquired lease into a local .env
  status      Inspect an on-chain lease, or verify a session token offline
  settle      Settle an expired/exhausted lease: pay the provider, refund the consumer
  revoke      End a lease early and refund its unused calls
  release     Release an expired lease to claim the consumer refund
  sessions    List locally stored leases or prune expired entries
  completions Print a bash, zsh or fish completion script

Options:
  --service <id>       Service identifier the lease is scoped to (default: .keyleaserc.json)
  --calls <count>      Number of API calls the lease authorises
  --duration <secs>    Lease lifetime in seconds (max: ${MAX_DURATION_SECONDS} / 365 days)
  --secret <key>       Stellar secret seed (S...) of the consumer account
  --lease <id>         On-chain lease id (repeatable or comma-separated for settle/revoke)
  --fee <stroops>      Transaction inclusion fee in stroops (positive integer)
  --timeout <seconds>  Transaction envelope timeout (positive integer; default: 60)
  --dry-run            Quote the price of --calls without signing or submitting
  --lease <id>         On-chain lease id (decimal u64)
  --token <token>      Session bearer token to verify offline
  --check-chain        Check the token's current lease over Soroban RPC
  --file <path>        Target env file for "env" (default: .env)
  --network <name>     testnet | mainnet | local (default: testnet)
  --rpc <url>          Soroban RPC endpoint override
  --contract <id>      keylease-core contract id override
  --prune              Remove expired sessions (for "sessions")
  --json               Machine-readable JSON output
  --quiet              Suppress human-readable success output (errors still go to stderr)
  -h, --help           Show this help

Error reference:
  Contract errors are documented at:
  https://github.com/KeyLease-Security/keylease-gateway#contract-reference
  See the "Contract failures" section for error codes and meanings.
Configuration:
  .keyleaserc.json in the working directory may set network, rpc, contract and
  defaultService. Precedence: flag > KEYLEASE_* environment > file > default.
`;
}

export const consoleIo: CliIo = {
  out(line = ''): void {
    process.stdout.write(`${line}\n`);
  },
  err(line = ''): void {
    process.stderr.write(`${line}\n`);
  },
};

const META_COMMANDS = new Set(['help', '--help', '-h', 'version', '--version', '-V']);

/** Commands that must work even if a checked-in config file is broken. */
function isMetaInvocation(argv: string[]): boolean {
  const command = argv[0];
  return command === undefined || META_COMMANDS.has(command);
}

interface InvocationFlags extends NetworkArgs {
  service?: string | undefined;
}

/** The network/service flags explicitly passed to `invocation`, if any. */
function invocationFlags(invocation: Invocation): InvocationFlags {
  if (!('args' in invocation)) return {};
  const args = invocation.args as Partial<InvocationFlags>;
  return {
    network: args.network,
    rpc: args.rpc,
    contract: args.contract,
    service: 'service' in invocation.args ? args.service : undefined,
  };
}

/** Applies resolved network settings to commands that talk to Soroban RPC. */
function withResolvedNetwork(invocation: Invocation, resolved: ResolvedConfig): Invocation {
  if (!('args' in invocation) || !('network' in invocation.args)) return invocation;
  return {
    ...invocation,
    args: {
      ...invocation.args,
      network: resolved.network,
      rpc: resolved.rpc,
      contract: resolved.contract,
    },
  } as Invocation;
}

/**
 * Detects whether --json flag is present in argv.
 * Used early to determine error rendering mode.
 */
function hasJsonFlag(argv: string[]): boolean {
  return argv.includes('--json');
}

/** Parses and dispatches a CLI invocation, returning a process exit code. */
export async function run(
  argv: string[],
  baseIo: CliIo = consoleIo,
  deps: RunDeps = {},
): Promise<number> {
  const json = hasJsonFlag(argv);

  let invocation: Invocation;
  try {
    if (isMetaInvocation(argv)) {
      invocation = parseArgv(argv);
    } else {
      const env = deps.environment ?? process.env;
      const file = deps.config ?? (await loadConfigFile(deps.cwd ?? process.cwd()));
      const defaults = resolveConfig({ env, file });
      const parsed = parseArgv(argv, { defaultService: defaults.service });
      invocation = withResolvedNetwork(
        parsed,
        resolveConfig({ flags: invocationFlags(parsed), env, file }),
      );
    }
  } catch (error) {
    if (error instanceof CliError) {
      renderError(error, io, json);
      return error.exitCode;
    }
    throw error;
  }

  try {
    switch (invocation.command) {
      case 'help':
        io.out(renderHelp());
        return 0;
      case 'version':
        io.out(`${CLI_NAME} ${CLI_VERSION}`);
        return 0;
      case 'acquire':
        return await acquireCommand(invocation.args, io, deps.acquire);
      case 'quote':
        return await quoteCommand(invocation.args, io, deps.quote);
      case 'env':
        return await envCommand(invocation.args, io, deps.env);
      case 'status':
        return await statusCommand(invocation.args, io, deps.status);
      case 'settle':
        return await settleCommand(invocation.args, io, deps.settle);
      case 'revoke':
        return await revokeCommand(invocation.args, io, deps.revoke);
      case 'use-call':
        return await useCallCommand(invocation.args, io, deps['use-call']);
      case 'sessions':
        return await sessionsCommand(invocation.args, io, deps.sessions);
      case 'completions':
        return await completionsCommand(invocation.args, io);
    }
  } catch (error) {
    if (error instanceof CliError) {
      renderError(error, io, json);
      return error.exitCode;
    }
    renderError(error, io, json);
    return 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
