import {
  LIFECYCLE_PATHS,
  libraryPath,
  subscriptionHandlerPath,
  timerHandlerPath,
} from "./sources.ts";
import type { WireManifest } from "./manifest.ts";
import type {
  CustomAppKind,
  EdgeAppExecCommand,
  EdgeAppHTTPRoute,
  EdgeAppLogLevel,
  EdgeAppModbusPort,
  EdgeAppMQTTBroker,
  EdgeAppOPCUAEndpoint,
  EdgeAppSNMPDevice,
  WorkflowTriggerState,
  WorkflowVersionState,
} from "./graphql/operations.ts";

/**
 * Render a `WireManifest` as a `manifest.ts` source file.
 *
 * `manifest.ts` is v2-only — calling this with a v1 manifest is a bug,
 * since pull-of-v1 always writes `manifest.yaml` instead.
 *
 * Pull always materialises every Lua body to a separate file and
 * references it via `luaFile("./...")` — the printer never emits inline
 * `lua\`...\`` bodies. Authors who want inline one-liners write them by
 * hand; the round-trip rule is "pull's output is a valid input for push,"
 * not "pull preserves the author's exact source layout."
 */
export function printManifestTs(manifest: WireManifest): string {
  if ((manifest as Record<string, unknown>).engine_version === 1) {
    throw new Error(
      `printManifestTs called with a v1 manifest. v1 integrations must ` +
        `be written as manifest.yaml — pull with --format yaml instead.`,
    );
  }
  const lines = [
    `import { defineIntegration, luaFile } from "@wearecococo/dev-cli/define";`,
    "",
    `export default defineIntegration(${printObject(toAuthorShape(manifest), 0)});`,
    "",
  ];
  return lines.join("\n");
}

/**
 * Convert a snake_case v2 `WireManifest` into the camelCase author
 * surface the printer emits. Source fields become `luaFile()` references;
 * every `LuaFileRef` survives the print step verbatim.
 */
function toAuthorShape(manifest: WireManifest): Record<string, unknown> {
  const m = manifest as Record<string, unknown>;
  const out: Record<string, unknown> = {
    id: m.id,
    version: m.version,
    engineVersion: 2,
    sdkVersion: m.sdk_version,
  };
  copy(out, "description", m.description);
  copy(out, "runtimeMode", m.runtime_mode);
  copy(out, "resources", m.resources);
  copy(out, "permissions", m.permissions);
  copy(out, "dataContainerSchemas", m.data_container_schemas);
  copy(out, "actions", m.actions);
  copy(out, "timeoutMs", m.timeout_ms);

  // Replace every materialised source with a `luaFile()` reference.
  if (typeof m.init_source === "string" && m.init_source !== "") {
    out.initSource = luaFileRef(LIFECYCLE_PATHS.init_source);
  }
  if (typeof m.shutdown_source === "string" && m.shutdown_source !== "") {
    out.shutdownSource = luaFileRef(LIFECYCLE_PATHS.shutdown_source);
  }
  if (typeof m.upgrade_source === "string" && m.upgrade_source !== "") {
    out.upgradeSource = luaFileRef(LIFECYCLE_PATHS.upgrade_source);
  }

  if (Array.isArray(m.timers)) {
    out.timers = m.timers.map((t) => {
      const timer = { ...(t as Record<string, unknown>) };
      const name = String(timer.name ?? "");
      if (typeof timer.source === "string" && timer.source !== "" && name) {
        timer.source = luaFileRef(timerHandlerPath(name));
      } else if (timer.source === "" || timer.source == null) {
        delete timer.source;
      }
      return timer;
    });
  }
  if (Array.isArray(m.subscriptions)) {
    out.subscriptions = m.subscriptions.map((s) => {
      const sub = { ...(s as Record<string, unknown>) };
      const topic = String(sub.topic ?? "");
      if (typeof sub.source === "string" && sub.source !== "" && topic) {
        sub.source = luaFileRef(subscriptionHandlerPath(topic));
      } else if (sub.source === "" || sub.source == null) {
        delete sub.source;
      }
      return sub;
    });
  }
  if (m.libraries && typeof m.libraries === "object" && !Array.isArray(m.libraries)) {
    const libsIn = m.libraries as Record<string, string>;
    const libsOut: Record<string, unknown> = {};
    for (const [name, content] of Object.entries(libsIn)) {
      if (typeof content === "string" && content.length > 0) {
        libsOut[name] = luaFileRef(libraryPath(name));
      }
    }
    if (Object.keys(libsOut).length > 0) out.libraries = libsOut;
  }

  return out;
}

function copy(out: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) out[key] = value;
}

// ──────────────────────────────────────────────────────────────────────
// Tiny TS-literal printer. Handles the value shapes that defineIntegration
// arguments contain: strings, numbers, booleans, nulls, arrays, plain
// objects, and the `LuaFileRef` sentinel below.
// ──────────────────────────────────────────────────────────────────────

const LUA_FILE_REF = Symbol("luaFileRef");
type LuaFileRef = { [LUA_FILE_REF]: true; path: string };

function luaFileRef(path: string): LuaFileRef {
  return { [LUA_FILE_REF]: true, path: `./${path}` };
}

function isLuaFileRef(x: unknown): x is LuaFileRef {
  return typeof x === "object" && x !== null && (x as LuaFileRef)[LUA_FILE_REF] === true;
}

function printValue(value: unknown, indent: number): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isLuaFileRef(value)) return `luaFile(${JSON.stringify(value.path)})`;
  if (isFileRef(value)) return `file(${JSON.stringify(value.path)})`;
  if (Array.isArray(value)) return printArray(value, indent);
  if (typeof value === "object") return printObject(value as Record<string, unknown>, indent);
  return JSON.stringify(value);
}

function printArray(arr: unknown[], indent: number): string {
  if (arr.length === 0) return "[]";
  const inner = " ".repeat((indent + 1) * 2);
  const closing = " ".repeat(indent * 2);
  const items = arr.map((v) => `${inner}${printValue(v, indent + 1)}`);
  return `[\n${items.join(",\n")},\n${closing}]`;
}

function printObject(obj: Record<string, unknown>, indent: number): string {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "{}";
  const inner = " ".repeat((indent + 1) * 2);
  const closing = " ".repeat(indent * 2);
  const lines = entries.map(([k, v]) => `${inner}${formatKey(k)}: ${printValue(v, indent + 1)}`);
  return `{\n${lines.join(",\n")},\n${closing}}`;
}

const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function formatKey(k: string): string {
  return SAFE_KEY.test(k) ? k : JSON.stringify(k);
}

// ──────────────────────────────────────────────────────────────────────
// Custom-app printer. Materialises template / script / serverApi to
// disk and emits a `defineCustomApp({...})` source file with `file()` /
// `luaFile()` references. Used by `cococo init --type app` and by
// `cococo pull --type app`.
// ──────────────────────────────────────────────────────────────────────

export type AppPrintInput = {
  handle: string;
  name: string;
  kind: CustomAppKind;
  icon?: string;
  /** Relative path the printed manifest will reference for template. */
  templatePath: string;
  scriptPath: string;
  /** Set only when serverApi exists — drives whether luaFile() is imported. */
  serverApiPath?: string;
  /** JSON-encoded; will be `JSON.parse`d and emitted as a literal. */
  dataContainerSpec?: string;
};

export function printAppManifestTs(input: AppPrintInput): string {
  const usesLuaFile = input.serverApiPath !== undefined;
  const importLine = usesLuaFile
    ? `import { defineCustomApp, file, luaFile } from "@wearecococo/dev-cli/define";`
    : `import { defineCustomApp, file } from "@wearecococo/dev-cli/define";`;

  const body: Record<string, unknown> = {
    handle: input.handle,
    name: input.name,
    kind: input.kind,
  };
  if (input.icon) body.icon = input.icon;
  body.engineVersion = 2;
  body.template = fileRef(input.templatePath);
  body.script = fileRef(input.scriptPath);
  if (input.serverApiPath) body.serverApi = luaFileRef(input.serverApiPath);
  if (input.dataContainerSpec) {
    try {
      body.dataContainerSpec = JSON.parse(input.dataContainerSpec);
    } catch {
      // Malformed JSON shouldn't be printed as a literal — drop it,
      // and let the next push fail loudly with a server-side error
      // rather than silently shipping junk into the wire payload.
    }
  }

  return `${importLine}\n\nexport default defineCustomApp(${printObject(body, 0)});\n`;
}

const FILE_REF = Symbol("fileRef");
type FileRef = { [FILE_REF]: true; path: string };

function fileRef(path: string): FileRef {
  return { [FILE_REF]: true, path: `./${path}` };
}

function isFileRef(x: unknown): x is FileRef {
  return typeof x === "object" && x !== null && (x as FileRef)[FILE_REF] === true;
}

// ──────────────────────────────────────────────────────────────────────
// Edge-app printer. Emits a `defineEdgeApp({...})` manifest.ts with
// `luaFile()` references for handlers / libraries / onMessage. Used by
// `cococo init --type edge` and by `cococo pull --type edge`.
// ──────────────────────────────────────────────────────────────────────

export type EdgeAppPrintTrigger =
  | { kind: "CRON"; name: string; handler: string; schedule: string }
  | { kind: "TAIL"; name: string; handler: string; path: string }
  | {
      kind: "FILE_CREATED" | "FILE_DELETED";
      name: string;
      handler: string;
      path: string;
      pattern?: string;
    };

export type EdgeAppPrintInput = {
  handle: string;
  name: string;
  description?: string;
  logLevel?: EdgeAppLogLevel;
  isActive?: boolean;
  /** Each handler is materialised at the given relative path. */
  handlers: Array<{ name: string; path: string }>;
  /** Each library entry is materialised at the given relative path. */
  libraries?: Array<{ name: string; path: string }>;
  /** Set when the edge app has a non-empty onMessage entry. */
  onMessagePath?: string;
  /** Already a JSON-encoded string when present; will be `JSON.parse`d. */
  configSchema?: unknown;
  triggers: EdgeAppPrintTrigger[];
  // I/O config — passed through verbatim from the server, with one
  // exception: write-only secrets the server doesn't return (MQTT
  // password, OPC UA USERNAME password, SNMP v3 keys, HTTP credentials)
  // are filled in with `${config:...}` template-string placeholders so
  // the printed manifest typechecks and round-trips through push.
  mqttBrokers?: EdgeAppMQTTBroker[];
  opcuaEndpoints?: EdgeAppOPCUAEndpoint[];
  snmpDevices?: EdgeAppSNMPDevice[];
  modbusPorts?: EdgeAppModbusPort[];
  execCommands?: EdgeAppExecCommand[];
  httpRoutes?: EdgeAppHTTPRoute[];
};

export function printEdgeAppManifestTs(input: EdgeAppPrintInput): string {
  const body: Record<string, unknown> = {
    handle: input.handle,
    name: input.name,
  };
  if (input.description) body.description = input.description;
  if (input.logLevel) body.logLevel = input.logLevel;
  if (input.isActive === false) body.isActive = false;

  body.triggers = input.triggers.map((t) => {
    const out: Record<string, unknown> = {
      kind: t.kind,
      name: t.name,
      handler: t.handler,
    };
    if (t.kind === "CRON") out.schedule = (t as { schedule: string }).schedule;
    else {
      out.path = (t as { path: string }).path;
      const pat = (t as { pattern?: string }).pattern;
      if (pat) out.pattern = pat;
    }
    return out;
  });

  const handlersBody: Record<string, unknown> = {};
  for (const h of input.handlers) handlersBody[h.name] = luaFileRef(h.path);
  body.handlers = handlersBody;

  if (input.libraries && input.libraries.length > 0) {
    const libs: Record<string, unknown> = {};
    for (const l of input.libraries) libs[l.name] = luaFileRef(l.path);
    body.libraries = libs;
  }
  if (input.onMessagePath) body.onMessage = luaFileRef(input.onMessagePath);
  if (input.configSchema !== undefined && input.configSchema !== null) {
    if (typeof input.configSchema === "string") {
      try {
        body.configSchema = JSON.parse(input.configSchema);
      } catch {
        // Drop malformed JSON rather than emit unparseable TS.
      }
    } else {
      body.configSchema = input.configSchema;
    }
  }

  let placeholderEmitted = false;
  const placeholder = (suffix: string): string => {
    placeholderEmitted = true;
    return `\${config:${configKey(input.handle, suffix)}}`;
  };

  if (input.mqttBrokers && input.mqttBrokers.length > 0) {
    body.mqttBrokers = input.mqttBrokers.map((b) =>
      transformMqttBroker(b, placeholder),
    );
  }
  if (input.opcuaEndpoints && input.opcuaEndpoints.length > 0) {
    body.opcuaEndpoints = input.opcuaEndpoints.map((e) =>
      transformOpcuaEndpoint(e, placeholder),
    );
  }
  if (input.snmpDevices && input.snmpDevices.length > 0) {
    body.snmpDevices = input.snmpDevices.map((d) =>
      transformSnmpDevice(d, placeholder),
    );
  }
  if (input.modbusPorts && input.modbusPorts.length > 0) {
    body.modbusPorts = input.modbusPorts.map(stripNulls) as unknown[];
  }
  if (input.execCommands && input.execCommands.length > 0) {
    body.execCommands = input.execCommands.map(stripNulls) as unknown[];
  }
  if (input.httpRoutes && input.httpRoutes.length > 0) {
    body.httpRoutes = input.httpRoutes.map((r) =>
      transformHttpRoute(r, placeholder),
    );
  }

  const banner = placeholderEmitted
    ? `// NOTE: Some secrets (passwords / API tokens / SNMP keys) aren't returned\n` +
      `// by the server on pull, so the printer filled them in with\n` +
      `// \${config:...} template-string placeholders. Either replace them with\n` +
      `// real values before pushing, or define the corresponding config keys\n` +
      `// per-installation so the platform substitutes them at runtime.\n\n`
    : "";

  return (
    banner +
    `import { defineEdgeApp, luaFile } from "@wearecococo/dev-cli/define";\n\n` +
    `export default defineEdgeApp(${printObject(body, 0)});\n`
  );
}

/**
 * Build a stable, uppercase config key for a placeholder. The handle
 * disambiguates across edge apps in the same tenant; the suffix
 * disambiguates within the manifest. Non-identifier characters are
 * collapsed to underscores so the key remains a valid config name.
 */
function configKey(handle: string, suffix: string): string {
  const sanitize = (s: string): string =>
    s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return `${sanitize(handle)}_${sanitize(suffix)}`;
}

/**
 * Recursively turn nulls into undefined and strip empty optional
 * collections — printObject filters undefined but keeps null, which
 * would emit `field: null` in the manifest. Cleaner output without it.
 */
function stripNulls(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) {
    return value.map(stripNulls).filter((v) => v !== undefined);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = stripNulls(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

function transformMqttBroker(
  b: EdgeAppMQTTBroker,
  placeholder: (suffix: string) => string,
): unknown {
  const out = stripNulls(b) as Record<string, unknown>;
  // Server doesn't return password. If a username is set, fill in a
  // placeholder so the credential pair is at least visible in the
  // printed manifest.
  if (typeof out.username === "string" && out.password === undefined) {
    out.password = placeholder(`MQTT_${b.name}_PASSWORD`);
  }
  return out;
}

function transformOpcuaEndpoint(
  e: EdgeAppOPCUAEndpoint,
  placeholder: (suffix: string) => string,
): unknown {
  const out = stripNulls(e) as Record<string, unknown>;
  const auth = out.auth as Record<string, unknown> | undefined;
  if (auth && auth.mode === "USERNAME" && auth.password === undefined) {
    auth.password = placeholder(`OPCUA_${e.name}_PASSWORD`);
  }
  return out;
}

function transformSnmpDevice(
  d: EdgeAppSNMPDevice,
  placeholder: (suffix: string) => string,
): unknown {
  const out = stripNulls(d) as Record<string, unknown>;
  const v3 = out.v3 as Record<string, unknown> | undefined;
  if (v3) {
    if (v3.authProtocol !== undefined && v3.authKey === undefined) {
      v3.authKey = placeholder(`SNMP_${d.name}_AUTH_KEY`);
    }
    if (v3.privProtocol !== undefined && v3.privKey === undefined) {
      v3.privKey = placeholder(`SNMP_${d.name}_PRIV_KEY`);
    }
  }
  return out;
}

function transformHttpRoute(
  r: EdgeAppHTTPRoute,
  placeholder: (suffix: string) => string,
): unknown {
  const out = stripNulls(r) as Record<string, unknown>;
  const auth = out.auth as Record<string, unknown> | undefined;
  if (auth) {
    // The HTTPRouteAuth discriminated union *requires* basicCredentials /
    // bearerTokens to be present for BASIC / BEARER. Server omits them
    // on pull, so we have to fill in placeholders or the printed manifest
    // won't typecheck.
    const slug = `${r.method}_${r.path}`;
    if (auth.mode === "BASIC" && !Array.isArray(auth.basicCredentials)) {
      auth.basicCredentials = [placeholder(`HTTP_${slug}_BASIC`)];
    }
    if (auth.mode === "BEARER" && !Array.isArray(auth.bearerTokens)) {
      auth.bearerTokens = [placeholder(`HTTP_${slug}_BEARER`)];
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Workflow printer. Emits a `defineWorkflow({...})` manifest.ts from
// a server-resolved version + triggers. Node `config` and variable
// `defaultValue` come back as JSON strings; we parse them so the emitted
// TS is plain object literals (the loader re-stringifies on push).
// ──────────────────────────────────────────────────────────────────────

export type WorkflowPrintInput = {
  handle: string;
  /** Display name; omit when it equals `handle`. */
  displayName?: string;
  description?: string;
  isActive?: boolean;
  defaultNodeTimeoutSeconds?: number;
  /** Bot user email; omit when no botUser is set on the server row. */
  botUserEmail?: string;
  version: WorkflowVersionState;
  triggers: WorkflowTriggerState[];
};

export function printWorkflowManifestTs(input: WorkflowPrintInput): string {
  const body: Record<string, unknown> = { handle: input.handle };
  if (input.displayName) body.displayName = input.displayName;
  if (input.description) body.description = input.description;
  if (input.isActive !== undefined) body.isActive = input.isActive;
  if (input.botUserEmail) body.botUser = input.botUserEmail;
  if (input.defaultNodeTimeoutSeconds !== undefined) {
    body.defaultNodeTimeoutSeconds = input.defaultNodeTimeoutSeconds;
  }

  body.variables = input.version.definition.variables.map((v) => ({
    name: v.name,
    type: v.type,
    defaultValue: parseMaybeJson(v.defaultValue),
    description: v.description ?? undefined,
  }));

  body.nodes = input.version.definition.nodes.map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    config: parseMaybeJson(n.config),
    position: n.position ?? undefined,
  }));

  body.edges = input.version.definition.edges.map((e) => ({
    id: e.id,
    from: e.fromNodeId,
    to: e.toNodeId,
    condition: e.condition ?? undefined,
  }));

  body.triggers = input.triggers.map((t) => {
    const config = serverTriggerToAuthorConfig(t.configJSON);
    return {
      name: t.name,
      config,
      isEnabled: t.isEnabled,
      concurrencyPolicy: t.concurrencyPolicy,
      maxConcurrentExecutions: t.maxConcurrentExecutions ?? undefined,
    };
  });

  return (
    `import { defineWorkflow } from "@wearecococo/dev-cli/define";\n\n` +
    `export default defineWorkflow(${printObject(body, 0)});\n`
  );
}

/**
 * Parse a JSON string (defaultValue / config) back to its original
 * shape, returning `undefined` for null/empty/unparseable input. The
 * printer renders the result as a plain object literal.
 */
function parseMaybeJson(value: string | null | undefined): unknown {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    // Don't fail the whole pull on a malformed config blob — emit the
    // raw string and let the user fix it.
    return value;
  }
}

/**
 * The server returns trigger config as a single JSON blob (with
 * `type` + one typed slot). Map it back to the author-side
 * discriminated union (`{ kind: ..., ...flat fields }`).
 */
export function serverTriggerToAuthorConfig(json: string): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { kind: "event", topic: "PARSE_ERROR" };
  }
  const type = parsed.type;
  if (type === "scheduled") {
    const s = (parsed.scheduled ?? {}) as Record<string, unknown>;
    return strip({
      kind: "scheduled",
      cronExpression: s.cronExpression,
      overlapPolicy: s.overlapPolicy,
      timezone: s.timezone,
    });
  }
  if (type === "event") {
    const e = (parsed.event ?? {}) as Record<string, unknown>;
    return strip({ kind: "event", topic: e.topic, filter: e.filter, dataQuery: e.dataQuery });
  }
  if (type === "deviceMqtt") {
    const m = (parsed.deviceMqtt ?? {}) as Record<string, unknown>;
    return strip({ kind: "deviceMqtt", topic: m.topic, deviceId: m.deviceId, filter: m.filter });
  }
  if (type === "webhook") {
    const w = (parsed.webhook ?? {}) as Record<string, unknown>;
    return strip({
      kind: "webhook",
      path: w.path,
      method: w.method,
      authRequired: w.authRequired,
    });
  }
  // edgeAppEvent
  const e = (parsed.edgeAppEvent ?? {}) as Record<string, unknown>;
  return strip({
    kind: "edgeAppEvent",
    topic: e.topic,
    controllerId: e.controllerId,
    edgeAppHandle: e.edgeAppHandle,
  });
}

function strip(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

