/**
 * Author-facing API for `manifest.ts`.
 *
 * A `manifest.ts` file in an integration folder exports a default
 * `defineIntegration({...})` value. The `lua` tag and `luaFile()` helper
 * are the two ways to attach Lua bodies to manifest fields:
 *
 *   - `lua` is a tagged template literal. The result is a branded
 *     `LuaSource` string with leading whitespace stripped, suitable for
 *     short inline hooks.
 *   - `luaFile("./relative/path.lua")` returns a sentinel that the loader
 *     resolves to file content at the time the manifest is normalised.
 *     Use this for anything longer than a one-liner so the body lives in
 *     a `.lua` file with proper tooling.
 *
 * The shape of the value is hand-typed (no codegen) and kept aligned with
 * the platform's `IntegrationManifest` GraphQL type by code review +
 * integration tests, not by tooling.
 *
 * **`manifest.ts` is v2 only.** The TS author surface was added at the
 * same time as engineVersion 2; a v2-only TS API is the simplest model.
 * Legacy v1 integrations stay on `manifest.yaml` (with
 * `engine_version: 1`).
 */

declare const luaSourceBrand: unique symbol;
/**
 * A `string` known to contain Lua source. Produced by `lua` and `luaFile`;
 * not constructible from a plain string. The brand is purely a TypeScript
 * device — at runtime it's still `typeof === "string"` (for `lua` results)
 * or the `LuaFileMarker` object (for `luaFile`, replaced by the loader
 * before the value reaches the wire).
 */
export type LuaSource = string & { [luaSourceBrand]: true };

const LUA_FILE_MARKER = Symbol.for("@wearecococo/dev-cli/luaFile");
const FILE_MARKER = Symbol.for("@wearecococo/dev-cli/file");

export type LuaFileMarker = {
  readonly [LUA_FILE_MARKER]: true;
  readonly path: string;
};

/**
 * Generic file reference for non-Lua content (Vue templates, JS scripts,
 * any text file the loader should inline). Distinct from `LuaFileMarker`
 * so the type system can keep `serverApi: luaFile(...)` separate from
 * `template: file(...)` — the lint pipeline only validates LuaSource
 * fields, and `template` is HTML.
 */
export type FileMarker = {
  readonly [FILE_MARKER]: true;
  readonly path: string;
};

export function isLuaFileMarker(x: unknown): x is LuaFileMarker {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as LuaFileMarker)[LUA_FILE_MARKER] === true
  );
}

export function isFileMarker(x: unknown): x is FileMarker {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as FileMarker)[FILE_MARKER] === true
  );
}

/**
 * Tagged template that returns a `LuaSource`. Strips a common leading
 * indent so callers can write
 *
 *   lua`
 *     local config = ...
 *     ctx.log.info("hi")
 *   `
 *
 * and have the actual Lua string be unindented. A leading newline (from
 * the template's first character being `\n`) is dropped.
 */
export function lua(strings: TemplateStringsArray, ...values: unknown[]): LuaSource {
  let raw = "";
  for (let i = 0; i < strings.length; i++) {
    raw += strings[i];
    if (i < values.length) raw += String(values[i]);
  }
  return dedent(raw) as LuaSource;
}

/**
 * Reference a Lua file on disk relative to the manifest.ts that contains
 * the call. The actual read happens when the loader normalises the
 * manifest (it knows the manifest.ts directory). The returned value is
 * declared as `LuaSource` for assignment ergonomics, but at runtime it's
 * a sentinel object that the loader replaces with the file's content.
 */
export function luaFile(path: string): LuaSource {
  const marker: LuaFileMarker = { [LUA_FILE_MARKER]: true, path };
  return marker as unknown as LuaSource;
}

/**
 * Reference an arbitrary text file on disk relative to the manifest.ts
 * that contains the call. Used by custom-app manifests for the
 * `template` (Vue HTML) and `script` (JS) slots — anything that isn't
 * Lua. The returned value is declared as `string` for assignment
 * ergonomics, but at runtime it's a sentinel object that the loader
 * replaces with the file's content.
 */
export function file(path: string): string {
  const marker: FileMarker = { [FILE_MARKER]: true, path };
  return marker as unknown as string;
}

// Re-export JSONLogic types + helpers so author code can do
//   import { jl, type JSONLogicExpression } from "@wearecococo/dev-cli/define"
// without a separate import path. Workflow node configs surface
// JSONLogicExpression on the fields the generated registry marks for it.
export { jl } from "./jsonlogic.ts";
export type { JSONLogicExpression, JSONLogicValue } from "./jsonlogic.ts";

// ──────────────────────────────────────────────────────────────────────
// Manifest shape — discriminated on engineVersion. v1 requires
// entryScript and forbids v2-only fields; v2 forbids entryScript and
// makes engineVersion optional (defaults to 2 when omitted).
// ──────────────────────────────────────────────────────────────────────

// Re-export the GraphQL-level enums that surface in the author API so
// consumers can import them from `@wearecococo/dev-cli/define` alongside
// the `defineX` helpers. Type-only — no runtime import of the wire
// module, so the author bundle stays light.
import type {
  CustomAppKind,
  DatabaseAdapter,
  DeviceAuthMode,
  EdgeAppLogLevel,
  Effect,
  RuntimeMode,
  UserKind,
} from "./graphql/operations.ts";
export type {
  CustomAppKind,
  DatabaseAdapter,
  DeviceAuthMode,
  EdgeAppLogLevel,
  Effect,
  RuntimeMode,
  UserKind,
};

export type ResourceSpec = {
  id: string;
  type: string;
  description?: string;
  optional?: boolean;
};

export type DataContainerSchemaSpec = {
  name: string;
  schema: string;
  description?: string;
  taggableTypes?: string[];
  maxPerInstance?: number;
};

export type ActionSpec = {
  name: string;
  label: string;
  description?: string;
  scriptName: string;
  configSchema?: string;
  icon?: string;
};

type IntegrationCommon = {
  id: string;
  version: string;
  sdkVersion: string;
  description?: string;
  runtimeMode?: RuntimeMode;
  resources?: ResourceSpec[];
  permissions?: string[];
  dataContainerSchemas?: DataContainerSchemaSpec[];
  actions?: ActionSpec[];
  /** Per-script Lua execution timeout in ms. Defaults to 5000, capped at 60000. */
  timeoutMs?: number;
};

export type IntegrationV2 = IntegrationCommon & {
  /**
   * Engine version. Optional and pinned to `2` — `manifest.ts` is v2-only.
   * Legacy v1 integrations stay on `manifest.yaml`.
   */
  engineVersion?: 2;
  initSource?: LuaSource;
  shutdownSource?: LuaSource;
  upgradeSource?: LuaSource;
  subscriptions?: Array<{
    topic: string;
    filter?: string;
    source?: LuaSource;
  }>;
  timers?: Array<{
    name: string;
    every?: string;
    cron?: string;
    jitter?: string;
    source?: LuaSource;
  }>;
  libraries?: Record<string, LuaSource>;
};

export type IntegrationDefinition = IntegrationV2;

/**
 * Hidden Symbol-keyed tag stamped onto the result of `defineIntegration` /
 * `defineCustomApp`. The loader reads it to discriminate which kind of
 * manifest it's looking at without resorting to structural sniffing.
 *
 * Symbol-keyed so it survives `Object.assign` / spread but is invisible
 * to `JSON.stringify` (the wire payload is unaffected) and `Object.keys`
 * (`Object.entries`-based clones drop it cleanly — that's by design;
 * the loader reads the tag once before any cloning happens).
 */
const KIND_TAG = Symbol.for("@wearecococo/dev-cli/kind");

export type ManifestKind =
  | "integration"
  | "app"
  | "edge"
  | "workflow"
  | "users"
  | "iam_policies"
  | "iam_policy_bindings"
  | "networks"
  | "devices"
  | "teams"
  | "custom_app_user_bindings"
  | "custom_app_team_bindings"
  | "controllers"
  | "controller_tokens"
  | "edge_app_installations"
  | "integration_installations";

export type Tagged<T, K extends ManifestKind> = T & {
  readonly [KIND_TAG]: K;
};

export function manifestKind(value: unknown): ManifestKind | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const k = (value as Record<symbol, unknown>)[KIND_TAG];
  return k === "integration" ||
    k === "app" ||
    k === "edge" ||
    k === "workflow" ||
    k === "users" ||
    k === "iam_policies" ||
    k === "iam_policy_bindings" ||
    k === "networks" ||
    k === "devices" ||
    k === "teams" ||
    k === "custom_app_user_bindings" ||
    k === "custom_app_team_bindings" ||
    k === "controllers" ||
    k === "controller_tokens" ||
    k === "edge_app_installations" ||
    k === "integration_installations"
    ? k
    : undefined;
}

/**
 * Identity helper that pins the spec to `IntegrationV2` for better
 * in-editor errors. Returns the value with a hidden kind tag attached.
 */
export function defineIntegration<T extends IntegrationV2>(spec: T): Tagged<T, "integration"> {
  return Object.assign({}, spec, { [KIND_TAG]: "integration" as const });
}

// ──────────────────────────────────────────────────────────────────────
// Custom apps. Authored as `custom_apps/<handle>/manifest.ts`. The
// platform stores three "source slots" — Vue template, client script,
// optional Lua RPC — plus a small handful of metadata fields. There's
// no semver / DRAFT / ACTIVE machinery; push mutates a working copy,
// publish snapshots + flips the published-version pointer.
// ──────────────────────────────────────────────────────────────────────

/**
 * Author-facing custom-app spec. `template` and `script` accept either
 * an inline string (for one-liners), a `file(...)` reference (for the
 * normal case where the body lives on disk), or a tagged template you
 * built yourself. `serverApi` is optional and Lua-typed — it accepts
 * `lua\`...\``, `luaFile(...)`, or omitted entirely.
 */
export type CustomAppV2 = {
  /** URL-safe slug, unique per tenant. */
  handle: string;
  /** Human-readable display name. */
  name: string;
  /** Where in the UI the app appears (PAGE / DASHBOARD / KIOSK / JOB_VIEW). */
  kind: CustomAppKind;
  /** Material icon identifier; defaults server-side to `"app_badging"`. */
  icon?: string;
  /** Engine version. Optional and pinned to `2` — manifest.ts is v2-only. */
  engineVersion?: 2;
  /** Vue template HTML rendered in the app iframe. */
  template: string;
  /** Client-side JavaScript / TypeScript executed when the app mounts. */
  script: string;
  /** Optional Lua RPC handlers attached to the global `exports` table. */
  serverApi?: LuaSource;
  /** Optional JSON Schema for custom data container validation. */
  dataContainerSpec?: Record<string, unknown>;
};

export type CustomAppDefinition = CustomAppV2;

export function defineCustomApp<T extends CustomAppV2>(spec: T): Tagged<T, "app"> {
  return Object.assign({}, spec, { [KIND_TAG]: "app" as const });
}

// ──────────────────────────────────────────────────────────────────────
// Edge apps. Authored under `edge_apps/<handle>/manifest.ts`. Identified
// by handle, lifecycle DRAFT → PUBLISHED → DEPRECATED, with monotonic
// Int versioning managed server-side. The CLI authors the DRAFT — push
// upserts, publish flips DRAFT → PUBLISHED.
// ──────────────────────────────────────────────────────────────────────

/**
 * Discriminated union over the four trigger kinds. Each kind requires a
 * shape-correct config (`schedule` for CRON, `path` for the file
 * triggers) and the `handler` field is constrained by the generic to
 * one of the keys you defined on `handlers`.
 */
export type EdgeAppTrigger<HandlerName extends string> =
  | {
      kind: "CRON";
      name: string;
      handler: HandlerName;
      /** Cron expression, e.g. `"*\/5 * * * *"`. */
      schedule: string;
    }
  | {
      kind: "TAIL";
      name: string;
      handler: HandlerName;
      /** Filesystem path of the file to tail. */
      path: string;
    }
  | {
      kind: "FILE_CREATED";
      name: string;
      handler: HandlerName;
      path: string;
      pattern?: string;
    }
  | {
      kind: "FILE_DELETED";
      name: string;
      handler: HandlerName;
      path: string;
      pattern?: string;
    };

// ── External I/O config — author-surface types ────────────────────────
// All `handler` fields below carry the same `keyof H` constraint as
// `EdgeAppTrigger`, so any handler reference (subscriptions, poll
// groups, HTTP routes) is checked against the literal keys of
// `handlers` at edit time. Discriminated unions on variant config
// (SNMP version, Modbus transport, HTTP auth, OPC UA auth/security)
// make the required fields per variant explicit.

export type MQTTSubscription<H extends string> = {
  topic: string;
  handler: H;
};

export type MQTTBroker<H extends string> = {
  name: string;
  url: string;
  clientId?: string;
  username?: string;
  /** Literal password or a `${config:NAME}` template resolved per-installation. */
  password?: string;
  keepaliveSeconds?: number;
  qos?: 0 | 1 | 2;
  subscriptions: Array<MQTTSubscription<H>>;
  tls?: {
    /** Server CA. Literal PEM or `${config:NAME}` template. */
    caCertPem: string;
    clientCertPem?: string;
    clientKeyPem?: string;
    insecureSkipVerify?: boolean;
  };
  will?: {
    topic: string;
    payload?: string;
    qos?: 0 | 1 | 2;
    retain?: boolean;
  };
};

export type OPCUASubscription<H extends string> = {
  /** OPC UA NodeId, e.g. `ns=2;s=PressTemp`. */
  nodeId: string;
  handler: H;
  samplingMs?: number;
  queueSize?: number;
};

/** OPC UA user-identification — discriminated on `mode`. */
export type OPCUAAuth =
  | { mode: "ANONYMOUS" }
  | { mode: "USERNAME"; username: string; password: string }
  | { mode: "CERTIFICATE" };

/**
 * OPC UA channel-security — discriminated on whether `policy === "NONE"`.
 * Non-NONE policies require `clientCertPem` + `clientKeyPem`.
 */
export type OPCUASecurity =
  | { policy: "NONE"; mode: "NONE" }
  | {
      policy: "BASIC128_RSA15" | "BASIC256" | "BASIC256_SHA256";
      mode: "SIGN" | "SIGN_AND_ENCRYPT";
      clientCertPem: string;
      clientKeyPem: string;
    };

export type OPCUAEndpoint<H extends string> = {
  name: string;
  /** OPC UA URL, e.g. `opc.tcp://...`. */
  endpoint: string;
  subscriptions: Array<OPCUASubscription<H>>;
  auth?: OPCUAAuth;
  security?: OPCUASecurity;
  reconnectIntervalMs?: number;
};

export type SNMPOIDEntry = { label: string; oid: string };

export type SNMPPollGroup<H extends string> = {
  name: string;
  intervalMs: number;
  handler: H;
  oids?: SNMPOIDEntry[];
  walkPrefixes?: SNMPOIDEntry[];
};

/**
 * SNMP device — discriminated on `version`. v2c uses `community`; v3
 * uses the `v3` block (with optional auth + priv).
 */
export type SNMPDevice<H extends string> =
  | {
      version: "V2C";
      name: string;
      host: string;
      pollGroups: Array<SNMPPollGroup<H>>;
      community?: string;
      port?: number;
      timeoutMs?: number;
      retries?: number;
    }
  | {
      version: "V3";
      name: string;
      host: string;
      pollGroups: Array<SNMPPollGroup<H>>;
      v3: {
        user: string;
        authProtocol?: "MD5" | "SHA1" | "SHA224" | "SHA256" | "SHA384" | "SHA512";
        authKey?: string;
        privProtocol?: "DES" | "AES128" | "AES192" | "AES256";
        privKey?: string;
        contextName?: string;
      };
      port?: number;
      timeoutMs?: number;
      retries?: number;
    };

export type ModbusRead = {
  /** Surfaces in the handler payload as `params.values.<label>`. */
  label: string;
  function: "HOLDING" | "INPUT" | "COILS" | "DISCRETE";
  address: number;
  quantity: number;
  /** Decoding type — see platform docs for the full enum. */
  type: string;
  scale?: number;
  wordOrder?: string;
  byteOrder?: string;
};

export type ModbusPollGroup<H extends string> = {
  name: string;
  intervalMs: number;
  reads: ModbusRead[];
  handler: H;
};

export type ModbusSlave<H extends string> = {
  name: string;
  unitId: number;
  pollGroups: Array<ModbusPollGroup<H>>;
};

/**
 * Modbus port — discriminated on `transport`. TCP / RTU_OVER_TCP use
 * host + port; RTU uses the serial fields.
 */
export type ModbusPort<H extends string> =
  | {
      transport: "TCP" | "RTU_OVER_TCP";
      name: string;
      slaves: Array<ModbusSlave<H>>;
      host: string;
      port?: number;
    }
  | {
      transport: "RTU";
      name: string;
      slaves: Array<ModbusSlave<H>>;
      serialPath: string;
      baudRate?: number;
      parity?: "NONE" | "EVEN" | "ODD";
      stopBits?: 1 | 2;
      dataBits?: 5 | 6 | 7 | 8 | 9;
    };

export type ExecCommand = {
  name: string;
  /** Absolute path to the binary. */
  path: string;
  /** argv template; supports `${input}` and `${output:NAME}` placeholders. */
  args: string[];
  outputs?: string[];
  timeoutMs?: number;
  maxStdoutBytes?: number;
  env?: Array<{ name: string; value: string }>;
};

/** HTTP inbound route auth — discriminated on `mode`. */
export type HTTPRouteAuth =
  | { mode: "NONE" }
  | { mode: "BASIC"; basicCredentials: string[] }
  | { mode: "BEARER"; bearerTokens: string[] };

export type HTTPRoute<H extends string> = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ANY";
  /** Path pattern starting with `/`; supports `{name}` and `{name...}`. */
  path: string;
  handler: H;
  auth: HTTPRouteAuth;
  maxBodyBytes?: number;
  timeoutMs?: number;
};

/**
 * Author surface for an edge app. The `H` type parameter is inferred
 * from the literal keys of `handlers` so every place a handler name
 * appears (`triggers`, MQTT subscriptions, OPC UA subscriptions, SNMP
 * pollGroups, Modbus pollGroups, HTTP routes) is constrained to the
 * actual keys at compile time.
 */
export type EdgeAppV2<H extends Record<string, LuaSource> = Record<string, LuaSource>> = {
  /** URL-safe slug, unique per tenant. */
  handle: string;
  /** Human-readable display name. */
  name: string;
  description?: string;
  /** Map of handler name → Lua source (`lua\`...\`` inline or `luaFile()`). */
  handlers: H;
  /** Trigger list — `handler` is statically constrained to a key in `handlers`. */
  triggers: Array<EdgeAppTrigger<keyof H & string>>;
  /** Reusable Lua snippets, loaded by handlers via `bridge.loadLib(name)`. */
  libraries?: Record<string, LuaSource>;
  /** Lua entry point fired by `local.edgeApp.invoke` from the cloud. */
  onMessage?: LuaSource;
  /** JSON Schema for installation variables. */
  configSchema?: Record<string, unknown>;
  /** Cloud-forwarding level for `bridge.log.*` calls. */
  logLevel?: EdgeAppLogLevel;
  /** Default true; flipping to false hides the app from installation pushes. */
  isActive?: boolean;

  // ── External I/O config ────────────────────────────────────────────
  mqttBrokers?: Array<MQTTBroker<keyof H & string>>;
  opcuaEndpoints?: Array<OPCUAEndpoint<keyof H & string>>;
  snmpDevices?: Array<SNMPDevice<keyof H & string>>;
  modbusPorts?: Array<ModbusPort<keyof H & string>>;
  execCommands?: ExecCommand[];
  httpRoutes?: Array<HTTPRoute<keyof H & string>>;
};

export type EdgeAppDefinition = EdgeAppV2;

export function defineEdgeApp<H extends Record<string, LuaSource>>(
  spec: EdgeAppV2<H>,
): Tagged<EdgeAppV2<H>, "edge"> {
  return Object.assign({}, spec, { [KIND_TAG]: "edge" as const });
}

// ──────────────────────────────────────────────────────────────────────
// Workflows. The platform models a workflow as a mutable workflow row
// plus immutable version snapshots; each push creates a new version,
// publish flips the active pointer. Definitions are graphs of nodes,
// edges, and variables — node `config` is JSON-serialised at the wire
// boundary because the platform validates per-node-type via JSON Schema
// rather than at the GraphQL level.
//
// Phase 1 keeps node config typing intentionally loose (`unknown`) and
// relies on server-side `validateWorkflow` to catch schema violations.
// A future codegen pass will derive a discriminated `WorkflowNode`
// union from `getWorkflowSchema` and tighten authoring ergonomics.
// ──────────────────────────────────────────────────────────────────────

/**
 * A workflow variable. `defaultValue` is any JSON-serialisable value
 * (including objects/arrays); the loader stringifies it for the wire.
 */
export type WorkflowVariable = {
  name: string;
  type: string;
  defaultValue?: unknown;
  description?: string;
};

/**
 * A workflow node — base shape, used as the fallback when a node's
 * `type` isn't in `NodeTypeRegistry`. Typed configs land via the
 * generated `node-types.d.ts` (shipped with the CLI) which augments
 * `NodeTypeRegistry`; `defineNode<T>` and the `nodes:` array on
 * `defineWorkflow` then narrow `config` to the registered shape.
 *
 * Code-bearing configs (e.g. a Lua script) accept `luaFile()` refs in
 * any string field; the loader walks the config tree and inlines them
 * before serialisation.
 */
export type WorkflowNode = {
  /** Stable id, unique within the workflow. */
  id: string;
  name: string;
  type: string;
  /** Per-node config object. Untyped at this base level; see `NodeTypeRegistry`. */
  config?: unknown;
  position?: { x: number; y: number };
};

/**
 * Map of node-type identifier → typed config shape. Empty here;
 * augmented by the generated `node-types.d.ts` that ships with the
 * CLI (and optionally by `.cococo/generated/node-types.d.ts` in user
 * workspaces with non-baseline tenants). When no entry exists for a
 * given `type`, nodes fall through to the base `WorkflowNode` shape.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface NodeTypeRegistry {}

/**
 * Workspace-local override registry, populated by `cococo update`
 * writing to `.cococo/generated/node-types.d.ts`. Keys here win over
 * `NodeTypeRegistry`, so a workspace running against a tenant whose
 * server has drifted (added node types, changed shapes) gets the
 * tenant's view without colliding with the shipped baseline.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WorkspaceNodeTypeRegistry {}

// Pull in the shipped baseline registry. Regenerated at maintain time
// via `bun run codegen`; keep it under `src/generated/` so it ships
// in the package's `files` whitelist.
/// <reference path="./generated/node-types.d.ts" />

/**
 * Effective registry: every key in either the shipped baseline or the
 * workspace overrides. Workspace types take precedence on shared keys
 * (when a tenant has drifted from the baseline, the live shape wins).
 */
export type RegisteredNodeType =
  | keyof NodeTypeRegistry
  | keyof WorkspaceNodeTypeRegistry;

/**
 * Resolve a node-type's config shape, preferring the workspace
 * override when one exists. Used by both `defineNode` and the inline
 * `nodes: [...]` array on `defineWorkflow`.
 */
export type ConfigFor<T extends RegisteredNodeType> =
  T extends keyof WorkspaceNodeTypeRegistry
    ? WorkspaceNodeTypeRegistry[T]
    : T extends keyof NodeTypeRegistry
      ? NodeTypeRegistry[T]
      : never;

/**
 * Discriminated union over the effective registry. Picking a `type`
 * literal narrows `config` to the resolved shape. Nodes whose `type`
 * is not in either registry fall back to the base `WorkflowNode`,
 * which keeps unregistered + custom node types compiling.
 */
export type AnyWorkflowNode =
  | {
      [K in RegisteredNodeType]: {
        id: string;
        name: string;
        type: K;
        config?: ConfigFor<K>;
        position?: { x: number; y: number };
      };
    }[RegisteredNodeType]
  | WorkflowNode;

/**
 * Identity helper that narrows `config` to the registry's entry for
 * `type`. Use for nodes you want to author as standalone TS objects
 * and insert into one or more workflows; an inline `nodes: [{...}]`
 * literal on `defineWorkflow` gets the same typing.
 *
 * Returns the spec unchanged at runtime — the wire shape is identical
 * whether a node is authored inline or via this helper.
 */
export function defineNode<T extends RegisteredNodeType>(spec: {
  id: string;
  name: string;
  type: T;
  config?: ConfigFor<T>;
  position?: { x: number; y: number };
}): {
  id: string;
  name: string;
  type: T;
  config?: ConfigFor<T>;
  position?: { x: number; y: number };
} {
  return spec;
}

export type WorkflowEdge = {
  id: string;
  /** Authoring-friendly aliases — wire shape is `fromNodeId` / `toNodeId`. */
  from: string;
  to: string;
  /** Optional condition expression evaluated to decide whether to traverse. */
  condition?: string;
};

/**
 * Trigger config — discriminated on `kind` to mirror the platform's
 * `TriggerConfigInput`. Each variant maps to one of the typed input
 * slots at submit time.
 */
export type WorkflowTriggerConfig =
  | {
      kind: "scheduled";
      cronExpression: string;
      overlapPolicy: string;
      timezone?: string;
    }
  | {
      kind: "event";
      topic: string;
      filter?: string;
      dataQuery?: string;
    }
  | {
      kind: "deviceMqtt";
      topic: string;
      deviceId?: string;
      filter?: string;
    }
  | {
      kind: "webhook";
      path: string;
      method: string;
      authRequired: boolean;
    }
  | {
      kind: "edgeAppEvent";
      topic?: string;
      controllerId?: string;
      edgeAppHandle?: string;
    };

export type WorkflowTriggerSpec = {
  /** Natural key — `(workflowId, name)` is unique per platform. */
  name: string;
  config: WorkflowTriggerConfig;
  isEnabled?: boolean;
  concurrencyPolicy?: "ALLOW" | "QUEUE" | "SKIP" | "CANCEL";
  maxConcurrentExecutions?: number;
  /** Pin a specific version. Omit to track `currentVersionId`. */
  versionId?: string;
};

/**
 * A workflow definition. `handle` is the local folder/filename
 * identity and gets pushed as the workflow's `name`. `displayName`
 * (when set) is preserved on the server's `name` field instead — use
 * it when you want a human-friendly title that differs from a
 * URL-safe handle.
 */
export type Workflow = {
  /** Folder name + natural key. */
  handle: string;
  /** Optional human-friendly display name; defaults to `handle`. */
  displayName?: string;
  description?: string;
  isActive?: boolean;
  /** Bot user that workflow executions act as for `bridge.graphql` calls. */
  botUser?: UserRef;
  defaultNodeTimeoutSeconds?: number;
  variables?: WorkflowVariable[];
  nodes: AnyWorkflowNode[];
  edges: WorkflowEdge[];
  triggers?: WorkflowTriggerSpec[];
};

export function defineWorkflow(spec: Workflow): Tagged<Workflow, "workflow"> {
  return Object.assign({}, spec, { [KIND_TAG]: "workflow" as const });
}

// ──────────────────────────────────────────────────────────────────────
// Tenant-config "ops" resources. Unlike integrations / custom apps /
// edge apps, these aren't artifacts with a folder layout and a
// lifecycle — they're declarative records describing tenant IAM,
// networks, devices, controllers, and edge-app installations. Authored
// as flat per-kind files at the repo root. Push is additive (upserts
// what's declared, never deletes); explicit `cococo delete` removes.
//
// **Cross-resource refs.** Every reference between ops resources
// accepts either a natural-key string OR the typed object itself —
// passing the object lets TypeScript catch typos at compile time and
// powers IDE rename refactoring. The natural key (email, handle,
// name, identifier) is what the apply pass actually sends to the
// server.
// ──────────────────────────────────────────────────────────────────────

/**
 * A user account. `email` is the natural key (unique per tenant) — the
 * loader uses it to resolve to a server-side `UserID` when pushing.
 */
export type User = {
  email: string;
  name?: string;
  kind?: UserKind;
  /** Identifier in an external system (HRIS, IdP). Optional. */
  externalId?: string;
};

export type IAMStatement = {
  effect: Effect;
  /** Action patterns, e.g. `["job:read", "job:transition"]`. */
  actions: string[];
  /** Resource patterns, e.g. `["*"]` or `["script:abc123"]`. */
  resources: string[];
};

/**
 * An IAM policy. `handle` is a stable tenant-local identifier — pushed
 * as the policy's custom ID so the manifest survives create/update
 * cycles without recording server-generated IDs.
 */
export type IAMPolicy = {
  handle: string;
  name: string;
  description?: string;
  statements: IAMStatement[];
};

/**
 * Reference shorthands. Each accepts either the natural-key string or
 * the typed object — pass the object when authoring (compile-time
 * typo safety, rename refactoring) or a string when referencing
 * something that lives on the server but not in this repo.
 */
export type UserRef = string | User;
export type IAMPolicyRef = string | IAMPolicy;
export type NetworkRef = string | Network;
export type ControllerRef = string | Controller;
export type TeamRef = string | Team;

/** Extract the natural-key email from a `UserRef`. */
export function userEmail(ref: UserRef): string {
  return typeof ref === "string" ? ref : ref.email;
}
/** Extract the natural-key handle from an `IAMPolicyRef`. */
export function iamPolicyHandle(ref: IAMPolicyRef): string {
  return typeof ref === "string" ? ref : ref.handle;
}
/** Extract the natural-key name from a `NetworkRef`. */
export function networkName(ref: NetworkRef): string {
  return typeof ref === "string" ? ref : ref.name;
}
/** Extract the natural-key handle from a `ControllerRef`. */
export function controllerHandle(ref: ControllerRef): string {
  return typeof ref === "string" ? ref : ref.handle;
}
/** Extract the natural-key name from a `TeamRef`. */
export function teamName(ref: TeamRef): string {
  return typeof ref === "string" ? ref : ref.name;
}

/**
 * A user → policy attachment. Both ends accept either the natural-key
 * string or the typed object. The apply pass resolves to the server-side
 * IDs at push time; bindings that point at entities not declared
 * locally must already exist on the server.
 */
export type IAMPolicyBinding = {
  user: UserRef;
  policy: IAMPolicyRef;
};

export function defineUsers(users: User[]): Tagged<{ users: User[] }, "users"> {
  return Object.assign({}, { users }, { [KIND_TAG]: "users" as const });
}

export function defineIAMPolicies(
  policies: IAMPolicy[],
): Tagged<{ policies: IAMPolicy[] }, "iam_policies"> {
  return Object.assign({}, { policies }, { [KIND_TAG]: "iam_policies" as const });
}

export function defineIAMPolicyBindings(
  bindings: IAMPolicyBinding[],
): Tagged<{ bindings: IAMPolicyBinding[] }, "iam_policy_bindings"> {
  return Object.assign({}, { bindings }, { [KIND_TAG]: "iam_policy_bindings" as const });
}

// ──────────────────────────────────────────────────────────────────────
// Networks + Devices. Networks group IoT controllers, devices, and
// databases. Devices belong to a network (optional) and carry inbound
// + outbound protocol configs. Authored as `networks.ts` / `devices.ts`
// at the repo root, applied additively.
//
// Protocol configs are discriminated unions over `kind` so the author
// API only allows fields that apply to that kind (HTTP wants `url`,
// SQL wants `host`/`adapter`/`databaseName`, MQTT wants `topic`, …) —
// a typo or wrong-field combo is a compile error, not a server reject.
// ──────────────────────────────────────────────────────────────────────

export type Network = {
  /** Natural key — pushed as the network's name. */
  name: string;
  description?: string;
};

/**
 * Outbound protocol — the device-side endpoint the platform writes to
 * (HTTP REST, SQL inserts, MQTT publishes, JMF). Fields per kind are
 * disjoint so the type system rejects e.g. `kind: "HTTP"` with a `host`.
 */
export type OutboundProtocol =
  | {
      kind: "HTTP";
      label?: string;
      /** Endpoint URL (required for HTTP). */
      url: string;
      authMode?: DeviceAuthMode;
      username?: string;
      /** Plaintext or `${config:NAME}` template. Write-only on the server. */
      password?: string;
    }
  | {
      kind: "JMF";
      label?: string;
      url: string;
    }
  | {
      kind: "MQTT";
      label?: string;
      url: string;
      topic: string;
      authMode?: DeviceAuthMode;
      username?: string;
      password?: string;
    }
  | {
      kind: "SQL";
      label?: string;
      adapter: DatabaseAdapter;
      /** SQLite uses `url` as the file path; the others use host/port/databaseName. */
      url?: string;
      host?: string;
      port?: number;
      databaseName?: string;
      username?: string;
      password?: string;
      /** Write-only override for explicit connection strings. */
      connectionString?: string;
    };

/**
 * Inbound protocol — the platform-side endpoint that listens for
 * messages from the device (MQTT subscribe, HTTP webhook receive).
 */
export type InboundProtocol =
  | { kind: "MQTT"; label?: string; topic: string }
  | { kind: "HTTP"; label?: string; webhookPath: string };

export type Device = {
  /** Natural key — pushed as the device's identifier (unique per tenant). */
  identifier: string;
  /** Network reference (string `name`, or a typed `Network`). Optional. */
  network?: NetworkRef;
  name?: string;
  description?: string;
  deviceType?: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  isActive?: boolean;
  outboundProtocols?: OutboundProtocol[];
  inboundProtocols?: InboundProtocol[];
};

export function defineNetworks(
  networks: Network[],
): Tagged<{ networks: Network[] }, "networks"> {
  return Object.assign({}, { networks }, { [KIND_TAG]: "networks" as const });
}

export function defineDevices(
  devices: Device[],
): Tagged<{ devices: Device[] }, "devices"> {
  return Object.assign({}, { devices }, { [KIND_TAG]: "devices" as const });
}

// ──────────────────────────────────────────────────────────────────────
// Teams + custom-app assignments. Authored as `teams.ts`,
// `custom_app_users.ts`, `custom_app_teams.ts` at the repo root.
//
// Team membership semantics: the `members` list on a declared team is
// the *canonical* membership for that team — apply reconciles to it
// (declared members get added, undeclared members on the server get
// removed for that team only). Teams *not* declared in `teams.ts` are
// untouched.
//
// Custom-app bindings (user→app and team→app) are additive at the row
// level — declared rows get attached, others left alone. Use
// `cococo delete custom-app-user|custom-app-team` to detach.
// ──────────────────────────────────────────────────────────────────────

/**
 * A team. `name` is the natural key (unique per tenant). `members` is
 * a list of user references (emails or `User` objects) — the apply
 * pass reconciles to this set exactly: declared members get added,
 * server-side members not in the list get removed. Omit `members` to
 * skip membership reconciliation for this team (just upsert the team
 * row itself).
 */
export type Team = {
  name: string;
  description?: string;
  members?: UserRef[];
};

/**
 * A user → custom-app attachment. `user` is a `UserRef`; `app` is a
 * custom-app handle (string — custom apps live in `custom_apps/<handle>/`,
 * not as ops objects). Used for kiosk-mode visibility.
 */
export type CustomAppUserBinding = {
  user: UserRef;
  app: string;
};

/**
 * A team → custom-app attachment. `team` is a `TeamRef`; `app` is a
 * custom-app handle. Used for non-kiosk visibility filtering — every
 * member of the team can see the app on their dashboard.
 */
export type CustomAppTeamBinding = {
  team: TeamRef;
  app: string;
};

export function defineTeams(teams: Team[]): Tagged<{ teams: Team[] }, "teams"> {
  return Object.assign({}, { teams }, { [KIND_TAG]: "teams" as const });
}

export function defineCustomAppUserBindings(
  bindings: CustomAppUserBinding[],
): Tagged<{ bindings: CustomAppUserBinding[] }, "custom_app_user_bindings"> {
  return Object.assign({}, { bindings }, { [KIND_TAG]: "custom_app_user_bindings" as const });
}

export function defineCustomAppTeamBindings(
  bindings: CustomAppTeamBinding[],
): Tagged<{ bindings: CustomAppTeamBinding[] }, "custom_app_team_bindings"> {
  return Object.assign({}, { bindings }, { [KIND_TAG]: "custom_app_team_bindings" as const });
}

// ──────────────────────────────────────────────────────────────────────
// Controllers, tokens, and edge-app installations. The full chain to
// run an edge app on a controller:
//
//   controllers.ts                  defines controllers + inline policy
//   controller_tokens.ts            mints connect bundles (create-only)
//   edge_app_installations.ts       pins (controller, edge-app, version)
//
// Inline `policy` on a controller follows the same "declared list = the
// canonical set" rule as team `members` — declared policy fields are
// the exact allowlist on the server. Tokens are create-only with an
// existence check; the connect bundle is printed once on creation.
// Installations resolve (controller-handle, app-handle, version) to
// concrete server IDs and either upsert, upgrade, or no-op based on
// what's already on the controller.
// ──────────────────────────────────────────────────────────────────────

/**
 * Per-controller filesystem + exec allowlists. Empty lists = deny all
 * (the bridge default-denies on first boot until a policy is pushed).
 */
export type ControllerPolicySpec = {
  allowedIoPaths: string[];
  allowedExecBinaries: string[];
};

export type Controller = {
  /** Natural key — pushed as the controller's handle. Lowercase alphanumeric/underscore/hyphen. */
  handle: string;
  /** Network reference (string `name`, or a typed `Network`). Optional. */
  network?: NetworkRef;
  name?: string;
  description?: string;
  host?: string;
  port?: number;
  isActive?: boolean;
  jmfConfig?: { enabled: boolean; path?: string; authEnabled?: boolean };
  /**
   * Inline IO/exec allowlists. Declared lists are the *canonical* set
   * for this controller — apply replaces both lists wholesale. Omit
   * to leave the policy untouched (or to inherit the default-deny on
   * first push).
   */
  policy?: ControllerPolicySpec;
};

/**
 * Authentication bundle for a single controller. The natural key is
 * `(controller, name)`. Apply is create-only with an existence check:
 * if a non-revoked token with this name already exists for the
 * controller, apply skips it. Otherwise it mints a new one and prints
 * the connect bundle once — copy that into the bridge configuration
 * before the next apply, since it's never returned again.
 */
export type ControllerToken = {
  controller: ControllerRef;
  name: string;
  description?: string;
  /** ISO8601. Optional — omit for non-expiring tokens. */
  expiresAt?: string;
};

/**
 * A specific edge-app version pinned to a specific controller. Refs
 * the controller by `handle`, the edge app by `app` (handle) +
 * `version`, and (optionally) a bot user by email. `variables` matches
 * the edge app's `configSchema` and resolves `${config:...}` template
 * strings inside the edge app's brokers/endpoints at runtime on the
 * controller.
 */
export type EdgeAppInstallation = {
  controller: ControllerRef;
  /** Edge-app handle (string — edge apps live in `edge_apps/<handle>/`, not as ops objects). */
  app: string;
  /** Specific PUBLISHED version of the edge app to pin. */
  version: number;
  /** A `BOT` user (email or `User` object); cloud-side IAM principal for `bridge.graphql` calls. */
  botUser?: UserRef;
  isActive?: boolean;
  variables?: Record<string, unknown>;
};

/**
 * An installation of an integration definition on the tenant. Identity
 * is `(integration, name)` — you can install the same integration
 * multiple times under different names (e.g. `production` vs
 * `staging`). The pin is `(integration, version)` against an ACTIVE
 * definition on the server.
 *
 * Two opaque blobs:
 *  - `config`   → per-instance config; server validates against the
 *                 integration's `bundle.configSchema` (which the CLI
 *                 picks up automatically from
 *                 `integrations/<handle>/config_schema.json` at push
 *                 time). Plan/apply runs the same validation locally
 *                 before sending so you get clear errors up front.
 *  - `bindings` → maps the integration's declared `resources[].id` to
 *                 actual resources on the tenant (device identifier,
 *                 network name, controller handle, etc.). Validated
 *                 against the integration's `resources` array.
 *
 * `isActive` controls runtime state — true ⇒ START, false ⇒ PAUSE.
 * Status comparison happens after create/update so transitions are
 * driven explicitly by the declared value.
 */
export type IntegrationInstallation = {
  /** Integration handle (reverse-domain id, e.g. `com.acme.orders`). */
  integration: string;
  /** Per-installation natural name — unique within `(integration, name)`. */
  name: string;
  /** Semver of the published integration definition to pin against. */
  version: string;
  /** Per-instance config; shape comes from the integration's `config_schema.json`. */
  config?: Record<string, unknown>;
  /** Mapping from `resources[].id` → tenant resource identifier (device/network/controller/etc.). */
  bindings?: Record<string, string>;
  /** A `BOT` user (email or `User` object); cloud-side IAM principal for `bridge.graphql` calls. */
  botUser?: UserRef;
  description?: string;
  /** Default true (ACTIVE). Set false to install but keep PAUSED. */
  isActive?: boolean;
};

export function defineControllers(
  controllers: Controller[],
): Tagged<{ controllers: Controller[] }, "controllers"> {
  return Object.assign({}, { controllers }, { [KIND_TAG]: "controllers" as const });
}

export function defineControllerTokens(
  tokens: ControllerToken[],
): Tagged<{ tokens: ControllerToken[] }, "controller_tokens"> {
  return Object.assign({}, { tokens }, { [KIND_TAG]: "controller_tokens" as const });
}

export function defineIntegrationInstallations(
  installations: IntegrationInstallation[],
): Tagged<{ installations: IntegrationInstallation[] }, "integration_installations"> {
  return Object.assign(
    {},
    { installations },
    { [KIND_TAG]: "integration_installations" as const },
  );
}

export function defineEdgeAppInstallations(
  installations: EdgeAppInstallation[],
): Tagged<{ installations: EdgeAppInstallation[] }, "edge_app_installations"> {
  return Object.assign(
    {},
    { installations },
    { [KIND_TAG]: "edge_app_installations" as const },
  );
}

// ──────────────────────────────────────────────────────────────────────

function dedent(s: string): string {
  // Drop a single leading newline (common for `lua\n  ...`).
  const body = s.startsWith("\n") ? s.slice(1) : s;
  const lines = body.split("\n");

  // The trailing line is conventionally just the indent of the closing
  // backtick (or empty). Drop it and replace with a final newline — the
  // author wants their Lua to end with a newline, not with stray indent.
  let trailingNewline = false;
  if (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
    lines.pop();
    trailingNewline = true;
  }

  // Find the smallest indent across non-blank body lines.
  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const m = line.match(/^[ \t]*/);
    const indent = m ? m[0].length : 0;
    if (indent < minIndent) minIndent = indent;
  }
  const indentToStrip = Number.isFinite(minIndent) ? minIndent : 0;

  const stripped =
    indentToStrip > 0
      ? lines.map((l) => (l.length >= indentToStrip ? l.slice(indentToStrip) : l))
      : lines;
  return stripped.join("\n") + (trailingNewline ? "\n" : "");
}
