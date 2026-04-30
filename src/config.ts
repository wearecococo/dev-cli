export type Config = {
  endpoint: string;
  token: string;
};

export type ConfigOverrides = {
  endpoint?: string;
  token?: string;
};

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const endpoint = overrides.endpoint ?? process.env.COCOCO_ENDPOINT;
  const token = overrides.token ?? process.env.COCOCO_TOKEN;

  if (!endpoint) {
    throw new Error(
      "COCOCO_ENDPOINT is not set. Add it to .env or pass --endpoint. See .env.example.",
    );
  }
  if (!token) {
    throw new Error(
      "COCOCO_TOKEN is not set. Add it to .env or pass --token. See .env.example.",
    );
  }

  return { endpoint, token };
}
