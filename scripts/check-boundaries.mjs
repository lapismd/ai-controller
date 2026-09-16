import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
const files = await readdir("src", { recursive: true });
for (const path of files.filter((path) => path.endsWith(".ts"))) {
  const source = await readFile(`src/${path}`, "utf8");
  if (
    /from\s+["'](?:@lapis-notes\/|.*lapis-plugins|.*nostr-agent-controller)/.test(
      source,
    )
  )
    throw new Error(`Consumer dependency in src/${path}`);
}
// A browser bundle is also an executable import-boundary check.
await build({
  entryPoints: ["src/client.ts", "src/contracts.ts"],
  outdir: "dist/browser-check",
  bundle: true,
  platform: "browser",
  write: false,
  logLevel: "silent",
});
console.log("Controller and browser SDK boundaries passed");
