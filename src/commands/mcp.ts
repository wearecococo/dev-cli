import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { startStdio, type SwaggerSpec } from "../mcp/swagger-server.ts";

export async function runMcpSwagger(specPath: string): Promise<void> {
  const abs = resolve(process.cwd(), specPath);
  const raw = readFileSync(abs, "utf8");
  const parsed = abs.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Spec at ${abs} did not parse to an object.`);
  }
  const spec = parsed as SwaggerSpec;
  if (!spec.openapi && !spec.swagger) {
    throw new Error(
      `Spec at ${abs} has no 'openapi' or 'swagger' version field — is it really an OpenAPI/Swagger doc?`,
    );
  }
  await startStdio(spec, abs);
}
