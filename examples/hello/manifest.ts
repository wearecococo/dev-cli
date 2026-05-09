import { defineIntegration, luaFile } from "@wearecococo/dev-cli/define";

export default defineIntegration({
  id: "com.cococo.hello",
  version: "0.1.0",
  engineVersion: 2,
  sdkVersion: "1.0",
  runtimeMode: "script_actor",
  description: "Minimal example integration that logs a heartbeat every minute.",
  resources: [],
  permissions: [],
  subscriptions: [],
  timers: [
    {
      name: "heartbeat",
      every: "1m",
      source: luaFile("./handlers/timers/heartbeat.lua"),
    },
  ],
});
