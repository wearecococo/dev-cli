import type { Config } from "../config.ts";

type GraphQLError = {
  message: string;
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
};

type GraphQLResponse<T> = {
  data?: T;
  errors?: GraphQLError[];
};

export class GraphQLRequestError extends Error {
  constructor(
    message: string,
    readonly errors: GraphQLError[],
  ) {
    super(message);
    this.name = "GraphQLRequestError";
  }
}

export type GraphQLClient = {
  request<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
};

export function createClient(config: Config): GraphQLClient {
  return {
    async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      const res = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
      }

      const body = (await res.json()) as GraphQLResponse<T>;

      if (body.errors && body.errors.length > 0) {
        const summary = body.errors.map((e) => e.message).join("; ");
        throw new GraphQLRequestError(summary, body.errors);
      }

      if (!body.data) {
        throw new Error("GraphQL response had no data and no errors.");
      }

      return body.data;
    },
  };
}
