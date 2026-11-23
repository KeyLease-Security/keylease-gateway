import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StrKey } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FILE_NAME,
  DEFAULT_NETWORK,
  loadConfigFile,
  parseConfigFile,
  resolveConfig,
} from './config.js';
import { CliError, parseArgv, run, type CliIo } from './index.js';
import type { LeaseSession } from './commands/lease.js';

const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));

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

function sessionFor(service: string): LeaseSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    service,
    leaseId: '42',
    consumer: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1)),
    token: 'kls1.payload.signature',
    callsLimit: 5,
    issuedAt: now - 10,
    expiresAt: now + 3600,
    txHash: null,
    network: 'testnet',
  };
}

function expectCliError(fn: () => unknown, code: string): CliError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(code);
    return error as CliError;
  }
  throw new Error(`expected CliError ${code}`);
}

describe('parseConfigFile', () => {
  it('accepts every supported key', () => {
    expect(
      parseConfigFile(
        JSON.stringify({
          network: 'local',
          rpc: 'http://localhost:8000/soroban/rpc',
          contract: CONTRACT,
          defaultService: 'weather-api',
        }),
      ),
    ).toEqual({
      network: 'local',
      rpc: 'http://localhost:8000/soroban/rpc',
      contract: CONTRACT,
      defaultService: 'weather-api',
    });
  });

  it('rejects unknown keys with an actionable error', () => {
    const error = expectCliError(
      () => parseConfigFile('{"network":"testnet","netwrok":"local"}', CONFIG_FILE_NAME),
      'invalid_config',
    );
    expect(error.message).toContain('unknown key "netwrok"');
    expect(error.message).toContain('supported keys: network, rpc, contract, defaultService');
  });

  it('rejects wrong types and empty values', () => {
    for (const json of ['{"network":1}', '{"rpc":null}', '{"contract":""}', '{"defaultService":[]}']) {
      const error = expectCliError(() => parseConfigFile(json, CONFIG_FILE_NAME), 'invalid_config');
      expect(error.message).toMatch(/must be a non-empty string/);
    }
  });

  it('rejects invalid JSON and non-object documents', () => {
    expect(() => parseConfigFile('{', CONFIG_FILE_NAME)).toThrow(/not valid JSON/);
    expect(() => parseConfigFile('["testnet"]', CONFIG_FILE_NAME)).toThrow(/JSON object/);
  });
});

describe('loadConfigFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'keylease-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('ignores a missing file', async () => {
    expect(await loadConfigFile(dir)).toEqual({});
  });

  it('reads and validates the file in the working directory', async () => {
    await writeFile(
      join(dir, CONFIG_FILE_NAME),
      JSON.stringify({ network: 'local', defaultService: 'weather-api' }),
    );
    expect(await loadConfigFile(dir)).toEqual({ network: 'local', defaultService: 'weather-api' });
  });

  it('names the file when it is not valid JSON', async () => {
    const path = join(dir, CONFIG_FILE_NAME);
    await writeFile(path, 'nope');
    await expect(loadConfigFile(dir)).rejects.toThrow(new RegExp(`${path} is not valid JSON`));
  });
});

describe('resolveConfig', () => {
  it('falls back to the documented defaults', () => {
    expect(resolveConfig()).toEqual({
      network: DEFAULT_NETWORK,
      rpc: undefined,
      contract: undefined,
      service: undefined,
    });
    expect(DEFAULT_NETWORK).toBe('testnet');
  });

  it('reads every key from the file', () => {
    expect(
      resolveConfig({
        file: {
          network: 'local',
          rpc: 'http://localhost:8000/soroban/rpc',
          contract: CONTRACT,
          defaultService: 'weather-api',
        },
      }),
    ).toEqual({
      network: 'local',
      rpc: 'http://localhost:8000/soroban/rpc',
      contract: CONTRACT,
      service: 'weather-api',
    });
  });

  it('lets the environment beat the file', () => {
    const resolved = resolveConfig({
      file: {
        network: 'local',
        rpc: 'http://file',
        contract: CONTRACT,
        defaultService: 'from-file',
      },
      env: {
        KEYLEASE_NETWORK: 'mainnet',
        KEYLEASE_RPC_URL: 'http://env',
        KEYLEASE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32, 9)),
        KEYLEASE_SERVICE: 'from-env',
      },
    });
    expect(resolved.network).toBe('mainnet');
    expect(resolved.rpc).toBe('http://env');
    expect(resolved.contract).toBe(StrKey.encodeContract(Buffer.alloc(32, 9)));
    expect(resolved.service).toBe('from-env');
  });

  it('lets flags beat the environment and the file', () => {
    const resolved = resolveConfig({
      flags: {
        network: 'testnet',
        rpc: 'http://flag',
        contract: CONTRACT,
        service: 'from-flag',
      },
      env: { KEYLEASE_NETWORK: 'mainnet', KEYLEASE_RPC_URL: 'http://env', KEYLEASE_SERVICE: 'env' },
      file: { network: 'local', rpc: 'http://file', defaultService: 'file' },
    });
    expect(resolved).toEqual({
      network: 'testnet',
      rpc: 'http://flag',
      contract: CONTRACT,
      service: 'from-flag',
    });
  });

  it('rejects an unknown network from any layer', () => {
    expect(() => resolveConfig({ file: { network: 'moon' } })).toThrow(/unknown network "moon"/);
    expect(() => resolveConfig({ flags: { network: 'moon' } })).toThrow(/testnet, mainnet, local/);
  });
});

describe('service default', () => {
  it('lets --service be omitted when a default is configured', () => {
    expect(parseArgv(['env'], { defaultService: 'weather-api' })).toEqual({
      command: 'env',
      args: { service: 'weather-api', file: '.env', json: false },
    });
    expect(parseArgv(['env', '--service', 'maps-api'], { defaultService: 'weather-api' })).toEqual({
      command: 'env',
      args: { service: 'maps-api', file: '.env', json: false },
    });
  });

  it('still requires a service when nothing is configured', () => {
    expectCliError(() => parseArgv(['env']), 'missing_option');
  });
});

describe('run with .keyleaserc.json', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'keylease-run-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uses defaultService from the file', async () => {
    await writeFile(join(dir, CONFIG_FILE_NAME), JSON.stringify({ defaultService: 'from-file' }));
    const { io, out, err } = captureIo();
    const store = memoryStore({ 'from-file': sessionFor('from-file') });

    const code = await run(
      ['env', '--file', join(dir, '.env'), '--json'],
      io,
      { cwd: dir, environment: {}, env: { store } },
    );

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(out.join('\n')).file).toBe(join(dir, '.env'));
    expect((await readFile(join(dir, '.env'), 'utf8')).includes('KEYLEASE_SERVICE=from-file')).toBe(
      true,
    );
  });

  it('lets KEYLEASE_SERVICE and --service win over the file', async () => {
    await writeFile(join(dir, CONFIG_FILE_NAME), JSON.stringify({ defaultService: 'from-file' }));
    const store = memoryStore({
      'from-env': sessionFor('from-env'),
      'from-flag': sessionFor('from-flag'),
    });

    const fromEnv = captureIo();
    expect(
      await run(['env', '--file', join(dir, 'env'), '--json'], fromEnv.io, {
        cwd: dir,
        environment: { KEYLEASE_SERVICE: 'from-env' },
        env: { store },
      }),
    ).toBe(0);

    const fromFlag = captureIo();
    expect(
      await run(['env', '--service', 'from-flag', '--file', join(dir, 'flag'), '--json'], fromFlag.io, {
        cwd: dir,
        environment: { KEYLEASE_SERVICE: 'from-env' },
        env: { store },
      }),
    ).toBe(0);

    expect(await readFile(join(dir, 'env'), 'utf8')).toContain('KEYLEASE_SERVICE=from-env');
    expect(await readFile(join(dir, 'flag'), 'utf8')).toContain('KEYLEASE_SERVICE=from-flag');
  });

  it('reports an invalid config with exit code 2', async () => {
    await writeFile(join(dir, CONFIG_FILE_NAME), '{"network":"testnet","typo":true}');
    const { io, err } = captureIo();

    expect(await run(['env', '--service', 'weather-api'], io, { cwd: dir })).toBe(2);
    expect(err.join('\n')).toContain('unknown key "typo"');
  });

  it('still prints help and version when the config file is broken', async () => {
    await writeFile(join(dir, CONFIG_FILE_NAME), 'not json');
    const version = captureIo();
    expect(await run(['--version'], version.io, { cwd: dir })).toBe(0);
    expect(version.out.join('\n')).toContain('keylease 0.1.0');

    const help = captureIo();
    expect(await run(['help'], help.io, { cwd: dir })).toBe(0);
    expect(help.out.join('\n')).toContain('Usage:');
  });
});
