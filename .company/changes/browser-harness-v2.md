# browser-harness-v2 (INFRA-386, M1B)

- **Old surface:** unversioned legacy WS (`docs/contracts/browser-harness-v1.md`): no hello, last-used browser selection, correlation by request id only, 100 MiB default payload. Left unchanged and now marked deprecated.
- **New surface:** `docs/contracts/browser-harness-v2.md`: negotiated endpoint `/ws/harness` (hello/hello_ack/hello_reject, wire version `1`, catalog digest), per-MCP-session browser binding, socket/generation correlation, 32 MiB per message. Source of truth: `packages/protocol`. Opt-in (`BROWSER_HARNESS_PORT` / `harness` option); the legacy listener is not touched.
- **Who moves:** the extension (vendored protocol tgz, new state machine, still ships the legacy client until the authorized rollout); both houses (StaticDuo, Pocharlies NAS) and the updater (DGX-147/309) only when the separate, authorized rollout happens. Nothing is deployed by this change.
- **Decision recorded in:** INFRA-383 `nota-architect-plan.md` (APROBADO) and the M1B design (`docs/superpowers/specs/2026-10-01-browser-harness-m1b-design.md`, PR #3).
