import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installOptions, installRuntime } from "./runtime-install.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const options = installOptions(process.argv.slice(2));
const installed = await installRuntime(
  options.artifact ?? join(root, "artifacts/runtime"),
  { ...options },
);
console.log(JSON.stringify(installed));
