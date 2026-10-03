# Browser Harness negotiated wire contract (v2)

Status: **active, experimental package `0.1.0`**. Supersedes `browser-harness-v1.md` (deprecated, untouched).
Source of truth for every schema below: `packages/protocol` (`@agent-jake-browser/protocol`). This document
explains it; it never defines a second copy. Design: `docs/superpowers/specs/2026-10-01-browser-harness-m1b-design.md`.

## Identifiers (all distinct)

| identifier | what | value |
| --- | --- | --- |
| this document `v2` | surface/contract revision (file name) | 2 |
| wire version | integer negotiated in the hello | `1` (the first negotiated wire; **not** the legacy "v1" document) |
| package semver | `@agent-jake-browser/protocol` | `0.1.0` |
| catalog digest | `sha256:<hex>` over canonical JSON of the tool descriptors sorted by name | exported as `CATALOG_VERSION` |
| MCP initialize version | MCP SDK protocol version | unrelated |

Legacy is unversioned and is **not** a member of the supported list `[1]`.

## Endpoint

Separate listener, path `/ws/harness` (proposed local port `18766`; a proposal, never a discovery rule). The
legacy listener is untouched. No path or port is appended to a configured URL by guesswork; there is **no
fallback** to the legacy wire on a missing, late or invalid hello. Authentication is the same token as legacy,
checked at the upgrade (401). `maxPayload` is **33,554,432 bytes (32 MiB)** on this endpoint only.

## State machine

Server: authenticated upgrade → `AWAITING_HELLO` → `READY` → `CLOSED`. Nothing is registered and no tool is
dispatched before `READY`. First application frame must be `hello`.

| condition | reply | close |
| --- | --- | --- |
| no hello in 5 s | `hello_reject hello_timeout` | `4408` |
| first frame is not a hello (legacy frame, heartbeat, result, binary) | `hello_reject hello_required` | `4400` |
| malformed / extra keys / requested house | `hello_reject invalid_message` | `4400` |
| duplicate hello | `invalid_message` | `4400` |
| no common wire version | `hello_reject protocol_version_mismatch` (+ `supportedProtocolVersions`) | `4406` |
| catalog digest differs (exact equality) | `hello_reject catalog_version_mismatch` | `4406` |
| message over 32 MiB (either direction) | — | `1009` |

Greatest common version is chosen independent of list order. `hello_ack` carries server-issued `browserId`,
`connectionId` (new UUID per READY socket) and `house` (from deployment configuration, never from the client).

## Frames

`hello`, `hello_ack`, `hello_reject`, `tool_request`, `tool_result`, `session_close`, `request_cancel`,
`heartbeat`, `heartbeat_ack` — strict zod schemas in `packages/protocol/src/messages.ts`. Every frame is parsed
with the strict schema before acting. `tool_result` must echo `id`, `sessionId`, `connectionId`, `house`;
`ok:true` carries no `error`; `ok:false` carries `error` and no `data`.

## Identity and ownership

- `installationId` is a client **hint**: it never replaces a live socket, never resumes a binding.
- Shared static credentials do not prove which installation reconnects: a second socket with a copied
  `installationId` gets its own `connectionId`/`browserId` and cannot settle another socket's pending request.
- Binding is per MCP session (`SessionBinding {sessionId, browserId, connectionId, house}`): 0 browsers →
  `browser_unavailable`; 1 → atomic auto-bind; N → `browser_selection_required` (zero action). Explicit
  selection (`connection` argument) is persistent for that session; changing it with calls in flight →
  `session_busy`. Loss of the bound browser → `browser_disconnected`, never a fallback to another.
- A result is accepted only from the socket and generation that own the pending request, with all ids matching;
  wrong-sender / duplicate / late / unknown results are discarded without consuming a legitimate entry.
- `tabHandle` is an opaque string carried in `tool_request`; M1B.1/2 pass it through. Issuance, invalidation and
  recovery (M1B.3) are not part of this revision; the window-per-session lifecycle belongs to INFRA-413.

## Limits

16 versions, 128 capability names, 128 UTF-8 bytes per identifier, 5 s hello, 20 s heartbeat, 32 MiB per
complete uncompressed UTF-8 JSON message in both directions (checked before parse on receipt and before send).

## Errors

`protocol_version_mismatch`, `catalog_version_mismatch`, `hello_required`, `hello_timeout`, `invalid_message`,
`browser_selection_required`, `browser_unavailable`, `browser_not_found`, `browser_disconnected`, `session_busy`,
`session_closed`, `request_cancelled`, `request_timeout`, `tab_handle_invalid`, `capability_unavailable`,
`capability_revoked`, `payload_too_large`, `response_correlation_mismatch`. Messages are bounded and carry no
token, query string or payload.

## Compatibility fixture

`packages/core/tests/fixtures/harness/version-matrix.json` (identical file in the extension repo) fixes the
matrix; both repos execute it against the real handshake. Changing it is a reviewed contract change.
