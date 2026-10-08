/**
 * Edge reverse proxy: intercepts every request, verifies the KeyLease bearer
 * token (signature + cached on-chain state + local quota), then forwards
 * allowed requests to the protected upstream API.
 */
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
  /** Per-request upstream timeout in milliseconds. Defaults to 15s; 0 disables it. */
  requestTimeoutMs?: number;
}

export interface ForwardedRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: Buffer | undefined;
  signal?: AbortSignal | undefined;
}

/** Normalises a relative request URL against the configured upstream. */
export function resolveUpstreamUrl(upstream: string, rawUrl: string): string {
  const base = new URL(upstream);
  const path = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '');
  return new URL(`${basePath}${path}`, base.origin).toString();
}

/**
 * Copies request headers, dropping hop-by-hop entries (and auth by default).
 * Multi-valued headers are folded onto a single field line: `; ` for cookies
 * (RFC 6265), `, ` for everything else.
 */
export function buildUpstreamHeaders(
  headers: Record<string, string | string[] | undefined>,
  options: { forwardAuthorization?: boolean } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'authorization' && options.forwardAuthorization !== true) continue;
    out[lower] = Array.isArray(value) ? value.join(lower === 'cookie' ? '; ' : ', ') : value;
  }
  return out;
}

function appendForwardedFor(
  incoming: string | string[] | undefined,
  remote: string | undefined,
): string {
  const existing = Array.isArray(incoming) ? incoming.join(', ') : incoming;
  if (remote === undefined || remote.length === 0) return existing ?? '';
  return existing && existing.length > 0 ? `${existing}, ${remote}` : remote;
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
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;

  // Parse every payload as a buffer so the proxy forwards bodies untouched.
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 32 * 1024 * 1024 });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const decision = await verifier.verifyAuthorization(request.headers.authorization);
    if (!decision.ok) {
      request.log.info(
        { reason: decision.reason, url: request.url },
        'request denied by lease verifier',
      );
      return reply
        .code(decision.status)
        .type('application/json; charset=utf-8')
        .send({ error: decision.reason, message: decision.message });
    }

    const target = resolveUpstreamUrl(upstream, request.raw.url ?? '/');
    const method = request.method;
    const headers = buildUpstreamHeaders(request.headers, { forwardAuthorization });
    const payload =
      allowsBody(method) && Buffer.isBuffer(request.body) && request.body.length > 0
        ? request.body
        : undefined;

    const init: ForwardedRequestInit = {
      method,
      headers: {
        ...headers,
        'x-forwarded-for': appendForwardedFor(request.headers['x-forwarded-for'], request.ip),
        'x-forwarded-host': request.headers.host ?? '',
        'x-forwarded-proto': request.protocol,
        'x-keylease-lease-id': decision.lease.leaseId,
        'x-keylease-calls-remaining': String(decision.remainingCalls),
      },
      body: payload,
      signal: requestTimeoutMs > 0 ? AbortSignal.timeout(requestTimeoutMs) : undefined,
    };

    let response: Response;
    try {
      response = await fetchImpl(target, init);
    } catch (error) {
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

    reply.code(response.status);
    copyResponseHeaders(reply, response.headers);
    reply.header('x-keylease-lease-id', decision.lease.leaseId);
    reply.header('x-keylease-calls-remaining', String(decision.remainingCalls));

    const emptyBody =
      method === 'HEAD' || response.status === 204 || response.status === 304;
    if (emptyBody) {
      return reply.send();
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.headers.has('content-type')) {
      reply.type('application/octet-stream');
    }
    return reply.send(buffer);
  };

  // Fastify auto-exposes a HEAD route for every GET route; registering HEAD
  // explicitly as well would duplicate it.
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
  for (const url of ['/', '/*']) {
    app.route({ method: [...methods], url, handler });
  }

  return app;
}
