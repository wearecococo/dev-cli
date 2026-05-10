import type { GraphQLClient } from "./client.ts";

export type IntegrationDefinitionStatus = "DRAFT" | "ACTIVE" | "DEPRECATED";
export type IntegrationRuntimeMode = "bundle" | "script_actor";
export type EngineVersion = 1 | 2;

export type FieldError = { path: string; message: string };

type ResourceSpec = {
  id: string;
  type: string;
  description?: string | null;
  optional?: boolean | null;
};

type DataContainerSchemaSpec = {
  name: string;
  schema: string;
  description?: string | null;
  taggableTypes?: string[] | null;
  maxPerInstance?: number | null;
};

type ActionSpec = {
  name: string;
  label: string;
  description?: string | null;
  scriptName: string;
  configSchema?: string | null;
  icon?: string | null;
};

type ManifestCommon = {
  id: string;
  version: string;
  sdkVersion: string;
  configSchema?: string | null;
  resources: ResourceSpec[];
  permissions: string[];
  description?: string | null;
  dataContainerSchemas?: DataContainerSchemaSpec[] | null;
  actions?: ActionSpec[] | null;
  runtimeMode?: IntegrationRuntimeMode | null;
  timeoutMs?: number | null;
};

/** Manifest shape for engineVersion 1: entry-script + exports-table dispatch. */
export type IntegrationManifestV1 = ManifestCommon & {
  entryScript?: string | null;
  subscriptions?: Array<{ topic: string; filter?: string | null }> | null;
  timers?: Array<{
    name: string;
    every?: string | null;
    cron?: string | null;
    jitter?: string | null;
  }> | null;
};

/** Manifest shape for engineVersion 2: per-handler inline source. */
export type IntegrationManifestV2 = ManifestCommon & {
  subscriptions?: Array<{
    topic: string;
    filter?: string | null;
    source?: string | null;
  }> | null;
  timers?: Array<{
    name: string;
    every?: string | null;
    cron?: string | null;
    jitter?: string | null;
    source?: string | null;
  }> | null;
  initSource?: string | null;
  shutdownSource?: string | null;
  upgradeSource?: string | null;
  /** JSON-encoded map of name → Lua source. */
  libraries?: string | null;
};

export type IntegrationManifest = IntegrationManifestV1 | IntegrationManifestV2;

type BundleCommon = {
  configSchema?: string | null;
  policy?: string | null;
  scripts: string;
  workflows: string;
  customAppFiles: string;
  runtimeMode: IntegrationRuntimeMode;
};

export type IntegrationBundleV1 = BundleCommon & { manifest: IntegrationManifestV1 };
export type IntegrationBundleV2 = BundleCommon & { manifest: IntegrationManifestV2 };
export type IntegrationBundle = IntegrationBundleV1 | IntegrationBundleV2;

type DefinitionCommon = {
  id: string;
  integrationId: string;
  version: string;
  status: IntegrationDefinitionStatus;
  createdAt: string;
};

export type IntegrationDefinitionV1 = DefinitionCommon & {
  engineVersion: 1;
  bundle?: IntegrationBundleV1;
};

export type IntegrationDefinitionV2 = DefinitionCommon & {
  engineVersion: 2;
  bundle?: IntegrationBundleV2;
};

export type IntegrationDefinition = IntegrationDefinitionV1 | IntegrationDefinitionV2;

const DEFINITION_SUMMARY = `
  id
  integrationId
  version
  status
  createdAt
  engineVersion
`;

const DEFINITION_WITH_BUNDLE = `
  id
  integrationId
  version
  status
  createdAt
  engineVersion
  bundle {
    manifest {
      id
      version
      sdkVersion
      configSchema
      resources { id type description optional }
      permissions
      description
      dataContainerSchemas { name schema description taggableTypes maxPerInstance }
      actions { name label description scriptName configSchema icon }
      runtimeMode
      timeoutMs
      entryScript
      subscriptions { topic filter source }
      timers { name every cron jitter source }
      initSource
      shutdownSource
      upgradeSource
      libraries
    }
    configSchema
    policy
    scripts
    workflows
    customAppFiles
    runtimeMode
  }
`;

export async function listDefinitions(
  client: GraphQLClient,
  filter: { integrationId?: string; version?: string; status?: IntegrationDefinitionStatus },
): Promise<IntegrationDefinition[]> {
  const query = `
    query ListIntegrationDefinitions($filter: IntegrationDefinitionFilterInput) {
      listIntegrationDefinitions(first: 100, filter: $filter) {
        edges { node { ${DEFINITION_SUMMARY} } }
      }
    }
  `;
  const filterArg: Record<string, unknown> = {};
  if (filter.integrationId) filterArg.integrationId = { eq: filter.integrationId };
  if (filter.version) filterArg.version = { eq: filter.version };
  if (filter.status) filterArg.status = { eq: filter.status };

  const data = await client.request<{
    listIntegrationDefinitions: { edges: { node: IntegrationDefinition }[] };
  }>(query, { filter: filterArg });
  return data.listIntegrationDefinitions.edges.map((e) => e.node);
}

export async function getDefinition(
  client: GraphQLClient,
  id: string,
): Promise<IntegrationDefinition> {
  const query = `
    query GetIntegrationDefinition($id: IntegrationDefinitionID!) {
      getIntegrationDefinition(id: $id) { ${DEFINITION_WITH_BUNDLE} }
    }
  `;
  const data = await client.request<{ getIntegrationDefinition: IntegrationDefinition | null }>(
    query,
    { id },
  );
  if (!data.getIntegrationDefinition) {
    throw new Error(`Integration definition ${id} not found.`);
  }
  return data.getIntegrationDefinition;
}

export async function createDraft(
  client: GraphQLClient,
  input: {
    integrationId: string;
    version: string;
    runtimeMode?: IntegrationRuntimeMode;
    engineVersion?: EngineVersion;
  },
): Promise<IntegrationDefinition> {
  const query = `
    mutation CreateIntegrationDraft($input: CreateIntegrationDraftInput!) {
      createIntegrationDraft(input: $input) {
        definition { ${DEFINITION_SUMMARY} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    createIntegrationDraft: { definition: IntegrationDefinition | null; errors: FieldError[] };
  }>(query, { input });
  return unwrap("createIntegrationDraft", data.createIntegrationDraft);
}

export async function updateDraftManifest(
  client: GraphQLClient,
  input: { id: string; manifest: string },
): Promise<IntegrationDefinition> {
  const query = `
    mutation UpdateIntegrationDraftManifest($input: UpdateIntegrationDraftManifestInput!) {
      updateIntegrationDraftManifest(input: $input) {
        definition { ${DEFINITION_SUMMARY} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    updateIntegrationDraftManifest: {
      definition: IntegrationDefinition | null;
      errors: FieldError[];
    };
  }>(query, { input });
  return unwrap("updateIntegrationDraftManifest", data.updateIntegrationDraftManifest);
}

export async function updateDraftFile(
  client: GraphQLClient,
  input: { id: string; path: string; content: string | null },
): Promise<void> {
  const query = `
    mutation UpdateIntegrationDraftFile($input: UpdateIntegrationDraftFileInput!) {
      updateIntegrationDraftFile(input: $input) {
        definition { id }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    updateIntegrationDraftFile: { definition: IntegrationDefinition | null; errors: FieldError[] };
  }>(query, { input });
  unwrap("updateIntegrationDraftFile", data.updateIntegrationDraftFile);
}

export type ValidationResult = { valid: boolean; errors: FieldError[] };

/**
 * Roles understood by the Lua validator. The role determines which
 * `ctx.*` / `bridge.*` APIs are visible — e.g. `ctx.integration.*`
 * exists in INTEGRATION, `bridge.loadLib` / `bridge.log.*` in EDGE_APP,
 * and CUSTOM_APP has its own slimmer surface.
 */
export type ValidateLuaRole = "INTEGRATION" | "CUSTOM_APP" | "EDGE_APP";

export type LuaSeverity = "ERROR" | "WARNING";

export type LuaDiagnostic = {
  line: number;
  column: number;
  severity: LuaSeverity;
  message: string;
  /** Luau error code (e.g. `LU0042`) when present; null for soft warnings. */
  code?: string | null;
};

export type LuaValidationResult = {
  success: boolean;
  diagnostics: LuaDiagnostic[];
};

export async function validateLua(
  client: GraphQLClient,
  input: {
    source: string;
    role: ValidateLuaRole;
    /** Surfaced verbatim in diagnostic headers. */
    scriptName?: string;
    /** When true, warnings count as failures. Defaults to false server-side. */
    strict?: boolean;
  },
): Promise<LuaValidationResult> {
  const query = `
    query ValidateLua($input: ValidateLuaInput!) {
      validateLua(input: $input) {
        success
        diagnostics { line column severity message code }
      }
    }
  `;
  const data = await client.request<{ validateLua: LuaValidationResult }>(query, { input });
  return data.validateLua;
}

export async function validateDraft(
  client: GraphQLClient,
  id: string,
): Promise<ValidationResult> {
  const query = `
    mutation ValidateIntegrationDraft($input: ValidateIntegrationDraftInput!) {
      validateIntegrationDraft(input: $input) { valid errors { path message } }
    }
  `;
  const data = await client.request<{ validateIntegrationDraft: ValidationResult }>(query, {
    input: { id },
  });
  return data.validateIntegrationDraft;
}

export async function deprecateDefinition(
  client: GraphQLClient,
  id: string,
): Promise<IntegrationDefinition> {
  const query = `
    mutation DeprecateIntegrationDefinition($input: DeprecateIntegrationDefinitionInput!) {
      deprecateIntegrationDefinition(input: $input) {
        definition { ${DEFINITION_SUMMARY} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    deprecateIntegrationDefinition: {
      definition: IntegrationDefinition | null;
      errors: FieldError[];
    };
  }>(query, { input: { id } });
  return unwrap("deprecateIntegrationDefinition", data.deprecateIntegrationDefinition);
}

export async function publishDraft(
  client: GraphQLClient,
  id: string,
): Promise<IntegrationDefinition> {
  const query = `
    mutation PublishIntegrationDraft($input: PublishIntegrationDraftInput!) {
      publishIntegrationDraft(input: $input) {
        definition { ${DEFINITION_SUMMARY} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    publishIntegrationDraft: { definition: IntegrationDefinition | null; errors: FieldError[] };
  }>(query, { input: { id } });
  return unwrap("publishIntegrationDraft", data.publishIntegrationDraft);
}

function unwrap<T>(
  op: string,
  payload: { definition: T | null; errors: FieldError[] },
): T {
  if (payload.errors.length > 0) {
    const summary = payload.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`${op} failed: ${summary}`);
  }
  if (!payload.definition) {
    throw new Error(`${op} returned no definition and no errors.`);
  }
  return payload.definition;
}

// ──────────────────────────────────────────────────────────────────────
// Custom apps. A first-class top-level entity alongside integrations —
// authored locally as a folder under `custom_apps/<handle>/`, pushed to
// the platform's working copy via `upsertCustomApp`, and published by
// snapshotting the working copy as a `CustomAppVersion` and flipping
// the `publishedVersion` pointer.
// ──────────────────────────────────────────────────────────────────────

export type CustomAppKind = "PAGE" | "DASHBOARD" | "KIOSK" | "JOB_VIEW";

export type CustomAppState = {
  id: string;
  name: string;
  handle: string;
  icon: string;
  kind: CustomAppKind;
  template: string;
  script: string;
  serverApi?: string | null;
  hasServerApi: boolean;
  dataContainerSpec?: string | null;
  publishedVersion?: number | null;
  engineVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type CustomAppVersionState = {
  id: string;
  customAppId: string;
  version: number;
  template: string;
  script: string;
  serverApi?: string | null;
  description?: string | null;
  engineVersion: number;
  createdAt: string;
};

const CUSTOM_APP_FIELDS = `
  id
  name
  handle
  icon
  kind
  template
  script
  serverApi
  hasServerApi
  dataContainerSpec
  publishedVersion
  engineVersion
  createdAt
  updatedAt
`;

export async function listCustomApps(
  client: GraphQLClient,
): Promise<CustomAppState[]> {
  const query = `
    query ListCustomApps {
      listCustomApps(first: 200) {
        edges { node { ${CUSTOM_APP_FIELDS} } }
      }
    }
  `;
  const data = await client.request<{
    listCustomApps: { edges: { node: CustomAppState }[] };
  }>(query, {});
  return data.listCustomApps.edges.map((e) => e.node);
}

export async function getCustomAppByHandle(
  client: GraphQLClient,
  handle: string,
): Promise<CustomAppState | undefined> {
  const query = `
    query GetCustomAppByHandle($handle: String!) {
      getCustomAppByHandle(handle: $handle) { ${CUSTOM_APP_FIELDS} }
    }
  `;
  const data = await client.request<{ getCustomAppByHandle: CustomAppState | null }>(
    query,
    { handle },
  );
  return data.getCustomAppByHandle ?? undefined;
}

export async function getCustomApp(
  client: GraphQLClient,
  id: string,
): Promise<CustomAppState> {
  const query = `
    query GetCustomApp($id: CustomAppID!) {
      getCustomApp(id: $id) { ${CUSTOM_APP_FIELDS} }
    }
  `;
  const data = await client.request<{ getCustomApp: CustomAppState | null }>(query, { id });
  if (!data.getCustomApp) throw new Error(`Custom app ${id} not found.`);
  return data.getCustomApp;
}

export async function upsertCustomApp(
  client: GraphQLClient,
  input: {
    id?: string;
    name: string;
    handle: string;
    kind: CustomAppKind;
    icon?: string;
    dataContainerSpec?: string;
    config: { template: string; script: string; serverApi?: string };
  },
): Promise<CustomAppState> {
  const query = `
    mutation UpsertCustomApp($input: UpsertCustomAppInput!) {
      upsertCustomApp(input: $input) {
        customApp { ${CUSTOM_APP_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    upsertCustomApp: { customApp: CustomAppState | null; errors: FieldError[] };
  }>(query, { input });
  if (data.upsertCustomApp.errors.length > 0) {
    const summary = data.upsertCustomApp.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`upsertCustomApp failed: ${summary}`);
  }
  if (!data.upsertCustomApp.customApp) {
    throw new Error(`upsertCustomApp returned no customApp and no errors.`);
  }
  return data.upsertCustomApp.customApp;
}

export async function createCustomAppVersion(
  client: GraphQLClient,
  input: {
    customAppId: string;
    config: { template: string; script: string; serverApi?: string };
    description?: string;
  },
): Promise<CustomAppVersionState> {
  const query = `
    mutation CreateCustomAppVersion($input: CreateCustomAppVersionInput!) {
      createCustomAppVersion(input: $input) {
        version {
          id
          customAppId
          version
          template
          script
          serverApi
          description
          engineVersion
          createdAt
        }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    createCustomAppVersion: {
      version: CustomAppVersionState | null;
      errors: FieldError[];
    };
  }>(query, { input });
  if (data.createCustomAppVersion.errors.length > 0) {
    const summary = data.createCustomAppVersion.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`createCustomAppVersion failed: ${summary}`);
  }
  if (!data.createCustomAppVersion.version) {
    throw new Error(`createCustomAppVersion returned no version and no errors.`);
  }
  return data.createCustomAppVersion.version;
}

export async function publishCustomApp(
  client: GraphQLClient,
  input: { id: string; version: number },
): Promise<CustomAppState> {
  const query = `
    mutation PublishCustomApp($input: PublishCustomAppInput!) {
      publishCustomApp(input: $input) {
        customApp { ${CUSTOM_APP_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    publishCustomApp: { customApp: CustomAppState | null; errors: FieldError[] };
  }>(query, { input });
  if (data.publishCustomApp.errors.length > 0) {
    const summary = data.publishCustomApp.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`publishCustomApp failed: ${summary}`);
  }
  if (!data.publishCustomApp.customApp) {
    throw new Error(`publishCustomApp returned no customApp and no errors.`);
  }
  return data.publishCustomApp.customApp;
}

// ──────────────────────────────────────────────────────────────────────
// Edge apps. A tenant-scoped template installable on N controllers.
// Identified by handle, monotonic Int versioning, lifecycle DRAFT →
// PUBLISHED → DEPRECATED. Authoring this CLI: upsert the DRAFT, publish
// when ready (auto-deprecates the prior PUBLISHED).
// ──────────────────────────────────────────────────────────────────────

export type EdgeAppStatus = "DRAFT" | "PUBLISHED" | "DEPRECATED";

export type EdgeAppTriggerKind = "CRON" | "TAIL" | "FILE_CREATED" | "FILE_DELETED";

export type EdgeAppLogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "OFF";

export type EdgeAppTrigger = {
  kind: EdgeAppTriggerKind;
  name: string;
  handler: string;
  schedule?: string | null;
  path?: string | null;
  pattern?: string | null;
};

export type EdgeAppHandler = {
  name: string;
  source: string;
};

export type EdgeAppLibrary = {
  name: string;
  source: string;
};

// ── External I/O config sub-types ─────────────────────────────────────
// These are all declarative records that pass through the upsertEdgeApp
// input verbatim — no Lua resolution, no special transformation.
// Secret-bearing string fields accept literal values OR `${config:NAME}`
// templates resolved per-installation; the CLI doesn't manipulate
// either form. camelCase throughout to match the GraphQL input shapes.

export type EdgeAppMQTTSubscription = {
  topic: string;
  handler: string;
};

export type EdgeAppMQTTTLS = {
  caCertPem: string;
  clientCertPem?: string;
  clientKeyPem?: string;
  insecureSkipVerify?: boolean;
};

export type EdgeAppMQTTWill = {
  topic: string;
  payload?: string;
  qos?: number;
  retain?: boolean;
};

export type EdgeAppMQTTBroker = {
  name: string;
  url: string;
  clientId?: string;
  username?: string;
  password?: string;
  keepaliveSeconds?: number;
  qos?: number;
  subscriptions: EdgeAppMQTTSubscription[];
  tls?: EdgeAppMQTTTLS;
  will?: EdgeAppMQTTWill;
};

export type EdgeAppOPCUAAuthMode = "ANONYMOUS" | "USERNAME" | "CERTIFICATE";
export type EdgeAppOPCUASecurityPolicy =
  | "NONE"
  | "BASIC128_RSA15"
  | "BASIC256"
  | "BASIC256_SHA256";
export type EdgeAppOPCUASecurityMode = "NONE" | "SIGN" | "SIGN_AND_ENCRYPT";

export type EdgeAppOPCUASubscription = {
  nodeId: string;
  handler: string;
  samplingMs?: number;
  queueSize?: number;
};

export type EdgeAppOPCUAAuth = {
  mode: EdgeAppOPCUAAuthMode;
  username?: string;
  password?: string;
};

export type EdgeAppOPCUASecurity = {
  policy: EdgeAppOPCUASecurityPolicy;
  mode: EdgeAppOPCUASecurityMode;
  clientCertPem?: string;
  clientKeyPem?: string;
};

export type EdgeAppOPCUAEndpoint = {
  name: string;
  endpoint: string;
  subscriptions: EdgeAppOPCUASubscription[];
  auth?: EdgeAppOPCUAAuth;
  security?: EdgeAppOPCUASecurity;
  reconnectIntervalMs?: number;
};

export type EdgeAppSNMPVersion = "V2C" | "V3";
export type EdgeAppSNMPAuthProtocol =
  | "MD5"
  | "SHA1"
  | "SHA224"
  | "SHA256"
  | "SHA384"
  | "SHA512";
export type EdgeAppSNMPPrivProtocol = "DES" | "AES128" | "AES192" | "AES256";

export type EdgeAppSNMPOIDEntry = { label: string; oid: string };

export type EdgeAppSNMPPollGroup = {
  name: string;
  intervalMs: number;
  handler: string;
  oids?: EdgeAppSNMPOIDEntry[];
  walkPrefixes?: EdgeAppSNMPOIDEntry[];
};

export type EdgeAppSNMPv3 = {
  user: string;
  authProtocol?: EdgeAppSNMPAuthProtocol;
  authKey?: string;
  privProtocol?: EdgeAppSNMPPrivProtocol;
  privKey?: string;
  contextName?: string;
};

export type EdgeAppSNMPDevice = {
  name: string;
  host: string;
  version: EdgeAppSNMPVersion;
  pollGroups: EdgeAppSNMPPollGroup[];
  port?: number;
  community?: string;
  v3?: EdgeAppSNMPv3;
  timeoutMs?: number;
  retries?: number;
};

export type EdgeAppModbusTransport = "TCP" | "RTU" | "RTU_OVER_TCP";
export type EdgeAppModbusParity = "NONE" | "EVEN" | "ODD";
export type EdgeAppModbusFunction = "HOLDING" | "INPUT" | "COILS" | "DISCRETE";

export type EdgeAppModbusRead = {
  label: string;
  function: EdgeAppModbusFunction;
  address: number;
  quantity: number;
  /** Decoding type — kept loose because the platform schema enumerates many. */
  type: string;
  scale?: number;
  wordOrder?: string;
  byteOrder?: string;
};

export type EdgeAppModbusPollGroup = {
  name: string;
  intervalMs: number;
  reads: EdgeAppModbusRead[];
  handler: string;
};

export type EdgeAppModbusSlave = {
  name: string;
  unitId: number;
  pollGroups: EdgeAppModbusPollGroup[];
};

export type EdgeAppModbusPort = {
  name: string;
  transport: EdgeAppModbusTransport;
  slaves: EdgeAppModbusSlave[];
  host?: string;
  port?: number;
  serialPath?: string;
  baudRate?: number;
  parity?: EdgeAppModbusParity;
  stopBits?: number;
  dataBits?: number;
};

export type EdgeAppExecEnvEntry = { name: string; value: string };

export type EdgeAppExecCommand = {
  name: string;
  path: string;
  args: string[];
  outputs?: string[];
  timeoutMs?: number;
  maxStdoutBytes?: number;
  env?: EdgeAppExecEnvEntry[];
};

export type EdgeAppHTTPMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ANY";
export type EdgeAppHTTPAuthMode = "NONE" | "BASIC" | "BEARER";

export type EdgeAppHTTPAuth = {
  mode: EdgeAppHTTPAuthMode;
  basicCredentials?: string[];
  bearerTokens?: string[];
};

export type EdgeAppHTTPRoute = {
  method: EdgeAppHTTPMethod;
  path: string;
  handler: string;
  auth: EdgeAppHTTPAuth;
  maxBodyBytes?: number;
  timeoutMs?: number;
};

export type EdgeAppState = {
  id: string;
  handle: string;
  name: string;
  description?: string | null;
  version: number;
  status: EdgeAppStatus;
  triggers: EdgeAppTrigger[];
  handlers: EdgeAppHandler[];
  libraries: EdgeAppLibrary[];
  mqttBrokers: EdgeAppMQTTBroker[];
  opcuaEndpoints: EdgeAppOPCUAEndpoint[];
  snmpDevices: EdgeAppSNMPDevice[];
  modbusPorts: EdgeAppModbusPort[];
  execCommands: EdgeAppExecCommand[];
  httpRoutes: EdgeAppHTTPRoute[];
  onMessage?: string | null;
  configSchema?: unknown;
  logLevel?: EdgeAppLogLevel | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

const EDGE_APP_SUMMARY = `
  id
  handle
  name
  description
  version
  status
  isActive
  logLevel
  createdAt
  updatedAt
`;

const EDGE_APP_FULL = `
  ${EDGE_APP_SUMMARY}
  triggers { kind name handler schedule path pattern }
  handlers { name source }
  libraries { name source }
  mqttBrokers {
    name url clientId username keepaliveSeconds qos
    subscriptions { topic handler }
    tls { caCertPem clientCertPem clientKeyPem insecureSkipVerify }
    will { topic payload qos retain }
  }
  opcuaEndpoints {
    name endpoint reconnectIntervalMs
    subscriptions { nodeId handler samplingMs queueSize }
    auth { mode username }
    security { policy mode clientCertPem clientKeyPem }
  }
  snmpDevices {
    name host version port community timeoutMs retries
    pollGroups {
      name intervalMs handler
      oids { label oid }
      walkPrefixes { label oid }
    }
    v3 { user authProtocol privProtocol contextName }
  }
  modbusPorts {
    name transport host port serialPath baudRate parity stopBits dataBits
    slaves {
      name unitId
      pollGroups {
        name intervalMs handler
        reads { label function address quantity type scale wordOrder byteOrder }
      }
    }
  }
  execCommands {
    name path args outputs timeoutMs maxStdoutBytes
    env { name value }
  }
  httpRoutes {
    method path handler maxBodyBytes timeoutMs
    auth { mode }
  }
  onMessage
  configSchema
`;

export async function listEdgeApps(
  client: GraphQLClient,
  filter?: { handle?: string; status?: EdgeAppStatus },
): Promise<EdgeAppState[]> {
  const filterArg: Record<string, unknown> = {};
  if (filter?.handle) filterArg.handle = { eq: filter.handle };
  if (filter?.status) filterArg.status = { eq: filter.status };
  const query = `
    query ListEdgeApps($filter: EdgeAppFilterInput) {
      listEdgeApps(first: 200, filter: $filter) {
        edges { node { ${EDGE_APP_SUMMARY} } }
      }
    }
  `;
  const data = await client.request<{
    listEdgeApps: { edges: { node: EdgeAppState }[] };
  }>(query, { filter: filterArg });
  return data.listEdgeApps.edges.map((e) => e.node);
}

export async function getEdgeApp(
  client: GraphQLClient,
  id: string,
): Promise<EdgeAppState> {
  const query = `
    query GetEdgeApp($id: EdgeAppID!) {
      getEdgeApp(id: $id) { ${EDGE_APP_FULL} }
    }
  `;
  const data = await client.request<{ getEdgeApp: EdgeAppState | null }>(query, { id });
  if (!data.getEdgeApp) throw new Error(`Edge app ${id} not found.`);
  return data.getEdgeApp;
}

/**
 * Resolve an edge app by handle, preferring the DRAFT (which is what
 * the CLI authors against). Returns undefined if no row exists for the
 * handle in any state.
 */
export async function findEdgeAppDraft(
  client: GraphQLClient,
  handle: string,
): Promise<EdgeAppState | undefined> {
  const matches = await listEdgeApps(client, { handle });
  if (matches.length === 0) return undefined;
  const draft = matches.find((m) => m.status === "DRAFT");
  if (draft) return getEdgeApp(client, draft.id);
  // No DRAFT — return the most-recent row (PUBLISHED / DEPRECATED) so
  // the caller can decide what to do (push will create a new DRAFT).
  return getEdgeApp(client, matches[0]!.id);
}

export async function upsertEdgeApp(
  client: GraphQLClient,
  input: {
    id?: string;
    handle: string;
    name: string;
    description?: string;
    triggers: EdgeAppTrigger[];
    handlers: EdgeAppHandler[];
    libraries?: EdgeAppLibrary[];
    mqttBrokers?: EdgeAppMQTTBroker[];
    opcuaEndpoints?: EdgeAppOPCUAEndpoint[];
    snmpDevices?: EdgeAppSNMPDevice[];
    modbusPorts?: EdgeAppModbusPort[];
    execCommands?: EdgeAppExecCommand[];
    httpRoutes?: EdgeAppHTTPRoute[];
    onMessage?: string;
    configSchema?: unknown;
    logLevel?: EdgeAppLogLevel;
    isActive?: boolean;
  },
): Promise<EdgeAppState> {
  const query = `
    mutation UpsertEdgeApp($input: UpsertEdgeAppInput!) {
      upsertEdgeApp(input: $input) {
        edgeApp { ${EDGE_APP_FULL} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    upsertEdgeApp: { edgeApp: EdgeAppState | null; errors: FieldError[] };
  }>(query, { input });
  if (data.upsertEdgeApp.errors.length > 0) {
    const summary = data.upsertEdgeApp.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`upsertEdgeApp failed: ${summary}`);
  }
  if (!data.upsertEdgeApp.edgeApp) {
    throw new Error(`upsertEdgeApp returned no edgeApp and no errors.`);
  }
  return data.upsertEdgeApp.edgeApp;
}

export async function publishEdgeAppDraft(
  client: GraphQLClient,
  id: string,
): Promise<EdgeAppState> {
  const query = `
    mutation PublishEdgeAppDraft($id: EdgeAppID!) {
      publishEdgeAppDraft(id: $id) {
        edgeApp { ${EDGE_APP_FULL} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    publishEdgeAppDraft: { edgeApp: EdgeAppState | null; errors: FieldError[] };
  }>(query, { id });
  if (data.publishEdgeAppDraft.errors.length > 0) {
    const summary = data.publishEdgeAppDraft.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`publishEdgeAppDraft failed: ${summary}`);
  }
  if (!data.publishEdgeAppDraft.edgeApp) {
    throw new Error(`publishEdgeAppDraft returned no edgeApp and no errors.`);
  }
  return data.publishEdgeAppDraft.edgeApp;
}

export async function deprecateEdgeApp(
  client: GraphQLClient,
  id: string,
): Promise<EdgeAppState> {
  const query = `
    mutation DeprecateEdgeApp($id: EdgeAppID!) {
      deprecateEdgeApp(id: $id) {
        edgeApp { ${EDGE_APP_FULL} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    deprecateEdgeApp: { edgeApp: EdgeAppState | null; errors: FieldError[] };
  }>(query, { id });
  if (data.deprecateEdgeApp.errors.length > 0) {
    const summary = data.deprecateEdgeApp.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`deprecateEdgeApp failed: ${summary}`);
  }
  if (!data.deprecateEdgeApp.edgeApp) {
    throw new Error(`deprecateEdgeApp returned no edgeApp and no errors.`);
  }
  return data.deprecateEdgeApp.edgeApp;
}
