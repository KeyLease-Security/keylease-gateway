import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NETWORKS } from './client/soroban.js';
import { CliError } from './errors.js';

/** Checked-in config file `keylease` reads from the working directory. */
export const CONFIG_FILE_NAME = '.keyleaserc.json';

/** The only keys `.keyleaserc.json` may contain. */
export const CONFIG_KEYS = ['network', 'rpc', 'contract', 'defaultService'] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** Contents of `.keyleaserc.json`; every key is optional. */
export type KeyleaseConfigFile = Partial<Record<ConfigKey, string>>;

/** Network used when neither a flag, nor the environment, nor the file sets one. */
export const DEFAULT_NETWORK = 'testnet';

/** Per-key source layers, ordered by precedence: flags > env > file > default. */
export interface ConfigLayers {
  flags?: {
    network?: string | undefined;
    rpc?: string | undefined;
    contract?: string | undefined;
    service?: string | undefined;
  };
  env?: Record<string, string | undefined>;
  file?: KeyleaseConfigFile;
}

/** Fully resolved network/service settings for one CLI invocation. */
export interface ResolvedConfig {
  network: string;
  rpc: string | undefined;
  contract: string | undefined;
  service: string | undefined;
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

/**
 * Parses and validates `.keyleaserc.json` text.
 *
 * Unknown keys and non-string/empty values are rejected with an actionable
 * {@link CliError} so a typo in a checked-in file fails loudly rather than
 * being silently ignored.
 */
export function parseConfigFile(text: string, path: string = CONFIG_FILE_NAME): KeyleaseConfigFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(`${path} is not valid JSON: ${detail}`, 'invalid_config');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      `${path} must contain a JSON object with optional keys: ${CONFIG_KEYS.join(', ')}`,
      'invalid_config',
    );
  }

  const record = parsed as Record<string, unknown>;
  const known = new Set<string>(CONFIG_KEYS);
  const unknown = Object.keys(record).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new CliError(
      `${path} has unknown ${unknown.length === 1 ? 'key' : 'keys'} ` +
        `${unknown.map((key) => `"${key}"`).join(', ')} ` +
        `(supported keys: ${CONFIG_KEYS.join(', ')})`,
      'invalid_config',
    );
  }

  const config: KeyleaseConfigFile = {};
  for (const key of CONFIG_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new CliError(
        `${path}: "${key}" must be a non-empty string, got ${describeValue(value)}`,
        'invalid_config',
      );
    }
    config[key] = value;
  }
  return config;
}

/**
 * Loads `.keyleaserc.json` from `cwd`. A missing file is not an error and
 * resolves to an empty config; unreadable or invalid files are.
 */
export async function loadConfigFile(cwd: string = process.cwd()): Promise<KeyleaseConfigFile> {
  const path = join(cwd, CONFIG_FILE_NAME);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return {};
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(`Cannot read ${path}: ${detail}`, 'invalid_config');
  }
  return parseConfigFile(text, path);
}

function firstValue(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Applies the documented precedence for every key:
 * flag > environment (`KEYLEASE_*`) > `.keyleaserc.json` > built-in default.
 *
 * The service id follows the same order, with `defaultService` in the file and
 * `KEYLEASE_SERVICE` standing in for a missing `--service`.
 */
export function resolveConfig(layers: ConfigLayers = {}): ResolvedConfig {
  const flags = layers.flags ?? {};
  const env = layers.env ?? {};
  const file = layers.file ?? {};

  const network =
    firstValue(flags.network, env['KEYLEASE_NETWORK'], file.network) ?? DEFAULT_NETWORK;
  if (!Object.hasOwn(NETWORKS, network)) {
    throw new CliError(
      `unknown network "${network}" (expected one of: ${Object.keys(NETWORKS).join(', ')})`,
      'invalid_option',
    );
  }

  return {
    network,
    rpc: firstValue(flags.rpc, env['KEYLEASE_RPC_URL'], file.rpc),
    contract: firstValue(
      flags.contract,
      env['KEYLEASE_CONTRACT_ID'],
      env['KEYLEASE_CONTRACT'],
      file.contract,
    ),
    service: firstValue(flags.service, env['KEYLEASE_SERVICE'], file.defaultService),
  };
}
