import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
});
console.log("Controller CLI modules bundled");
