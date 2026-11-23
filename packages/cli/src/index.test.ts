import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { CliError, parseArgv, renderHelp, run, type CliIo } from './index.js';
import type { AcquireArgs, LeaseSession, QuoteArgs } from './commands/lease.js';
import { ContractCallError } from './client/soroban.js';

const NOW_MS = 1_700_000_000_000;
const NOW = NOW_MS / 1000;
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
      '--fee=2500',
      '--timeout=90',
      '--json',
    ]);
    expect(invocation.command).toBe('acquire');
    const args = (invocation as { args: AcquireArgs }).args;
    expect(args.service).toBe('weather-api');
    expect(args.network).toBe('local');
    expect(args.fee).toBe(2_500);
    expect(args.timeout).toBe(90);
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
    // --secret is now optional, so omitting it is valid
    const valid = parseArgv(['acquire', '--service', 'x', '--calls', '5', '--duration', '60']);
    expect(valid.command).toBe('acquire');
    const args = (valid as { args: AcquireArgs }).args;
    expect(args.secret).toBeUndefined();
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
    expectCliError(
      () =>
        parseArgv([
          'acquire',
          '--service',
          'x',
          '--calls',
          '1000001',
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
          '--duration',
          '31536001',
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

  it('validates the maximum duration (365 days)', () => {
    const maxSeconds = 365 * 24 * 60 * 60; // 31536000

    // Exactly at the limit: should pass
    const atLimit = parseArgv([
      'acquire',
      '--service',
      'x',
      '--calls',
      '1',
      `--duration=${maxSeconds}`,
      '--secret',
      SECRET,
    ]);
    expect(atLimit.command).toBe('acquire');
    expect((atLimit as { args: AcquireArgs }).args.duration).toBe(maxSeconds);

    // One second over: should fail
    const error = expectCliError(
      () =>
        parseArgv([
          'acquire',
          '--service',
          'x',
          '--calls',
          '1',
          `--duration=${maxSeconds + 1}`,
          '--secret',
          SECRET,
        ]),
      'invalid_option',
    );
    expect(error.message).toContain('365 days');
    expect(error.message).toContain(String(maxSeconds));

    // Zero should still fail (caught by requirePositiveInt)
    expectCliError(
      () =>
        parseArgv([
          'acquire',
          '--service',
          'x',
          '--calls',
          '1',
          '--duration=0',
          '--secret',
          SECRET,
        ]),
      'invalid_option',
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

  it('parses use-call with a lease, count and secret', () => {
    expect(
      parseArgv(['use-call', '--lease', '42', '--count', '3', '--secret', SECRET, '--json']),
    ).toEqual({
      command: 'use-call',
      args: { lease: '42', count: 3, secret: SECRET, json: true },
    });
    expectCliError(
      () => parseArgv(['use-call', '--lease', '42', '--secret', SECRET]),
      'missing_option',
    );
    expectCliError(
      () => parseArgv(['use-call', '--lease', '42', '--count', '0', '--secret', SECRET]),
      'invalid_option',
    );
  });

  it('parses whoami with optional network flags and secret', () => {
    expect(parseArgv(['whoami'])).toEqual({
      command: 'whoami',
      args: { network: undefined, rpc: undefined, contract: undefined, secret: undefined, json: false },
    });
    expect(
      parseArgv(['whoami', '--network', 'mainnet', '--secret', SECRET, '--json']),
    ).toMatchObject({ command: 'whoami', args: { network: 'mainnet', secret: SECRET, json: true } });
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

  it('parses repeated and comma-separated lifecycle lease ids without duplicates', () => {
    expect(
      parseArgv([
        'settle',
        '--lease',
        '1,2',
        '--lease',
        '2',
        '--lease=3',
        '--secret',
        SECRET,
        '--fee',
        '5000',
        '--timeout',
        '120',
      ]),
    ).toEqual({
      command: 'settle',
      args: {
        lease: ['1', '2', '3'],
        secret: SECRET,
        json: false,
        fee: 5_000,
        timeout: 120,
      },
    });
    expect(
      parseArgv(['revoke', '--lease', '4', '--lease', '5,6', '--secret', SECRET, '--json']),
    ).toEqual({
      command: 'revoke',
      args: {
        lease: ['4', '5', '6'],
        secret: SECRET,
        json: true,
      },
    });
    expectCliError(
      () => parseArgv(['acquire', '--service', 'x', '--calls', '1', '--duration', '1', '--secret', SECRET, '--fee', '0']),
      'invalid_option',
    );
    expectCliError(
      () => parseArgv(['revoke', '--lease', '1', '--secret', SECRET, '--timeout', '1.5']),
      'invalid_option',
    );
    expectCliError(
      () => parseArgv(['settle', '--lease', '1', '--secret', SECRET, '--fee', '9007199254740992']),
      'invalid_option',
    );
    expectCliError(
      () => parseArgv(['settle', '--lease', '1,,2', '--secret', SECRET]),
      'invalid_option',
    );
    expectCliError(
      () => parseArgv(['status', '--lease', '1', '--lease', '2']),
      'invalid_option',
    );
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

  it('parses quote, rejecting zero calls and missing options', () => {
    const invocation = parseArgv(['quote', '--service', 'weather-api', '--calls', '10']);
    expect(invocation.command).toBe('quote');
    expect((invocation as { args: QuoteArgs }).args).toMatchObject({
      service: 'weather-api',
      calls: 10,
      json: false,
    });

    expectCliError(
      () => parseArgv(['quote', '--service', 'weather-api', '--calls', '0']),
      'invalid_option',
    );
    expectCliError(() => parseArgv(['quote', '--service', 'weather-api']), 'missing_option');
    expectCliError(() => parseArgv(['quote', '--calls', '5']), 'missing_option');
  });

  it('accepts the global --quiet flag anywhere in argv', () => {
    const after = parseArgv(['quote', '--service', 'weather-api', '--calls', '1', '--quiet']);
    const before = parseArgv(['--quiet', 'quote', '--service', 'weather-api', '--calls', '1']);
    expect(after).toEqual(before);
    expect(after.command).toBe('quote');
  });
});

describe('renderHelp', () => {
  it('documents every command', () => {
    const help = renderHelp();
    for (const needle of [
      'acquire',
      'env',
      'status',
      'settle',
      'revoke',
      'use-call',
      'whoami',
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

  it('outputs JSON error when --json flag is set', async () => {
    const { io, err, out } = captureIo();
    expect(await run(['acquire', '--service', 'x', '--json'], io)).toBe(2);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    const response = JSON.parse(err[0]);
    expect(response).toEqual({
      error: {
        code: 'missing_option',
        message: expect.stringContaining('--duration'),
        hint: expect.stringContaining('keylease help'),
      },
    });
  });

  it('outputs JSON error for unknown command with --json', async () => {
    const { io, err, out } = captureIo();
    expect(await run(['explode', '--json'], io)).toBe(2);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    const response = JSON.parse(err[0]);
    expect(response.error.code).toBe('unknown_command');
    expect(response.error.message).toContain('unknown command');
  });

  it('outputs JSON error for parse errors with --json', async () => {
    const { io, err, out } = captureIo();
    expect(
      await run(
        ['acquire', '--service', 'x', '--calls', 'not_a_number', '--duration', '60', '--secret', SECRET, '--json'],
        io,
      ),
    ).toBe(2);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    const response = JSON.parse(err[0]);
    expect(response.error.code).toBe('invalid_option');
    expect(response.error.message).toContain('positive integer');
  });

  it('outputs human-readable error without --json', async () => {
    const { io, err, out } = captureIo();
    expect(await run(['acquire', '--service', 'x'], io)).toBe(2);
    expect(out).toEqual([]);
    expect(err.length).toBeGreaterThan(0);
    expect(err[0]).toContain('error:');
    expect(err[0]).not.toContain('{');
  });

  it('preserves exit code 2 with JSON errors', async () => {
    const { io } = captureIo();
    const code = await run(['unknown', '--json'], io);
    expect(code).toBe(2);
  });

  it('preserves exit code 1 for command failures', async () => {
    const { io, err } = captureIo();
    const code = await run(
      ['acquire', '--service', 'x', '--calls', '1', '--duration', '1', '--secret', SECRET, '--json'],
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
    expect(err).toHaveLength(1);
    const response = JSON.parse(err[0]);
    expect(response.error.code).toBe('internal_error');
    expect(response.error.message).toBe('rpc exploded');
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
            quote: async () => 5_000,
            quote: async () => 10,
            createLease: async (params) => {
              seen.push(params);
              return { leaseId: 'lease-abc', txHash: 'deadbeef' };
            },
            getLeaseState: async () => ({
              leaseId: 'lease-abc',
              service: 'weather-api',
              provider: 'GPROVIDER',
              consumer: Keypair.fromSecret(SECRET).publicKey(),
              callsLimit: 5,
              callsUsed: 0,
              expiresAt: NOW + 300,
              active: true,
              settled: false,
              pricePaid: 5_000,
            }),
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
            quote: async () => 1_000,
            quote: async () => 10,
            createLease: async () => {
              throw new Error('rpc exploded');
            },
            getLeaseState: async () => {
              throw new Error('should not be called');
            },
          }),
        },
      },
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('rpc exploded');
  });

  it('dispatches quote and surfaces contract errors with exit code 1', async () => {
    const ok = captureIo();
    expect(
      await run(['quote', '--service', 'weather-api', '--calls', '4', '--json'], ok.io, {
        quote: { createClient: () => ({ quote: async () => 8_000_000 }) },
      }),
    ).toBe(0);
    expect(JSON.parse(ok.out.join('\n'))).toEqual({
      service: 'weather-api',
      calls: 4,
      price: 8_000_000,
      asset: 'XLM',
    });

    const bad = captureIo();
    expect(
      await run(['quote', '--service', 'ghost-api', '--calls', '1'], bad.io, {
        quote: {
          createClient: () => ({
            quote: async () => {
              throw new ContractCallError('quote', 3, 'unknown service');
            },
          }),
        },
      }),
    ).toBe(1);
    expect(bad.err.join('\n')).toContain('failed with Error(3)');
  });

  it('suppresses stdout with --quiet while still saving the session', async () => {
    const store = memoryStore();
    const { io, out, err } = captureIo();

    const code = await run(
      [
        'acquire',
        '--quiet',
        '--service',
        'quiet-api',
        '--calls',
        '2',
        '--duration',
        '60',
        '--secret',
        SECRET,
      ],
      io,
      {
        acquire: {
          now: () => NOW_MS,
          store,
          createClient: () => ({
            createLease: async () => ({ leaseId: 'lease-quiet', txHash: null }),
          }),
        },
      },
    );

    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(store.sessions['quiet-api']?.leaseId).toBe('lease-quiet');
  });

  it('keeps stderr and exit codes with --quiet', async () => {
    const unknown = captureIo();
    expect(await run(['--quiet', 'explode'], unknown.io)).toBe(2);
    expect(unknown.out).toEqual([]);
    expect(unknown.err.join('\n')).toContain('unknown command');

    const missing = captureIo();
    expect(await run(['--quiet', 'acquire', '--service', 'x'], missing.io)).toBe(2);
    expect(missing.out).toEqual([]);
    expect(missing.err.join('\n')).toContain('error:');

    const failing = captureIo();
    expect(
      await run(
        ['--quiet', 'acquire', '--service', 'x', '--calls', '1', '--duration', '1', '--secret', SECRET],
        failing.io,
        {
          acquire: {
            createClient: () => ({
              createLease: async () => {
                throw new Error('rpc exploded');
              },
            }),
          },
        },
      ),
    ).toBe(1);
    expect(failing.out).toEqual([]);
    expect(failing.err.join('\n')).toContain('rpc exploded');
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
