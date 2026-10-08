import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { CliError, parseArgv, renderHelp, run, type CliIo } from './index.js';
import type { AcquireArgs, LeaseSession } from './commands/lease.js';

const NOW_MS = 1_700_000_000_000;
const SECRET = Keypair.random().secret();

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (line = '') => out.push(line),
      err: (line = '') => err.push(line),
    },
  };
}

function memoryStore(initial: Record<string, LeaseSession> = {}) {
  const sessions: Record<string, LeaseSession> = { ...initial };
  return {
    sessions,
    load: async () => sessions,
    save: async (session: LeaseSession) => {
      sessions[session.service] = session;
    },
  };
}

function expectCliError(fn: () => unknown, code: string): CliError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    const cliError = error as CliError;
    expect(cliError.code).toBe(code);
    expect(cliError.exitCode).toBe(2);
    return cliError;
  }
  throw new Error(`expected CliError ${code}`);
}

describe('parseArgv', () => {
  it('returns help for an empty argv', () => {
    expect(parseArgv([])).toEqual({ command: 'help' });
    expect(parseArgv(['--help'])).toEqual({ command: 'help' });
    expect(parseArgv(['acquire', '--help'])).toEqual({ command: 'help' });
  });

  it('returns the version for --version', () => {
    expect(parseArgv(['--version'])).toEqual({ command: 'version' });
    expect(parseArgv(['-V'])).toEqual({ command: 'version' });
  });

  it('parses a complete acquire invocation', () => {
    const invocation = parseArgv([
      'acquire',
      '--service',
      'weather-api',
      '--calls',
      '25',
      '--duration',
      '3600',
      '--secret',
      SECRET,
    ]);

    expect(invocation.command).toBe('acquire');
    const args = (invocation as { args: AcquireArgs }).args;
    expect(args).toMatchObject({
      service: 'weather-api',
      calls: 25,
      duration: 3600,
      secret: SECRET,
      json: false,
    });
    expect(typeof args.calls).toBe('number');
  });

  it('supports --flag=value syntax and option shorthands', () => {
    const invocation = parseArgv([
      'acquire',
      '--service=weather-api',
      '--calls=1',
      '--duration=60',
      `--secret=${SECRET}`,
      '--network=local',
      '--json',
    ]);
    expect(invocation.command).toBe('acquire');
    const args = (invocation as { args: AcquireArgs }).args;
    expect(args.service).toBe('weather-api');
    expect(args.network).toBe('local');
    expect(args.json).toBe(true);
  });

  it('requires --service, --calls, --duration and --secret for acquire', () => {
    expectCliError(() => parseArgv(['acquire']), 'missing_option');
    expectCliError(
      () => parseArgv(['acquire', '--calls', '5', '--duration', '60', '--secret', SECRET]),
      'missing_option',
    );
    expectCliError(
      () => parseArgv(['acquire', '--service', 'x', '--duration', '60', '--secret', SECRET]),
      'missing_option',
    );
    expectCliError(
      () => parseArgv(['acquire', '--service', 'x', '--calls', '5', '--secret', SECRET]),
      'missing_option',
    );
    expectCliError(
      () => parseArgv(['acquire', '--service', 'x', '--calls', '5', '--duration', '60']),
      'missing_option',
    );
  });

  it('validates numeric flags', () => {
    expectCliError(
      () =>
        parseArgv([
          'acquire',
          '--service',
          'x',
          '--calls',
          'many',
          '--duration',
          '60',
          '--secret',
          SECRET,
        ]),
      'invalid_option',
    );
    expectCliError(
      () =>
        parseArgv([
          'acquire',
          '--service',
          'x',
          '--calls',
          '0',
          '--duration',
          '60',
          '--secret',
          SECRET,
        ]),
      'invalid_option',
    );
    expectCliError(
      () =>
        parseArgv([
          'acquire',
          '--service',
          'x',
          '--calls',
          '5',
          '--duration=-10',
          '--secret',
          SECRET,
        ]),
      'invalid_option',
    );
    // A negative value in token position is read as flags, still a usage error.
    expectCliError(
      () =>
        parseArgv([
          'acquire',
          '--service',
          'x',
          '--calls',
          '5',
          '--duration',
          '-10',
          '--secret',
          SECRET,
        ]),
      'parse_error',
    );
  });

  it('rejects unknown commands, flags and stray positionals', () => {
    expectCliError(() => parseArgv(['destroy', '--service', 'x']), 'unknown_command');
    expectCliError(
      () =>
        parseArgv([
          'acquire',
          '--service',
          'x',
          '--calls',
          '1',
          '--duration',
          '1',
          '--secret',
          SECRET,
          '--force',
        ]),
      'parse_error',
    );
    expectCliError(
      () =>
        parseArgv([
          'acquire',
          'extra',
          '--service',
          'x',
          '--calls',
          '1',
          '--duration',
          '1',
          '--secret',
          SECRET,
        ]),
      'unexpected_argument',
    );
  });

  it('defaults env to .env and requires a lease or token for status', () => {
    const envInvocation = parseArgv(['env', '--service', 'weather-api']);
    expect(envInvocation).toEqual({
      command: 'env',
      args: { service: 'weather-api', file: '.env', json: false },
    });

    expectCliError(() => parseArgv(['status']), 'missing_option');
    expect(parseArgv(['status', '--lease', 'lease-1']).command).toBe('status');
    expect(parseArgv(['status', '--token', 'kls1.a.b']).command).toBe('status');
  });
});

describe('renderHelp', () => {
  it('documents every command', () => {
    const help = renderHelp();
    for (const needle of ['acquire', 'env', 'status', '--secret', '--service']) {
      expect(help).toContain(needle);
    }
  });
});

describe('run', () => {
  it('prints help and version', async () => {
    const help = captureIo();
    expect(await run([], help.io)).toBe(0);
    expect(help.out.join('\n')).toContain('Usage:');

    const version = captureIo();
    expect(await run(['--version'], version.io)).toBe(0);
    expect(version.out.join('\n')).toContain('keylease');
  });

  it('returns exit code 2 for usage errors', async () => {
    const { io, err } = captureIo();
    expect(await run(['acquire', '--service', 'x'], io)).toBe(2);
    expect(err.join('\n')).toContain('error:');
  });

  it('returns exit code 2 for unknown commands', async () => {
    const { io, err } = captureIo();
    expect(await run(['explode'], io)).toBe(2);
    expect(err.join('\n')).toContain('unknown command');
  });

  it('dispatches acquire to the command with injected dependencies', async () => {
    const store = memoryStore();
    const { io, out, err } = captureIo();
    const seen: unknown[] = [];

    const code = await run(
      [
        'acquire',
        '--service',
        'weather-api',
        '--calls',
        '5',
        '--duration',
        '300',
        '--secret',
        SECRET,
      ],
      io,
      {
        acquire: {
          now: () => NOW_MS,
          store,
          createClient: () => ({
            createLease: async (params) => {
              seen.push(params);
              return { leaseId: 'lease-abc', txHash: 'deadbeef' };
            },
          }),
        },
      },
    );

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(store.sessions['weather-api']).toBeDefined();
    const session = store.sessions['weather-api'] as LeaseSession;
    expect(session.leaseId).toBe('lease-abc');
    expect(session.token.startsWith('kls1.')).toBe(true);
    expect(out.join('\n')).toContain('Authorization: Bearer kls1.');
    expect(seen).toHaveLength(1);
  });

  it('returns exit code 1 when a command fails', async () => {
    const { io, err } = captureIo();
    const code = await run(
      ['acquire', '--service', 'x', '--calls', '1', '--duration', '1', '--secret', SECRET],
      io,
      {
        acquire: {
          createClient: () => ({
            createLease: async () => {
              throw new Error('rpc exploded');
            },
          }),
        },
      },
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('rpc exploded');
  });

  it('reports a missing lease for env with exit code 1', async () => {
    const { io, err } = captureIo();
    const code = await run(['env', '--service', 'missing'], io, { env: { store: memoryStore() } });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('no lease found');
  });
});
