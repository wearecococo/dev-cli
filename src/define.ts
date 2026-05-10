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

// ──────────────────────────────────────────────────────────────────────
// Manifest shape — discriminated on engineVersion. v1 requires
// entryScript and forbids v2-only fields; v2 forbids entryScript and
// makes engineVersion optional (defaults to 2 when omitted).
// ──────────────────────────────────────────────────────────────────────

export type RuntimeMode = "script_actor" | "bundle";

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
  | "users"
  | "iam_policies"
  | "bindings";

export type Tagged<T, K extends ManifestKind> = T & {
  readonly [KIND_TAG]: K;
};

export function manifestKind(value: unknown): ManifestKind | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const k = (value as Record<symbol, unknown>)[KIND_TAG];
  return k === "integration" ||
    k === "app" ||
    k === "edge" ||
    k === "users" ||
    k === "iam_policies" ||
    k === "bindings"
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

export type CustomAppKind = "PAGE" | "DASHBOARD" | "KIOSK" | "JOB_VIEW";

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

export type EdgeAppLogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "OFF";

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
// Tenant-config "ops" resources. Unlike integrations / custom apps /
// edge apps, these aren't artifacts with a folder layout and a lifecycle
// — they're declarative records describing tenant IAM. Authored as flat
// per-kind files at the repo root: `users.ts`, `iam_policies.ts`,
// `bindings.ts`. Push is additive (upserts what's declared, never
// deletes); explicit `cococo delete` removes.
// ──────────────────────────────────────────────────────────────────────

export type UserKind = "HUMAN" | "BOT" | "KIOSK";

/**
 * A user account. `email` is the natural key (unique per tenant) — the
 * loader uses it to resolve to a server-side `UserID` when pushing.
 */
export type UserSpec = {
  email: string;
  name?: string;
  kind?: UserKind;
  /** Identifier in an external system (HRIS, IdP). Optional. */
  externalId?: string;
};

export type Effect = "ALLOW" | "DENY";

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
export type IAMPolicySpec = {
  handle: string;
  name: string;
  description?: string;
  statements: IAMStatement[];
};

/**
 * A user → policy attachment. Both ends reference the natural key:
 * `user` is an email (matches `UserSpec.email`), `policy` is a handle
 * (matches `IAMPolicySpec.handle`). The loader cross-checks the refs
 * against the same manifest's users/policies — pushing a binding for a
 * user or policy that isn't declared locally only resolves if the row
 * already exists on the server.
 */
export type BindingSpec = {
  user: string;
  policy: string;
};

export function defineUsers(users: UserSpec[]): Tagged<{ users: UserSpec[] }, "users"> {
  return Object.assign({}, { users }, { [KIND_TAG]: "users" as const });
}

export function defineIAMPolicies(
  policies: IAMPolicySpec[],
): Tagged<{ policies: IAMPolicySpec[] }, "iam_policies"> {
  return Object.assign({}, { policies }, { [KIND_TAG]: "iam_policies" as const });
}

export function defineBindings(
  bindings: BindingSpec[],
): Tagged<{ bindings: BindingSpec[] }, "bindings"> {
  return Object.assign({}, { bindings }, { [KIND_TAG]: "bindings" as const });
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
