import { request as httpRequest } from 'node:http';
import { Keypair } from '@stellar/stellar-sdk';
import { mintSessionToken } from '@keylease/cli/token';
import type { LeaseState } from '@keylease/cli/soroban';
import { describe, expect, it, vi } from 'vitest';
import {
  buildProxyServer,
  buildUpstreamHeaders,
  resolveUpstreamUrl,
  drainProxyServer,
} from './server.js';
import { LeaseVerifier, type LeaseStateProvider } from './verifier.js';
import { resolveConfig, describeConfig, attachSignalHandlers, ProxyConfigError } from './index.js';

const consumer = Keypair.random();
const NOW = Math.floor(Date.now() / 1000);

function leaseState(overrides: Partial<LeaseState> = {}): LeaseState {
  return {
    leaseId: 'lease-1',
    service: 'weather-api',
    provider: 'GCCJ6YI4KDNQJWVXQY2QZ6XKQ2J6QJ6YI4KDNQJWVXQY2QZ6XKQ2J6Q',
    consumer: consumer.publicKey(),
    callsLimit: 10,
    callsUsed: 0,
    expiresAt: NOW + 3_600,
    active: true,
    settled: false,
    pricePaid: 10_000,
    ...overrides,
  };
}

function mintToken(leaseId = 'lease-1', signer = consumer): string {
  return mintSessionToken({
    leaseId,
    consumerSecret: signer.secret(),
    issuedAt: NOW,
    expiresAt: NOW + 3_600,
  });
}

function makeVerifier(provider: LeaseStateProvider, cacheTtlMs = 30_000): LeaseVerifier {
  return new LeaseVerifier({ provider, cacheTtlMs });
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { impl, calls };
}

function okJson(body: unknown, init: ResponseInit = {}): Response {
  const json = JSON.stringify(body);
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (!headers.has('content-length')) {
    headers.set('content-length', String(Buffer.byteLength(json)));
  }
  return new Response(json, {
    status: 200,
    ...init,
    headers,
  });
}

describe('resolveUpstreamUrl', () => {
  it('joins the request path and query onto the upstream origin', () => {
    expect(resolveUpstreamUrl('https://api.example.com', '/v1/weather?city=paris')).toBe(
      'https://api.example.com/v1/weather?city=paris',
    );
  });

  it('preserves an upstream base path prefix', () => {
    expect(resolveUpstreamUrl('https://api.example.com/gateway/', '/v1/weather')).toBe(
      'https://api.example.com/gateway/v1/weather',
    );
  });

  it('handles a bare "/" request', () => {
    expect(resolveUpstreamUrl('https://api.example.com', '/')).toBe(
      'https://api.example.com/',
    );
  });
});

describe('buildUpstreamHeaders', () => {
  it('drops hop-by-hop headers and the lease token by default', () => {
    const out = buildUpstreamHeaders({
      host: 'proxy.local',
      connection: 'keep-alive',
      'content-length': '12',
      authorization: 'Bearer kls1.a.b',
      'content-type': 'application/json',
      cookie: 'session=1',
    });

    expect(out).toEqual({ 'content-type': 'application/json', cookie: 'session=1' });
  });

  it('keeps the lease token when explicitly forwarded', () => {
    const out = buildUpstreamHeaders(
      { authorization: 'Bearer kls1.a.b' },
      { forwardAuthorization: true },
    );
    expect(out['authorization']).toBe('Bearer kls1.a.b');
  });

  it('preserves multi-value headers by folding them onto one field line', () => {
    const out = buildUpstreamHeaders({ 'x-multi': ['a', 'b'], cookie: ['a=1', 'b=2'] });
    expect(out['x-multi']).toBe('a, b');
    expect(out['cookie']).toBe('a=1; b=2');
  });

  it('drops inbound headers starting with x-keylease-', () => {
    const out = buildUpstreamHeaders({
      'x-keylease-calls-remaining': '999999',
      'X-KeyLease-Custom': 'spoofed',
      'x-keylease-lease-id': 'fake',
      'content-type': 'application/json',
    });
    expect(out).toEqual({ 'content-type': 'application/json' });
  });
});

describe('proxy routing', () => {
  it('rejects requests without an Authorization header', async () => {
    const { impl, calls } = stubFetch(() => okJson({ upstream: true }));
    const provider: LeaseStateProvider = { getLeaseState: vi.fn(async () => leaseState()) };
    const app = buildProxyServer({ upstream: 'https://api.example.com', verifier: makeVerifier(provider), fetchImpl: impl });

    const res = await app.inject({ method: 'GET', url: '/v1/weather' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'missing_token' });
    expect(calls).toHaveLength(0);
    expect(provider.getLeaseState).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects an invalid token without touching the chain', async () => {
    const { impl, calls } = stubFetch(() => okJson({ upstream: true }));
    const provider: LeaseStateProvider = { getLeaseState: vi.fn(async () => leaseState()) };
    const app = buildProxyServer({ upstream: 'https://api.example.com', verifier: makeVerifier(provider), fetchImpl: impl });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/weather',
      headers: { authorization: 'Bearer garbage' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_token' });
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it('strips client-supplied x-keylease-* headers and sets legitimate values', async () => {
    const { impl, calls } = stubFetch(() => okJson({ ok: true }));
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier({ getLeaseState: async () => leaseState() }),
      fetchImpl: impl,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/resource',
      headers: {
        authorization: `Bearer ${mintToken()}`,
        'x-keylease-calls-remaining': '999999',
        'x-keylease-custom': 'spoofed-value',
        'X-KeyLease-Evil': 'attacker',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    const forwardedHeaders = calls[0]?.init?.headers as Record<string, string>;
    expect(forwardedHeaders['x-keylease-calls-remaining']).toBe('9');
    expect(forwardedHeaders['x-keylease-lease-id']).toBe('lease-1');
    expect(forwardedHeaders['x-keylease-custom']).toBeUndefined();
    expect(forwardedHeaders['x-keylease-evil']).toBeUndefined();
    await app.close();
  });

  it('forwards an allowed request and returns the upstream response', async () => {
    const { impl, calls } = stubFetch(() => okJson({ temperature: 21 }));
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier({ getLeaseState: async () => leaseState() }),
      fetchImpl: impl,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/weather?city=paris',
      headers: {
        authorization: `Bearer ${mintToken()}`,
        'x-trace-id': 'abc',
        host: 'proxy.local',
        connection: 'keep-alive',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ temperature: 21 });
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['x-keylease-lease-id']).toBe('lease-1');
    expect(res.headers['x-keylease-calls-remaining']).toBe('9');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.example.com/v1/weather?city=paris');
    const init = calls[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.method).toBe('GET');
    expect(init.headers['x-trace-id']).toBe('abc');
    expect(init.headers['x-keylease-lease-id']).toBe('lease-1');
    expect(init.headers['host']).toBeUndefined();
    expect(init.headers['connection']).toBeUndefined();
    expect(init.headers['authorization']).toBeUndefined();
    expect(init.headers['x-forwarded-for']).toContain('127.0.0.1');
    expect(init.body).toBeUndefined();

    await app.close();
  });

  it('strips the lease token but forwards method, body and content type', async () => {
    const { impl, calls } = stubFetch(() =>
      okJson({ created: true }, { status: 201 }),
    );
    const app = buildProxyServer({
      upstream: 'https://api.example.com/base',
      verifier: makeVerifier({ getLeaseState: async () => leaseState() }),
      fetchImpl: impl,
    });

    const payload = JSON.stringify({ query: 'rain' });
    const res = await app.inject({
      method: 'POST',
      url: '/search',
      headers: {
        authorization: `Bearer ${mintToken()}`,
        'content-type': 'application/json',
      },
      payload,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ created: true });

    const init = calls[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(calls[0]?.url).toBe('https://api.example.com/base/search');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers['authorization']).toBeUndefined();
    expect(String(init.body)).toBe(payload);

    await app.close();
  });

  it('keeps the lease token when forwardAuthorization is enabled', async () => {
    const token = mintToken();
    const { impl, calls } = stubFetch(() => okJson({ ok: true }));
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier({ getLeaseState: async () => leaseState() }),
      fetchImpl: impl,
      forwardAuthorization: true,
    });

    await app.inject({ method: 'GET', url: '/', headers: { authorization: `Bearer ${token}` } });

    const init = calls[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.headers['authorization']).toBe(`Bearer ${token}`);
    await app.close();
  });

  it('refuses requests once the lease quota is exhausted', async () => {
    const { impl, calls } = stubFetch(() => okJson({ ok: true }));
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier({ getLeaseState: async () => leaseState({ callsLimit: 1 }) }),
      fetchImpl: impl,
    });

    const headers = { authorization: `Bearer ${mintToken()}` };
    const first = await app.inject({ method: 'GET', url: '/v1/data', headers });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-keylease-calls-remaining']).toBe('0');

    const second = await app.inject({ method: 'GET', url: '/v1/data', headers });
    expect(second.statusCode).toBe(403);
    expect(second.json()).toMatchObject({ error: 'quota_exhausted' });
    expect(calls).toHaveLength(1);

    await app.close();
  });

  it('answers 403 when the lease does not exist on chain', async () => {
    const { impl, calls } = stubFetch(() => okJson({ ok: true }));
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier({
        getLeaseState: async (leaseId: string) => {
          throw Object.assign(new Error(`lease ${leaseId} was not found on chain`), {
            name: 'LeaseNotFoundError',
          });
        },
      }),
      fetchImpl: impl,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/data',
      headers: { authorization: `Bearer ${mintToken()}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'lease_not_found' });
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it('answers 503 when Soroban RPC is unavailable', async () => {
    const { impl } = stubFetch(() => okJson({ ok: true }));
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier(
        {
          getLeaseState: async () => {
            throw new Error('ECONNREFUSED');
          },
        },
        12_500,
      ),
      fetchImpl: impl,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/data',
      headers: { authorization: `Bearer ${mintToken()}` },
    });

    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('13');
    expect(res.json()).toMatchObject({ error: 'verification_unavailable' });
    await app.close();
  });

  it('maps upstream failures to 502 and timeouts to 504', async () => {
    const provider: LeaseStateProvider = { getLeaseState: async () => leaseState() };

    const failing = stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const down = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier(provider),
      fetchImpl: failing.impl,
    });
    const downRes = await down.inject({
      method: 'GET',
      url: '/v1/data',
      headers: { authorization: `Bearer ${mintToken()}` },
    });
    expect(downRes.statusCode).toBe(502);
    expect(downRes.json()).toMatchObject({ error: 'bad_gateway' });
    await down.close();

    const timingOut = stubFetch(() => {
      throw Object.assign(new Error('operation timed out'), { name: 'TimeoutError' });
    });
    const slow = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier(provider),
      fetchImpl: timingOut.impl,
    });
    const slowRes = await slow.inject({
      method: 'GET',
      url: '/v1/data',
      headers: { authorization: `Bearer ${mintToken()}` },
    });
    expect(slowRes.statusCode).toBe(504);
    expect(slowRes.json()).toMatchObject({ error: 'gateway_timeout' });
    await slow.close();
  });

  it('aborts the upstream request when the client disconnects without logging a proxy error', async () => {
    let markFetchStarted!: () => void;
    let markSignalAborted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const signalAborted = new Promise<void>((resolve) => {
      markSignalAborted = resolve;
    });
    let upstreamSignal: AbortSignal | undefined;
    const { impl } = stubFetch((_url, init) => {
      upstreamSignal = init?.signal as AbortSignal | undefined;
      markFetchStarted();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          markSignalAborted();
          reject(upstreamSignal?.reason);
        };
        if (upstreamSignal?.aborted) {
          abort();
        } else {
          upstreamSignal?.addEventListener('abort', abort, { once: true });
        }
      });
    });
    const verifier = makeVerifier({ getLeaseState: async () => leaseState() });
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier,
      fetchImpl: impl,
    });
    let proxyErrorLogged = false;
    app.addHook('onRequest', async (request) => {
      vi.spyOn(request.log, 'error').mockImplementation(() => {
        proxyErrorLogged = true;
      });
    });

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = httpRequest(address, {
      method: 'GET',
      path: '/v1/data',
      headers: { authorization: `Bearer ${mintToken()}` },
    });
    client.on('error', () => {});
    client.end();

    try {
      await fetchStarted;
      client.destroy();
      await signalAborted;

      expect(upstreamSignal?.aborted).toBe(true);
      expect(verifier.localCalls('lease-1')).toBe(1);
      expect(proxyErrorLogged).toBe(false);
    } finally {
      client.destroy();
      await app.close();
    }
  });

  it('forwards multi-value Set-Cookie headers', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'a=1; Path=/');
    headers.append('set-cookie', 'b=2; Path=/');
    const { impl } = stubFetch(async () => new Response('ok', { status: 200, headers }));

    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier({ getLeaseState: async () => leaseState() }),
      fetchImpl: impl,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/data',
      headers: { authorization: `Bearer ${mintToken()}` },
    });

    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    expect(cookies.join(' ')).toContain('a=1');
    expect(cookies.join(' ')).toContain('b=2');
    await app.close();
  });

  it('preserves non-JSON upstream bodies and content types', async () => {
    const csv = 'city,temp\nparis,21\n';
    const { impl } = stubFetch(
      async () =>
        new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } }),
    );
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier({ getLeaseState: async () => leaseState() }),
      fetchImpl: impl,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/export',
      headers: { authorization: `Bearer ${mintToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv');
    expect(res.body).toBe(csv);
    await app.close();
  });

  it('answers HEAD without a body', async () => {
    const { impl } = stubFetch(
      async () => new Response('ignored', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier({ getLeaseState: async () => leaseState() }),
      fetchImpl: impl,
    });

    const res = await app.inject({
      method: 'HEAD',
      url: '/v1/data',
      headers: { authorization: `Bearer ${mintToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    await app.close();
  });

  describe('request body limits', () => {
    it('rejects a body one byte over the limit with 413 payload_too_large before verification', async () => {
      const maxBodyBytes = 100;
      const { impl } = stubFetch(async () => okJson({ ok: true }));
      const verifier = makeVerifier({ getLeaseState: async () => leaseState() });
      const verifySpy = vi.spyOn(verifier, 'verifyAuthorization');
      const app = buildProxyServer({
        upstream: 'https://api.example.com',
        verifier,
        fetchImpl: impl,
        maxBodyBytes,
      });

      const overLimitBody = Buffer.alloc(maxBodyBytes + 1, 'a');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/upload',
        headers: {
          authorization: `Bearer ${mintToken()}`,
          'content-type': 'application/octet-stream',
        },
        payload: overLimitBody,
      });

      expect(res.statusCode).toBe(413);
      const json = res.json();
      expect(json.error).toBe('payload_too_large');
      expect(json.message).toBeDefined();
      expect(verifySpy).not.toHaveBeenCalled();
      await app.close();
    });

    it('forwards a body at the limit', async () => {
      const maxBodyBytes = 100;
      let forwardedBody: Buffer | undefined;
      const { impl } = stubFetch(async (_url, init) => {
        forwardedBody = init?.body as Buffer;
        return okJson({ ok: true });
      });
      const verifier = makeVerifier({ getLeaseState: async () => leaseState() });
      const verifySpy = vi.spyOn(verifier, 'verifyAuthorization');
      const app = buildProxyServer({
        upstream: 'https://api.example.com',
        verifier,
        fetchImpl: impl,
        maxBodyBytes,
      });

      const atLimitBody = Buffer.alloc(maxBodyBytes, 'b');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/upload',
        headers: {
          authorization: `Bearer ${mintToken()}`,
          'content-type': 'application/octet-stream',
        },
        payload: atLimitBody,
      });

      expect(res.statusCode).toBe(200);
      expect(verifySpy).toHaveBeenCalled();
      expect(forwardedBody).toEqual(atLimitBody);
      await app.close();
    });
  });

  describe('health and readiness endpoints', () => {
    it('returns 200 on /healthz without authentication and never proxies upstream', async () => {
      const { impl, calls } = stubFetch(() => okJson({ upstream: true }));
      const app = buildProxyServer({
        upstream: 'https://api.example.com',
        verifier: makeVerifier({ getLeaseState: async () => leaseState() }),
        fetchImpl: impl,
      });

      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
      expect(calls).toHaveLength(0);
      await app.close();
    });

    it('returns 200 on /readyz when verifier has a cached reachable state', async () => {
      const { impl, calls } = stubFetch(() => okJson({ upstream: true }));
      const verifier = makeVerifier({ getLeaseState: async () => leaseState() });
      await verifier.verifyAuthorization(`Bearer ${mintToken()}`);

      const app = buildProxyServer({
        upstream: 'https://api.example.com',
        verifier,
        fetchImpl: impl,
      });

      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
      expect(calls).toHaveLength(0);
      await app.close();
    });

    it('returns 503 verification_unavailable on /readyz when RPC is down / cold', async () => {
      const { impl, calls } = stubFetch(() => okJson({ upstream: true }));
      const verifier = makeVerifier(
        {
          getLeaseState: async () => {
            throw new Error('ECONNREFUSED');
          },
        },
        45_000,
      );

      const app = buildProxyServer({
        upstream: 'https://api.example.com',
        verifier,
        fetchImpl: impl,
      });

      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('30');
      expect(res.json()).toMatchObject({ error: 'verification_unavailable' });
      expect(calls).toHaveLength(0);
      await app.close();
    });
  });

  describe('Prometheus metrics endpoint', () => {
    it('is not registered when metricsEnabled is false or unset', async () => {
      const app = buildProxyServer({
        upstream: 'https://api.example.com',
        verifier: makeVerifier({ getLeaseState: async () => leaseState() }),
      });

      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('exposes Prometheus metrics and increments allow/deny counters and latency', async () => {
      const { impl, calls } = stubFetch(() => okJson({ ok: true }));
      const app = buildProxyServer({
        upstream: 'https://api.example.com',
        verifier: makeVerifier({ getLeaseState: async () => leaseState() }),
        fetchImpl: impl,
        metricsEnabled: true,
      });

      const initial = await app.inject({ method: 'GET', url: '/metrics' });
      expect(initial.statusCode).toBe(200);
      expect(initial.headers['content-type']).toContain('text/plain');
      expect(initial.body).toContain('keylease_requests_total 0');
      expect(initial.body).toContain('keylease_requests_allowed_total 0');
      expect(calls).toHaveLength(0);

      await app.inject({
        method: 'GET',
        url: '/v1/data',
        headers: { authorization: `Bearer ${mintToken()}` },
      });

      await app.inject({
        method: 'GET',
        url: '/v1/data',
        headers: { authorization: 'Bearer bad-token' },
      });

      const updated = await app.inject({ method: 'GET', url: '/metrics' });
      expect(updated.statusCode).toBe(200);
      expect(updated.body).toContain('keylease_requests_total 2');
      expect(updated.body).toContain('keylease_requests_allowed_total 1');
      expect(updated.body).toContain('keylease_requests_denied_total{error="invalid_token"} 1');
      expect(updated.body).toContain('keylease_upstream_latency_seconds_count 1');
      expect(updated.body).toContain('keylease_cache_hits_total');
      expect(updated.body).toContain('keylease_cache_misses_total');
      await app.close();
    });

    it('resolves KEYLEASE_METRICS_ENABLED in config', () => {
      expect(
        resolveConfig({ KEYLEASE_UPSTREAM_URL: 'https://api.example.com' }).metricsEnabled,
      ).toBe(false);
      expect(
        resolveConfig({
          KEYLEASE_UPSTREAM_URL: 'https://api.example.com',
          KEYLEASE_METRICS_ENABLED: 'true',
        }).metricsEnabled,
      ).toBe(true);
    });
  });

  describe('graceful shutdown and connection draining', () => {
    it('waits for in-flight requests before closing', async () => {
      let resolveUpstream;
      const upstreamPromise = new Promise((resolve) => {
        resolveUpstream = resolve;
      });

      let onFetchStarted;
      const fetchStartedPromise = new Promise((resolve) => {
        onFetchStarted = resolve;
      });

      const { impl } = stubFetch(() => {
        onFetchStarted();
        return upstreamPromise;
      });

      const app = buildProxyServer({
        upstream: 'https://api.example.com',
        verifier: makeVerifier({ getLeaseState: async () => leaseState() }),
        fetchImpl: impl,
      });

      let requestFinished = false;
      const requestPromise = app
        .inject({
          method: 'GET',
          url: '/v1/data',
          headers: { authorization: `Bearer ${mintToken()}` },
        })
        .then((res) => {
          requestFinished = true;
          return res;
        });

      await fetchStartedPromise;
      const drainPromise = drainProxyServer(app, 5000);
      expect(requestFinished).toBe(false);

      resolveUpstream(okJson({ done: true }));
      const [res, outcome] = await Promise.all([requestPromise, drainPromise]);

      expect(res.statusCode).toBe(200);
      expect(requestFinished).toBe(true);
      expect(outcome).toBe('drained');
    });

    it('returns timed_out when in-flight requests exceed timeout', async () => {
      const neverResolves = new Promise(() => {});
      let onFetchStarted;
      const fetchStartedPromise = new Promise((resolve) => {
        onFetchStarted = resolve;
      });

      const { impl } = stubFetch(() => {
        onFetchStarted();
        return neverResolves;
      });

      const app = buildProxyServer({
        upstream: 'https://api.example.com',
        verifier: makeVerifier({ getLeaseState: async () => leaseState() }),
        fetchImpl: impl,
      });

      void app.inject({
        method: 'GET',
        url: '/v1/data',
        headers: { authorization: `Bearer ${mintToken()}` },
      });

      await fetchStartedPromise;
      const outcome = await drainProxyServer(app, 50);
      expect(outcome).toBe('timed_out');
      await app.close();
    });

    it('handles SIGTERM and forces exit on second signal', async () => {
      const listeners = {};
      const fakeProcess = {
        on: (sig, fn) => {
          listeners[sig] = fn;
          return fakeProcess;
        },
        removeListener: (sig) => {
          delete listeners[sig];
          return fakeProcess;
        },
      };

      const exitCalls = [];
      const logs = [];
      let drainCalled = false;

      const detach = attachSignalHandlers(
        async () => {
          drainCalled = true;
          return 'drained';
        },
        {
          processObj: fakeProcess,
          exit: (code) => exitCalls.push(code),
          logger: { info: (msg) => logs.push(msg) },
        },
      );

      expect(listeners['SIGTERM']).toBeDefined();

      listeners['SIGTERM']();
      expect(logs).toContain('received SIGTERM; draining in-flight requests...');
      expect(drainCalled).toBe(true);

      listeners['SIGTERM']();
      expect(logs.some((l) => l.includes('second SIGTERM'))).toBe(true);
      expect(exitCalls).toContain(1);

      detach();
      expect(listeners['SIGTERM']).toBeUndefined();
    });

    it('parses KEYLEASE_SHUTDOWN_TIMEOUT_MS in config', () => {
      expect(
        resolveConfig({ KEYLEASE_UPSTREAM_URL: 'https://api.example.com' }).shutdownTimeoutMs,
      ).toBe(10_000);
      expect(
        resolveConfig({
          KEYLEASE_UPSTREAM_URL: 'https://api.example.com',
          KEYLEASE_SHUTDOWN_TIMEOUT_MS: '5000',
        }).shutdownTimeoutMs,
      ).toBe(5_000);
    });
  });
});

describe('resolveConfig KEYLEASE_MAX_BODY_BYTES', () => {
  const baseEnv = { KEYLEASE_UPSTREAM_URL: 'https://api.example.com' };

  it('defaults to 32 MiB', () => {
    const config = resolveConfig(baseEnv);
    expect(config.maxBodyBytes).toBe(32 * 1024 * 1024);
  });

  it('parses valid positive integer', () => {
    const config = resolveConfig({ ...baseEnv, KEYLEASE_MAX_BODY_BYTES: '1048576' });
    expect(config.maxBodyBytes).toBe(1048576);
  });

  it('rejects invalid or non-positive values', () => {
    expect(() => resolveConfig({ ...baseEnv, KEYLEASE_MAX_BODY_BYTES: '0' })).toThrow(
      ProxyConfigError,
    );
    expect(() => resolveConfig({ ...baseEnv, KEYLEASE_MAX_BODY_BYTES: '-10' })).toThrow(
      ProxyConfigError,
    );
    expect(() => resolveConfig({ ...baseEnv, KEYLEASE_MAX_BODY_BYTES: 'abc' })).toThrow(
      ProxyConfigError,
    );
    expect(() => resolveConfig({ ...baseEnv, KEYLEASE_MAX_BODY_BYTES: '12.34' })).toThrow(
      ProxyConfigError,
    );
  });

  it('rejects values exceeding sane upper bound of 1 GiB', () => {
    expect(() =>
      resolveConfig({ ...baseEnv, KEYLEASE_MAX_BODY_BYTES: String(1024 * 1024 * 1024 + 1) }),
    ).toThrow(ProxyConfigError);
  });
});

describe('x-request-id propagation', () => {
  function setup() {
    const { impl, calls } = stubFetch(() => okJson({ ok: true }));
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier({ getLeaseState: async () => leaseState() }),
      fetchImpl: impl,
    });
    return { app, calls };
  }
  const forwardedId = (calls: FetchCall[]) =>
    (calls[0]?.init as { headers: Record<string, string> }).headers['x-request-id'];

  it('reuses a valid inbound id, forwards it and echoes it', async () => {
    const { app, calls } = setup();
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: `Bearer ${mintToken()}`, 'x-request-id': 'req-123.abc' },
    });
    expect(res.headers['x-request-id']).toBe('req-123.abc');
    expect(forwardedId(calls)).toBe('req-123.abc');
    await app.close();
  });

  it('generates an id when none is supplied, including on denials', async () => {
    const { app, calls } = setup();
    const ok = await app.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: `Bearer ${mintToken()}` },
    });
    expect(ok.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(forwardedId(calls)).toBe(ok.headers['x-request-id']);
    const denied = await app.inject({ method: 'GET', url: '/' });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });

  it('replaces ids with unsafe characters or excessive length', async () => {
    const { app } = setup();
    for (const bad of ['bad id<script>', 'a'.repeat(129), 'tab\tid']) {
      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: { authorization: `Bearer ${mintToken()}`, 'x-request-id': bad },
      });
      expect(res.headers['x-request-id']).not.toBe(bad);
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
    await app.close();
  });
});

describe('WebSocket upgrade requests', () => {
  it('answers 426 before verification and consumes no quota', async () => {
    const getLeaseState = vi.fn(async () => leaseState());
    const { impl, calls } = stubFetch(() => okJson({ ok: true }));
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier({ getLeaseState }),
      fetchImpl: impl,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/socket',
      headers: {
        authorization: `Bearer ${mintToken()}`,
        connection: 'keep-alive, Upgrade',
        upgrade: 'websocket',
      },
    });
    expect(res.statusCode).toBe(426);
    expect(res.headers['upgrade']).toBe('HTTP/1.1');
    expect(res.json()).toMatchObject({ error: 'upgrade_required' });
    expect(getLeaseState).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);

    const next = await app.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: `Bearer ${mintToken()}` },
    });
    expect(next.headers['x-keylease-calls-remaining']).toBe('9');
    await app.close();
  });
});

describe('trustProxy and x-forwarded-* headers', () => {
  async function forwarded(trustProxy: boolean | string[], remoteAddress: string) {
    const { impl, calls } = stubFetch(() => okJson({ ok: true }));
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier({ getLeaseState: async () => leaseState() }),
      fetchImpl: impl,
      trustProxy,
    });
    await app.inject({
      method: 'GET',
      url: '/',
      remoteAddress,
      headers: {
        authorization: `Bearer ${mintToken()}`,
        host: 'proxy.local',
        'x-forwarded-for': '6.6.6.6',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'evil.example',
      },
    });
    await app.close();
    return (calls[0]?.init as { headers: Record<string, string> }).headers;
  }

  it('drops spoofed x-forwarded-* headers when trust is off (default)', async () => {
    const headers = await forwarded(false, '192.0.2.10');
    expect(headers['x-forwarded-for']).toBe('192.0.2.10');
    expect(headers['x-forwarded-proto']).toBe('http');
    expect(headers['x-forwarded-host']).toBe('proxy.local');
  });

  it('derives x-forwarded-* from a trusted edge proxy', async () => {
    const headers = await forwarded(true, '10.0.0.1');
    expect(headers['x-forwarded-for']).toBe('6.6.6.6, 10.0.0.1');
    expect(headers['x-forwarded-proto']).toBe('https');
    expect(headers['x-forwarded-host']).toBe('evil.example');
  });

  it('ignores forwarded headers from a peer outside the trusted CIDR list', async () => {
    const untrusted = await forwarded(['10.0.0.0/8'], '192.0.2.10');
    expect(untrusted['x-forwarded-for']).toBe('192.0.2.10');
    expect(untrusted['x-forwarded-proto']).toBe('http');
    const trusted = await forwarded(['10.0.0.0/8'], '10.1.2.3');
    expect(trusted['x-forwarded-for']).toBe('6.6.6.6, 10.1.2.3');
  });
});

describe('resolveConfig KEYLEASE_TRUST_PROXY', () => {
  const base = { KEYLEASE_UPSTREAM_URL: 'https://api.example.com' };
  it('parses false, true, hop counts and CIDR lists', () => {
    expect(resolveConfig(base).trustProxy).toBe(false);
    expect(resolveConfig({ ...base, KEYLEASE_TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(resolveConfig({ ...base, KEYLEASE_TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(
      resolveConfig({ ...base, KEYLEASE_TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }).trustProxy,
    ).toEqual(['10.0.0.0/8', '127.0.0.1']);
  });
  it('rejects garbage', () => {
    expect(() => resolveConfig({ ...base, KEYLEASE_TRUST_PROXY: 'yes please' })).toThrow(
      ProxyConfigError,
    );
  });
});

describe('in-flight upstream cap', () => {
  const baseEnv = { KEYLEASE_UPSTREAM_URL: 'https://api.example.com' };

  function gated(maxInFlight: number, fail = false) {
    const releases: Array<() => void> = [];
    const { impl, calls } = stubFetch(
      () =>
        new Promise<Response>((resolve, reject) => {
          releases.push(() => (fail ? reject(new Error('boom')) : resolve(okJson({ ok: true }))));
        }),
    );
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier({ getLeaseState: async () => leaseState({ callsLimit: 100 }) }),
      fetchImpl: impl,
      maxInFlight,
    });
    const send = () =>
      app.inject({
        method: 'GET',
        url: '/x',
        headers: { authorization: `Bearer ${mintToken()}` },
      });
    return { app, calls, releases, send };
  }

  it('sheds excess requests with 503 + Retry-After and charges no quota', async () => {
    const { app, calls, releases, send } = gated(1);
    const first = send();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const shed = await send();
    expect(shed.statusCode).toBe(503);
    expect(shed.headers['retry-after']).toBe('1');
    expect(shed.json()).toMatchObject({ error: 'overloaded' });
    expect(calls).toHaveLength(1);
    releases[0]!();
    expect((await first).statusCode).toBe(200);
    await app.close();
  });

  it('releases the slot after success and after upstream errors', async () => {
    const ok = gated(1);
    const p1 = ok.send();
    await vi.waitFor(() => expect(ok.calls).toHaveLength(1));
    ok.releases[0]!();
    await p1;
    const p2 = ok.send();
    await vi.waitFor(() => expect(ok.calls).toHaveLength(2));
    ok.releases[1]!();
    expect((await p2).statusCode).toBe(200);
    await ok.app.close();

    const bad = gated(1, true);
    const e1 = bad.send();
    await vi.waitFor(() => expect(bad.calls).toHaveLength(1));
    bad.releases[0]!();
    expect((await e1).statusCode).toBe(502);
    const e2 = bad.send();
    await vi.waitFor(() => expect(bad.calls).toHaveLength(2));
    bad.releases[1]!();
    expect((await e2).statusCode).toBe(502);
    await bad.app.close();
  });

  it('releases the slot on denials and 0 disables the cap', async () => {
    const { app, calls } = gated(1);
    for (let i = 0; i < 3; i += 1) {
      const denied = await app.inject({ method: 'GET', url: '/x' });
      expect(denied.statusCode).toBe(401);
    }
    expect(calls).toHaveLength(0);
    await app.close();

    const open = gated(0);
    const pending = [open.send(), open.send(), open.send()];
    await vi.waitFor(() => expect(open.calls).toHaveLength(3));
    open.releases.forEach((release) => release());
    for (const r of await Promise.all(pending)) expect(r.statusCode).toBe(200);
    await open.app.close();
  });

  it('parses KEYLEASE_MAX_INFLIGHT', () => {
    expect(resolveConfig(baseEnv).maxInFlight).toBe(1024);
    expect(resolveConfig({ ...baseEnv, KEYLEASE_MAX_INFLIGHT: '0' }).maxInFlight).toBe(0);
    expect(resolveConfig({ ...baseEnv, KEYLEASE_MAX_INFLIGHT: '8' }).maxInFlight).toBe(8);
    for (const bad of ['-1', 'abc', '1.5']) {
      expect(() => resolveConfig({ ...baseEnv, KEYLEASE_MAX_INFLIGHT: bad })).toThrow(
        ProxyConfigError,
      );
    }
  });
});

describe('access log sizes', () => {
  it('logs request and response byte sizes without the path query', async () => {
    const { impl } = stubFetch(() => okJson({ hello: 'world' }));
    const lines: Array<Record<string, unknown>> = [];
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier({ getLeaseState: async () => leaseState() }),
      fetchImpl: impl,
    });
    app.log.info = ((obj: unknown, msg?: string) => {
      if (msg === 'access') lines.push(obj as Record<string, unknown>);
    }) as typeof app.log.info;
    const res = await app.inject({
      method: 'POST',
      url: '/echo?token=secret',
      headers: { authorization: `Bearer ${mintToken()}`, 'content-type': 'text/plain' },
      payload: 'abcde',
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    expect(lines[0]).toMatchObject({
      method: 'POST',
      path: '/echo',
      statusCode: 200,
      requestBytes: 5,
      responseBytes: Number(res.headers['content-length']),
    });
    expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
    expect(JSON.stringify(lines[0])).not.toContain('secret');
    await app.close();
  });
});

describe('describeConfig', () => {
  it('never exposes secrets or upstream credentials', () => {
    const config = resolveConfig({
      KEYLEASE_UPSTREAM_URL: 'https://user:pa55word@api.example.com/v1?api_key=hunter2#frag',
      KEYLEASE_GATEWAY_SECRET: 'SABCDEFSECRETSEEDVALUE',
      KEYLEASE_TRUST_PROXY: '10.0.0.0/8',
    });
    const summary = describeConfig(config);
    const text = JSON.stringify(summary);
    for (const leaked of ['pa55word', 'hunter2', 'SABCDEF', 'user:', 'frag']) {
      expect(text).not.toContain(leaked);
    }
    expect(summary).toMatchObject({
      upstream: 'https://api.example.com/v1',
      onChainQuotaCommits: true,
      trustProxy: ['10.0.0.0/8'],
      maxInFlight: 1024,
    });
    expect(Object.keys(summary)).not.toContain('gatewaySecret');
  });
});

describe('buildUpstreamHeaders property test (request-smuggling vectors)', () => {
  // Dependency-free: a seeded mulberry32 PRNG keeps every run reproducible.
  function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = <T>(rand: () => number, items: readonly T[]): T =>
    items[Math.floor(rand() * items.length)]!;
  const mixCase = (rand: () => number, name: string): string =>
    [...name].map((c) => (rand() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join('');

  const FORBIDDEN = [
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
    'content-length',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-forwarded-port',
    'x-keylease-lease-id',
    'x-keylease-calls-remaining',
    'authorization',
  ];
  const VALUES = [
    'chunked',
    'chunked, identity',
    '0',
    '5',
    '-1',
    'close',
    'keep-alive, Upgrade',
    'websocket',
    '1.2.3.4',
    'evil.example.com',
    'Bearer stolen',
    'x',
  ];
  const BENIGN = ['accept', 'content-type', 'user-agent', 'x-custom', 'cookie', 'x-request-id'];

  it('never forwards hop-by-hop, forwarding or lease headers in any casing', () => {
    const rand = prng(0x5eed);
    for (let run = 0; run < 500; run += 1) {
      const input: Record<string, string | string[]> = {};
      const count = 1 + Math.floor(rand() * 12);
      for (let i = 0; i < count; i += 1) {
        const name = mixCase(rand, rand() < 0.6 ? pick(rand, FORBIDDEN) : pick(rand, BENIGN));
        const value = pick(rand, VALUES);
        input[name] = rand() < 0.2 ? [value, pick(rand, VALUES)] : value;
      }
      const out = buildUpstreamHeaders(input);
      for (const key of Object.keys(out)) {
        expect(key, `run ${run}: ${JSON.stringify(input)}`).toBe(key.toLowerCase());
        expect(FORBIDDEN, `run ${run}: ${JSON.stringify(input)}`).not.toContain(key);
        expect(key.startsWith('x-keylease-')).toBe(false);
        expect(key.startsWith('x-forwarded-')).toBe(false);
      }
    }
  });

  it('keeps authorization only when forwarding is enabled and preserves benign headers', () => {
    const rand = prng(0xc0ffee);
    for (let run = 0; run < 200; run += 1) {
      const name = mixCase(rand, pick(rand, BENIGN.filter((n) => n !== 'cookie')));
      const value = pick(rand, VALUES);
      const input = { [name]: value, [mixCase(rand, 'Authorization')]: 'Bearer t' };
      expect(buildUpstreamHeaders(input)[name.toLowerCase()]).toBe(value);
      expect(buildUpstreamHeaders(input).authorization).toBeUndefined();
      expect(buildUpstreamHeaders(input, { forwardAuthorization: true }).authorization).toBe(
        'Bearer t',
      );
    }
  });

  it('filters through allowedHeaders when configured', () => {
    const out = buildUpstreamHeaders(
      {
        accept: 'text/html',
        'x-custom': 'allowed',
        'x-other': 'denied',
        authorization: 'Bearer kls1.a.b',
      },
      { allowedHeaders: ['accept', 'x-custom'] },
    );
    expect(out).toEqual({
      accept: 'text/html',
      'x-custom': 'allowed',
    });
  });

  it('is deterministic for a given seed', () => {
    const a = prng(42);
    const b = prng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('response streaming (issue #17)', () => {
  it('streams multi-chunk upstream body while preserving headers and status', async () => {
    const chunks = ['chunk-1 ', 'chunk-2 ', 'chunk-3'];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    const response = new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-upstream-header': 'custom-value',
      },
    });

    const { impl } = stubFetch(async () => response);
    const provider: LeaseStateProvider = { getLeaseState: vi.fn(async () => leaseState()) };
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier(provider),
      fetchImpl: impl,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/stream',
      headers: { authorization: `Bearer ${mintToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['x-upstream-header']).toBe('custom-value');
    expect(res.body).toBe('chunk-1 chunk-2 chunk-3');
    await app.close();
  });

  it('cancels upstream stream on client abort', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first-chunk '));
      },
      cancel() {
        cancelled = true;
      },
    });

    const response = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });

    const { impl } = stubFetch(async () => response);
    const provider: LeaseStateProvider = { getLeaseState: vi.fn(async () => leaseState()) };
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier(provider),
      fetchImpl: impl,
    });

    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const req = httpRequest(address, {
      path: '/v1/abort-test',
      method: 'GET',
      headers: { authorization: `Bearer ${mintToken()}` },
    });

    req.on('response', (res) => {
      res.on('data', () => {
        req.destroy();
      });
    });
    req.on('error', () => {});
    req.end();

    try {
      await vi.waitFor(() => expect(cancelled).toBe(true));
    } finally {
      req.destroy();
      await app.close();
    }
  });
});

describe('security hardening and threat model (issue #3)', () => {
  it('rejects tampered session token signature with 401 invalid_token', async () => {
    const validToken = mintToken();
    const parts = validToken.split('.');
    expect(parts.length).toBe(3);
    // Tamper signature
    const tamperedSig = parts[2]!.replace(/[a-zA-Z0-9]/, (c) => (c === 'a' ? 'b' : 'a'));
    const forgedToken = `${parts[0]}.${parts[1]}.${tamperedSig}`;

    const { impl } = stubFetch(async () => okJson({ ok: true }));
    const provider: LeaseStateProvider = { getLeaseState: vi.fn(async () => leaseState()) };
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier(provider),
      fetchImpl: impl,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/secret',
      headers: { authorization: `Bearer ${forgedToken}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_token' });
    await app.close();
  });

  it('strips client-supplied mixed-case x-keylease-* and x-forwarded-* headers before upstream', async () => {
    let capturedHeaders: Record<string, string> = {};
    const { impl } = stubFetch(async (_url, init) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return okJson({ ok: true });
    });

    const provider: LeaseStateProvider = { getLeaseState: vi.fn(async () => leaseState()) };
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier(provider),
      fetchImpl: impl,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/headers',
      headers: {
        authorization: `Bearer ${mintToken()}`,
        'X-KeyLease-Injected': 'malicious',
        'x-keylease-spoof': 'fake',
        'X-Forwarded-For': '1.2.3.4',
        'X-Forwarded-Host': 'evil.com',
        'x-custom-header': 'safe',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(capturedHeaders['x-keylease-injected']).toBeUndefined();
    expect(capturedHeaders['x-keylease-spoof']).toBeUndefined();
    // Valid proxy-generated headers exist
    expect(capturedHeaders['x-keylease-lease-id']).toBe('lease-1');
    expect(capturedHeaders['x-keylease-calls-remaining']).toBe('9');
    expect(capturedHeaders['x-custom-header']).toBe('safe');
    await app.close();
  });

  it('enforces header allowlist when specified in ProxyOptions', async () => {
    let capturedHeaders: Record<string, string> = {};
    const { impl } = stubFetch(async (_url, init) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return okJson({ ok: true });
    });

    const provider: LeaseStateProvider = { getLeaseState: vi.fn(async () => leaseState()) };
    const app = buildProxyServer({
      upstream: 'https://api.example.com',
      verifier: makeVerifier(provider),
      fetchImpl: impl,
      allowedHeaders: ['accept', 'x-allowed'],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/allowlist',
      headers: {
        authorization: `Bearer ${mintToken()}`,
        accept: 'application/json',
        'x-allowed': 'allowed-value',
        'x-not-allowed': 'blocked-value',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(capturedHeaders['accept']).toBe('application/json');
    expect(capturedHeaders['x-allowed']).toBe('allowed-value');
    expect(capturedHeaders['x-not-allowed']).toBeUndefined();
    await app.close();
  });
});
