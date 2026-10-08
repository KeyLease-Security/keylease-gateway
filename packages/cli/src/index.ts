#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  acquireCommand,
  envCommand,
  type AcquireArgs,
  type AcquireDeps,
  type EnvArgs,
  type EnvDeps,
} from './commands/lease.js';
import { statusCommand, type StatusArgs, type StatusDeps } from './commands/status.js';

export const CLI_NAME = 'keylease';
export const CLI_VERSION = '0.1.0';

export interface CliIo {
  out(line?: string): void;
  err(line?: string): void;
}

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(message: string, code = 'usage_error', exitCode = 2) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export type CommandName = 'acquire' | 'env' | 'status';

export type Invocation =
  | { command: 'help' }
  | { command: 'version' }
  | { command: 'acquire'; args: AcquireArgs }
  | { command: 'env'; args: EnvArgs }
  | { command: 'status'; args: StatusArgs };

export interface RunDeps {
  acquire?: AcquireDeps;
  env?: EnvDeps;
  status?: StatusDeps;
}

const OPTION_SPEC = {
  service: { type: 'string' },
  calls: { type: 'string' },
  duration: { type: 'string' },
  secret: { type: 'string' },
  lease: { type: 'string' },
  token: { type: 'string' },
  network: { type: 'string' },
  rpc: { type: 'string' },
  contract: { type: 'string' },
  file: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

type ParsedOptions = {
  [K in keyof typeof OPTION_SPEC]?: (typeof OPTION_SPEC)[K]['type'] extends 'string'
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
  const value = values[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliError(`--${name} must be a non-empty value`, 'invalid_option');
  }
  return value;
}

function requirePositiveInt(values: ParsedOptions, name: keyof ParsedOptions): number {
  const raw = requireString(values, name);
  if (!/^[0-9]+$/.test(raw)) {
    throw new CliError(`--${name} must be a positive integer, got "${raw}"`, 'invalid_option');
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(`--${name} must be a positive integer, got "${raw}"`, 'invalid_option');
  }
  return parsed;
}

function networkArgs(values: ParsedOptions): {
  network?: string | undefined;
  rpc?: string | undefined;
  contract?: string | undefined;
} {
  return {
    network: optionalString(values, 'network'),
    rpc: optionalString(values, 'rpc'),
    contract: optionalString(values, 'contract'),
  };
}

function ensureNoPositionals(positionals: string[]): void {
  const first = positionals[0];
  if (first !== undefined) {
    throw new CliError(`unexpected argument "${first}"`, 'unexpected_argument');
  }
}

/**
 * Turns a raw argv slice into a typed invocation. Pure and side-effect free so
 * CLI parameter parsing can be unit tested directly.
 */
export function parseArgv(argv: string[]): Invocation {
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
      const args: AcquireArgs = {
        ...networkArgs(values),
        service: requireString(values, 'service'),
        calls: requirePositiveInt(values, 'calls'),
        duration: requirePositiveInt(values, 'duration'),
        secret: requireString(values, 'secret'),
        json: values.json === true,
      };
      return { command: 'acquire', args };
    }
    case 'env': {
      ensureNoPositionals(positionals);
      const args: EnvArgs = {
        service: requireString(values, 'service'),
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
        json: values.json === true,
      };
      if (!args.lease && !args.token) {
        throw new CliError('status requires either --lease <id> or --token <session-token>', 'missing_option');
      }
      return { command: 'status', args };
    }
    default:
      throw new CliError(
        `unknown command "${rawCommand}" (expected acquire, env or status)`,
        'unknown_command',
      );
  }
}

export function renderHelp(): string {
  return `${CLI_NAME} ${CLI_VERSION} - Soroban lease manager for KeyLease gateways

Usage:
  ${CLI_NAME} acquire --service <id> --calls <count> --duration <secs> --secret <key>
  ${CLI_NAME} env     --service <id> [--file <path>]
  ${CLI_NAME} status  --lease <id> | --token <session-token>
  ${CLI_NAME} help | --version

Commands:
  acquire   Invoke create_lease on keylease-core and mint a session bearer token
  env       Write the temporary session keys of an acquired lease into a local .env
  status    Inspect an on-chain lease, or verify a session token offline

Options:
  --service <id>       Service identifier the lease is scoped to (required)
  --calls <count>      Number of API calls the lease authorises
  --duration <secs>    Lease lifetime in seconds
  --secret <key>       Stellar secret seed (S...) of the consumer account
  --lease <id>         Lease id to inspect
  --token <token>      Session bearer token to verify offline
  --file <path>        Target env file for "env" (default: .env)
  --network <name>     testnet | mainnet | local (default: testnet)
  --rpc <url>          Soroban RPC endpoint override
  --contract <id>      keylease-core contract id override
  --json               Machine-readable JSON output
  -h, --help           Show this help
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

/** Parses and dispatches a CLI invocation, returning a process exit code. */
export async function run(
  argv: string[],
  io: CliIo = consoleIo,
  deps: RunDeps = {},
): Promise<number> {
  let invocation: Invocation;
  try {
    invocation = parseArgv(argv);
  } catch (error) {
    if (error instanceof CliError) {
      io.err(`error: ${error.message}`);
      io.err(`run "${CLI_NAME} help" for usage`);
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
      case 'env':
        return await envCommand(invocation.args, io, deps.env);
      case 'status':
        return await statusCommand(invocation.args, io, deps.status);
    }
  } catch (error) {
    if (error instanceof CliError) {
      io.err(`error: ${error.message}`);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.err(`error: ${message}`);
    return 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
