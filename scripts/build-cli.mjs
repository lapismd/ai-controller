import { buildRuntime } from "./runtime-build.mjs";
await buildRuntime(process.cwd(), "lapis-ai-controller", {
  input: "dist/main.js",
  smoke: [["__internal", "redaction-smoke"]],
  packages: ["@lapismd/ai-host", "@lapismd/agent-redaction"],
});
