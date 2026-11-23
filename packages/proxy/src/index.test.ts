import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_CACHE_TTL_MS,
  MAX_QUOTA_BATCH,
  MAX_QUOTA_FLUSH_MS,
  ProxyConfigError,
  resolveConfig,
} from './index.js';

const base = { KEYLEASE_UPSTREAM_URL: 'https://api.example.com' } as const;

describe('resolveConfig KEYLEASE_CACHE_TTL_MS bounds', () => {
  it('defaults to 30 seconds', () => {
    expect(resolveConfig(base).cacheTtlMs).toBe(30_000);
  });

  it('accepts the documented upper bound', () => {
    expect(
      resolveConfig({ ...base, KEYLEASE_CACHE_TTL_MS: String(MAX_CACHE_TTL_MS) }).cacheTtlMs,
    ).toBe(MAX_CACHE_TTL_MS);
  });

  it('rejects zero, negative, non-numeric, fractional and over-limit values', () => {
    for (const bad of ['0', '-1', 'soon', '12.5', String(MAX_CACHE_TTL_MS + 1)]) {
      expect(() => resolveConfig({ ...base, KEYLEASE_CACHE_TTL_MS: bad })).toThrow(
        ProxyConfigError,
      );
    }
    expect(() => resolveConfig({ ...base, KEYLEASE_CACHE_TTL_MS: '30000000' })).toThrow(
      /KEYLEASE_CACHE_TTL_MS/,
    );
  });
});

describe('resolveConfig quota bounds', () => {
  it('uses the same bounded helper for the flush interval and batch size', () => {
    expect(resolveConfig(base).quotaBatch).toBe(50);
    expect(resolveConfig(base).quotaFlushMs).toBe(10_000);
    expect(
      resolveConfig({
        ...base,
        KEYLEASE_QUOTA_BATCH: String(MAX_QUOTA_BATCH),
        KEYLEASE_QUOTA_FLUSH_MS: String(MAX_QUOTA_FLUSH_MS),
      }),
    ).toMatchObject({ quotaBatch: MAX_QUOTA_BATCH, quotaFlushMs: MAX_QUOTA_FLUSH_MS });
  });

  it('rejects out-of-range quota settings', () => {
    for (const [name, value] of [
      ['KEYLEASE_QUOTA_BATCH', '0'],
      ['KEYLEASE_QUOTA_BATCH', '-5'],
      ['KEYLEASE_QUOTA_BATCH', 'many'],
      ['KEYLEASE_QUOTA_BATCH', String(MAX_QUOTA_BATCH + 1)],
      ['KEYLEASE_QUOTA_FLUSH_MS', '0'],
      ['KEYLEASE_QUOTA_FLUSH_MS', '-5'],
      ['KEYLEASE_QUOTA_FLUSH_MS', 'soon'],
      ['KEYLEASE_QUOTA_FLUSH_MS', String(MAX_QUOTA_FLUSH_MS + 1)],
    ] as const) {
      expect(() => resolveConfig({ ...base, [name]: value })).toThrow(ProxyConfigError);
    }
  });
});

describe('resolveConfig inbound timeouts', () => {
  it('defaults keep-alive and request timeouts', () => {
    const config = resolveConfig(base);
    expect(config.keepAliveTimeoutMs).toBe(DEFAULT_KEEP_ALIVE_TIMEOUT_MS);
    expect(config.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it('parses positive timeout values', () => {
    const config = resolveConfig({
      ...base,
      KEYLEASE_KEEP_ALIVE_TIMEOUT_MS: '15000',
      KEYLEASE_REQUEST_TIMEOUT_MS: '2500',
    });
    expect(config.keepAliveTimeoutMs).toBe(15_000);
    expect(config.requestTimeoutMs).toBe(2_500);
  });

  it('rejects zero, negative and non-numeric timeouts', () => {
    for (const bad of ['0', '-100', 'later', '1.5']) {
      expect(() =>
        resolveConfig({ ...base, KEYLEASE_KEEP_ALIVE_TIMEOUT_MS: bad }),
      ).toThrow(ProxyConfigError);
      expect(() => resolveConfig({ ...base, KEYLEASE_REQUEST_TIMEOUT_MS: bad })).toThrow(
        ProxyConfigError,
      );
    }
  });
});

describe('resolveConfig CORS allowlists', () => {
  it('defaults to any origin with a conservative header allowlist', () => {
    const { cors } = resolveConfig(base);
    expect(cors.allowedOrigins).toEqual(['*']);
    expect(cors.allowedHeaders).toEqual(['authorization', 'content-type', 'x-request-id']);
    expect(cors.allowedMethods).toContain('OPTIONS');
    expect(cors.allowCredentials).toBe(false);
    expect(cors.maxAgeSeconds).toBe(600);
  });

  it('normalises explicit origins and lowercases header names', () => {
    const { cors } = resolveConfig({
      ...base,
      KEYLEASE_CORS_ALLOWED_ORIGINS: 'https://app.example.com/, https://admin.example.com',
      KEYLEASE_CORS_ALLOWED_HEADERS: 'Authorization, Content-Type',
      KEYLEASE_CORS_MAX_AGE_SECONDS: '30',
    });
    expect(cors.allowedOrigins).toEqual([
      'https://app.example.com',
      'https://admin.example.com',
    ]);
    expect(cors.allowedHeaders).toEqual(['authorization', 'content-type']);
    expect(cors.maxAgeSeconds).toBe(30);
  });

  it('lets credentials use explicit origins only', () => {
    const { cors } = resolveConfig({
      ...base,
      KEYLEASE_CORS_ALLOWED_ORIGINS: 'https://app.example.com',
      KEYLEASE_CORS_ALLOW_CREDENTIALS: 'true',
    });
    expect(cors.allowCredentials).toBe(true);
    expect(cors.allowedOrigins).toEqual(['https://app.example.com']);
  });

  it('rejects a wildcard origin combined with credentials', () => {
    expect(() =>
      resolveConfig({ ...base, KEYLEASE_CORS_ALLOW_CREDENTIALS: 'true' }),
    ).toThrow(ProxyConfigError);
    expect(() =>
      resolveConfig({
        ...base,
        KEYLEASE_CORS_ALLOW_CREDENTIALS: 'true',
        KEYLEASE_CORS_ALLOWED_ORIGINS: '*',
      }),
    ).toThrow(ProxyConfigError);
  });

  it('rejects malformed origins, headers and max-age values', () => {
    for (const origins of ['not-an-origin', '*, https://app.example.com']) {
      expect(() =>
        resolveConfig({ ...base, KEYLEASE_CORS_ALLOWED_ORIGINS: origins }),
      ).toThrow(ProxyConfigError);
    }
    for (const headers of ['bad header', '*, authorization']) {
      expect(() =>
        resolveConfig({ ...base, KEYLEASE_CORS_ALLOWED_HEADERS: headers }),
      ).toThrow(ProxyConfigError);
    }
    for (const maxAge of ['-1', 'soon', '90000']) {
      expect(() =>
        resolveConfig({ ...base, KEYLEASE_CORS_MAX_AGE_SECONDS: maxAge }),
      ).toThrow(ProxyConfigError);
    }
  });

  it('accepts a zero max-age', () => {
    expect(
      resolveConfig({ ...base, KEYLEASE_CORS_MAX_AGE_SECONDS: '0' }).cors.maxAgeSeconds,
    ).toBe(0);
  });
});
