/**
 * Harness plugin route codec.
 *
 * The wire format mirrors `packages/shared-contracts/src/harness-route.ts` in
 * codex-host (`encodeHarnessPluginRoute` / `decodeHarnessPluginRoute`) so both
 * sides agree byte for byte:
 *
 *   `codexhost/plugin-v1@` + lowercase hex of the canonical JSON payload
 *
 * The canonical payload always serialises its keys in this order and drops
 * absent optionals: `harnessId`, `model`, `thinkingOptionId`,
 * `permissionModeId`. Every byte of the payload is two lowercase hex digits.
 *
 * Known upstream nuance: codex-host validates `model` through
 * `harnessModelRefSchema`, i.e. on the wire it is an object `{ "id": "..." }`.
 * This module keeps the mobile-side surface flat (`model?: string`) and accepts
 * both shapes when decoding, but **always encodes the object form** — emitting a
 * bare id string makes codex-host's own decoder reject the route with
 * "Invalid Harness plugin route", which is exactly what happened once.
 */

export const HARNESS_ROUTE_PREFIX = "codexhost/plugin-v1@";

const MAX_ROUTE_LENGTH = 4096;
const HARNESS_ID_MAX_LENGTH = 128;
const MODEL_REF_MAX_LENGTH = 512;
const OPTION_ID_MAX_LENGTH = 128;
/** The official Codex identity is reserved and never routed through a plugin. */
const RESERVED_HARNESS_ID = "codex";

const HARNESS_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const TRANSPORT_SAFE_PATTERN = /^[A-Za-z0-9._~-]+$/u;
const HEX_PAYLOAD_PATTERN = /^(?:[a-f0-9]{2})+$/u;

const INVALID_ROUTE_MESSAGE = "Invalid Harness plugin route";
const ROUTE_KEYS: readonly string[] = [
  "harnessId",
  "model",
  "thinkingOptionId",
  "permissionModeId",
];

export interface HarnessRoute {
  harnessId: string;
  model?: string;
  thinkingOptionId?: string;
  permissionModeId?: string;
}

function invalidRoute(): never {
  throw new Error(INVALID_ROUTE_MESSAGE);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHarnessId(value: unknown): string {
  if (typeof value !== "string") invalidRoute();
  if (value.length < 1 || value.length > HARNESS_ID_MAX_LENGTH) invalidRoute();
  if (value.trim().length === 0) invalidRoute();
  if (!HARNESS_ID_PATTERN.test(value)) invalidRoute();
  if (value === RESERVED_HARNESS_ID) invalidRoute();
  return value;
}

function parseTransportSafeId(value: unknown, maxLength: number): string {
  if (typeof value !== "string") invalidRoute();
  if (value.length < 1 || value.length > maxLength) invalidRoute();
  if (value.trim().length === 0) invalidRoute();
  if (!TRANSPORT_SAFE_PATTERN.test(value)) invalidRoute();
  return value;
}

/** codex-host carries the Model Ref as `{ id }`; a bare id string is tolerated. */
function parseModelRef(value: unknown): string {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== "id") invalidRoute();
    return parseTransportSafeId(value.id, MODEL_REF_MAX_LENGTH);
  }
  return parseTransportSafeId(value, MODEL_REF_MAX_LENGTH);
}

interface ParsedRoute {
  route: HarnessRoute;
  /** Canonical payload rebuilt from the raw wire value (keeps `model` shape). */
  canonical: Record<string, unknown>;
}

function parseRouteObject(value: unknown): ParsedRoute {
  if (!isPlainObject(value)) invalidRoute();
  for (const key of Object.keys(value)) {
    if (!ROUTE_KEYS.includes(key)) invalidRoute();
  }
  const harnessId = parseHarnessId(value.harnessId);
  const rawModel = value.model;
  const model = rawModel === undefined ? undefined : parseModelRef(rawModel);
  const thinkingOptionId =
    value.thinkingOptionId === undefined
      ? undefined
      : parseTransportSafeId(value.thinkingOptionId, OPTION_ID_MAX_LENGTH);
  const permissionModeId =
    value.permissionModeId === undefined
      ? undefined
      : parseTransportSafeId(value.permissionModeId, OPTION_ID_MAX_LENGTH);
  const route: HarnessRoute = { harnessId };
  const canonical: Record<string, unknown> = { harnessId };
  if (model !== undefined) {
    route.model = model;
    // 线上必须是 `{ id }` 对象。codex-host 的 encodeHarnessPluginRoute 是
    // `JSON.stringify(harnessPluginRouteSchema.parse(route))`，而它的 schema 把
    // model 定义成 harnessModelRefSchema = z.object({ id }).strict()——
    // 发裸字符串会被它的 parse 拒掉，报 "Invalid Harness plugin route"。
    // （解码时仍然两种都收，见 parseModelRef。）
    canonical.model = { id: model };
  }
  if (thinkingOptionId !== undefined) {
    route.thinkingOptionId = thinkingOptionId;
    canonical.thinkingOptionId = thinkingOptionId;
  }
  if (permissionModeId !== undefined) {
    route.permissionModeId = permissionModeId;
    canonical.permissionModeId = permissionModeId;
  }
  return { route, canonical };
}

function toHex(json: string): string {
  let hex = "";
  for (const character of json) {
    hex += character.charCodeAt(0).toString(16).padStart(2, "0");
  }
  return hex;
}

function fromHex(payload: string): string {
  let json = "";
  for (let index = 0; index < payload.length; index += 2) {
    json += String.fromCharCode(Number.parseInt(payload.slice(index, index + 2), 16));
  }
  return json;
}

export function encodeHarnessRoute(route: HarnessRoute): string {
  const { canonical } = parseRouteObject(route);
  return `${HARNESS_ROUTE_PREFIX}${toHex(JSON.stringify(canonical))}`;
}

/** `null` means another protocol, not an invalid or unavailable Harness. */
export function decodeHarnessRoute(value: unknown): HarnessRoute | null {
  if (typeof value !== "string" || !value.startsWith(HARNESS_ROUTE_PREFIX)) return null;
  const payload = value.slice(HARNESS_ROUTE_PREFIX.length);
  if (value.length > MAX_ROUTE_LENGTH || !HEX_PAYLOAD_PATTERN.test(payload)) {
    throw new Error(INVALID_ROUTE_MESSAGE);
  }
  try {
    const { route, canonical } = parseRouteObject(JSON.parse(fromHex(payload)));
    if (toHex(JSON.stringify(canonical)) !== payload) {
      throw new Error(INVALID_ROUTE_MESSAGE);
    }
    return route;
  } catch {
    throw new Error(INVALID_ROUTE_MESSAGE);
  }
}

/** Cheap pre-check that never throws: does this value claim our protocol? */
export function isHarnessRouteValue(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(HARNESS_ROUTE_PREFIX);
}

/** Decode for display only; malformed routes degrade to `null`. */
export function tryDecodeHarnessRoute(value: unknown): HarnessRoute | null {
  try {
    return decodeHarnessRoute(value);
  } catch {
    return null;
  }
}

/** 编码失败（非法 id）时返回 null，别让调用方崩在渲染里。 */
export function tryEncodeHarnessRoute(route: HarnessRoute | null): string | null {
  if (!route) return null;
  try {
    return encodeHarnessRoute(route);
  } catch {
    return null;
  }
}

/** `harness 显示名 · 路由内的 model`, falling back to the raw harness id. */
export function harnessRouteLabel(route: HarnessRoute, displayName?: string): string {
  const name =
    typeof displayName === "string" && displayName.trim()
      ? displayName.trim()
      : route.harnessId;
  return route.model ? `${name} · ${route.model}` : name;
}
