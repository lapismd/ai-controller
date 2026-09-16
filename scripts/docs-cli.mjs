import { readFile, writeFile, mkdir } from "node:fs/promises";
import { markdownHelp } from "../dist/cli/commands.js";
const file = "docs/cli/reference.md";
const expected = markdownHelp();
if (process.argv.includes("--check")) {
  if ((await readFile(file, "utf8")) !== expected)
    throw new Error("CLI reference is stale: run pnpm docs:write");
} else {
  await mkdir("docs/cli", { recursive: true });
  await writeFile(file, expected);
}
