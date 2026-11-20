/**
 * Edge reverse proxy: intercepts every request, verifies the KeyLease bearer
 * token (signature + cached on-chain state + local quota), then forwards
 * allowed requests to the protected upstream API.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { LeaseVerifier } from './verifier.js';

/** Headers defined by RFC 9110 that must never be forwarded verbatim. */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
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
]);

export interface ProxyOptions {
  /** Base URL of the protected API, e.g. `https://api.example.com`. */
  upstream: string;
  verifier: LeaseVerifier;
  /** Injectable `fetch` for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Fastify logger toggle. Defaults to `false`. */
  logger?: boolean;
  /** Forward the caller's lease token upstream. Defaults to `false`. */
  forwardAuthorization?: boolean;
  /** Additional request headers to forward upstream. */
  forwardHeaders?: Iterable<string> | undefined;
  /** Per-request upstream timeout in milliseconds. Defaults to 15s; 0 disables it. */
  requestTimeoutMs?: number;
  /** Expose Prometheus metrics on /metrics. Defaults to `false`. */
  metricsEnabled?: boolean;
  /** Maximum request body size in bytes. Defaults to 32 MiB. */
  maxBodyBytes?: number;
  /**
   * Fastify `trustProxy` setting: `true`, a hop count, or CIDR/IP list of
   * trusted edge proxies. Defaults to `false`, in which case every inbound
   * `x-forwarded-*` header is dropped instead of forwarded.
   */
  trustProxy?: boolean | number | string | string[];
  /**
   * Maximum number of proxied requests handled at once (verification through
   * the end of the upstream response). Excess requests get a 503 with
   * `Retry-After`. Defaults to 1024; 0 disables the cap.
   */
  maxInFlight?: number;
}

export const DEFAULT_MAX_IN_FLIGHT = 1024;

const REQUEST_ID_HEADER = 'x-request-id';
const VALID_REQUEST_ID = /^[A-Za-z0-9._:~+=/-]{1,128}$/;

/** Returns the inbound request id when it is safe to reuse, otherwise a fresh one. */
export function resolveRequestId(incoming: string | string[] | undefined): string {
  if (typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming)) return incoming;
  return randomUUID();
}

export const METRICS_LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface ForwardedRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: Buffer | undefined;
  signal?: AbortSignal | undefined;
  redirect?: 'error' | 'follow' | 'manual' | undefined;
}

/** Normalises a relative request URL against the configured upstream. */
export function resolveUpstreamUrl(upstream: string, rawUrl: string): string {
  const base = new URL(upstream);
  const path = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '');
  return new URL(`${basePath}${path}`, base.origin).toString();
}

/** Default allowlist of request headers forwarded upstream. */
export const DEFAULT_FORWARDED_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'accept-charset',
  'accept-encoding',
  'accept-language',
  'content-type',
  'content-encoding',
  'content-language',
  'range',
  'user-agent',
]);

/** Returns whether an incoming header name is allowed to be forwarded upstream. */
export function isAllowedForwardHeader(
  name: string,
  extraHeaders?: ReadonlySet<string> | undefined,
): boolean {
  const lower = name.toLowerCase();
  if (DEFAULT_FORWARDED_HEADERS.has(lower)) return true;
  if (lower.startsWith('if-')) return true;
  if (extraHeaders?.has(lower)) return true;
  return false;
}

/**
 * Copies request headers, allowing only default allowlisted headers, conditional
 * `if-*` headers, and explicitly configured `forwardHeaders` (and auth when enabled).
 * Multi-valued headers are folded onto a single field line: `; ` for cookies
 * (RFC 6265), `, ` for everything else.
 */
export function buildUpstreamHeaders(
  headers: Record<string, string | string[] | undefined>,
  options: {
    forwardAuthorization?: boolean;
    forwardHeaders?: Iterable<string> | undefined;
  } = {},
): Record<string, string> {
  const extraHeaders = options.forwardHeaders
    ? new Set(Array.from(options.forwardHeaders, (h) => h.toLowerCase().trim()).filter(Boolean))
    : undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower.startsWith('x-keylease-')) continue;
    // Forwarding metadata is rebuilt by the proxy from trusted values only.
    if (lower.startsWith('x-forwarded-')) continue;
    if (lower === 'authorization') {
      if (options.forwardAuthorization === true) {
        out[lower] = Array.isArray(value) ? value.join(', ') : value;
      }
      continue;
    }
    if (isAllowedForwardHeader(lower, extraHeaders)) {
      out[lower] = Array.isArray(value) ? value.join(lower === 'cookie' ? '; ' : ', ') : value;
    }
  }
  return out;
}

function isUpgradeRequest(request: FastifyRequest): boolean {
  const connection = request.headers.connection;
  const upgrade = request.headers.upgrade;
  return (
    typeof upgrade === 'string' &&
    upgrade.length > 0 &&
    typeof connection === 'string' &&
    connection
      .split(',')
      .some((token) => token.trim().toLowerCase() === 'upgrade')
  );
}

function allowsBody(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

function copyResponseHeaders(reply: FastifyReply, headers: Headers): void {
  const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const [key, value] of headers) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'set-cookie') continue;
    if (lower === 'content-type' && value === undefined) continue;
    reply.header(lower, value);
  }
  for (const cookie of setCookies) {
    reply.header('set-cookie', cookie);
  }
}

/**
 * Builds the proxy server. The caller owns the lifecycle (`listen`/`close`),
 * which keeps this function fully testable through `fastify.inject`.
 */
export function buildProxyServer(options: ProxyOptions): FastifyInstance {
  const { verifier, upstream } = options;
  const fetchImpl: typeof fetch = options.fetchImpl ?? globalThis.fetch;
  const forwardAuthorization = options.forwardAuthorization === true;
  const forwardHeaders = options.forwardHeaders
    ? new Set(Array.from(options.forwardHeaders, (h) => h.toLowerCase().trim()).filter(Boolean))
    : undefined;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const verificationRetryAfterSeconds = Math.max(
    1,
    Math.ceil(Math.min(verifier.cacheTtlMs, 30_000) / 1_000),
  );

  // Parse every payload as a buffer so the proxy forwards bodies untouched.
  const maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: maxBodyBytes,
    // Fastify accepts a hop count at runtime even though its typings omit `number`.
    trustProxy: (options.trustProxy ?? false) as boolean,
    requestIdHeader: false,
    genReqId: (req) => resolveRequestId(req.headers[REQUEST_ID_HEADER]),
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  let upstreamSlots = 0;

  let inFlightRequests = 0;
  const drainWaiters = new Set<() => void>();

  app.addHook('onRequest', async (request, reply) => {
    inFlightRequests += 1;
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    // Sizes come from headers only; bodies are never buffered or measured here.
    const requestBytes = Number(request.headers['content-length'] ?? 0);
    const responseBytes = Number(reply.getHeader('content-length') ?? 0);
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        path: (request.raw.url ?? '/').split('?')[0],
        statusCode: reply.statusCode,
        requestBytes: Number.isFinite(requestBytes) ? requestBytes : 0,
        responseBytes: Number.isFinite(responseBytes) ? responseBytes : 0,
        durationMs: Math.round(reply.elapsedTime),
      },
      'access',
    );
    inFlightRequests -= 1;
    if (inFlightRequests <= 0) {
      for (const waiter of drainWaiters) {
        waiter();
      }
      drainWaiters.clear();
    }
  });

  (app as unknown as { drainInFlight: () => Promise<void> }).drainInFlight = async () => {
    if (inFlightRequests > 0) {
      await new Promise<void>((resolve) => drainWaiters.add(resolve));
    }
  };

  const metrics = {
    requestsTotal: 0,
    requestsAllowed: 0,
    requestsDenied: new Map<string, number>(),
    latencyBuckets: new Array(METRICS_LATENCY_BUCKETS.length).fill(0),
    latencySum: 0,
    latencyCount: 0,
  };

  const recordLatency = (seconds: number) => {
    metrics.latencyCount += 1;
    metrics.latencySum += seconds;
    for (let i = 0; i < METRICS_LATENCY_BUCKETS.length; i += 1) {
      if (seconds <= METRICS_LATENCY_BUCKETS[i]!) {
        metrics.latencyBuckets[i]! += 1;
      }
    }
  };

  app.setErrorHandler((error, _request, reply) => {
    const err =
      typeof error === 'object' && error !== null
        ? (error as { statusCode?: number; code?: string; message?: string })
        : null;
    if (err?.statusCode === 413 || err?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply
        .code(413)
        .type('application/json; charset=utf-8')
        .send({
          error: 'payload_too_large',
          message: err.message ?? 'request body exceeds the configured limit',
        });
    }
    return reply.send(error);
  });
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    metrics.requestsTotal += 1;
    if (maxInFlight > 0 && upstreamSlots >= maxInFlight) {
      return reply
        .code(503)
        .header('retry-after', '1')
        .type('application/json; charset=utf-8')
        .send({
          error: 'overloaded',
          message: 'too many in-flight upstream requests; retry shortly',
        });
    }
    // Taken before verification so shed requests are never charged against a lease.
    upstreamSlots += 1;
    try {
      return await handleProxied(request, reply);
    } finally {
      upstreamSlots -= 1;
    }
  };

  const handleProxied = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    if (isUpgradeRequest(request)) {
      // Upgrades are never proxied; refuse before the lease is verified or charged.
      return reply
        .code(426)
        .header('connection', 'Upgrade')
        .header('upgrade', 'HTTP/1.1')
        .type('application/json; charset=utf-8')
        .send({
          error: 'upgrade_required',
          message: 'protocol upgrades (e.g. WebSocket) are not supported by this proxy',
        });
    }
    const decision = await verifier.verifyAuthorization(request.headers.authorization);
    if (!decision.ok) {
      metrics.requestsDenied.set(
        decision.reason,
        (metrics.requestsDenied.get(decision.reason) ?? 0) + 1,
      );
      request.log.info(
        { reason: decision.reason, url: request.url, requestId: request.id },
        'request denied by lease verifier',
      );
      const deniedReply = reply.code(decision.status).type('application/json; charset=utf-8');
      if (decision.status === 503) {
        deniedReply.header('retry-after', String(verificationRetryAfterSeconds));
      }
      return deniedReply.send({ error: decision.reason, message: decision.message });
    }

    metrics.requestsAllowed += 1;

    const target = resolveUpstreamUrl(upstream, request.raw.url ?? '/');
    const method = request.method;
    const headers = buildUpstreamHeaders(request.headers, {
      forwardAuthorization,
      forwardHeaders,
    });
    const payload =
      allowsBody(method) && Buffer.isBuffer(request.body) && request.body.length > 0
        ? request.body
        : undefined;
    const clientAbortController = new AbortController();
    const socket = request.raw.socket;
    const abortOnDisconnect = () => clientAbortController.abort();
    if (socket.destroyed) {
      abortOnDisconnect();
    } else {
      socket.once('close', abortOnDisconnect);
    }
    const timeoutSignal = requestTimeoutMs > 0 ? AbortSignal.timeout(requestTimeoutMs) : undefined;

    const init: ForwardedRequestInit = {
      method,
      headers: {
        ...headers,
        [REQUEST_ID_HEADER]: request.id,
        // `ips` (only set with trustProxy) is socket-first and stops at the first
        // untrusted hop, so spoofed entries never reach the upstream chain.
        'x-forwarded-for': (request.ips ?? [request.ip]).slice().reverse().join(', '),
        'x-forwarded-host': request.host,
        'x-forwarded-proto': request.protocol,
        'x-keylease-lease-id': decision.lease.leaseId,
        'x-keylease-calls-remaining': String(decision.remainingCalls),
      },
      body: payload,
      signal:
        timeoutSignal === undefined
          ? clientAbortController.signal
          : AbortSignal.any([timeoutSignal, clientAbortController.signal]),
      redirect: 'manual',
    };

    try {
      if (clientAbortController.signal.aborted) return reply;

      const startTime = performance.now();
      let response: Response;
      try {
        response = await fetchImpl(target, init);
      } catch (error) {
        recordLatency((performance.now() - startTime) / 1000);
        if (clientAbortController.signal.aborted) return reply;
        const timedOut =
          error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        request.log.error({ err: error, target }, 'upstream request failed');
        return reply
          .code(timedOut ? 504 : 502)
          .type('application/json; charset=utf-8')
          .send({
            error: timedOut ? 'gateway_timeout' : 'bad_gateway',
            message: timedOut ? 'upstream did not respond in time' : 'upstream is unreachable',
          });
      }

      recordLatency((performance.now() - startTime) / 1000);

      reply.code(response.status);
      copyResponseHeaders(reply, response.headers);
      reply.header(REQUEST_ID_HEADER, request.id);
      reply.header('x-keylease-lease-id', decision.lease.leaseId);
      reply.header('x-keylease-calls-remaining', String(decision.remainingCalls));

      const emptyBody =
        method === 'HEAD' || response.status === 204 || response.status === 304;
      if (emptyBody) {
        return reply.send();
      }

      let responseBody: ArrayBuffer;
      try {
        responseBody = await response.arrayBuffer();
      } catch (error) {
        if (clientAbortController.signal.aborted) return reply;
        throw error;
      }
      if (clientAbortController.signal.aborted) return reply;
      if (!response.headers.has('content-type')) {
        reply.type('application/octet-stream');
      }
      return reply.send(Buffer.from(responseBody));
    } finally {
      socket.off('close', abortOnDisconnect);
    }
  };

  app.get('/healthz', async (_request, reply) => {
    return reply.code(200).type('application/json; charset=utf-8').send({ status: 'ok' });
  });

  app.get('/readyz', async (_request, reply) => {
    const ready = await verifier.isReady();
    if (ready) {
      return reply.code(200).type('application/json; charset=utf-8').send({ status: 'ok' });
    }
    return reply
      .code(503)
      .header('retry-after', String(verificationRetryAfterSeconds))
      .type('application/json; charset=utf-8')
      .send({
        error: 'verification_unavailable',
        message: 'verifier has no cached, reachable state',
      });
  });

  if (options.metricsEnabled === true) {
    app.get('/metrics', async (_request, reply) => {
      const verifierStats = verifier.stats();
      const lines: string[] = [
        '# HELP keylease_requests_total Total number of proxy requests received',
        '# TYPE keylease_requests_total counter',
        `keylease_requests_total ${metrics.requestsTotal}`,
        '',
        '# HELP keylease_requests_allowed_total Total number of requests allowed by lease verifier',
        '# TYPE keylease_requests_allowed_total counter',
        `keylease_requests_allowed_total ${metrics.requestsAllowed}`,
        '',
        '# HELP keylease_requests_denied_total Total number of requests denied by reason',
        '# TYPE keylease_requests_denied_total counter',
      ];
      for (const [reason, count] of metrics.requestsDenied.entries()) {
        lines.push(`keylease_requests_denied_total{error="${reason}"} ${count}`);
      }
      lines.push(
        '',
        '# HELP keylease_cache_hits_total Total number of lease cache hits',
        '# TYPE keylease_cache_hits_total counter',
        `keylease_cache_hits_total ${verifierStats.cache.hits}`,
        '',
        '# HELP keylease_cache_misses_total Total number of lease cache misses',
        '# TYPE keylease_cache_misses_total counter',
        `keylease_cache_misses_total ${verifierStats.cache.misses}`,
        '',
        '# HELP keylease_upstream_latency_seconds Upstream request duration in seconds',
        '# TYPE keylease_upstream_latency_seconds histogram',
      );
      for (let i = 0; i < METRICS_LATENCY_BUCKETS.length; i += 1) {
        lines.push(
          `keylease_upstream_latency_seconds_bucket{le="${METRICS_LATENCY_BUCKETS[i]}"} ${metrics.latencyBuckets[i]}`,
        );
      }
      lines.push(
        `keylease_upstream_latency_seconds_bucket{le="+Inf"} ${metrics.latencyCount}`,
        `keylease_upstream_latency_seconds_sum ${metrics.latencySum.toFixed(6)}`,
        `keylease_upstream_latency_seconds_count ${metrics.latencyCount}`,
        '',
      );
      return reply
        .code(200)
        .type('text/plain; version=0.0.4; charset=utf-8')
        .send(lines.join('\n'));
    });
  }

  // Fastify auto-exposes a HEAD route for every GET route; registering HEAD
  // explicitly as well would duplicate it.
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
  for (const url of ['/', '/*']) {
    app.route({ method: [...methods], url, handler });
  }

  return app;
}

/**
 * Gracefully drains in-flight requests and closes the Fastify instance within timeoutMs.
 */
export async function drainProxyServer(
  app: FastifyInstance,
  timeoutMs = 10_000,
): Promise<'drained' | 'timed_out'> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<'timed_out'>((resolve) => {
    timer = setTimeout(() => resolve('timed_out'), timeoutMs);
  });

  const closePromise = (async (): Promise<'drained'> => {
    if (typeof (app as unknown as { drainInFlight?: () => Promise<void> }).drainInFlight === 'function') {
      await (app as unknown as { drainInFlight: () => Promise<void> }).drainInFlight();
    }
    await app.close();
    return 'drained';
  })();

  try {
    const outcome = await Promise.race([closePromise, timeoutPromise]);
    return outcome;
  } finally {
    clearTimeout(timer!);
  }
}
