import { describe, expect, test } from "bun:test";
import { deriveMcpUrl } from "../src/commands/setup-mcp.ts";

describe("deriveMcpUrl", () => {
  test("replaces trailing /graphql with /mcp", () => {
    expect(deriveMcpUrl("https://api.example.com/graphql")).toBe(
      "https://api.example.com/mcp",
    );
  });

  test("preserves path prefix when stripping /graphql", () => {
    expect(deriveMcpUrl("https://api.example.com/v1/graphql")).toBe(
      "https://api.example.com/v1/mcp",
    );
  });

  test("appends /mcp when no /graphql suffix", () => {
    expect(deriveMcpUrl("https://api.example.com")).toBe(
      "https://api.example.com/mcp",
    );
  });

  test("strips trailing slash before appending", () => {
    expect(deriveMcpUrl("https://api.example.com/")).toBe(
      "https://api.example.com/mcp",
    );
  });

  test("preserves port and protocol", () => {
    expect(deriveMcpUrl("http://localhost:4000/graphql")).toBe(
      "http://localhost:4000/mcp",
    );
  });
});
