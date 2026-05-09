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
 * `ctx.*` APIs are visible — e.g. `ctx.integration.*` exists in
 * INTEGRATION but not in CUSTOM_APP. EDGE_APP is recognised by the
 * server but not yet emitted by this CLI; add it here once primitives
 * stabilise.
 */
export type ValidateLuaRole = "INTEGRATION" | "CUSTOM_APP";

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
