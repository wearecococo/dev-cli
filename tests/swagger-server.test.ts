import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, type SwaggerSpec } from "../src/mcp/swagger-server.ts";

const openapiSpec: SwaggerSpec = {
  openapi: "3.0.0",
  info: { title: "Petstore", version: "1.0.0", description: "Toy spec" },
  servers: [{ url: "https://api.example.com/v1" }],
  tags: [{ name: "pets", description: "Pet ops" }],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List all pets",
        tags: ["pets"],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" },
              },
            },
          },
        },
      },
      post: {
        operationId: "createPet",
        summary: "Create a pet",
        tags: ["pets"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Pet" },
            },
          },
        },
        responses: { "201": { description: "created" } },
      },
    },
    "/pets/{id}": {
      get: {
        operationId: "getPet",
        summary: "Get a pet by id",
        tags: ["pets"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          owner: { $ref: "#/components/schemas/Owner" },
        },
      },
      Owner: {
        type: "object",
        properties: {
          name: { type: "string" },
          favoritePet: { $ref: "#/components/schemas/Pet" },
        },
      },
    },
  },
};

const swagger2Spec: SwaggerSpec = {
  swagger: "2.0",
  info: { title: "V2 API", version: "0.1.0" },
  host: "api.example.com",
  basePath: "/v2",
  schemes: ["https"],
  paths: {
    "/things": {
      get: {
        operationId: "listThings",
        summary: "List things",
        responses: { "200": { description: "ok" } },
      },
    },
  },
  definitions: {
    Thing: {
      type: "object",
      properties: { id: { type: "string" } },
    },
  },
};

async function makeClient(spec: SwaggerSpec): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const server = buildServer(spec, "test://spec");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.1" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ data: unknown; isError: boolean }> {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? "")
    .join("");
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // leave as raw string for error-message assertions
  }
  return { data, isError: r.isError === true };
}

describe("swagger MCP server (OpenAPI 3.x)", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ client, cleanup } = await makeClient(openapiSpec));
  });
  afterAll(async () => {
    await cleanup();
  });

  test("registers exactly the read-only tools", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "get_info",
      "get_operation",
      "get_schema",
      "list_operations",
      "list_tags",
      "search_operations",
    ]);
  });

  test("get_info summarizes title, servers, and counts", async () => {
    const { data } = await callJson(client, "get_info");
    expect(data).toMatchObject({
      title: "Petstore",
      specVersion: "3.0.0",
      operationCount: 3,
      schemaCount: 2,
      servers: [{ url: "https://api.example.com/v1" }],
    });
  });

  test("list_operations returns method, path, and tags for each op", async () => {
    const { data } = await callJson(client, "list_operations");
    expect(Array.isArray(data)).toBe(true);
    const ops = data as Array<{ operationId: string; method: string; path: string }>;
    expect(ops).toHaveLength(3);
    const ids = ops.map((o) => o.operationId).sort();
    expect(ids).toEqual(["createPet", "getPet", "listPets"]);
  });

  test("list_operations filters by tag", async () => {
    const { data } = await callJson(client, "list_operations", { tag: "pets" });
    expect((data as unknown[]).length).toBe(3);
    const { data: empty } = await callJson(client, "list_operations", {
      tag: "nonexistent",
    });
    expect(empty).toEqual([]);
  });

  test("search_operations does case-insensitive substring match", async () => {
    const { data } = await callJson(client, "search_operations", { query: "CREATE" });
    const ops = data as Array<{ operationId: string }>;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.operationId).toBe("createPet");
  });

  test("search_operations honors limit", async () => {
    const { data } = await callJson(client, "search_operations", {
      query: "pet",
      limit: 2,
    });
    expect((data as unknown[]).length).toBe(2);
  });

  test("get_operation by operationId resolves request body $refs", async () => {
    const { data } = await callJson(client, "get_operation", {
      operationId: "createPet",
    });
    const op = data as {
      method: string;
      path: string;
      requestBody: { content: { "application/json": { schema: { properties: object } } } };
    };
    expect(op.method).toBe("post");
    expect(op.path).toBe("/pets");
    const schema = op.requestBody.content["application/json"].schema;
    expect(schema.properties).toMatchObject({
      id: { type: "integer" },
      name: { type: "string" },
    });
  });

  test("get_operation by method+path works", async () => {
    const { data } = await callJson(client, "get_operation", {
      method: "get",
      path: "/pets/{id}",
    });
    expect((data as { operationId: string }).operationId).toBe("getPet");
  });

  test("get_operation marks $ref cycles instead of recursing", async () => {
    const { data } = await callJson(client, "get_operation", {
      operationId: "createPet",
    });
    const json = JSON.stringify(data);
    expect(json).toContain('"$cycle":true');
    // cycle marker should appear inside owner.favoritePet, not at top level
    const op = data as {
      requestBody: {
        content: {
          "application/json": {
            schema: {
              properties: {
                owner: {
                  properties: {
                    favoritePet: { $ref?: string; $cycle?: boolean };
                  };
                };
              };
            };
          };
        };
      };
    };
    const fav =
      op.requestBody.content["application/json"].schema.properties.owner.properties
        .favoritePet;
    expect(fav.$cycle).toBe(true);
    expect(fav.$ref).toBe("#/components/schemas/Pet");
  });

  test("get_operation errors when neither operationId nor method+path provided", async () => {
    const r = await callJson(client, "get_operation", {});
    expect(r.isError).toBe(true);
    expect(typeof r.data === "string" ? r.data : "").toContain("operationId");
  });

  test("get_operation errors on unknown operationId", async () => {
    const r = await callJson(client, "get_operation", { operationId: "ghost" });
    expect(r.isError).toBe(true);
  });

  test("list_tags includes declared description and operation count", async () => {
    const { data } = await callJson(client, "list_tags");
    expect(data).toEqual([
      { name: "pets", description: "Pet ops", operationCount: 3 },
    ]);
  });

  test("get_schema resolves nested refs and breaks the self-cycle", async () => {
    const { data } = await callJson(client, "get_schema", { name: "Pet" });
    const schema = data as {
      properties: {
        owner: {
          properties: {
            favoritePet: { $ref?: string; $cycle?: boolean };
          };
        };
      };
    };
    expect(schema.properties.owner.properties.favoritePet.$cycle).toBe(true);
  });

  test("get_schema errors with helpful message on unknown name", async () => {
    const r = await callJson(client, "get_schema", { name: "Nope" });
    expect(r.isError).toBe(true);
    expect(typeof r.data === "string" ? r.data : "").toContain("not found");
  });
});

describe("swagger MCP server (Swagger 2.0)", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ client, cleanup } = await makeClient(swagger2Spec));
  });
  afterAll(async () => {
    await cleanup();
  });

  test("derives server URL from host/basePath/schemes", async () => {
    const { data } = await callJson(client, "get_info");
    expect(data).toMatchObject({
      specVersion: "2.0",
      servers: [{ url: "https://api.example.com/v2" }],
    });
  });

  test("get_schema reads from definitions, not components.schemas", async () => {
    const { data } = await callJson(client, "get_schema", { name: "Thing" });
    expect(data).toMatchObject({
      type: "object",
      properties: { id: { type: "string" } },
    });
  });
});
