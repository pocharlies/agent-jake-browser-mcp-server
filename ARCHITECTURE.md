# ARCHITECTURE.md — agent-jake-browser-mcp-server

> Servidor MCP de Browser Harness (canónico: `pocharlies-org/agent-jake-browser-mcp-server`, tronco `master`).
> Escrito por `developer` en INFRA-386 (primer commit de M1B); el `architect` lo revisa y es quien lo mantiene.

## 1. Clientes y versiones

| cliente | repositorio | versión / contrato | cómo llega |
|---|---|---|---|
| Servidor MCP (HTTP + stdio) | este repo (`packages/core`) | `docs/contracts/browser-harness-v2.md` (negociado) y `-v1.md` (**deprecated**, legacy) | imagen construida desde este repo |
| Extensión de Chrome | `pocharlies-org/agent-jake-browser-mcp-extension` | misma `PROTOCOL_VERSION`; recibe `@agent-jake-browser/protocol` como tgz vendorizado | manual / zip de `/download` |
| Imagen k8s | `pocharlies-org/k8s-agentjake-browser-mcp-pocharlies` (tronco `main`) | pin por digest en `k8s/base/manifest.yaml` | ArgoCD `agentjake-browser-mcp` |
| Casas | `packages/house-pocharlies`, `packages/house-staticduo` | adaptadores; dependen de core | composición en `entrypoints/` |

## 2. Dependencias, en ambos sentidos

- **Depende de** — `ws`, `@modelcontextprotocol/sdk` 1.30.x, `zod`, `express`.
- **Dependen de él** — la extensión (wire WS), el AgentGateway (#149, `mcp.browser.tools`), el updater diario
  (`ci/update-watch.yaml` de dgx-infra, entradas `agent-browser-server`/`-extension`, DGX-147/309; hoy apunta a
  los forks `jibanez-staticduo/*`, no a este repo) y la imagen del repo k8s.
- Dirección de imports: `house-*` → `core` → `protocol`. **`core` y `protocol` nunca importan una casa**
  (CI: grep `house-pocharlies|house-staticduo|op-safe` = 0 sobre `packages/core` y `packages/protocol`).

## 3. Stack

Node 22/24, TypeScript, npm workspaces, vitest, tsup, zod 4.

## 4. Componentes compartidos

| concepto | pieza canónica | ruta |
|---|---|---|
| Esquemas de mensajes, errores, negociación de versión, límites, catálogo de tools | `@agent-jake-browser/protocol` | `packages/protocol` (**único sitio**; la extensión lo recibe vendorizado) |
| Registro de conexiones y binding por sesión | `ConnectionRegistry`, `SessionBroker` | `packages/core/src/` |
| Tokens / pairing | `token-store.ts`, `pairing-store.ts` | `packages/core/src/` |

Prohibida una segunda copia de esquemas (JSON/TS a mano).

## 5. Cómo se construye aquí

Endpoint legacy (sin versión, parser intacto) y endpoint **negociado** `/ws/harness` aparte; nunca se cae de uno
al otro por timeout. `maxPayload` de 32 MiB (33 554 432 B) solo en el negociado. El binding de navegador es por
sesión MCP; el core no elige por «último usado» en el endpoint negociado. La ventana por sesión y
`browser_claim_tab` son de INFRA-413 (extensión), que consume `sessionId`/`tabHandle` de la petición.

## 6. Tests

`npm test` (incluye build), `npm run test:contract` (wire legacy + negociado + matriz de versiones),
`npm run typecheck`. Los tests legacy no se editan; los del wire negociado van al lado.

## 7. CI/CD

`.github/workflows/ci.yml` en runners **`arc-k8s`** (regla ci-runners-arc). Sin despliegue desde este repo.

## 8. Trampas

- Forks (`jibanez-staticduo/*`) ≠ canónico (`pocharlies-org/*`): el updater aún apunta a los forks.
- El puerto `18766` es el local **propuesto** para el negociado, no una regla de descubrimiento.
- El entero de wire `1` del hello no es la «v1» del doc de contrato legacy.
- Si DGX-309 sigue en el host x86, la meta es el clúster.
