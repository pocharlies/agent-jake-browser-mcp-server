import { sha256Hex } from './sha256.js';

export type ToolRisk = 'read' | 'write' | 'dangerous';
/** `tab`: acts on a tab target; `tabless`: no tab; `creates`: creates a tab (returns a handle). */
export type TabScope = 'tab' | 'tabless' | 'creates';

/** JSON-serializable metadata only. Argument/result schemas are extracted here in M1B.3. */
export interface ToolDescriptor {
  readonly name: string;
  readonly risk: ToolRisk;
  readonly tabScope: TabScope;
  /** Opaque capability name a client must have negotiated; absent = always available. */
  readonly capability?: string;
  /** Answered by the server without a browser. */
  readonly serverSide?: boolean;
}

const d = (
  name: string,
  risk: ToolRisk,
  tabScope: TabScope,
  extra: { capability?: string; serverSide?: boolean } = {},
): ToolDescriptor => Object.freeze({ name, risk, tabScope, ...extra });

export const TOOL_CATALOG: readonly ToolDescriptor[] = Object.freeze([
  d('browser_navigate', 'write', 'tab'),
  d('browser_go_back', 'write', 'tab'),
  d('browser_go_forward', 'write', 'tab'),
  d('browser_reload', 'write', 'tab'),
  d('browser_state', 'read', 'tab'),
  d('browser_find', 'read', 'tab'),
  d('browser_snapshot', 'read', 'tab'),
  d('browser_click', 'write', 'tab'),
  d('browser_type', 'write', 'tab'),
  d('browser_hover', 'write', 'tab'),
  d('browser_drag', 'write', 'tab'),
  d('browser_select_option', 'write', 'tab'),
  d('browser_press_key', 'write', 'tab'),
  d('browser_wait', 'read', 'tabless'),
  d('browser_screenshot', 'read', 'tab'),
  d('browser_pdf', 'read', 'tab'),
  d('browser_get_console_logs', 'read', 'tab'),
  d('browser_new_tab', 'write', 'creates'),
  d('browser_list_tabs', 'read', 'tabless'),
  d('browser_switch_tab', 'write', 'tab'),
  d('browser_send_to_back', 'write', 'tab'),
  d('browser_close_tab', 'write', 'tab'),
  d('browser_get_text', 'read', 'tab'),
  d('browser_get_attribute', 'read', 'tab'),
  d('browser_is_visible', 'read', 'tab'),
  d('browser_wait_for_element', 'read', 'tab'),
  d('browser_highlight', 'write', 'tab'),
  d('browser_evaluate', 'dangerous', 'tab'),
  d('browser_get_html', 'read', 'tab'),
  d('browser_iframe_eval', 'dangerous', 'tab'),
  d('browser_iframe_click', 'write', 'tab'),
  d('browser_upload_file', 'write', 'tab'),
  d('browser_resize_viewport', 'write', 'tab'),
  d('browser_network_requests', 'read', 'tab'),
  d('browser_network_request', 'read', 'tab'),
  d('browser_cdp', 'dangerous', 'tab', { capability: 'cdp.raw' }),
  d('browser_drop', 'write', 'tab'),
  d('browser_fill_form', 'write', 'tab'),
  d('browser_run_code_unsafe', 'dangerous', 'tab'),
  d('browser_list_connections', 'read', 'tabless', { serverSide: true }),
]);

export const TOOL_NAMES: readonly string[] = Object.freeze(TOOL_CATALOG.map((t) => t.name));

/** Recursively sorted keys, array order kept, no whitespace. Pure and deterministic. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** `sha256:<hex>` over UTF-8 canonical JSON of descriptors sorted by tool name. */
export function computeCatalogDigest(descriptors: readonly ToolDescriptor[] = TOOL_CATALOG): string {
  const sorted = [...descriptors].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return `sha256:${sha256Hex(canonicalJson(sorted))}`;
}

/** Build-produced digest of this package's own catalog. */
export const CATALOG_VERSION: string = computeCatalogDigest();
