# Session token format (`kls1`)

A session token is the bearer credential a consumer presents to a KeyLease
proxy (`Authorization: Bearer <token>`). It is minted offline by the CLI
(`mintSessionToken` in `packages/cli/src/token.ts`) and signed with the
consumer's Stellar ed25519 key, the same account that owns the lease on chain.

```
kls1.<base64url(payload JSON)>.<base64url(ed25519 signature)>
```

Three segments separated by `.`:

| Segment | Content |
| --- | --- |
| 1. prefix | The literal `kls1`. Any other prefix is `malformed_token`. |
| 2. payload | The UTF-8 JSON payload, base64url encoded. |
| 3. signature | The 64-byte ed25519 signature, base64url encoded. |

## Encoding rules

- base64url is the URL-safe alphabet (`A-Z a-z 0-9 - _`). The CLI emits it
  **without** `=` padding. A segment must be non-empty and match
  `^[A-Za-z0-9_-]+$`, otherwise the token is `malformed_token`.
- The signature must decode to exactly 64 bytes.
- The payload must decode to a JSON object containing every field below with
  the stated type. Unknown extra fields are not rejected by the reference
  parser, but the CLI never emits any.

## Payload fields

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | number | Token format version. Currently `1`; any other value is `unsupported_version`. |
| `lease_id` | string | Identifier of the on-chain lease the session rides on (a decimal string such as `"42"`). |
| `consumer` | string | Stellar public key (`G...`, ed25519) of the lease owner. It is also the verification key for the signature. An invalid key is `invalid_consumer`. |
| `iat` | number | Issued-at, integer unix seconds. |
| `exp` | number | Expiry, integer unix seconds. The minter requires `exp > iat`. |

## What is signed

The signature covers the **payload segment exactly as transmitted**: the
ASCII bytes of the base64url string in segment 2, not the decoded JSON.
Verifiers must therefore not re-serialise or re-encode the JSON before
checking the signature; there is no key-ordering or number-formatting
canonicalisation to get wrong. The prefix and the dots are not signed.

Signature check: `ed25519_verify(publicKey(payload.consumer), bytes(segment2), signature)`.

## Validity window, expiry and clock skew

With `now` as the verifier's unix time in seconds:

- **Expired**: `now >= exp` fails with `token_expired`. The expiry instant itself
  is already invalid.
- **Not yet valid**: `iat > now + skew` fails with `token_not_yet_valid`.
  `skew` (`maxClockSkewSeconds`) defaults to **60 seconds** and tolerates a
  consumer clock that runs slightly ahead of the verifier. A token issued in the
  past is never rejected on `iat` grounds; only `exp` limits its age.

The proxy reports both `token_expired` and `token_not_yet_valid` to the caller
as `401` with `error: "token_expired"` (see [proxy-api.md](./proxy-api.md)); the
distinction exists on the library error code only.

## Error codes

Thrown as `TokenVerificationError` with a `code`:

| Code | Cause |
| --- | --- |
| `malformed_token` | Wrong segment count, unknown prefix, bad base64url, signature not 64 bytes, payload not JSON or missing fields. At mint time also non-integer `iat`/`exp` or `exp <= iat`. |
| `unsupported_version` | `v` is not `1`. |
| `invalid_consumer` | `consumer` is not a valid Stellar ed25519 public key (or, at mint time, the secret seed is invalid). |
| `bad_signature` | The signature does not verify over segment 2. |
| `lease_mismatch` | Only when the caller passes `expectedLeaseId` and it differs from `lease_id`. |
| `consumer_mismatch` | Only when the caller passes `expectedConsumer` and it differs from `consumer`. |
| `token_expired` | `now >= exp`. |
| `token_not_yet_valid` | `iat > now + skew`. |

A token check is **offline only**. It proves that the holder of the consumer
key minted the token. Binding `consumer` to `lease_id` is done separately by the
proxy against the on-chain lease (`consumer_mismatch`, `lease_inactive`,
`lease_expired`, `quota_exhausted` there are lease decisions, not token errors).

## Worked example

Generated with a throwaway key (32 bytes of `0x07` as the ed25519 seed),
`lease_id` `42`, `iat` `1760000000`, `exp` `1760003600`. Never reuse this key.

Token:

```
kls1.eyJ2IjoxLCJsZWFzZV9pZCI6IjQyIiwiY29uc3VtZXIiOiJHRFZFVTNERDRLT0ZFQ1Y2NlZJSFdFWk9ZWDRaS1IzV1YyN0w0NjRTSUlQT1UySVVJM0pDWkE1NyIsImlhdCI6MTc2MDAwMDAwMCwiZXhwIjoxNzYwMDAzNjAwfQ.Cx7Zv_HWKd7Cb5IztLnU2v5bwJXY12AhV2rLgZxaBoqbIi1u7AkxS2efBbAW-SmoWXSnLA48NCG3otRoSIuKBg
```

Decoded payload (segment 2):

```json
{"v":1,"lease_id":"42","consumer":"GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57","iat":1760000000,"exp":1760003600}
```

The signed bytes are the ASCII string `eyJ2Ijox...fQ` (segment 2, verbatim).
This token is long expired; verify it with `now` set inside the window, for
example `verifySessionToken(token, { now: 1760000100 })`.

## Verification pseudocode

```
function verify(token, now, skew = 60):
    parts = token.split(".")
    if len(parts) != 3:                         fail malformed_token
    prefix, seg_payload, seg_sig = parts
    if prefix != "kls1":                        fail malformed_token
    if seg_payload or seg_sig not base64url:    fail malformed_token
    sig = base64url_decode(seg_sig)
    if len(sig) != 64:                          fail malformed_token
    payload = json_parse(base64url_decode(seg_payload))   # fail malformed_token
    require payload.v, lease_id, consumer, iat, exp have the documented types
    if payload.v != 1:                          fail unsupported_version
    if not valid_stellar_ed25519_pubkey(payload.consumer): fail invalid_consumer

    # the signed message is the transmitted segment, byte for byte
    if not ed25519_verify(payload.consumer, ascii_bytes(seg_payload), sig):
                                                fail bad_signature
    if now >= payload.exp:                      fail token_expired
    if payload.iat > now + skew:                fail token_not_yet_valid
    return payload
```
