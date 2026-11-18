# Proxy HTTP reference

Contract of `@keylease/proxy` (`packages/proxy/src/server.ts`,
`verifier.ts`). Operator configuration (environment variables) is in the
[README](../README.md#proxy-configuration).

The proxy has no routes of its own. Every request is verified and, if allowed,
forwarded to the configured upstream (`KEYLEASE_UPSTREAM_URL`).

## Routes and methods

| Method | Path | Behaviour |
| --- | --- | --- |
| `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` | `/` and any path (`/*`) | Verified, then forwarded to `<upstream><path>?<query>`. |
| `HEAD` | `/` and any path | Fastify exposes `HEAD` for each `GET` route automatically. The response has no body. |

The path and query are forwarded as received; a path prefix in
`KEYLEASE_UPSTREAM_URL` is preserved. There are **no health or status
endpoints** in the current code, so a request to `/health` is treated like any
other path: it needs a valid token and is forwarded upstream (and consumes a
call). Update this page when health endpoints are added.

## Request

### Headers the caller sends

| Header | Required | Notes |
| --- | --- | --- |
| `Authorization` | yes | `Bearer <session token>` (see [session-token.md](./session-token.md)). The scheme is matched case-insensitively and followed by spaces or tabs. |
| `Content-Type` | no | Not interpreted. Any content type is accepted and the body is forwarded as raw bytes. |

Header names are case-insensitive; the proxy lower-cases them when forwarding.

### What is forwarded upstream

- All request headers except hop-by-hop ones: `connection`, `keep-alive`,
  `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`,
  `transfer-encoding`, `upgrade`, `host`, `content-length`.
- `Authorization` is **dropped** unless `KEYLEASE_FORWARD_AUTH=true`.
- Multi-valued headers are joined onto one line with `, ` (`; ` for `cookie`).
- The proxy sets:

| Header | Value |
| --- | --- |
| `x-forwarded-for` | Incoming `x-forwarded-for` (if any) with the client address appended. |
| `x-forwarded-host` | The incoming `Host`. |
| `x-forwarded-proto` | `http` or `https` as seen by the proxy. |
| `x-keylease-lease-id` | Lease id from the verified token. |
| `x-keylease-calls-remaining` | Calls left on the lease after this one. |

- The body is forwarded unchanged for every method except `GET` and `HEAD`
  (an empty body is omitted).

## Response

On success the upstream status, body and headers are returned, minus the
hop-by-hop headers above (`set-cookie` values are preserved individually). The
proxy adds:

| Header | Value |
| --- | --- |
| `x-keylease-lease-id` | Lease id. |
| `x-keylease-calls-remaining` | Calls left on the lease after this one. |

`HEAD`, `204` and `304` responses carry no body. If the upstream sends no
`Content-Type`, the proxy sets `application/octet-stream`.

Upstream error statuses (4xx/5xx from the API itself) are passed through
unchanged, and the call still counts against the quota.

## Error responses

Errors produced by the proxy use `Content-Type: application/json; charset=utf-8`
and this schema:

```json
{ "error": "<machine code>", "message": "<human readable text>" }
```

| Status | `error` | Cause |
| --- | --- | --- |
| 401 | `missing_token` | No `Authorization` header. |
| 401 | `invalid_token` | Header present but not the Bearer scheme, or the token is malformed, forged, has an unsupported version, etc. |
| 401 | `token_expired` | Token expired, or issued too far in the future (`token_not_yet_valid` is reported under this code). |
| 403 | `lease_not_found` | The lease does not exist on chain. |
| 403 | `consumer_mismatch` | Token consumer is not the lease owner. |
| 403 | `lease_inactive` | The lease was revoked. |
| 403 | `lease_expired` | The on-chain lease has expired. |
| 403 | `quota_exhausted` | The lease's call limit is spent (counting on-chain and local usage). |
| 503 | `verification_unavailable` | Soroban RPC could not be reached to verify the lease (fails closed). |
| 502 | `bad_gateway` | Upstream unreachable (only after the lease passed). |
| 504 | `gateway_timeout` | Upstream did not respond within the timeout. |

Examples (the `message` text is what the code emits; ids and counts vary):

```json
{ "error": "missing_token", "message": "missing Authorization: Bearer <lease_token> header" }
```
```json
{ "error": "invalid_token", "message": "authorization header must use the Bearer scheme" }
```
```json
{ "error": "token_expired", "message": "session token has expired" }
```
```json
{ "error": "lease_not_found", "message": "lease 42 does not exist on chain" }
```
```json
{ "error": "consumer_mismatch", "message": "token consumer does not own this lease" }
```
```json
{ "error": "lease_inactive", "message": "lease has been revoked" }
```
```json
{ "error": "lease_expired", "message": "lease has expired" }
```
```json
{ "error": "quota_exhausted", "message": "lease quota exhausted (100 calls spent)" }
```
```json
{ "error": "verification_unavailable", "message": "unable to verify lease 42 over Soroban RPC" }
```
```json
{ "error": "bad_gateway", "message": "upstream is unreachable" }
```
```json
{ "error": "gateway_timeout", "message": "upstream did not respond in time" }
```

For `invalid_token` and `token_expired` the `message` carries the token
verification message (for example `session token signature does not verify`);
see [session-token.md](./session-token.md).

Errors raised by the HTTP framework itself (for example a body over the limit)
come from Fastify's default error handler and are not guaranteed to follow the
schema above.

## Defaults

| Setting | Default | Notes |
| --- | --- | --- |
| Upstream timeout | 15 000 ms | `requestTimeoutMs` in `buildProxyServer`; `0` disables it. Not exposed as an environment variable. |
| Request body limit | 32 MiB (`32 * 1024 * 1024` bytes) | Fastify `bodyLimit`, fixed in code. |
| Listen address | `0.0.0.0:8080` | `HOST` / `PORT`. |
| Lease-state cache TTL | 30 000 ms | `KEYLEASE_CACHE_TTL_MS`. |
