import type { GraphQLClient } from "./client.ts";

export type IntegrationDefinitionStatus = "DRAFT" | "ACTIVE" | "DEPRECATED";
export type RuntimeMode = "bundle" | "script_actor";
export type EngineVersion = 1 | 2;

export type FieldError = { path: string; message: string };

/**
 * The platform caps `first:` at 100 across every Connection-shaped
 * listing. List helpers below loop with cursor pagination via this
 * helper so callers always get the full set without surprises at 100.
 */
const PAGE_SIZE = 100;

type CursorPage<T> = {
  edges: { node: T }[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
};

async function paginateAll<T>(
  fetchPage: (after: string | undefined) => Promise<CursorPage<T>>,
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  while (true) {
    const page = await fetchPage(after);
    for (const edge of page.edges) out.push(edge.node);
    if (!page.pageInfo.hasNextPage) break;
    const next = page.pageInfo.endCursor;
    if (next == null || next === after) break;
    after = next;
  }
  return out;
}

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
  runtimeMode?: RuntimeMode | null;
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
  runtimeMode: RuntimeMode;
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
  const filterArg: Record<string, unknown> = {};
  if (filter.integrationId) filterArg.integrationId = { eq: filter.integrationId };
  if (filter.version) filterArg.version = { eq: filter.version };
  if (filter.status) filterArg.status = { eq: filter.status };
  return paginateAll<IntegrationDefinition>(async (after) => {
    const query = `
      query ListIntegrationDefinitions($filter: IntegrationDefinitionFilterInput, $first: Int!, $after: String) {
        listIntegrationDefinitions(first: $first, filter: $filter, after: $after) {
          edges { node { ${DEFINITION_SUMMARY} } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await client.request<{
      listIntegrationDefinitions: CursorPage<IntegrationDefinition>;
    }>(query, { filter: filterArg, first: PAGE_SIZE, after });
    return data.listIntegrationDefinitions;
  });
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
    runtimeMode?: RuntimeMode;
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
  return paginateAll<CustomAppState>(async (after) => {
    const query = `
      query ListCustomApps($first: Int!, $after: String) {
        listCustomApps(first: $first, after: $after) {
          edges { node { ${CUSTOM_APP_FIELDS} } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await client.request<{ listCustomApps: CursorPage<CustomAppState> }>(
      query,
      { first: PAGE_SIZE, after },
    );
    return data.listCustomApps;
  });
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
  return paginateAll<EdgeAppState>(async (after) => {
    const query = `
      query ListEdgeApps($filter: EdgeAppFilterInput, $first: Int!, $after: String) {
        listEdgeApps(first: $first, filter: $filter, after: $after) {
          edges { node { ${EDGE_APP_SUMMARY} } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await client.request<{ listEdgeApps: CursorPage<EdgeAppState> }>(
      query,
      { filter: filterArg, first: PAGE_SIZE, after },
    );
    return data.listEdgeApps;
  });
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

// ──────────────────────────────────────────────────────────────────────
// Tenant IAM: users, policies, attachments. Authored as flat per-kind
// files (`users.ts`, `iam_policies.ts`, `bindings.ts`) and applied
// additively — push upserts what's declared, never deletes. Use the
// explicit `cococo delete` command to remove.
// ──────────────────────────────────────────────────────────────────────

export type UserKind = "HUMAN" | "BOT" | "KIOSK";

export type UserState = {
  id: string;
  externalId?: string | null;
  email: string;
  name?: string | null;
  kind: UserKind;
  createdAt: string;
  updatedAt: string;
};

const USER_FIELDS = `id externalId email name kind createdAt updatedAt`;

export async function listUsers(
  client: GraphQLClient,
  filter?: { email?: string },
): Promise<UserState[]> {
  const filterArg: Record<string, unknown> = {};
  if (filter?.email) filterArg.email = { eq: filter.email };
  return paginateAll<UserState>(async (after) => {
    const query = `
      query ListUsers($filter: UserFilterInput, $first: Int!, $after: String) {
        listUsers(first: $first, filter: $filter, after: $after) {
          edges { node { ${USER_FIELDS} } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await client.request<{ listUsers: CursorPage<UserState> }>(query, {
      filter: filterArg,
      first: PAGE_SIZE,
      after,
    });
    return data.listUsers;
  });
}

export async function getUserByEmail(
  client: GraphQLClient,
  email: string,
): Promise<UserState | undefined> {
  const matches = await listUsers(client, { email });
  return matches[0];
}

export async function upsertUser(
  client: GraphQLClient,
  input: {
    id?: string;
    email: string;
    name?: string;
    kind?: UserKind;
    externalId?: string;
  },
): Promise<UserState> {
  const query = `
    mutation UpsertUser($input: UpsertUserInput!) {
      upsertUser(input: $input) {
        user { ${USER_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    upsertUser: { user: UserState | null; errors: FieldError[] };
  }>(query, { input });
  if (data.upsertUser.errors.length > 0) {
    const summary = data.upsertUser.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`upsertUser failed: ${summary}`);
  }
  if (!data.upsertUser.user) {
    throw new Error(`upsertUser returned no user and no errors.`);
  }
  return data.upsertUser.user;
}

export async function deleteUser(client: GraphQLClient, id: string): Promise<void> {
  const query = `mutation DeleteUser($id: UserID!) { deleteUser(id: $id) { id } }`;
  await client.request(query, { id });
}

export type Effect = "ALLOW" | "DENY";

export type IAMStatement = {
  effect: Effect;
  actions: string[];
  resources: string[];
};

export type IAMDocument = {
  version: string;
  statements: IAMStatement[];
};

export type IAMPolicyState = {
  id: string;
  name: string;
  description?: string | null;
  document: IAMDocument;
  createdAt: string;
  updatedAt: string;
};

const POLICY_FIELDS = `
  id name description createdAt updatedAt
  document { version statements { effect actions resources } }
`;

export async function listIAMPolicies(client: GraphQLClient): Promise<IAMPolicyState[]> {
  return paginateAll<IAMPolicyState>(async (after) => {
    const query = `
      query ListIAMPolicies($first: Int!, $after: String) {
        listIAMPolicies(first: $first, after: $after) {
          edges { node { ${POLICY_FIELDS} } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await client.request<{ listIAMPolicies: CursorPage<IAMPolicyState> }>(
      query,
      { first: PAGE_SIZE, after },
    );
    return data.listIAMPolicies;
  });
}

export async function getIAMPolicy(
  client: GraphQLClient,
  id: string,
): Promise<IAMPolicyState | undefined> {
  const query = `
    query GetIAMPolicy($id: IAMPolicyID!) {
      getIAMPolicy(id: $id) { ${POLICY_FIELDS} }
    }
  `;
  const data = await client.request<{ getIAMPolicy: IAMPolicyState | null }>(query, { id });
  return data.getIAMPolicy ?? undefined;
}

export async function createIAMPolicy(
  client: GraphQLClient,
  input: {
    id?: string;
    name: string;
    description?: string;
    document: IAMDocument;
  },
): Promise<IAMPolicyState> {
  const query = `
    mutation CreateIAMPolicy($input: CreateIAMPolicyInput!) {
      createIAMPolicy(input: $input) {
        policy { ${POLICY_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    createIAMPolicy: { policy: IAMPolicyState | null; errors: FieldError[] };
  }>(query, { input });
  if (data.createIAMPolicy.errors.length > 0) {
    const summary = data.createIAMPolicy.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`createIAMPolicy failed: ${summary}`);
  }
  if (!data.createIAMPolicy.policy) {
    throw new Error(`createIAMPolicy returned no policy and no errors.`);
  }
  return data.createIAMPolicy.policy;
}

export async function updateIAMPolicy(
  client: GraphQLClient,
  input: {
    id: string;
    name?: string;
    description?: string;
    document?: IAMDocument;
  },
): Promise<IAMPolicyState> {
  const query = `
    mutation UpdateIAMPolicy($input: UpdateIAMPolicyInput!) {
      updateIAMPolicy(input: $input) {
        policy { ${POLICY_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    updateIAMPolicy: { policy: IAMPolicyState | null; errors: FieldError[] };
  }>(query, { input });
  if (data.updateIAMPolicy.errors.length > 0) {
    const summary = data.updateIAMPolicy.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`updateIAMPolicy failed: ${summary}`);
  }
  if (!data.updateIAMPolicy.policy) {
    throw new Error(`updateIAMPolicy returned no policy and no errors.`);
  }
  return data.updateIAMPolicy.policy;
}

export async function deleteIAMPolicy(client: GraphQLClient, id: string): Promise<void> {
  const query = `mutation DeleteIAMPolicy($id: IAMPolicyID!) { deleteIAMPolicy(id: $id) { id } }`;
  await client.request(query, { id });
}

export async function listUserPolicies(
  client: GraphQLClient,
  userId: string,
): Promise<IAMPolicyState[]> {
  const query = `
    query ListUserPolicies($userId: UserID!) {
      listUserPolicies(userId: $userId) { ${POLICY_FIELDS} }
    }
  `;
  const data = await client.request<{ listUserPolicies: IAMPolicyState[] }>(query, { userId });
  return data.listUserPolicies;
}

export async function attachPolicy(
  client: GraphQLClient,
  input: { userId: string; policyId: string },
): Promise<void> {
  const query = `
    mutation AttachPolicy($input: AttachPolicyInput!) {
      attachPolicy(input: $input) {
        success
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    attachPolicy: { success: boolean; errors: FieldError[] };
  }>(query, { input });
  if (data.attachPolicy.errors.length > 0) {
    const summary = data.attachPolicy.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`attachPolicy failed: ${summary}`);
  }
  if (!data.attachPolicy.success) {
    throw new Error(`attachPolicy returned success=false with no errors.`);
  }
}

export async function detachPolicy(
  client: GraphQLClient,
  input: { userId: string; policyId: string },
): Promise<void> {
  const query = `
    mutation DetachPolicy($input: DetachPolicyInput!) {
      detachPolicy(input: $input) {
        success
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    detachPolicy: { success: boolean; errors: FieldError[] };
  }>(query, { input });
  if (data.detachPolicy.errors.length > 0) {
    const summary = data.detachPolicy.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`detachPolicy failed: ${summary}`);
  }
  if (!data.detachPolicy.success) {
    throw new Error(`detachPolicy returned success=false with no errors.`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Networks + Devices. Networks group IoT controllers, devices, and
// databases. Devices belong to a network (optional) and carry a list
// of inbound + outbound protocol configs. Authored as flat per-kind
// files at the repo root: `networks.ts`, `devices.ts`. Applied
// additively with `cococo apply`.
// ──────────────────────────────────────────────────────────────────────

export type NetworkState = {
  id: string;
  name: string;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
};

const NETWORK_FIELDS = `id name description createdAt updatedAt`;

export async function listNetworks(
  client: GraphQLClient,
  filter?: { name?: string },
): Promise<NetworkState[]> {
  const filterArg: Record<string, unknown> = {};
  if (filter?.name) filterArg.name = { eq: filter.name };
  return paginateAll<NetworkState>(async (after) => {
    const query = `
      query ListNetworks($filter: NetworkFilterInput, $first: Int!, $after: String) {
        listNetworks(first: $first, filter: $filter, after: $after) {
          edges { node { ${NETWORK_FIELDS} } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await client.request<{ listNetworks: CursorPage<NetworkState> }>(query, {
      filter: filterArg,
      first: PAGE_SIZE,
      after,
    });
    return data.listNetworks;
  });
}

export async function getNetworkByName(
  client: GraphQLClient,
  name: string,
): Promise<NetworkState | undefined> {
  const matches = await listNetworks(client, { name });
  return matches[0];
}

export async function upsertNetwork(
  client: GraphQLClient,
  input: { id?: string; name: string; description?: string },
): Promise<NetworkState> {
  const query = `
    mutation UpsertNetwork($input: UpsertNetworkInput!) {
      upsertNetwork(input: $input) {
        network { ${NETWORK_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    upsertNetwork: { network: NetworkState | null; errors: FieldError[] };
  }>(query, { input });
  if (data.upsertNetwork.errors.length > 0) {
    const summary = data.upsertNetwork.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`upsertNetwork failed: ${summary}`);
  }
  if (!data.upsertNetwork.network) {
    throw new Error(`upsertNetwork returned no network and no errors.`);
  }
  return data.upsertNetwork.network;
}

export async function deleteNetwork(client: GraphQLClient, id: string): Promise<void> {
  const query = `mutation DeleteNetwork($id: NetworkID!) { deleteNetwork(id: $id) { id } }`;
  await client.request(query, { id });
}

export type OutboundProtocolKind = "HTTP" | "SQL" | "MQTT" | "JMF";
export type InboundProtocolKind = "MQTT" | "HTTP";
export type DeviceAuthMode = "NONE" | "BASIC";
export type DatabaseAdapter = "MSSQL" | "MYSQL" | "POSTGRESQL" | "SQLITE";

export type OutboundProtocolConfig = {
  kind: OutboundProtocolKind;
  label?: string | null;
  url?: string | null;
  authMode?: DeviceAuthMode | null;
  username?: string | null;
  /** Write-only on the server — never returned by listDevices/getDevice. */
  password?: string | null;
  adapter?: DatabaseAdapter | null;
  host?: string | null;
  port?: number | null;
  databaseName?: string | null;
  /** Write-only on the server. */
  connectionString?: string | null;
  topic?: string | null;
};

export type InboundProtocolConfig = {
  kind: InboundProtocolKind;
  label?: string | null;
  topic?: string | null;
  webhookPath?: string | null;
};

export type DeviceState = {
  id: string;
  networkId?: string | null;
  identifier: string;
  name?: string | null;
  description?: string | null;
  deviceType?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  outboundProtocols: OutboundProtocolConfig[];
  inboundProtocols: InboundProtocolConfig[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

const DEVICE_FIELDS = `
  id networkId identifier name description deviceType manufacturer model serialNumber
  isActive createdAt updatedAt
  outboundProtocols { kind label url authMode username adapter host port databaseName topic }
  inboundProtocols { kind label topic webhookPath }
`;

export async function listDevices(
  client: GraphQLClient,
  filter?: { identifier?: string; networkId?: string },
): Promise<DeviceState[]> {
  const filterArg: Record<string, unknown> = {};
  if (filter?.identifier) filterArg.identifier = { eq: filter.identifier };
  if (filter?.networkId) filterArg.networkId = { eq: filter.networkId };
  return paginateAll<DeviceState>(async (after) => {
    const query = `
      query ListDevices($filter: DeviceFilterInput, $first: Int!, $after: String) {
        listDevices(first: $first, filter: $filter, after: $after) {
          edges { node { ${DEVICE_FIELDS} } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await client.request<{ listDevices: CursorPage<DeviceState> }>(query, {
      filter: filterArg,
      first: PAGE_SIZE,
      after,
    });
    return data.listDevices;
  });
}

export async function getDeviceByIdentifier(
  client: GraphQLClient,
  identifier: string,
): Promise<DeviceState | undefined> {
  const matches = await listDevices(client, { identifier });
  return matches[0];
}

export async function upsertDevice(
  client: GraphQLClient,
  input: {
    id?: string;
    networkId?: string;
    identifier: string;
    name?: string;
    description?: string;
    deviceType?: string;
    manufacturer?: string;
    model?: string;
    serialNumber?: string;
    outboundProtocols?: OutboundProtocolConfig[];
    inboundProtocols?: InboundProtocolConfig[];
    isActive?: boolean;
  },
): Promise<DeviceState> {
  const query = `
    mutation UpsertDevice($input: UpsertDeviceInput!) {
      upsertDevice(input: $input) {
        device { ${DEVICE_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    upsertDevice: { device: DeviceState | null; errors: FieldError[] };
  }>(query, { input });
  if (data.upsertDevice.errors.length > 0) {
    const summary = data.upsertDevice.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`upsertDevice failed: ${summary}`);
  }
  if (!data.upsertDevice.device) {
    throw new Error(`upsertDevice returned no device and no errors.`);
  }
  return data.upsertDevice.device;
}

export async function deleteDevice(client: GraphQLClient, id: string): Promise<void> {
  const query = `mutation DeleteDevice($id: DeviceID!) { deleteDevice(id: $id) { id } }`;
  await client.request(query, { id });
}

// ──────────────────────────────────────────────────────────────────────
// Teams + custom-app assignments. Teams group users for collaboration
// and bulk app assignment. The declarative model:
//
//  - `teams.ts`             defines teams with an inline `members: [email]`
//                           list — the apply pass reconciles membership
//                           within each declared team (declared = canonical).
//  - `custom_app_users.ts`  attaches individual users to a custom app
//                           (kiosk-mode visibility).
//  - `custom_app_teams.ts`  attaches teams to a custom app (non-kiosk
//                           visibility filtering).
// ──────────────────────────────────────────────────────────────────────

export type TeamState = {
  id: string;
  name: string;
  description?: string | null;
  defaultNotificationGroupId?: string | null;
  createdAt: string;
  updatedAt: string;
};

const TEAM_FIELDS = `id name description defaultNotificationGroupId createdAt updatedAt`;

export type TeamMemberState = {
  id: string;
  email: string;
  name?: string | null;
  joinedAt: string;
};

export async function listTeams(
  client: GraphQLClient,
  filter?: { name?: string },
): Promise<TeamState[]> {
  const filterArg: Record<string, unknown> = {};
  if (filter?.name) filterArg.name = { eq: filter.name };
  return paginateAll<TeamState>(async (after) => {
    const query = `
      query ListTeams($filter: TeamFilterInput, $first: Int!, $after: String) {
        listTeams(first: $first, filter: $filter, after: $after) {
          edges { node { ${TEAM_FIELDS} } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await client.request<{ listTeams: CursorPage<TeamState> }>(query, {
      filter: filterArg,
      first: PAGE_SIZE,
      after,
    });
    return data.listTeams;
  });
}

export async function getTeamByName(
  client: GraphQLClient,
  name: string,
): Promise<TeamState | undefined> {
  const matches = await listTeams(client, { name });
  return matches[0];
}

export async function upsertTeam(
  client: GraphQLClient,
  input: { id?: string; name: string; description?: string },
): Promise<TeamState> {
  const query = `
    mutation UpsertTeam($input: UpsertTeamInput!) {
      upsertTeam(input: $input) {
        team { ${TEAM_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    upsertTeam: { team: TeamState | null; errors: FieldError[] };
  }>(query, { input });
  if (data.upsertTeam.errors.length > 0) {
    const summary = data.upsertTeam.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`upsertTeam failed: ${summary}`);
  }
  if (!data.upsertTeam.team) {
    throw new Error(`upsertTeam returned no team and no errors.`);
  }
  return data.upsertTeam.team;
}

export async function deleteTeam(client: GraphQLClient, id: string): Promise<void> {
  const query = `mutation DeleteTeam($id: TeamID!) { deleteTeam(id: $id) { id } }`;
  await client.request(query, { id });
}

export async function getTeamMembers(
  client: GraphQLClient,
  teamId: string,
): Promise<TeamMemberState[]> {
  const query = `
    query GetTeamMembers($teamId: TeamID!) {
      getTeamMembers(teamId: $teamId) { id email name joinedAt }
    }
  `;
  const data = await client.request<{ getTeamMembers: TeamMemberState[] }>(query, { teamId });
  return data.getTeamMembers;
}

export async function addTeamMember(
  client: GraphQLClient,
  input: { teamId: string; userId: string },
): Promise<void> {
  const query = `
    mutation AddTeamMember($input: AddTeamMemberInput!) {
      addTeamMember(input: $input) { success errors { path message } }
    }
  `;
  const data = await client.request<{
    addTeamMember: { success: boolean; errors: FieldError[] };
  }>(query, { input });
  if (data.addTeamMember.errors.length > 0) {
    const summary = data.addTeamMember.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`addTeamMember failed: ${summary}`);
  }
}

export async function removeTeamMember(
  client: GraphQLClient,
  input: { teamId: string; userId: string },
): Promise<void> {
  const query = `
    mutation RemoveTeamMember($input: RemoveTeamMemberInput!) {
      removeTeamMember(input: $input) { success errors { path message } }
    }
  `;
  const data = await client.request<{
    removeTeamMember: { success: boolean; errors: FieldError[] };
  }>(query, { input });
  if (data.removeTeamMember.errors.length > 0) {
    const summary = data.removeTeamMember.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`removeTeamMember failed: ${summary}`);
  }
}

export type CustomAppUserBindingState = {
  id: string;
  customAppId: string;
  userId: string;
  createdAt: string;
};

export type CustomAppTeamBindingState = {
  id: string;
  customAppId: string;
  teamId: string;
  createdAt: string;
};

export async function listCustomAppUsers(
  client: GraphQLClient,
  filter?: { customAppId?: string; userId?: string },
): Promise<CustomAppUserBindingState[]> {
  const filterArg: Record<string, unknown> = {};
  if (filter?.customAppId) filterArg.customAppId = { eq: filter.customAppId };
  if (filter?.userId) filterArg.userId = { eq: filter.userId };
  return paginateAll<CustomAppUserBindingState>(async (after) => {
    const query = `
      query ListCustomAppUsers($filter: CustomAppUserFilterInput, $first: Int!, $after: String) {
        listCustomAppUsers(first: $first, filter: $filter, after: $after) {
          edges { node { id customAppId userId createdAt } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await client.request<{
      listCustomAppUsers: CursorPage<CustomAppUserBindingState>;
    }>(query, { filter: filterArg, first: PAGE_SIZE, after });
    return data.listCustomAppUsers;
  });
}

export async function attachCustomAppUser(
  client: GraphQLClient,
  input: { customAppId: string; userId: string },
): Promise<void> {
  const query = `
    mutation AttachCustomAppUser($input: AttachCustomAppUserInput!) {
      attachCustomAppUser(input: $input) {
        customAppUser { id }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    attachCustomAppUser: { customAppUser: { id: string } | null; errors: FieldError[] };
  }>(query, { input });
  if (data.attachCustomAppUser.errors.length > 0) {
    const summary = data.attachCustomAppUser.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`attachCustomAppUser failed: ${summary}`);
  }
}

export async function detachCustomAppUser(
  client: GraphQLClient,
  input: { customAppId: string; userId: string },
): Promise<void> {
  const query = `
    mutation DetachCustomAppUser($input: DetachCustomAppUserInput!) {
      detachCustomAppUser(input: $input) {
        success
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    detachCustomAppUser: { success: boolean; errors: FieldError[] };
  }>(query, { input });
  if (data.detachCustomAppUser.errors.length > 0) {
    const summary = data.detachCustomAppUser.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`detachCustomAppUser failed: ${summary}`);
  }
}

export async function listCustomAppTeams(
  client: GraphQLClient,
  filter?: { customAppId?: string; teamId?: string },
): Promise<CustomAppTeamBindingState[]> {
  const filterArg: Record<string, unknown> = {};
  if (filter?.customAppId) filterArg.customAppId = { eq: filter.customAppId };
  if (filter?.teamId) filterArg.teamId = { eq: filter.teamId };
  return paginateAll<CustomAppTeamBindingState>(async (after) => {
    const query = `
      query ListCustomAppTeams($filter: CustomAppTeamFilterInput, $first: Int!, $after: String) {
        listCustomAppTeams(first: $first, filter: $filter, after: $after) {
          edges { node { id customAppId teamId createdAt } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await client.request<{
      listCustomAppTeams: CursorPage<CustomAppTeamBindingState>;
    }>(query, { filter: filterArg, first: PAGE_SIZE, after });
    return data.listCustomAppTeams;
  });
}

export async function attachCustomAppTeam(
  client: GraphQLClient,
  input: { customAppId: string; teamId: string },
): Promise<void> {
  const query = `
    mutation AttachCustomAppTeam($input: AttachCustomAppTeamInput!) {
      attachCustomAppTeam(input: $input) {
        customAppTeam { id }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    attachCustomAppTeam: { customAppTeam: { id: string } | null; errors: FieldError[] };
  }>(query, { input });
  if (data.attachCustomAppTeam.errors.length > 0) {
    const summary = data.attachCustomAppTeam.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`attachCustomAppTeam failed: ${summary}`);
  }
}

export async function detachCustomAppTeam(
  client: GraphQLClient,
  input: { customAppId: string; teamId: string },
): Promise<void> {
  const query = `
    mutation DetachCustomAppTeam($input: DetachCustomAppTeamInput!) {
      detachCustomAppTeam(input: $input) {
        success
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    detachCustomAppTeam: { success: boolean; errors: FieldError[] };
  }>(query, { input });
  if (data.detachCustomAppTeam.errors.length > 0) {
    const summary = data.detachCustomAppTeam.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`detachCustomAppTeam failed: ${summary}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Controllers, controller policies, controller tokens, and edge-app
// installations. The full chain to actually run an edge app on a
// controller:
//
//   Network ─┐
//            ▼
//        Controller ──▶ ControllerPolicy   (allowlists; default-deny without one)
//             │
//             ├──▶ ControllerToken         (create-only; secret connect bundle
//             │                             returned once)
//             ▼
//        EdgeAppInstallation               (pins an edge-app version to this
//                                           controller, with per-install variables)
// ──────────────────────────────────────────────────────────────────────

export type JMFConfig = {
  enabled: boolean;
  path?: string | null;
  authEnabled?: boolean | null;
};

export type ControllerState = {
  id: string;
  networkId?: string | null;
  handle: string;
  name?: string | null;
  description?: string | null;
  host?: string | null;
  port?: number | null;
  isActive: boolean;
  jmfConfig?: JMFConfig | null;
  createdAt: string;
  updatedAt: string;
};

const CONTROLLER_FIELDS = `
  id networkId handle name description host port isActive createdAt updatedAt
  jmfConfig { enabled path authEnabled }
`;

export async function listControllers(
  client: GraphQLClient,
  filter?: { handle?: string },
): Promise<ControllerState[]> {
  const filterArg: Record<string, unknown> = {};
  if (filter?.handle) filterArg.handle = { eq: filter.handle };
  return paginateAll<ControllerState>(async (after) => {
    const query = `
      query ListControllers($filter: ControllerFilterInput, $first: Int!, $after: String) {
        listControllers(first: $first, filter: $filter, after: $after) {
          edges { node { ${CONTROLLER_FIELDS} } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await client.request<{ listControllers: CursorPage<ControllerState> }>(
      query,
      { filter: filterArg, first: PAGE_SIZE, after },
    );
    return data.listControllers;
  });
}

export async function getControllerByHandle(
  client: GraphQLClient,
  handle: string,
): Promise<ControllerState | undefined> {
  const matches = await listControllers(client, { handle });
  return matches[0];
}

export async function upsertController(
  client: GraphQLClient,
  input: {
    id?: string;
    handle: string;
    networkId?: string;
    name?: string;
    description?: string;
    host?: string;
    port?: number;
    isActive?: boolean;
    jmfConfig?: { enabled: boolean; path?: string; authEnabled?: boolean };
  },
): Promise<ControllerState> {
  const query = `
    mutation UpsertController($input: UpsertControllerInput!) {
      upsertController(input: $input) {
        controller { ${CONTROLLER_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    upsertController: { controller: ControllerState | null; errors: FieldError[] };
  }>(query, { input });
  if (data.upsertController.errors.length > 0) {
    const summary = data.upsertController.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`upsertController failed: ${summary}`);
  }
  if (!data.upsertController.controller) {
    throw new Error(`upsertController returned no controller and no errors.`);
  }
  return data.upsertController.controller;
}

export async function deleteController(client: GraphQLClient, id: string): Promise<void> {
  const query = `mutation DeleteController($id: ControllerID!) { deleteController(id: $id) { id } }`;
  await client.request(query, { id });
}

export type ControllerPolicyState = {
  id: string;
  controllerId: string;
  allowedIoPaths: string[];
  allowedExecBinaries: string[];
  createdAt: string;
  updatedAt: string;
};

const POLICY_FIELDS_CTRL = `id controllerId allowedIoPaths allowedExecBinaries createdAt updatedAt`;

export async function getControllerPolicyByController(
  client: GraphQLClient,
  controllerId: string,
): Promise<ControllerPolicyState | undefined> {
  const query = `
    query GetControllerPolicyByController($controllerId: ControllerID!) {
      getControllerPolicyByController(controllerId: $controllerId) { ${POLICY_FIELDS_CTRL} }
    }
  `;
  const data = await client.request<{
    getControllerPolicyByController: ControllerPolicyState | null;
  }>(query, { controllerId });
  return data.getControllerPolicyByController ?? undefined;
}

export async function upsertControllerPolicy(
  client: GraphQLClient,
  input: { controllerId: string; allowedIoPaths: string[]; allowedExecBinaries: string[] },
): Promise<ControllerPolicyState> {
  const query = `
    mutation UpsertControllerPolicy($input: UpsertControllerPolicyInput!) {
      upsertControllerPolicy(input: $input) {
        controllerPolicy { ${POLICY_FIELDS_CTRL} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    upsertControllerPolicy: {
      controllerPolicy: ControllerPolicyState | null;
      errors: FieldError[];
    };
  }>(query, { input });
  if (data.upsertControllerPolicy.errors.length > 0) {
    const summary = data.upsertControllerPolicy.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`upsertControllerPolicy failed: ${summary}`);
  }
  if (!data.upsertControllerPolicy.controllerPolicy) {
    throw new Error(`upsertControllerPolicy returned no policy and no errors.`);
  }
  return data.upsertControllerPolicy.controllerPolicy;
}

export async function deleteControllerPolicy(client: GraphQLClient, id: string): Promise<void> {
  const query = `
    mutation DeleteControllerPolicy($id: ControllerPolicyID!) {
      deleteControllerPolicy(id: $id) { id }
    }
  `;
  await client.request(query, { id });
}

export type ControllerTokenState = {
  id: string;
  controllerId: string;
  name: string;
  description?: string | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  isRevoked: boolean;
  createdAt: string;
  updatedAt: string;
};

const TOKEN_FIELDS = `
  id controllerId name description expiresAt lastUsedAt isRevoked createdAt updatedAt
`;

export async function listControllerTokens(
  client: GraphQLClient,
  filter?: { controllerId?: string; name?: string; isRevoked?: boolean },
): Promise<ControllerTokenState[]> {
  const filterArg: Record<string, unknown> = {};
  if (filter?.controllerId) filterArg.controllerId = { eq: filter.controllerId };
  if (filter?.name) filterArg.name = { eq: filter.name };
  if (filter?.isRevoked !== undefined) filterArg.isRevoked = { eq: filter.isRevoked };
  return paginateAll<ControllerTokenState>(async (after) => {
    const query = `
      query ListControllerTokens($filter: ControllerTokenFilterInput, $first: Int!, $after: String) {
        listControllerTokens(first: $first, filter: $filter, after: $after) {
          edges { node { ${TOKEN_FIELDS} } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await client.request<{
      listControllerTokens: CursorPage<ControllerTokenState>;
    }>(query, { filter: filterArg, first: PAGE_SIZE, after });
    return data.listControllerTokens;
  });
}

export type CreatedControllerToken = {
  controllerToken: ControllerTokenState;
  /** Base64-encoded JSON connect bundle for the bridge. Returned once. */
  connectBundle: string;
};

export async function createControllerToken(
  client: GraphQLClient,
  input: { controllerId: string; name: string; description?: string; expiresAt?: string },
): Promise<CreatedControllerToken> {
  const query = `
    mutation CreateControllerToken($input: CreateControllerTokenInput!) {
      createControllerToken(input: $input) {
        controllerToken { ${TOKEN_FIELDS} }
        connectBundle
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    createControllerToken: {
      controllerToken: ControllerTokenState | null;
      connectBundle: string | null;
      errors: FieldError[];
    };
  }>(query, { input });
  if (data.createControllerToken.errors.length > 0) {
    const summary = data.createControllerToken.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`createControllerToken failed: ${summary}`);
  }
  if (!data.createControllerToken.controllerToken || !data.createControllerToken.connectBundle) {
    throw new Error(`createControllerToken returned no token/bundle and no errors.`);
  }
  return {
    controllerToken: data.createControllerToken.controllerToken,
    connectBundle: data.createControllerToken.connectBundle,
  };
}

export async function revokeControllerToken(client: GraphQLClient, id: string): Promise<void> {
  const query = `
    mutation RevokeControllerToken($id: ControllerTokenID!) {
      revokeControllerToken(id: $id) { id }
    }
  `;
  await client.request(query, { id });
}

export type EdgeAppInstallationState = {
  id: string;
  edgeAppId: string;
  controllerId: string;
  botUserId?: string | null;
  isActive: boolean;
  /** JSON object — the bridge resolves ${config:NAME} refs in the edge app from this. */
  variables: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** Pinned edge app row — populated when selected; lets us recover the handle. */
  edgeApp?: { id: string; handle: string; version: number } | null;
};

const INSTALL_FIELDS = `
  id edgeAppId controllerId botUserId isActive variables createdAt updatedAt
  edgeApp { id handle version }
`;

export async function listEdgeAppInstallations(
  client: GraphQLClient,
  filter?: { controllerId?: string; edgeAppId?: string },
): Promise<EdgeAppInstallationState[]> {
  const filterArg: Record<string, unknown> = {};
  if (filter?.controllerId) filterArg.controllerId = { eq: filter.controllerId };
  if (filter?.edgeAppId) filterArg.edgeAppId = { eq: filter.edgeAppId };
  return paginateAll<EdgeAppInstallationState>(async (after) => {
    const query = `
      query ListEdgeAppInstallations($filter: EdgeAppInstallationFilterInput, $first: Int!, $after: String) {
        listEdgeAppInstallations(first: $first, filter: $filter, after: $after) {
          edges { node { ${INSTALL_FIELDS} } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await client.request<{
      listEdgeAppInstallations: CursorPage<EdgeAppInstallationState>;
    }>(query, { filter: filterArg, first: PAGE_SIZE, after });
    return data.listEdgeAppInstallations;
  });
}

export async function upsertEdgeAppInstallation(
  client: GraphQLClient,
  input: {
    id?: string;
    edgeAppId: string;
    controllerId: string;
    botUserId?: string | null;
    isActive?: boolean;
    variables?: Record<string, unknown>;
  },
): Promise<EdgeAppInstallationState> {
  const query = `
    mutation UpsertEdgeAppInstallation($input: UpsertEdgeAppInstallationInput!) {
      upsertEdgeAppInstallation(input: $input) {
        edgeAppInstallation { ${INSTALL_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    upsertEdgeAppInstallation: {
      edgeAppInstallation: EdgeAppInstallationState | null;
      errors: FieldError[];
    };
  }>(query, { input });
  if (data.upsertEdgeAppInstallation.errors.length > 0) {
    const summary = data.upsertEdgeAppInstallation.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`upsertEdgeAppInstallation failed: ${summary}`);
  }
  if (!data.upsertEdgeAppInstallation.edgeAppInstallation) {
    throw new Error(`upsertEdgeAppInstallation returned no installation and no errors.`);
  }
  return data.upsertEdgeAppInstallation.edgeAppInstallation;
}

export async function upgradeEdgeAppInstallation(
  client: GraphQLClient,
  input: { id: string; toEdgeAppId: string },
): Promise<EdgeAppInstallationState> {
  const query = `
    mutation UpgradeEdgeAppInstallation($input: UpgradeEdgeAppInstallationInput!) {
      upgradeEdgeAppInstallation(input: $input) {
        edgeAppInstallation { ${INSTALL_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    upgradeEdgeAppInstallation: {
      edgeAppInstallation: EdgeAppInstallationState | null;
      errors: FieldError[];
    };
  }>(query, { input });
  if (data.upgradeEdgeAppInstallation.errors.length > 0) {
    const summary = data.upgradeEdgeAppInstallation.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`upgradeEdgeAppInstallation failed: ${summary}`);
  }
  if (!data.upgradeEdgeAppInstallation.edgeAppInstallation) {
    throw new Error(`upgradeEdgeAppInstallation returned no installation and no errors.`);
  }
  return data.upgradeEdgeAppInstallation.edgeAppInstallation;
}

export async function deleteEdgeAppInstallation(
  client: GraphQLClient,
  id: string,
): Promise<void> {
  const query = `
    mutation DeleteEdgeAppInstallation($id: EdgeAppInstallationID!) {
      deleteEdgeAppInstallation(id: $id) { id }
    }
  `;
  await client.request(query, { id });
}

/**
 * Resolve an edge-app handle + version to a specific `edgeAppId`. The
 * server stores each version as a distinct row keyed by `id`; the
 * (handle, version) pair is the natural composite the install pins
 * against.
 */
export async function resolveEdgeAppByHandleAndVersion(
  client: GraphQLClient,
  handle: string,
  version: number,
): Promise<EdgeAppState | undefined> {
  const matches = await listEdgeApps(client, { handle });
  return matches.find((e) => e.version === version);
}

// ──────────────────────────────────────────────────────────────────────
// Workflows. The platform models a workflow as a mutable workflow row
// with immutable version snapshots and a `currentVersionId` pointer
// (cf. custom apps' working-copy-plus-snapshots model). Triggers are
// independent rows that pin a workflow + an optional specific version.
//
// Each push creates a fresh version snapshot; publish flips the
// `currentVersionId` pointer. Triggers are reconciled additively at
// the row level — declared rows get upserted by `(workflowId, name)`,
// undeclared rows are left alone (use `cococo delete trigger` to
// remove explicitly).
// ──────────────────────────────────────────────────────────────────────

export type ConcurrencyPolicy = "ALLOW" | "QUEUE" | "SKIP" | "CANCEL";
export type WorkflowSerializationFormat = "YAML" | "JSON";

export type WorkflowState = {
  id: string;
  tenantId: string;
  name: string;
  description?: string | null;
  currentVersionId?: string | null;
  botUserId?: string | null;
  defaultNodeTimeoutSeconds?: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

const WORKFLOW_FIELDS = `
  id tenantId name description currentVersionId botUserId
  defaultNodeTimeoutSeconds isActive createdAt updatedAt
`;

export type WorkflowNodeWire = {
  id: string;
  name: string;
  type: string;
  /** JSON string — the platform stores per-node config opaquely. */
  config?: string | null;
  position?: { x: number; y: number } | null;
};

export type WorkflowEdgeWire = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  condition?: string | null;
};

export type WorkflowVariableWire = {
  name: string;
  type: string;
  /** JSON string — variables can hold any JSON value as their default. */
  defaultValue?: string | null;
  description?: string | null;
};

export type WorkflowDefinitionWire = {
  nodes: WorkflowNodeWire[];
  edges: WorkflowEdgeWire[];
  variables: WorkflowVariableWire[];
};

export type WorkflowVersionState = {
  id: string;
  workflowId: string;
  tenantId: string;
  version: number;
  definition: WorkflowDefinitionWire;
  isValid: boolean;
  validationErrors: string[];
  createdAt: string;
};

const WORKFLOW_VERSION_FIELDS = `
  id workflowId tenantId version isValid validationErrors createdAt
  definition {
    nodes { id name type config position { x y } }
    edges { id fromNodeId toNodeId condition }
    variables { name type defaultValue description }
  }
`;

export type WorkflowTriggerState = {
  id: string;
  tenantId: string;
  workflowId: string;
  versionId?: string | null;
  name: string;
  /** Always JSON when read; submit a typed `TriggerConfigInput` on write. */
  configJSON: string;
  isEnabled: boolean;
  concurrencyPolicy: ConcurrencyPolicy;
  maxConcurrentExecutions?: number | null;
  createdAt: string;
  updatedAt: string;
};

const TRIGGER_FIELDS = `
  id tenantId workflowId versionId name configJSON isEnabled
  concurrencyPolicy maxConcurrentExecutions createdAt updatedAt
`;

/**
 * Discriminated trigger config matching the platform's
 * `TriggerConfigInput`. The wire shape uses a `type` discriminator and
 * one of five typed slots; we present it as a sum-type over `kind`
 * locally, then map at submit time.
 */
export type TriggerConfigInputWire =
  | {
      type: "scheduled";
      scheduled: {
        cronExpression: string;
        overlapPolicy: string;
        timezone?: string;
      };
    }
  | {
      type: "event";
      event: { topic: string; filter?: string; dataQuery?: string };
    }
  | {
      type: "deviceMqtt";
      deviceMqtt: { topic: string; deviceId?: string; filter?: string };
    }
  | {
      type: "webhook";
      webhook: { path: string; method: string; authRequired: boolean };
    }
  | {
      type: "edgeAppEvent";
      edgeAppEvent: {
        topic?: string;
        controllerId?: string;
        edgeAppHandle?: string;
      };
    };

// ── Workflow CRUD ─────────────────────────────────────────────────────

export async function listWorkflows(
  client: GraphQLClient,
  filter?: { name?: string },
): Promise<WorkflowState[]> {
  const filterArg: Record<string, unknown> = {};
  if (filter?.name) filterArg.name = { eq: filter.name };
  return paginateAll<WorkflowState>(async (after) => {
    const query = `
      query ListWorkflows($filter: WorkflowFilterInput, $first: Int!, $after: String) {
        listWorkflows(first: $first, filter: $filter, after: $after) {
          edges { node { ${WORKFLOW_FIELDS} } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await client.request<{ listWorkflows: CursorPage<WorkflowState> }>(query, {
      filter: filterArg,
      first: PAGE_SIZE,
      after,
    });
    return data.listWorkflows;
  });
}

export async function getWorkflowByName(
  client: GraphQLClient,
  name: string,
): Promise<WorkflowState | undefined> {
  const matches = await listWorkflows(client, { name });
  return matches[0];
}

export async function getWorkflow(
  client: GraphQLClient,
  id: string,
): Promise<WorkflowState> {
  const query = `
    query GetWorkflow($id: WorkflowID!) {
      getWorkflow(id: $id) { ${WORKFLOW_FIELDS} }
    }
  `;
  const data = await client.request<{ getWorkflow: WorkflowState | null }>(query, { id });
  if (!data.getWorkflow) throw new Error(`Workflow ${id} not found.`);
  return data.getWorkflow;
}

export async function createWorkflow(
  client: GraphQLClient,
  input: {
    name: string;
    description?: string;
    isActive?: boolean;
    botUserId?: string;
    defaultNodeTimeoutSeconds?: number;
  },
): Promise<WorkflowState> {
  const query = `
    mutation CreateWorkflow($input: CreateWorkflowInput!) {
      createWorkflow(input: $input) {
        workflow { ${WORKFLOW_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    createWorkflow: { workflow: WorkflowState | null; errors: FieldError[] };
  }>(query, { input });
  if (data.createWorkflow.errors.length > 0) {
    const summary = data.createWorkflow.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`createWorkflow failed: ${summary}`);
  }
  if (!data.createWorkflow.workflow) {
    throw new Error(`createWorkflow returned no workflow and no errors.`);
  }
  return data.createWorkflow.workflow;
}

export async function updateWorkflow(
  client: GraphQLClient,
  input: {
    id: string;
    name?: string;
    description?: string;
    isActive?: boolean;
    botUserId?: string;
    defaultNodeTimeoutSeconds?: number;
  },
): Promise<WorkflowState> {
  const query = `
    mutation UpdateWorkflow($input: UpdateWorkflowInput!) {
      updateWorkflow(input: $input) {
        workflow { ${WORKFLOW_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    updateWorkflow: { workflow: WorkflowState | null; errors: FieldError[] };
  }>(query, { input });
  if (data.updateWorkflow.errors.length > 0) {
    const summary = data.updateWorkflow.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`updateWorkflow failed: ${summary}`);
  }
  if (!data.updateWorkflow.workflow) {
    throw new Error(`updateWorkflow returned no workflow and no errors.`);
  }
  return data.updateWorkflow.workflow;
}

export async function deleteWorkflow(client: GraphQLClient, id: string): Promise<void> {
  const query = `mutation DeleteWorkflow($id: WorkflowID!) { deleteWorkflow(id: $id) { success } }`;
  await client.request(query, { id });
}

// ── Versions ─────────────────────────────────────────────────────────

export async function listWorkflowVersions(
  client: GraphQLClient,
  workflowId: string,
): Promise<WorkflowVersionState[]> {
  return paginateAll<WorkflowVersionState>(async (after) => {
    const query = `
      query ListWorkflowVersions($workflowId: WorkflowID!, $first: Int!, $after: String) {
        listWorkflowVersions(workflowId: $workflowId, first: $first, after: $after) {
          edges { node { ${WORKFLOW_VERSION_FIELDS} } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await client.request<{
      listWorkflowVersions: CursorPage<WorkflowVersionState>;
    }>(query, { workflowId, first: PAGE_SIZE, after });
    return data.listWorkflowVersions;
  });
}

export async function getWorkflowVersion(
  client: GraphQLClient,
  id: string,
): Promise<WorkflowVersionState> {
  const query = `
    query GetWorkflowVersion($id: WorkflowVersionID!) {
      getWorkflowVersion(id: $id) { ${WORKFLOW_VERSION_FIELDS} }
    }
  `;
  const data = await client.request<{ getWorkflowVersion: WorkflowVersionState | null }>(query, { id });
  if (!data.getWorkflowVersion) throw new Error(`Workflow version ${id} not found.`);
  return data.getWorkflowVersion;
}

export async function createWorkflowVersion(
  client: GraphQLClient,
  input: { workflowId: string; definition: WorkflowDefinitionWire },
): Promise<WorkflowVersionState> {
  const query = `
    mutation CreateWorkflowVersion($input: CreateWorkflowVersionInput!) {
      createWorkflowVersion(input: $input) {
        version { ${WORKFLOW_VERSION_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    createWorkflowVersion: { version: WorkflowVersionState | null; errors: FieldError[] };
  }>(query, { input });
  if (data.createWorkflowVersion.errors.length > 0) {
    const summary = data.createWorkflowVersion.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`createWorkflowVersion failed: ${summary}`);
  }
  if (!data.createWorkflowVersion.version) {
    throw new Error(`createWorkflowVersion returned no version and no errors.`);
  }
  return data.createWorkflowVersion.version;
}

export async function setActiveVersion(
  client: GraphQLClient,
  input: { workflowId: string; versionId: string },
): Promise<WorkflowState> {
  const query = `
    mutation SetActiveVersion($input: SetActiveVersionInput!) {
      setActiveVersion(input: $input) {
        workflow { ${WORKFLOW_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    setActiveVersion: { workflow: WorkflowState | null; errors: FieldError[] };
  }>(query, { input });
  if (data.setActiveVersion.errors.length > 0) {
    const summary = data.setActiveVersion.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`setActiveVersion failed: ${summary}`);
  }
  if (!data.setActiveVersion.workflow) {
    throw new Error(`setActiveVersion returned no workflow and no errors.`);
  }
  return data.setActiveVersion.workflow;
}

export async function validateWorkflowDefinition(
  client: GraphQLClient,
  definition: WorkflowDefinitionWire,
): Promise<{ isValid: boolean; errors: FieldError[] }> {
  const query = `
    mutation ValidateWorkflow($input: ValidateWorkflowInput!) {
      validateWorkflow(input: $input) {
        isValid
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    validateWorkflow: { isValid: boolean; errors: FieldError[] };
  }>(query, { input: { definition } });
  return data.validateWorkflow;
}

// ── Schema ───────────────────────────────────────────────────────────

export async function getWorkflowSchema(client: GraphQLClient): Promise<string> {
  const query = `query GetWorkflowSchema { getWorkflowSchema }`;
  const data = await client.request<{ getWorkflowSchema: string }>(query, {});
  return data.getWorkflowSchema;
}

// ── Export / import ──────────────────────────────────────────────────

export async function exportWorkflow(
  client: GraphQLClient,
  versionId: string,
  format: WorkflowSerializationFormat = "YAML",
): Promise<{ content: string; format: WorkflowSerializationFormat }> {
  const query = `
    mutation ExportWorkflow($input: ExportWorkflowInput!) {
      exportWorkflow(input: $input) {
        content
        format
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    exportWorkflow: {
      content: string;
      format: WorkflowSerializationFormat;
      errors: FieldError[];
    };
  }>(query, { input: { versionId, format } });
  if (data.exportWorkflow.errors.length > 0) {
    const summary = data.exportWorkflow.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`exportWorkflow failed: ${summary}`);
  }
  return { content: data.exportWorkflow.content, format: data.exportWorkflow.format };
}

export async function importWorkflow(
  client: GraphQLClient,
  input: {
    workflowId: string;
    content: string;
    format: WorkflowSerializationFormat;
    validate?: boolean;
  },
): Promise<WorkflowVersionState> {
  const query = `
    mutation ImportWorkflow($input: ImportWorkflowInput!) {
      importWorkflow(input: $input) {
        version { ${WORKFLOW_VERSION_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    importWorkflow: { version: WorkflowVersionState | null; errors: FieldError[] };
  }>(query, { input });
  if (data.importWorkflow.errors.length > 0) {
    const summary = data.importWorkflow.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`importWorkflow failed: ${summary}`);
  }
  if (!data.importWorkflow.version) {
    throw new Error(`importWorkflow returned no version and no errors.`);
  }
  return data.importWorkflow.version;
}

// ── Triggers ─────────────────────────────────────────────────────────

export async function listWorkflowTriggers(
  client: GraphQLClient,
  workflowId: string,
): Promise<WorkflowTriggerState[]> {
  const query = `
    query WorkflowTriggers($workflowId: WorkflowID!) {
      workflowTriggers(workflowId: $workflowId) { ${TRIGGER_FIELDS} }
    }
  `;
  const data = await client.request<{ workflowTriggers: WorkflowTriggerState[] }>(query, {
    workflowId,
  });
  return data.workflowTriggers;
}

export async function createWorkflowTrigger(
  client: GraphQLClient,
  input: {
    workflowId: string;
    name: string;
    config: TriggerConfigInputWire;
    versionId?: string;
    isEnabled?: boolean;
    concurrencyPolicy?: ConcurrencyPolicy;
    maxConcurrentExecutions?: number;
  },
): Promise<WorkflowTriggerState> {
  const query = `
    mutation CreateWorkflowTrigger($input: CreateWorkflowTriggerInput!) {
      createWorkflowTrigger(input: $input) {
        trigger { ${TRIGGER_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    createWorkflowTrigger: { trigger: WorkflowTriggerState | null; errors: FieldError[] };
  }>(query, { input });
  if (data.createWorkflowTrigger.errors.length > 0) {
    const summary = data.createWorkflowTrigger.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`createWorkflowTrigger failed: ${summary}`);
  }
  if (!data.createWorkflowTrigger.trigger) {
    throw new Error(`createWorkflowTrigger returned no trigger and no errors.`);
  }
  return data.createWorkflowTrigger.trigger;
}

export async function updateWorkflowTrigger(
  client: GraphQLClient,
  input: {
    id: string;
    name?: string;
    config?: TriggerConfigInputWire;
    isEnabled?: boolean;
    concurrencyPolicy?: ConcurrencyPolicy;
    maxConcurrentExecutions?: number;
  },
): Promise<WorkflowTriggerState> {
  const query = `
    mutation UpdateWorkflowTrigger($input: UpdateWorkflowTriggerInput!) {
      updateWorkflowTrigger(input: $input) {
        trigger { ${TRIGGER_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    updateWorkflowTrigger: { trigger: WorkflowTriggerState | null; errors: FieldError[] };
  }>(query, { input });
  if (data.updateWorkflowTrigger.errors.length > 0) {
    const summary = data.updateWorkflowTrigger.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`updateWorkflowTrigger failed: ${summary}`);
  }
  if (!data.updateWorkflowTrigger.trigger) {
    throw new Error(`updateWorkflowTrigger returned no trigger and no errors.`);
  }
  return data.updateWorkflowTrigger.trigger;
}

export async function deleteWorkflowTrigger(client: GraphQLClient, id: string): Promise<void> {
  const query = `
    mutation DeleteWorkflowTrigger($id: WorkflowTriggerID!) {
      deleteWorkflowTrigger(id: $id) { success }
    }
  `;
  await client.request(query, { id });
}

export async function enableWorkflowTrigger(
  client: GraphQLClient,
  id: string,
): Promise<WorkflowTriggerState> {
  const query = `
    mutation EnableWorkflowTrigger($id: WorkflowTriggerID!) {
      enableWorkflowTrigger(id: $id) {
        trigger { ${TRIGGER_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    enableWorkflowTrigger: { trigger: WorkflowTriggerState | null; errors: FieldError[] };
  }>(query, { id });
  if (data.enableWorkflowTrigger.errors.length > 0) {
    const summary = data.enableWorkflowTrigger.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`enableWorkflowTrigger failed: ${summary}`);
  }
  if (!data.enableWorkflowTrigger.trigger) {
    throw new Error(`enableWorkflowTrigger returned no trigger and no errors.`);
  }
  return data.enableWorkflowTrigger.trigger;
}

export async function disableWorkflowTrigger(
  client: GraphQLClient,
  id: string,
): Promise<WorkflowTriggerState> {
  const query = `
    mutation DisableWorkflowTrigger($id: WorkflowTriggerID!) {
      disableWorkflowTrigger(id: $id) {
        trigger { ${TRIGGER_FIELDS} }
        errors { path message }
      }
    }
  `;
  const data = await client.request<{
    disableWorkflowTrigger: { trigger: WorkflowTriggerState | null; errors: FieldError[] };
  }>(query, { id });
  if (data.disableWorkflowTrigger.errors.length > 0) {
    const summary = data.disableWorkflowTrigger.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`disableWorkflowTrigger failed: ${summary}`);
  }
  if (!data.disableWorkflowTrigger.trigger) {
    throw new Error(`disableWorkflowTrigger returned no trigger and no errors.`);
  }
  return data.disableWorkflowTrigger.trigger;
}
