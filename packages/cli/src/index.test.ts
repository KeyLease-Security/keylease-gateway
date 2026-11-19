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
    saveAll: async (next: Record<string, LeaseSession>) => {
      for (const service of Object.keys(sessions)) delete sessions[service];
      Object.assign(sessions, next);
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

  it('validates --rpc URLs with valid http and https schemes', () => {
    const validUrls = [
      'https://soroban-testnet.stellar.org',
      'https://mainnet.sorobanrpc.com',
      'http://localhost:8000/soroban/rpc',
      'http://127.0.0.1:8000/soroban/rpc',
      'http://[::1]:8000/soroban/rpc',
    ];

    for (const url of validUrls) {
      const invocation = parseArgv([
        'acquire',
        '--service',
        'weather-api',
        '--calls',
        '1',
        '--duration',
        '60',
        '--secret',
        SECRET,
        '--rpc',
        url,
      ]);
      expect(invocation.command).toBe('acquire');
      const args = (invocation as { args: AcquireArgs }).args;
      expect(args.rpc).toBe(url);
    }
  });

  it('rejects --rpc URLs with invalid schemes', () => {
    const invalidUrls = [
      'ftp://example.com',
      'file:///path/to/file',
      'htps://typo.example.com',
      'htp://typo.example.com',
    ];

    for (const url of invalidUrls) {
      const error = expectCliError(
        () =>
          parseArgv([
            'acquire',
            '--service',
            'weather-api',
            '--calls',
            '1',
            '--duration',
            '60',
            '--secret',
            SECRET,
            '--rpc',
            url,
          ]),
        'invalid_option',
      );
      expect(error.message).toContain(url);
      expect(error.message).toContain('scheme');
    }
  });

  it('rejects --rpc URLs that are not valid URLs', () => {
    const invalidUrls = [
      'not-a-url',
      'htps://example.com',
      'localhost:8000',
      '192.168.1.1:8000',
    ];

    for (const url of invalidUrls) {
      const error = expectCliError(
        () =>
          parseArgv([
            'acquire',
            '--service',
            'weather-api',
            '--calls',
            '1',
            '--duration',
            '60',
            '--secret',
            SECRET,
            '--rpc',
            url,
          ]),
        'invalid_option',
      );
      expect(error.message).toContain(url);
    }
  });

  it('rejects http: URLs that are not localhost', () => {
    const nonLocalHostUrls = [
      'http://example.com',
      'http://192.168.1.1',
      'http://staging.example.com:8000',
    ];

    for (const url of nonLocalHostUrls) {
      const error = expectCliError(
        () =>
          parseArgv([
            'acquire',
            '--service',
            'weather-api',
            '--calls',
            '1',
            '--duration',
            '60',
            '--secret',
            SECRET,
            '--rpc',
            url,
          ]),
        'invalid_option',
      );
      expect(error.message).toContain(url);
      expect(error.message).toContain('localhost');
    }
  });

  it('parses --dry-run acquire without a secret', () => {
    const invocation = parseArgv([
      'acquire',
      '--service',
      'weather-api',
      '--calls',
      '5',
      '--duration',
      '300',
      '--dry-run',
    ]);
    expect(invocation.command).toBe('acquire');
    expect((invocation as { args: AcquireArgs }).args).toMatchObject({
      service: 'weather-api',
      calls: 5,
      duration: 300,
      secret: undefined,
      dryRun: true,
      json: false,
    });

    const withSecret = parseArgv([
      'acquire',
      '--service',
      'weather-api',
      '--calls',
      '5',
      '--duration',
      '300',
      '--dry-run',
      '--secret',
      SECRET,
    ]);
    expect((withSecret as { args: AcquireArgs }).args.dryRun).toBe(true);
    expect((withSecret as { args: AcquireArgs }).args.secret).toBe(SECRET);
  });

  it('requires --secret unless --dry-run is set', () => {
    const error = expectCliError(
      () => parseArgv(['acquire', '--service', 'x', '--calls', '1', '--duration', '1']),
      'missing_option',
    );
    expect(error.message).toContain('--dry-run');
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

  it('parses sessions list and prune flags', () => {
    expect(parseArgv(['sessions'])).toEqual({
      command: 'sessions',
      args: { prune: false, json: false },
    });
    expect(parseArgv(['sessions', '--prune', '--json'])).toEqual({
      command: 'sessions',
      args: { prune: true, json: true },
    });
  });

  it('parses --check-chain only with status tokens', () => {
    expect(parseArgv(['status', '--token', 'kls1.a.b'])).toEqual({
      command: 'status',
      args: { lease: undefined, token: 'kls1.a.b', checkChain: false, json: false },
    });
    expect(parseArgv(['status', '--token', 'kls1.a.b', '--check-chain', '--json'])).toEqual({
      command: 'status',
      args: { lease: undefined, token: 'kls1.a.b', checkChain: true, json: true },
    });
    expectCliError(() => parseArgv(['status', '--lease', '42', '--check-chain']), 'invalid_option');
  });
});

describe('renderHelp', () => {
  it('documents every command', () => {
    const help = renderHelp();
    for (const needle of [
      'acquire',
      'env',
      'status',
      'sessions',
      'completions',
      '--prune',
      '--check-chain',
      '--dry-run',
      '--secret',
      '--service',
      '.keyleaserc.json',
    ]) {
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
            quote: async () => 10,
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
            quote: async () => 10,
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

  it('dispatches sessions to the command with injected dependencies', async () => {
    const now = Math.floor(NOW_MS / 1000);
    const store = memoryStore({
      'weather-api': {
        service: 'weather-api',
        leaseId: 'lease-abc',
        consumer: 'GCONSUMER',
        token: 'kls1.payload.signature',
        callsLimit: 5,
        issuedAt: now - 60,
        expiresAt: now + 60,
        txHash: null,
        network: 'testnet',
      },
    });
    const { io, out } = captureIo();

    expect(
      await run(['sessions', '--json'], io, {
        sessions: { store, now: () => NOW_MS },
      }),
    ).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual([
      {
        service: 'weather-api',
        lease_id: 'lease-abc',
        expires_at: now + 60,
        status: 'active',
      },
    ]);
  });

  it('parses and dispatches release command', async () => {
    const { io, out } = captureIo();
    const parsed = parseArgv(['release', '--lease', '42', '--secret', SECRET, '--json']);
    expect(parsed).toEqual({
      command: 'release',
      args: {
        lease: '42',
        secret: SECRET,
        json: true,
        network: undefined,
        rpc: undefined,
        contract: undefined,
      },
    });

    const code = await run(['release', '--lease', '42', '--secret', SECRET, '--json'], io, {
      release: {
        createClient: () => ({
          release: async () => ({
            leaseId: '42',
            refunded: 5000,
            txHash: '0x123',
            lease: {
              leaseId: '42',
              service: 'test',
              provider: 'GP',
              consumer: 'GC',
              callsLimit: 10,
              callsUsed: 5,
              expiresAt: 1000,
              active: false,
              settled: true,
              pricePaid: 10000,
            },
          }),
        }),
      },
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual({
      leaseId: '42',
      refunded: 5000,
      txHash: '0x123',
    });
  });
});
