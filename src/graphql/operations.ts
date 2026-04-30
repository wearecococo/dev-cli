import type { GraphQLClient } from "./client.ts";

export type IntegrationDefinitionStatus = "DRAFT" | "ACTIVE" | "DEPRECATED";
export type IntegrationRuntimeMode = "bundle" | "script_actor";

export type FieldError = { path: string; message: string };

export type IntegrationManifest = {
  id: string;
  version: string;
  sdkVersion: string;
  configSchema?: string | null;
  resources: Array<{
    id: string;
    type: string;
    description?: string | null;
    optional?: boolean | null;
  }>;
  permissions: string[];
  description?: string | null;
  dataContainerSchemas?: Array<{
    name: string;
    schema: string;
    description?: string | null;
    taggableTypes?: string[] | null;
    maxPerInstance?: number | null;
  }> | null;
  actions?: Array<{
    name: string;
    label: string;
    description?: string | null;
    scriptName: string;
    configSchema?: string | null;
    icon?: string | null;
  }> | null;
  runtimeMode?: IntegrationRuntimeMode | null;
  entryScript?: string | null;
  subscriptions?: Array<{ topic: string; filter?: string | null }> | null;
  timers?: Array<{
    name: string;
    every?: string | null;
    cron?: string | null;
    jitter?: string | null;
  }> | null;
};

export type IntegrationBundle = {
  manifest: IntegrationManifest;
  configSchema?: string | null;
  policy?: string | null;
  scripts: string;
  workflows: string;
  customAppFiles: string;
  runtimeMode: IntegrationRuntimeMode;
};

export type IntegrationDefinition = {
  id: string;
  integrationId: string;
  version: string;
  status: IntegrationDefinitionStatus;
  createdAt: string;
  bundle?: IntegrationBundle;
};

const DEFINITION_SUMMARY = `
  id
  integrationId
  version
  status
  createdAt
`;

const DEFINITION_WITH_BUNDLE = `
  id
  integrationId
  version
  status
  createdAt
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
      entryScript
      subscriptions { topic filter }
      timers { name every cron jitter }
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
  input: { integrationId: string; version: string; runtimeMode?: IntegrationRuntimeMode },
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

export type ScriptValidationResult = { success: boolean; errors: FieldError[] };

export async function validateLuaScript(
  client: GraphQLClient,
  script: string,
): Promise<ScriptValidationResult> {
  const query = `
    mutation ValidateLuaScript($script: String!) {
      validateLuaScript(script: $script) { success errors { path message } }
    }
  `;
  const data = await client.request<{ validateLuaScript: ScriptValidationResult }>(
    query,
    { script },
  );
  return data.validateLuaScript;
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
